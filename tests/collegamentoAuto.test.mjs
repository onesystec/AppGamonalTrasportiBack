// Los servicios que llegan de una app conectada (App Piazza) entran DIRECTO al Registro del dia, sin chofer ni vehiculo ("Sin asignar"), sin pasar por la bandeja de
// Solicitudes; el Responsable elige chofer y vehiculo y a la otra app se le avisa. Pruebas con base LOCAL (GAMONAL_TEST_DATABASE_URL a localhost) y una Piazza simulada.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";

const DB = process.env.GAMONAL_TEST_DATABASE_URL ?? "";
const dbOk = /@(localhost|127\.0\.0\.1)[:/]/.test(DB);
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = dbOk ? DB : (process.env.DATABASE_URL ?? "postgresql://x:y@localhost:5432/none");
Object.assign(process.env, {
  JWT_SECRET: "0123456789abcdef0123456789abcdef",
  RESET_PASSWORD_URL: "http://localhost:5173/reset",
  RESEND_API_KEY: "x",
  RESEND_FROM_EMAIL: "x@x.io",
  R2_ACCOUNT_ID: "x",
  R2_ACCESS_KEY_ID: "x",
  R2_SECRET_ACCESS_KEY: "x",
  R2_BUCKET_NAME: "x",
  GOOGLE_MAPS_API_KEY: "x",
  COLLEGAMENTI_ENCRYPTION_KEY: "k".repeat(40),
  // Sin servidores de rutas reales: el calculo de ruta es "best-effort" y falla rapido.
  OSRM_BASE_URL: "http://127.0.0.1:9",
  VALHALLA_BASE_URL: "http://127.0.0.1:9",
});

const { detectarTipoServicio, tipoDeSolicitud, textoDeServicio } = await import("../src/services/collegamentoTipo.service.js");

describe("tipo de servicio deducido del texto (reglas puras)", () => {
  const tipo = (s) => detectarTipoServicio({ ...s, texto: textoDeServicio(s) });
  test("AB Service: por el cliente, las palabras, el deposito de Romanengo o la forma del Shipment", () => {
    assert.equal(tipo({ cliente: "AB SERVICE", destinazione: "Via Nazionale 544, Roseto degli Abruzzi" }), "AB_SERVICE");
    assert.equal(tipo({ cliente: "AB", codigo: "X" }), "AB_SERVICE");
    assert.equal(tipo({ cliente: "A.B. Service s.r.l." }), "AB_SERVICE");
    assert.equal(tipo({ cliente: "Farmacia", note: "Ritiro: AB Service (Romanengo)\nConsegna: Via Roma 1" }), "AB_SERVICE");
    assert.equal(tipo({ cliente: "Farmacia", note: "ritiro presso magazzino di Romanengo" }), "AB_SERVICE");
    assert.equal(tipo({ cliente: "Farmacia", shipment: "182123456" }), "AB_SERVICE");
    assert.equal(tipo({ codigo: "182123456" }), "AB_SERVICE");
    assert.equal(tipo({ cliente: "Farmacia", shipment: "123456789", orderNumero: "012345678" }), "AB_SERVICE");
  });
  test("DHL: por el cliente, el portal (Ship To) o la forma del Shipment y del Order", () => {
    assert.equal(tipo({ cliente: "DHL" }), "DHL");
    assert.equal(tipo({ cliente: "EMC2", note: "Shipment # 171712939 / Customer EMC2 / Ship To City VIZZOLA TICINO" }), "DHL");
    assert.equal(tipo({ cliente: "EMC2", note: "Ship To Address VIA X 1" }), "DHL");
    assert.equal(tipo({ cliente: "HP", shipment: "172076185" }), "DHL");
    assert.equal(tipo({ cliente: "HP", orderNumero: "1167746741" }), "DHL");
  });
  test("el resto es Extra Piazza; el tipo expreso de la otra app manda", () => {
    assert.equal(tipo({ cliente: "Farmacia Verdi", destinazione: "Via Roma 1, Milano", codigo: "P-100" }), "EXTRA_PIAZZA");
    assert.equal(tipo({ cliente: "HP", codigo: "S20602391" }), "EXTRA_PIAZZA");
    assert.equal(tipo({}), "EXTRA_PIAZZA");
    assert.equal(tipo({ tipo: "AB_SERVICE", cliente: "Farmacia" }), "AB_SERVICE");
    assert.equal(tipo({ tipo: "DHL Milano", cliente: "Farmacia" }), "DHL");
    assert.equal(tipo({ tipo: "EXTRA_PIAZZA", cliente: "DHL" }), "EXTRA_PIAZZA");
  });
  test("tipo y zona de la solicitud", () => {
    assert.deepEqual(tipoDeSolicitud("AB_SERVICE", { ciudad: "Roma" }), { servicio: "AB_SERVICE", zona: null });
    assert.deepEqual(tipoDeSolicitud("DHL", { ciudad: "Milano" }), { servicio: "DHL_MILANO", zona: null });
    assert.deepEqual(tipoDeSolicitud("DHL", { destino: "Via del Corso 1, 00186 Roma RM" }), { servicio: "DHL_ROMA", zona: null });
    assert.deepEqual(tipoDeSolicitud("EXTRA_PIAZZA", { ciudad: "Roma" }), { servicio: "EXTRA_PIAZZA", zona: "ROMA" });
    assert.deepEqual(tipoDeSolicitud("EXTRA_PIAZZA", { ciudad: "Milano" }), { servicio: "EXTRA_PIAZZA", zona: "MILANO" });
  });
});

describe("App collegate: servicios directo al Registro (base local + Piazza simulada)", { skip: !dbOk && "falta GAMONAL_TEST_DATABASE_URL (localhost)" }, () => {
  let server, base, piazza, prisma, ownerToken, owner, col, choferA, vehA;
  const T1 = "T1-token-de-piazza-para-gamonal-123456";
  const T2 = "T2-token-de-gamonal-para-piazza-123456";
  const aggiornamenti = [];
  const entregas = [];
  let ignorar = false;

  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const servizio = (extra = {}) => ({ recordId: "pz-1", codigo: "P-100", cliente: "Farmacia Verdi", destinazione: "Via Roma 1, 20121 Milano MI", eta: "2026-11-24T10:00:00Z", ciudad: "Milano", km: 12, ...extra });
  const esperar = async (fn, ms = 25000) => {
    const hasta = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > hasta) throw new Error("tiempo agotado esperando");
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  before(async () => {
    const { default: app } = await import("../src/app.js");
    ({ prisma } = await import("../src/config/prisma.js"));
    const { signToken } = await import("../src/utils/jwt.js");
    const { sha256 } = await import("../src/services/collegamentoInvio.service.js");
    const { encryptSecret } = await import("../src/utils/secretBox.js");
    await prisma.$executeRawUnsafe('TRUNCATE "collegamenti","solicitudes_servicio","records","clients","vehiculos","users","configuracion","cambios_servicio","alertas_cambio" RESTART IDENTITY CASCADE');
    const mk = (cargo, correo, nombre) => prisma.user.create({ data: { nombre, apellido: "Test", area: "DHL", cargo, fechaNacimiento: new Date("1985-01-01"), numeroCelular: "3331234567", correoElectronico: correo, password: "x" } });
    owner = await mk("OWNER", "owner@t.it", "Olga");
    choferA = await mk("CHOFER", "chofer@t.it", "Carlos");
    ownerToken = signToken({ sub: owner.id });
    vehA = await prisma.vehiculo.create({ data: { targa: "GA111AA", modelo: "Ducato", area: "DHL" } });
    const cliente = await prisma.client.create({ data: { nombre: "Piazza Spedizioni" } });
    // "Piazza": guarda lo que recibe.
    piazza = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        if (req.url.endsWith("/aggiornamenti")) {
          aggiornamenti.push(JSON.parse(data));
          entregas.push({ url: req.url, authorization: req.headers.authorization });
        }
        const respuesta = ignorar ? { ok: true, ignorato: true, motivo: "Servicio reasignado" } : { ok: true };
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, data: respuesta }));
      });
    });
    await new Promise((r) => piazza.listen(0, r));
    col = await prisma.collegamento.create({
      data: { ruolo: "CLIENTE", stato: "ATTIVO", remotoUrl: `http://localhost:${piazza.address().port}`, remotoId: "p-1", remotoNome: "App Piazza", clientId: cliente.id, creadoDaId: owner.id, tokenEntranteHash: sha256(T2), tokenUscente: encryptSecret(T1) },
    });
    server = createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
  });
  after(async () => {
    server?.close();
    piazza?.close();
    await prisma?.$disconnect();
  });

  const enviar = (extra) => api("POST", `/collegamenti/pubblico/${col.id}/servizi`, { token: T2, body: servizio(extra) });

  test("llega y aparece en el Registro del dia, sin chofer ni vehiculo; no queda ninguna solicitud pendiente", async () => {
    const r = await enviar();
    assert.equal(r.status, 200, r.text);
    const sol = await esperar(async () => {
      const s = await prisma.solicitudServicio.findUnique({ where: { id: r.body.data.id } });
      return s?.estado === "ACEPTADA" && s.recordId ? s : null;
    });
    const record = await prisma.record.findUnique({ where: { id: sol.recordId }, include: { driver: true, vehicle: true, stops: true } });
    assert.equal(record.spedizzione, "EXTRA_PIAZZA");
    assert.equal(record.driver.correoElectronico, "sin-asignar@sistema.interno");
    assert.equal(record.vehicle.targa, "SIN-ASIGNAR");
    assert.equal(record.destinazione, "Via Roma 1, 20121 Milano MI");
    assert.equal(record.kilometros, 12);
    assert.match(record.descripcion, /Codice App Piazza: P-100/);
    assert.equal(record.estado, "IN_CONSEGNA");
    assert.equal(record.fechaServicio.toISOString().slice(0, 10), "2026-11-24", "el dia del servicio es el de su ETA");
    // Ya no hay nada que aceptar a mano.
    const pendientes = await api("GET", "/solicitudes?estado=PENDIENTE", { token: ownerToken });
    assert.equal(pendientes.body.data.items.length, 0);
    // Esta en la lista del dia y en "Por asignar".
    const dia = await api("GET", "/records/2026/11/24", { token: ownerToken });
    assert.ok(dia.body.data.records.some((x) => x.id === record.id), "esta en la lista de servicios del dia");
    const sinAsignar = await api("GET", "/records/sin-asignar", { token: ownerToken });
    assert.ok(!sinAsignar.body.data.records.some((x) => x.id === record.id), "NO se repite arriba, en Por asignar: ya esta en la lista del dia");
    assert.equal(dia.body.data.records.find((x) => x.id === record.id).origenApp, "App Piazza", "con la insignia 'Da App Piazza'");
  });

  test("a Piazza se le avisa enseguida que quedo aceptado (todavia sin chofer ni targa)", async () => {
    await esperar(() => aggiornamenti.some((b) => b.tipo === "ACCETTATO"));
    assert.deepEqual(aggiornamenti.find((b) => b.tipo === "ACCETTATO"), { recordId: "pz-1", tipo: "ACCETTATO" });
    const aggiornamento = await esperar(() => aggiornamenti.find((b) => b.tipo === "AGGIORNAMENTO"));
    assert.equal(aggiornamento.estado, "IN_CONSEGNA");
    assert.equal(aggiornamento.autista ?? null, null);
    assert.equal(aggiornamento.targa ?? null, null);
  });

  test("el chofer asignado acepta, elige un vehículo disponible y Piazza recibe la targa confirmada", async () => {
    const { signToken } = await import("../src/utils/jwt.js");
    const token = signToken({ sub: choferA.id });
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "pz-1" } });
    const ruta = `/records/${sol.recordId}`;
    aggiornamenti.length = 0;
    const asignado = await api("PATCH", ruta, { token: ownerToken, body: { driverId: choferA.id, vehicleId: vehA.id } });
    assert.equal(asignado.status, 200, asignado.text);
    assert.equal(asignado.body.data.record.aceptacionChofer, "PENDIENTE");
    assert.equal((await api("PATCH", ruta, { token, body: { estado: "CONSEGNATO" } })).status, 409);
    assert.equal((await api("POST", `${ruta}/asignacion/vehiculo`, { token, body: { vehicleId: vehA.id } })).status, 409);
    const previo = await esperar(() => aggiornamenti.find((body) => body.autista));
    assert.equal(previo.targa, null);
    const aceptado = await api("POST", `${ruta}/asignacion/aceptar`, { token });
    assert.equal(aceptado.status, 200, aceptado.text);
    assert.equal(aceptado.body.data.record.aceptacionChofer, "VEHICULO_PENDIENTE");

    const asignadoB = await prisma.vehiculo.create({ data: { targa: "QC345AB", modelo: "Transit", area: "DHL" } });
    const taller = await prisma.vehiculo.create({ data: { targa: "QC346AB", modelo: "Transit", area: "DHL", estado: "EN_MANTENIMIENTO" } });
    const lista = await api("GET", `${ruta}/asignacion/vehiculos`, { token });
    assert.deepEqual(lista.body.data.vehicles.map(({ id }) => id), [vehA.id, asignadoB.id]);
    assert.equal((await api("POST", `${ruta}/asignacion/vehiculo`, { token, body: { vehicleId: taller.id } })).status, 409);
    const confirmado = await api("POST", `${ruta}/asignacion/vehiculo`, { token, body: { vehicleId: asignadoB.id } });
    assert.equal(confirmado.status, 200, confirmado.text);
    assert.equal(confirmado.body.data.record.aceptacionChofer, "CONFIRMADA");
    const msg = await esperar(() => aggiornamenti.find((body) => body.targa));
    assert.deepEqual(msg, { recordId: "pz-1", tipo: "AGGIORNAMENTO", estado: "IN_CONSEGNA", autista: "Carlos Test", targa: "QC345AB" });
  });

  test("los PATCH de chofer, vehículo y ambos avisan únicamente sobre el registro guardado", async () => {
    const remoto = "pz-selectores";
    assert.equal((await enviar({ recordId: remoto, codigo: "P-SELECTORES" })).status, 200);
    const sol = await esperar(() => prisma.solicitudServicio.findFirst({
      where: { recordRemotoId: remoto, estado: "ACEPTADA" },
    }));
    await esperar(async () => (await prisma.solicitudServicio.findUnique({ where: { id: sol.id } })).ultimoEnviado);
    const choferB = await prisma.user.create({
      data: { nombre: "Fabio", apellido: "Test", area: "DHL", cargo: "CHOFER", fechaNacimiento: new Date("1985-01-01"), numeroCelular: "3331234567", correoElectronico: "fabio@t.it", password: "x" },
    });
    const vehB = await prisma.vehiculo.create({ data: { targa: "GB222BB", modelo: "Transit", area: "DHL" } });
    for (const [body, autista, targa] of [
      [{ driverId: choferA.id }, "Carlos Test", null],
      [{ driverId: choferB.id, vehicleId: vehB.id }, "Fabio Test", null],
    ]) {
      const desde = aggiornamenti.length;
      const r = await api("PATCH", `/records/${sol.recordId}`, { token: ownerToken, body });
      assert.equal(r.status, 200, r.text);
      await esperar(async () => {
        const { ultimoEnviado } = await prisma.solicitudServicio.findUnique({ where: { id: sol.id } });
        return ultimoEnviado?.autista === autista && ultimoEnviado?.targa === targa;
      });
      assert.deepEqual(aggiornamenti.slice(desde), [{ recordId: remoto, tipo: "AGGIORNAMENTO", estado: "IN_CONSEGNA", autista, targa }]);
    }

    const propio = await prisma.record.create({
      data: { driverId: choferA.id, vehicleId: vehA.id, clientId: col.clientId, descripcion: "Prueba", codigo: "PROPIO-SELECTORES", destinazione: "Milano", fechaServicio: new Date("2026-11-24"), eta: new Date("2026-11-24T09:00:00Z"), spedizzione: "EXTRA_PIAZZA" },
    });
    const desde = aggiornamenti.length;
    const r = await api("PATCH", `/records/${propio.id}`, { token: ownerToken, body: { driverId: choferB.id } });
    assert.equal(r.status, 200, r.text);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(aggiornamenti.length, desde);
  });

  test("Reenviar recupera una solicitud tras reconectar y distingue un 200 ignorado", async () => {
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "pz-selectores" } });
    const { encryptSecret } = await import("../src/utils/secretBox.js");
    await prisma.solicitudServicio.update({ where: { id: sol.id }, data: { collegamentoId: null } });
    const tokenNuevo = "token-saliente-de-la-nueva-conexion";
    await prisma.collegamento.update({ where: { id: col.id }, data: { remotoId: "p-conexion-nueva", tokenUscente: encryptSecret(tokenNuevo) } });
    ignorar = true;
    try {
      const r = await api("PATCH", `/records/${sol.recordId}`, { token: ownerToken, body: { driverId: choferA.id } });
      assert.equal(r.status, 200, r.text);
      await esperar(async () => (await prisma.collegamento.findUnique({ where: { id: col.id } })).ultimoErrore);
      const reinvio = await api("POST", `/collegamenti/solicitudes/${sol.id}/reinvia`, { token: ownerToken });
      assert.equal(reinvio.status, 502, reinvio.text);
      assert.match(reinvio.text, /Servicio reasignado/);
      assert.deepEqual((await prisma.solicitudServicio.findUnique({ where: { id: sol.id } })).ultimoEnviado, sol.ultimoEnviado);
    } finally {
      ignorar = false;
    }
    const r = await api("POST", `/collegamenti/solicitudes/${sol.id}/reinvia`, { token: ownerToken });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.inviato, true);
    assert.deepEqual(entregas.at(-1), { url: "/api/collegamenti/pubblico/p-conexion-nueva/aggiornamenti", authorization: `Bearer ${tokenNuevo}` });
    assert.deepEqual(aggiornamenti.at(-1), { recordId: "pz-selectores", tipo: "AGGIORNAMENTO", estado: "IN_CONSEGNA", autista: "Carlos Test", targa: null });
    assert.equal((await prisma.solicitudServicio.findUnique({ where: { id: sol.id } })).collegamentoId, col.id);
    assert.equal((await prisma.collegamento.findUnique({ where: { id: col.id } })).ultimoErrore, null);
  });

  test("si Piazza lo reenvia con cambios: no se duplica el servicio, queda la alerta y la linea de tiempo", async () => {
    const antes = await prisma.record.count();
    const r = await enviar({ destinazione: "Via Verdi 9, 20121 Milano MI" });
    assert.equal(r.status, 200, r.text);
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(await prisma.record.count(), antes, "no se crea otro servicio");
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "pz-1" } });
    assert.equal(sol.estado, "ACEPTADA");
    const fila = await prisma.cambioServicio.findFirst({ where: { solicitudId: sol.id, campo: "app_destinazione" } });
    assert.equal(fila.nuevo, "Via Verdi 9, 20121 Milano MI");
    assert.equal((await prisma.record.findUnique({ where: { id: sol.recordId } })).destinazione, "Via Roma 1, 20121 Milano MI", "el servicio de Gamonal no se cambia solo");
    // Reenviar lo mismo no hace nada.
    await enviar({ destinazione: "Via Verdi 9, 20121 Milano MI" });
    assert.equal(await prisma.record.count(), antes);
  });

  test("varios servicios seguidos: cada uno entra una sola vez aunque Piazza reintente al mismo tiempo", async () => {
    const antes = await prisma.record.count();
    const [a, b, c] = await Promise.all([enviar({ recordId: "pz-2", destinazione: "Via Dante 5, Milano" }), enviar({ recordId: "pz-2", destinazione: "Via Dante 5, Milano" }), enviar({ recordId: "pz-3", destinazione: "Via Manzoni 2, Milano" })]);
    assert.deepEqual([a.status, b.status, c.status], [200, 200, 200]);
    await esperar(async () => (await prisma.solicitudServicio.count({ where: { estado: "ACEPTADA", recordRemotoId: { in: ["pz-2", "pz-3"] } } })) === 2);
    await new Promise((res) => setTimeout(res, 800));
    assert.equal(await prisma.record.count(), antes + 2, "dos servicios, ni uno de mas");
    assert.equal(await prisma.solicitudServicio.count({ where: { recordRemotoId: "pz-2" } }), 1);
  });

  test("un servicio de AB Service entra como AB Service (por su texto), con el cliente AB y su Shipment como codigo", async () => {
    await prisma.client.create({ data: { nombre: "AB" } });
    const r = await enviar({ recordId: "pz-ab", cliente: "AB SERVICE", codigo: "182123456", shipment: "182123456", orderNumero: "012345678", destinazione: "VIA NAZIONALE, 544, 64026 Roseto Degli Abruzzi", km: 594, note: "Ritiro: AB Service (Romanengo)" });
    assert.equal(r.status, 200, r.text);
    const sol = await esperar(async () => {
      const x = await prisma.solicitudServicio.findUnique({ where: { id: r.body.data.id } });
      return x?.estado === "ACEPTADA" ? x : null;
    });
    assert.equal(sol.servicio, "AB_SERVICE");
    const rec = await prisma.record.findUnique({ where: { id: sol.recordId }, include: { client: true } });
    assert.equal(rec.spedizzione, "AB_SERVICE");
    assert.equal(rec.client.nombre, "AB");
    assert.equal(rec.codigo, "182123456");
    assert.equal(rec.shipment, "182123456");
    assert.equal(rec.orderNumero, "012345678");
    assert.equal(rec.kilometros, 594);
    // Sale en el area AB Service del dia.
    const dia = await api("GET", "/records/2026/11/24", { token: ownerToken });
    assert.equal(dia.body.data.records.find((x) => x.id === rec.id).spedizzione, "AB_SERVICE");
  });

  test("un servicio de DHL entra como DHL Milano (o DHL Roma si es de Roma)", async () => {
    const a = await enviar({ recordId: "pz-dhl", cliente: "DHL", shipment: "172076185", codigo: "172076185", destinazione: "Via Italia 9, 20900 Monza MB", ciudad: "Monza" });
    const b = await enviar({ recordId: "pz-dhl-roma", cliente: "DHL", shipment: "172076186", codigo: "172076186", destinazione: "Via del Corso 1, 00186 Roma RM", ciudad: "Roma" });
    const final = async (id) => esperar(async () => {
      const x = await prisma.solicitudServicio.findUnique({ where: { id } });
      return x?.estado === "ACEPTADA" ? x : null;
    });
    const sa = await final(a.body.data.id);
    const sb = await final(b.body.data.id);
    assert.equal(sa.servicio, "DHL_MILANO");
    assert.equal(sb.servicio, "DHL_ROMA");
    const ra = await prisma.record.findUnique({ where: { id: sa.recordId } });
    const rb = await prisma.record.findUnique({ where: { id: sb.recordId } });
    assert.equal(ra.spedizzione, "DHL");
    assert.equal(ra.extrasPiazzaZona, "MILANO");
    assert.equal(rb.extrasPiazzaZona, "ROMA");
    assert.equal(ra.shipment, "172076185");
  });

  test("'Por asignar' no repite los servicios de Piazza, pero sigue mostrando los de otros clientes sin chofer", async () => {
    const { getSinAsignar } = await import("../src/services/sinAsignar.service.js");
    const { driverId, vehicleId } = await getSinAsignar();
    const cli = await prisma.client.findFirst();
    const portal = await prisma.record.create({
      data: { driverId, vehicleId, clientId: cli.id, descripcion: "d", codigo: "PORTAL-1", destinazione: "Via Portal 1, Milano", fechaServicio: new Date("2026-11-24T00:00:00Z"), eta: new Date("2026-11-24T09:00:00Z"), spedizzione: "EXTRA_PIAZZA" },
    });
    const r = await api("GET", "/records/sin-asignar", { token: ownerToken });
    const codigos = r.body.data.records.map((x) => x.codigo);
    assert.ok(codigos.includes("PORTAL-1"), "el de otro cliente sigue arriba");
    assert.ok(!codigos.includes("182123456") && !codigos.includes("172076185") && !codigos.includes("P-100"), "los de Piazza no");
    await prisma.record.delete({ where: { id: portal.id } });
  });

  test("los servicios de Piazza que entraron mal clasificados (sin chofer todavia) se corrigen; los ya asignados no se tocan", async () => {
    const { getSinAsignar } = await import("../src/services/sinAsignar.service.js");
    const { driverId, vehicleId } = await getSinAsignar();
    const cli = await prisma.client.findFirst({ where: { nombre: "Piazza Spedizioni" } });
    const mkConectado = async (clave, { asignado = false, datos }) => {
      const rec = await prisma.record.create({
        data: { driverId: asignado ? choferA.id : driverId, vehicleId: asignado ? vehA.id : vehicleId, clientId: cli.id, descripcion: "d", codigo: `EXTRA_PIAZZA-17953478${clave}`, destinazione: "Via Nazionale 544, Roseto", fechaServicio: new Date("2026-11-26T00:00:00Z"), eta: new Date("2026-11-26T09:00:00Z"), spedizzione: "EXTRA_PIAZZA", extrasPiazzaZona: "MILANO" },
      });
      const sol = await prisma.solicitudServicio.create({
        data: { servicio: "EXTRA_PIAZZA", zona: "MILANO", cliente: datos.app_cliente, destinazione: "Via Nazionale 544, Roseto", fechaHora: new Date("2026-11-26T09:00:00Z"), fornitore: "Gamonal", shipment: datos.app_shipment, empresaId: col.clientId, creadoPorId: owner.id, collegamentoId: col.id, recordRemotoId: `pz-mal-${clave}`, estado: "ACEPTADA", recordId: rec.id, datosRemotos: datos },
      });
      return { rec, sol };
    };
    const ab = { app_cliente: "AB SERVICE", app_codice: "182555111", app_shipment: "182555111", app_destinazione: "Via Nazionale 544, Roseto", app_tappe: [], app_ciudad: null };
    const sinAsignar = await mkConectado("11", { datos: ab });
    const yaAsignado = await mkConectado("22", { asignado: true, datos: { ...ab, app_codice: "182555222", app_shipment: "182555222" } });
    const extraOk = await mkConectado("33", { datos: { app_cliente: "Farmacia", app_codice: "P-9", app_shipment: "P-9", app_destinazione: "Via Roma 1", app_tappe: [], app_ciudad: "Milano" } });
    const { reclasificarServiciosConectados } = await import("../src/services/collegamento.service.js");
    assert.ok((await reclasificarServiciosConectados()) >= 1);
    const a = await prisma.record.findUnique({ where: { id: sinAsignar.rec.id }, include: { client: true } });
    assert.equal(a.spedizzione, "AB_SERVICE");
    assert.equal(a.client.nombre, "AB");
    assert.equal(a.codigo, "182555111");
    assert.equal((await prisma.solicitudServicio.findUnique({ where: { id: sinAsignar.sol.id } })).servicio, "AB_SERVICE");
    assert.equal((await prisma.record.findUnique({ where: { id: yaAsignado.rec.id } })).spedizzione, "EXTRA_PIAZZA", "uno con chofer asignado no se toca");
    assert.equal((await prisma.record.findUnique({ where: { id: extraOk.rec.id } })).spedizzione, "EXTRA_PIAZZA", "un Extra Piazza sigue siendo Extra Piazza");
    assert.equal(await reclasificarServiciosConectados(), 0, "repetirlo no cambia nada");
  });

  const esperarAceptada = (id) =>
    esperar(async () => {
      const x = await prisma.solicitudServicio.findUnique({ where: { id } });
      return x?.estado === "ACEPTADA" && x.recordId ? x : null;
    });
  const annullare = (recordId, motivo) => api("POST", `/collegamenti/pubblico/${col.id}/servizi/${recordId}/annulla`, { token: T2, body: motivo ? { motivo } : {} });

  test("si Piazza elimina o anula un servicio que todavia no salio, aqui pasa a Anulado (y se ve asi en la lista del dia)", async () => {
    const r = await enviar({ recordId: "pz-an", codigo: "P-AN", destinazione: "Via Anulada 1, Milano", eta: "2026-11-27T10:00:00Z" });
    const sol = await esperarAceptada(r.body.data.id);
    await prisma.record.update({ where: { id: sol.recordId }, data: { estado: "IN_SOSPESO" } });
    const a = await annullare("pz-an", "eliminado en Piazza");
    assert.equal(a.status, 200, a.text);
    const rec = await prisma.record.findUnique({ where: { id: sol.recordId } });
    assert.equal(rec.estado, "ANNULLATO");
    const dia = await api("GET", "/records/2026/11/27", { token: ownerToken });
    assert.equal(dia.body.data.records.find((x) => x.id === sol.recordId).estado, "ANNULLATO");
    // Queda en la linea de tiempo y con alerta para la oficina.
    const hist = await api("GET", `/cambios?recordId=${sol.recordId}`, { token: ownerToken });
    const hito = hist.body.data.items.find((i) => i.hito && /Anulado por App Piazza/.test(i.nuevo));
    assert.ok(hito, "esta en la linea de tiempo");
    assert.match(hito.nuevo, /pasó a Anulado/);
    assert.ok(await prisma.alertaCambio.findFirst({ where: { recordId: sol.recordId } }), "hay alerta");
    // Anularlo otra vez no rompe nada.
    assert.equal((await annullare("pz-an")).status, 200);
    assert.equal((await prisma.record.findUnique({ where: { id: sol.recordId } })).estado, "ANNULLATO");
  });

  test("una eliminación de Piazza anula también un servicio creado en viaje", async () => {
    const recibido = await enviar({ recordId: "pz-eliminado-express", codigo: "P-ELIM-EXPRESS" });
    const sol = await esperarAceptada(recibido.body.data.id);
    const where = { id: sol.recordId };
    assert.equal((await prisma.record.findUnique({ where })).estado, "IN_CONSEGNA");
    const motivo = "Servizio annullato dall'ufficio: duplicato";
    assert.equal((await annullare("pz-eliminado-express", motivo)).status, 200);
    assert.equal((await annullare("pz-eliminado-express", motivo)).status, 200);
    assert.equal((await prisma.record.findUnique({ where })).estado, "ANNULLATO");
    assert.equal(await prisma.cambioServicio.count({ where: { recordId: sol.recordId, campo: "app_annullata" } }), 1);
  });

  test("si ya tenia chofer asignado pero no habia salido, tambien pasa a Anulado; un servicio que ya salio NO se toca (solo alerta)", async () => {
    const a = await enviar({ recordId: "pz-an-chofer", codigo: "P-AN2", destinazione: "Via Con Chofer 2, Milano", eta: "2026-11-27T11:00:00Z" });
    const sa = await esperarAceptada(a.body.data.id);
    await prisma.record.update({ where: { id: sa.recordId }, data: { driverId: choferA.id, vehicleId: vehA.id, estado: "IN_SOSPESO" } });
    await annullare("pz-an-chofer");
    assert.equal((await prisma.record.findUnique({ where: { id: sa.recordId } })).estado, "ANNULLATO");

    const b = await enviar({ recordId: "pz-an-salio", codigo: "P-AN3", destinazione: "Via Ya Salio 3, Milano", eta: "2026-11-27T12:00:00Z" });
    const sb = await esperarAceptada(b.body.data.id);
    await annullare("pz-an-salio", "cliente cancelo");
    assert.equal((await prisma.record.findUnique({ where: { id: sb.recordId } })).estado, "IN_CONSEGNA", "uno que ya salio no se anula solo");
    const hist = await api("GET", `/cambios?recordId=${sb.recordId}`, { token: ownerToken });
    assert.ok(hist.body.data.items.some((i) => i.hito && /ya había salido/.test(i.nuevo)));
    assert.ok(await prisma.alertaCambio.findFirst({ where: { recordId: sb.recordId } }));
  });

  test("si Piazza lo vuelve a asignar a Gamonal despues de anularlo, el servicio se reabre", async () => {
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "pz-an" } });
    assert.equal((await prisma.record.findUnique({ where: { id: sol.recordId } })).estado, "ANNULLATO");
    const r = await enviar({ recordId: "pz-an", codigo: "P-AN", destinazione: "Via Anulada 1, Milano", eta: "2026-11-27T10:00:00Z" });
    assert.equal(r.status, 200, r.text);
    assert.equal((await prisma.record.findUnique({ where: { id: sol.recordId } })).estado, "IN_SOSPESO", "reabierto");
    const hist = await api("GET", `/cambios?recordId=${sol.recordId}`, { token: ownerToken });
    assert.ok(hist.body.data.items.some((i) => i.hito && /se reabrió/.test(i.nuevo)));
    // Un servicio anulado a mano por la oficina (sin marca de anulacion de Piazza) NO se reabre porque llegue un reenvio.
    const b = await enviar({ recordId: "pz-an-oficina", codigo: "P-AN4", destinazione: "Via Oficina 4, Milano", eta: "2026-11-27T13:00:00Z" });
    const sb = await esperarAceptada(b.body.data.id);
    await prisma.record.update({ where: { id: sb.recordId }, data: { estado: "ANNULLATO" } });
    await enviar({ recordId: "pz-an-oficina", codigo: "P-AN4", destinazione: "Via Oficina 4, Milano", eta: "2026-11-27T13:00:00Z", note: "cambio" });
    assert.equal((await prisma.record.findUnique({ where: { id: sb.recordId } })).estado, "ANNULLATO");
  });

  test("al arrancar, los servicios que Piazza ya habia anulado y siguen Pendientes pasan a Anulado", async () => {
    const { getSinAsignar } = await import("../src/services/sinAsignar.service.js");
    const { driverId, vehicleId } = await getSinAsignar();
    const cli = await prisma.client.findFirst({ where: { nombre: "Piazza Spedizioni" } });
    const mk = async (clave, hitos) => {
      const rec = await prisma.record.create({
        data: { driverId, vehicleId, clientId: cli.id, descripcion: "d", codigo: `REC-${clave}`, destinazione: "Via Vieja 1, Milano", fechaServicio: new Date("2026-11-28T00:00:00Z"), eta: new Date("2026-11-28T09:00:00Z"), spedizzione: "EXTRA_PIAZZA", extrasPiazzaZona: "MILANO" },
      });
      const sol = await prisma.solicitudServicio.create({
        data: { servicio: "EXTRA_PIAZZA", zona: "MILANO", cliente: "X", destinazione: "Via Vieja 1, Milano", fechaHora: new Date("2026-11-28T09:00:00Z"), fornitore: "Gamonal", empresaId: col.clientId, creadoPorId: owner.id, collegamentoId: col.id, recordRemotoId: `pz-rec-${clave}`, estado: "ACEPTADA", recordId: rec.id },
      });
      let t = Date.now() - 60_000;
      for (const campo of hitos) await prisma.cambioServicio.create({ data: { solicitudId: sol.id, recordId: rec.id, campo, nuevo: campo, editorId: col.id, editorNombre: "App Piazza", createdAt: new Date((t += 1000)) } });
      return rec;
    };
    const anulado = await mk("a", ["app_ricevuto", "app_annullata"]);
    const reasignado = await mk("b", ["app_ricevuto", "app_annullata", "app_ricevuto"]);
    const normal = await mk("c", ["app_ricevuto"]);
    const { reconciliarAnuladosConectados } = await import("../src/services/collegamento.service.js");
    assert.equal(await reconciliarAnuladosConectados(), 1);
    assert.equal((await prisma.record.findUnique({ where: { id: anulado.id } })).estado, "ANNULLATO");
    assert.equal((await prisma.record.findUnique({ where: { id: reasignado.id } })).estado, "IN_SOSPESO", "si despues lo volvieron a asignar, no");
    assert.equal((await prisma.record.findUnique({ where: { id: normal.id } })).estado, "IN_SOSPESO");
    assert.equal(await reconciliarAnuladosConectados(), 0, "repetirlo no cambia nada");
  });

  test("al arrancar, las solicitudes de apps conectadas que quedaron pendientes pasan al Registro", async () => {
    const solicitud = await prisma.solicitudServicio.create({
      data: { servicio: "EXTRA_PIAZZA", zona: "MILANO", cliente: "HP", destinazione: "Via Pendiente 7, Milano", fechaHora: new Date("2026-11-25T09:00:00Z"), fornitore: "Gamonal", empresaId: col.clientId, creadoPorId: owner.id, collegamentoId: col.id, recordRemotoId: "pz-viejo" },
    });
    const { convertirSolicitudesConectadasPendientes } = await import("../src/services/collegamento.service.js");
    aggiornamenti.length = 0;
    assert.ok((await convertirSolicitudesConectadasPendientes()) >= 1);
    const despues = await prisma.solicitudServicio.findUnique({ where: { id: solicitud.id } });
    assert.equal(despues.estado, "ACEPTADA");
    assert.ok(despues.recordId);
    await esperar(() => aggiornamenti.some((b) => b.recordId === "pz-viejo" && b.tipo === "ACCETTATO"));
  });
});
