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

describe("App collegate: servicios directo al Registro (base local + Piazza simulada)", { skip: !dbOk && "falta GAMONAL_TEST_DATABASE_URL (localhost)" }, () => {
  let server, base, piazza, prisma, ownerToken, owner, col, choferA, vehA;
  const T1 = "T1-token-de-piazza-para-gamonal-123456";
  const T2 = "T2-token-de-gamonal-para-piazza-123456";
  const aggiornamenti = [];

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
        if (req.url.endsWith("/aggiornamenti")) aggiornamenti.push(JSON.parse(data));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, data: { ok: true } }));
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
    assert.equal(record.estado, "IN_SOSPESO");
    assert.equal(record.fechaServicio.toISOString().slice(0, 10), "2026-11-24", "el dia del servicio es el de su ETA");
    // Ya no hay nada que aceptar a mano.
    const pendientes = await api("GET", "/solicitudes?estado=PENDIENTE", { token: ownerToken });
    assert.equal(pendientes.body.data.items.length, 0);
    // Esta en la lista del dia y en "Por asignar".
    const dia = await api("GET", "/records/2026/11/24", { token: ownerToken });
    assert.ok(dia.body.data.records.some((x) => x.id === record.id), "esta en la lista de servicios del dia");
    const sinAsignar = await api("GET", "/records/sin-asignar", { token: ownerToken });
    assert.ok(sinAsignar.body.data.records.some((x) => x.id === record.id), "esta en Por asignar");
    assert.equal(dia.body.data.records.find((x) => x.id === record.id).origenApp, "App Piazza", "con la insignia 'Da App Piazza'");
  });

  test("a Piazza se le avisa enseguida que quedo aceptado (todavia sin chofer ni targa)", async () => {
    await esperar(() => aggiornamenti.some((b) => b.tipo === "ACCETTATO"));
    assert.deepEqual(aggiornamenti.find((b) => b.tipo === "ACCETTATO"), { recordId: "pz-1", tipo: "ACCETTATO" });
    const aggiornamento = await esperar(() => aggiornamenti.find((b) => b.tipo === "AGGIORNAMENTO"));
    assert.equal(aggiornamento.estado, "IN_SOSPESO");
    assert.equal(aggiornamento.autista ?? null, null);
    assert.equal(aggiornamento.targa ?? null, null);
  });

  test("el Responsable elige chofer y vehiculo y Piazza recibe su nombre y targa", async () => {
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "pz-1" } });
    aggiornamenti.length = 0;
    const r = await api("PATCH", `/records/${sol.recordId}`, { token: ownerToken, body: { driverId: choferA.id, vehicleId: vehA.id } });
    assert.equal(r.status, 200, r.text);
    const msg = await esperar(() => aggiornamenti.find((b) => b.autista));
    assert.deepEqual(msg, { recordId: "pz-1", tipo: "AGGIORNAMENTO", estado: "IN_SOSPESO", autista: "Carlos Test", targa: "GA111AA" });
    const sinAsignar = await api("GET", "/records/sin-asignar", { token: ownerToken });
    assert.ok(!sinAsignar.body.data.records.some((x) => x.id === sol.recordId), "ya no esta en Por asignar");
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
