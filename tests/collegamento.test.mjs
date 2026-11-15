// Protocolo de "App collegate" de Gamonal (lado que RECIBE los servicios de App Piazza).
//  - Pruebas puras (sin base): estado que se avisa, mapeo de solicitud, comparacion del segreto, cifrado.
//  - Pruebas con base: arrancan la API de verdad contra una base LOCAL de prueba y una "Piazza" simulada (servidor http).
//    Solo corren con GAMONAL_TEST_DATABASE_URL apuntando a localhost (nunca a una base real):
//      GAMONAL_TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gamonal_test node --test tests/
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
});

const { datiAggiornamento, ESPERAS_MS, chiamaConRiprova, stessiDati, stessoHash, sha256 } = await import("../src/services/collegamentoInvio.service.js");
const { datiSolicitud, stessoSegreto } = await import("../src/services/collegamento.service.js");
const { decryptSecret, encryptSecret } = await import("../src/utils/secretBox.js");

describe("collegamento: piezas puras", () => {
  const rec = (estado, driver = { nombre: "Ana", apellido: "Rossi", correoElectronico: "a@x.it" }, targa = "AB123CD") => ({ estado, driver, vehicle: { targa } });

  test("avisa solo estado, nombre del chofer y targa (nada mas)", () => {
    const d = datiAggiornamento({ ...rec("RITIRATO"), precio: 99, driver: { nombre: "Ana", apellido: "Rossi", correoElectronico: "a@x.it", numeroCelular: "123" } });
    assert.deepEqual(Object.keys(d).sort(), ["autista", "estado", "targa"]);
    assert.deepEqual(d, { estado: "RITIRATO", autista: "Ana Rossi", targa: "AB123CD" });
  });

  test("las fichas internas 'Sin asignar' cuentan como vacio", () => {
    const d = datiAggiornamento(rec("IN_SOSPESO", { nombre: "Sin", apellido: "asignar", correoElectronico: "sin-asignar@sistema.interno" }, "SIN-ASIGNAR"));
    assert.deepEqual(d, { estado: "IN_SOSPESO", autista: null, targa: null });
  });

  test("el estado solo avanza hacia adelante (IN_SOSPESO < RITIRATO < IN_CONSEGNA < CONSEGNATO)", () => {
    assert.equal(datiAggiornamento(rec("RITIRATO"), { estado: "IN_CONSEGNA" }).estado, "IN_CONSEGNA");
    assert.equal(datiAggiornamento(rec("IN_SOSPESO"), { estado: "CONSEGNATO" }).estado, "CONSEGNATO");
    assert.equal(datiAggiornamento(rec("CONSEGNATO"), { estado: "RITIRATO" }).estado, "CONSEGNATO");
    assert.equal(datiAggiornamento(rec("IN_CONSEGNA"), null).estado, "IN_CONSEGNA");
  });

  test("ANNULLATO y RISCHEDULATO se mandan tal cual (no son parte del orden)", () => {
    assert.equal(datiAggiornamento(rec("ANNULLATO"), { estado: "IN_CONSEGNA" }).estado, "ANNULLATO");
    assert.equal(datiAggiornamento(rec("RISCHEDULATO"), { estado: "RITIRATO" }).estado, "RISCHEDULATO");
  });

  test("comparar lo ya avisado no depende del orden de las claves (jsonb las reordena)", () => {
    const a = { estado: "RITIRATO", autista: "Ana", targa: "X1" };
    assert.equal(stessiDati(a, { targa: "X1", estado: "RITIRATO", autista: "Ana" }), true);
    assert.equal(stessiDati(a, { targa: "X2", estado: "RITIRATO", autista: "Ana" }), false);
    assert.equal(stessiDati({ estado: "IN_SOSPESO", autista: null, targa: null }, { estado: "IN_SOSPESO" }), true);
    assert.equal(stessiDati(a, null), false);
  });

  test("segreto: comparacion exacta; hash en tiempo constante", () => {
    assert.equal(stessoSegreto("AB12-CD34", "AB12-CD34"), true);
    assert.equal(stessoSegreto("AB12-CD35", "AB12-CD34"), false);
    assert.equal(stessoSegreto("", "AB12-CD34"), false);
    assert.equal(stessoSegreto(undefined, undefined), false);
    assert.equal(stessoHash("tok", sha256("tok")), true);
    assert.equal(stessoHash("tok2", sha256("tok")), false);
    assert.equal(stessoHash("", sha256("tok")), false);
    assert.equal(stessoHash("tok", null), false);
  });

  test("cifrado AES-256-GCM: ida y vuelta, y el texto cifrado no contiene el token", () => {
    const token = "t0ken-secreto-1234567890-abcdefghij";
    const c = encryptSecret(token);
    assert.ok(!c.includes(token));
    assert.equal(decryptSecret(c), token);
    assert.notEqual(encryptSecret(token), c);
  });

  test("solicitud: mercancia, remitente, paradas y notas van en la descripcion", () => {
    const d = datiSolicitud(
      { recordId: "r1", codigo: "C-1", cliente: "Farmacia Verdi", destinazione: "Via Roma 1, Milano", ritiro: "Via A 2", tappe: ["a", "b", "c"], eta: "2026-11-20T10:00:00Z", pesoKg: 12, colli: 3, mittente: "Bayer", note: "Fragile" },
      { remotoNome: "App Piazza" }
    );
    assert.equal(d.cliente, "Farmacia Verdi");
    assert.equal(d.shipment, "C-1");
    assert.equal(d.fechaHora.toISOString(), "2026-11-20T10:00:00.000Z");
    assert.match(d.descripcion, /Mittente: Bayer/);
    assert.match(d.descripcion, /Merce: 12 kg · 3 colli/);
    assert.match(d.descripcion, /Tappe: a → b → c/);
    assert.match(d.descripcion, /Fragile/);
  });

  test("reintentos: transitorio se reintenta con espera creciente, permanente no", async () => {
    assert.deepEqual(ESPERAS_MS, [2000, 8000, 30000]);
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n < 3) throw Object.assign(new Error("duerme"), { riprova: true });
      return { ok: true };
    };
    assert.deepEqual(await chiamaConRiprova({}, "/x", {}, { esperas: [1, 1, 1], chiama: flaky }), { ok: true });
    assert.equal(n, 3);
    let m = 0;
    const permanent = async () => {
      m += 1;
      throw Object.assign(new Error("401"), { riprova: false });
    };
    await assert.rejects(chiamaConRiprova({}, "/x", {}, { esperas: [1, 1, 1], chiama: permanent }), /401/);
    assert.equal(m, 1);
    let k = 0;
    const siempre = async () => {
      k += 1;
      throw Object.assign(new Error("caido"), { riprova: true });
    };
    await assert.rejects(chiamaConRiprova({}, "/x", {}, { esperas: [1, 1, 1], chiama: siempre }), /caido/);
    assert.equal(k, 4);
  });
});

describe("collegamento: protocolo completo (base local + Piazza simulada)", { skip: !dbOk && "falta GAMONAL_TEST_DATABASE_URL (localhost)" }, () => {
  let server, base, piazza, piazzaUrl, prisma, ownerToken, owner, cliente;
  const recibido = []; // lo que "Piazza" recibe de Gamonal
  let piazzaFalla = 0; // cuantas respuestas 503 da antes de responder bien
  const T1 = "T1-token-de-piazza-para-gamonal-123456";

  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const oficina = (method, path, body) => api(method, path, { token: ownerToken, body });

  before(async () => {
    const { default: app } = await import("../src/app.js");
    ({ prisma } = await import("../src/config/prisma.js"));
    const { signToken } = await import("../src/utils/jwt.js");
    await prisma.$executeRawUnsafe('TRUNCATE "collegamenti","solicitudes_servicio","records","clients","vehiculos","users","configuracion" RESTART IDENTITY CASCADE');
    owner = await prisma.user.create({
      data: { nombre: "Olga", apellido: "Owner", area: "DHL", cargo: "OWNER", fechaNacimiento: new Date("1980-01-01"), numeroCelular: "1", correoElectronico: "owner@test.it", password: "x" },
    });
    ownerToken = signToken({ sub: owner.id });
    cliente = await prisma.client.create({ data: { nombre: "Piazza Spedizioni" } });
    server = createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
    // "Piazza": responde a /esito, /aggiornamentos y /scollega, y guarda lo que recibe.
    piazza = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        recibido.push({ url: req.url, auth: req.headers.authorization, body: data ? JSON.parse(data) : null });
        if (piazzaFalla > 0 && req.url.endsWith("/aggiornamenti")) {
          piazzaFalla -= 1;
          res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ success: false, message: "duerme" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, data: { ok: true } }));
      });
    });
    await new Promise((r) => piazza.listen(0, r));
    piazzaUrl = `http://localhost:${piazza.address().port}`;
  });

  after(async () => {
    server?.close();
    piazza?.close();
    await prisma?.$disconnect();
  });

  let segreto, collegamentoId, T2;
  const servizio = (extra = {}) => ({ recordId: "rec-1", codigo: "P-100", cliente: "Farmacia Verdi", destinazione: "Via Roma 1, Milano", eta: "2026-11-20T10:00:00Z", ciudad: "Milano", ...extra });

  test("solo el Owner ve el codigo; formato XXXX-XXXX@host", async () => {
    assert.equal((await api("GET", "/collegamenti")).status, 401);
    const r = await oficina("GET", "/collegamenti");
    assert.equal(r.status, 200);
    assert.match(r.body.data.codice, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}@/);
    segreto = r.body.data.codice.split("@")[0];
    assert.ok(new Date(r.body.data.scadeAt) > new Date());
  });

  test("/richiesta: segreto malo -> 403 generico; sin mas datos no crea nada", async () => {
    const r = await api("POST", "/collegamenti/pubblico/richiesta", { body: { segreto: "ZZZZ-ZZZZ", idRemoto: "p-1", url: piazzaUrl, nome: "App Piazza", token: T1 } });
    assert.equal(r.status, 403);
    assert.equal(await prisma.collegamento.count(), 0);
  });

  test("/richiesta valida: crea DA_APPROVARE con el token cifrado; idempotente; el codigo queda usado", async () => {
    const cuerpo = { segreto, idRemoto: "p-1", url: piazzaUrl, nome: "App Piazza", partitaIva: "IT123", token: T1 };
    const r = await api("POST", "/collegamenti/pubblico/richiesta", { body: cuerpo });
    assert.equal(r.status, 201);
    assert.ok(r.body.data.id && r.body.data.nome);
    collegamentoId = r.body.data.id;
    const fila = await prisma.collegamento.findUnique({ where: { id: collegamentoId } });
    assert.equal(fila.stato, "DA_APPROVARE");
    assert.equal(fila.ruolo, "CLIENTE");
    assert.ok(!fila.tokenUscente.includes(T1), "el token saliente va cifrado");
    assert.equal(decryptSecret(fila.tokenUscente), T1);
    // Idempotente por (url, idRemoto): mismo id, sin duplicar.
    const otra = await api("POST", "/collegamenti/pubblico/richiesta", { body: { ...cuerpo, segreto: "ZZZZ-ZZZZ" } });
    // el codigo ya se uso: aun sabiendo el idRemoto, sin codigo nuevo no entra
    assert.equal(otra.status, 403);
    assert.equal(await prisma.collegamento.count(), 1);
    // Codigo usado: ya no vale (un solo uso) y se genero otro distinto.
    const reuse = await api("POST", "/collegamenti/pubblico/richiesta", { body: { ...cuerpo, idRemoto: "p-2" } });
    assert.equal(reuse.status, 403);
    const nuevo = (await oficina("GET", "/collegamenti")).body.data.codice.split("@")[0];
    assert.notEqual(nuevo, segreto);
    // Reintento del mismo (url, idRemoto) con el codigo nuevo: devuelve la misma fila.
    const idem = await api("POST", "/collegamenti/pubblico/richiesta", { body: { ...cuerpo, segreto: nuevo } });
    assert.equal(idem.status, 201);
    assert.equal(idem.body.data.id, collegamentoId);
    assert.equal(await prisma.collegamento.count(), 1);
  });

  test("/richiesta: codigo caducado -> 403; direccion privada en produccion se rechaza (urlValida)", async () => {
    await prisma.configuracion.update({ where: { clave: "collegamento.codice" }, data: { valor: { segreto: "AAAA-BBBB", creadoAt: new Date(Date.now() - 25 * 3600_000).toISOString() } } });
    const r = await api("POST", "/collegamenti/pubblico/richiesta", { body: { segreto: "AAAA-BBBB", idRemoto: "p-9", url: piazzaUrl, nome: "X", token: T1 } });
    assert.equal(r.status, 403);
    const { urlValida } = await import("../src/utils/codiceCollegamento.js");
    assert.throws(() => urlValida("http://192.168.1.5:4000", { produzione: true }));
    assert.throws(() => urlValida("https://localhost", { produzione: true }));
    assert.throws(() => urlValida("https://otra-app.example.com", { produzione: true, hostPermessi: ["app-piazza.onrender.com"] }));
    // Caduco: el estado lo regenera y Owner ve uno nuevo.
    const nuevo = (await oficina("GET", "/collegamenti")).body.data;
    assert.notEqual(nuevo.codice.split("@")[0], "AAAA-BBBB");
  });

  test("solo el Owner acepta; al aceptar se avisa a Piazza con T2 y queda ATTIVO (solo si Piazza responde OK)", async () => {
    const noOwner = await prisma.user.create({
      data: { nombre: "Adm", apellido: "In", area: "DHL", cargo: "ADMIN", fechaNacimiento: new Date("1990-01-01"), numeroCelular: "2", correoElectronico: "admin@test.it", password: "x" },
    });
    const { signToken } = await import("../src/utils/jwt.js");
    const adm = await api("POST", `/collegamenti/${collegamentoId}/accetta`, { token: signToken({ sub: noOwner.id }), body: { clientId: cliente.id } });
    assert.equal(adm.status, 403);
    const r = await oficina("POST", `/collegamenti/${collegamentoId}/accetta`, { clientId: cliente.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.collegamento.stato, "ATTIVO");
    const esito = recibido.find((x) => x.url.endsWith("/p-1/esito"));
    assert.ok(esito, "Piazza recibio /esito");
    assert.equal(esito.auth, `Bearer ${T1}`);
    assert.equal(esito.body.esito, "ACCETTATO");
    T2 = esito.body.token;
    assert.ok(T2 && T2.length >= 40);
    const fila = await prisma.collegamento.findUnique({ where: { id: collegamentoId } });
    assert.equal(fila.tokenEntranteHash, sha256(T2));
    assert.equal(fila.clientId, cliente.id);
    assert.equal(JSON.stringify(fila).includes(T2), false, "T2 nunca se guarda en claro");
  });

  test("401 IDENTICO para id inexistente y token malo; sin Bearer tambien", async () => {
    const malo = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: "token-falso-token-falso-token-falso", body: servizio() });
    const inexistente = await api("POST", "/collegamenti/pubblico/no-existe/servizi", { token: T2, body: servizio() });
    const sin = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { body: servizio() });
    assert.equal(malo.status, 401);
    assert.equal(malo.text, inexistente.text);
    assert.equal(malo.text, sin.text);
    assert.equal(inexistente.status, 401);
  });

  test("no hay ningun GET para Piazza y /servizi valida el cuerpo (zod)", async () => {
    for (const ruta of [`/collegamenti/pubblico/${collegamentoId}/servizi`, `/collegamenti/pubblico/${collegamentoId}`, "/collegamenti/pubblico/richiesta"]) {
      const r = await api("GET", ruta, { token: T2 });
      assert.ok([401, 404].includes(r.status), `GET ${ruta} -> ${r.status}`);
    }
    const mal = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: { recordId: "x", destinazione: "y" } });
    assert.equal(mal.status, 400);
  });

  test("/servizi: crea una solicitud PENDIENTE (nunca un Record); reenvio actualiza; avisa a la oficina", async () => {
    const r = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio() });
    assert.equal(r.status, 200, r.text);
    const s = await prisma.solicitudServicio.findUnique({ where: { id: r.body.data.id } });
    assert.equal(s.estado, "PENDIENTE");
    assert.equal(s.collegamentoId, collegamentoId);
    assert.equal(s.recordRemotoId, "rec-1");
    assert.equal(s.empresaId, cliente.id);
    assert.equal(s.recordId, null);
    assert.equal(await prisma.record.count(), 0);
    // Reenvio con otra direccion: misma fila, actualizada.
    const again = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ destinazione: "Via Nuova 5, Milano" }) });
    assert.equal(again.body.data.id, r.body.data.id);
    assert.equal((await prisma.solicitudServicio.findUnique({ where: { id: r.body.data.id } })).destinazione, "Via Nuova 5, Milano");
    assert.equal(await prisma.solicitudServicio.count(), 1);
    // La oficina la ve en la bandeja con el origen.
    const lista = await oficina("GET", "/solicitudes");
    assert.equal(lista.body.data.items[0].origen.empresa, "App Piazza");
  });

  test("annulla con la solicitud PENDIENTE: pasa a RECHAZADA 'Annullata da ...'; si se reasigna vuelve a PENDIENTE", async () => {
    const a = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi/rec-1/annulla`, { token: T2, body: { motivo: "cambio de plan" } });
    assert.equal(a.status, 200);
    let s = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-1" } });
    assert.equal(s.estado, "RECHAZADA");
    assert.match(s.motivoRechazo, /^Annullata da Piazza Spedizioni: cambio de plan/);
    await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio() });
    s = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-1" } });
    assert.equal(s.estado, "PENDIENTE");
    assert.equal(s.motivoRechazo, null);
    // annulla de un servicio que no existe: ok sin hacer nada
    assert.equal((await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi/no/annulla`, { token: T2, body: {} })).body.data.ok, true);
  });

  test("rechazar desde la oficina avisa a Piazza (RIFIUTATO con motivo)", async () => {
    const otro = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-rech", destinazione: "Via X 1" }) });
    recibido.length = 0;
    const r = await oficina("POST", `/solicitudes/${otro.body.data.id}/rechazar`, { motivo: "sin chofer" });
    assert.equal(r.status, 200, r.text);
    await new Promise((res) => setTimeout(res, 300));
    const msg = recibido.find((x) => x.url.endsWith("/p-1/aggiornamenti"));
    assert.ok(msg);
    assert.deepEqual(msg.body, { recordId: "rec-rech", tipo: "RIFIUTATO", motivo: "sin chofer" });
    assert.equal(msg.auth, `Bearer ${T1}`);
  });

  test("aceptar: Piazza recibe ACCETTATO y luego estado/chofer/targa (solo eso); no se repite si nada cambio", async () => {
    const veh = await prisma.vehiculo.create({ data: { targa: "GA111AA", modelo: "Ducato", area: "DHL" } });
    const chofer = await prisma.user.create({
      data: { nombre: "Carlos", apellido: "Perez", area: "DHL", cargo: "CHOFER", fechaNacimiento: new Date("1985-01-01"), numeroCelular: "55512345", correoElectronico: "carlos@test.it", password: "x" },
    });
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-1" } });
    const record = await prisma.record.create({
      data: { driverId: chofer.id, vehicleId: veh.id, clientId: cliente.id, fechaServicio: new Date("2026-11-20"), eta: new Date("2026-11-20T10:00:00Z"), descripcion: "d", codigo: "GT-1", destinazione: sol.destinazione },
    });
    const { linkSolicitudToRecord } = await import("../src/services/solicitud.service.js");
    recibido.length = 0;
    assert.equal(await linkSolicitudToRecord(owner, sol.id, record.id), true);
    await new Promise((res) => setTimeout(res, 600));
    const msgs = recibido.filter((x) => x.url.endsWith("/p-1/aggiornamenti")).map((x) => x.body);
    assert.deepEqual(msgs[0], { recordId: "rec-1", tipo: "ACCETTATO" });
    assert.deepEqual(msgs[1], { recordId: "rec-1", tipo: "AGGIORNAMENTO", estado: "IN_SOSPESO", autista: "Carlos Perez", targa: "GA111AA" });
    assert.ok(!JSON.stringify(msgs).includes("55512345") && !JSON.stringify(msgs).includes("carlos@test.it"), "no se manda telefono ni correo");
    // Sin cambios no se manda otra vez.
    const { sincronizza } = await import("../src/services/collegamentoInvio.service.js");
    recibido.length = 0;
    assert.equal((await sincronizza({ recordId: record.id })).inviato, false);
    assert.equal(recibido.length, 0);
    // Cambia el estado: se manda; el estado no retrocede.
    await prisma.record.update({ where: { id: record.id }, data: { estado: "IN_CONSEGNA" } });
    assert.equal((await sincronizza({ recordId: record.id })).inviato, true);
    assert.equal(recibido.at(-1).body.estado, "IN_CONSEGNA");
    await prisma.record.update({ where: { id: record.id }, data: { estado: "RITIRATO" } });
    assert.equal((await sincronizza({ recordId: record.id })).inviato, false, "retroceder no se avisa");
    await prisma.record.update({ where: { id: record.id }, data: { estado: "CONSEGNATO" } });
    await sincronizza({ recordId: record.id });
    assert.equal(recibido.at(-1).body.estado, "CONSEGNATO");
  });

  test("annulla con el servicio ya aceptado: NO se borra ni se anula el Record", async () => {
    const antes = await prisma.record.findFirst({ where: { codigo: "GT-1" } });
    const a = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi/rec-1/annulla`, { token: T2, body: { motivo: "x" } });
    assert.equal(a.status, 200);
    const despues = await prisma.record.findFirst({ where: { codigo: "GT-1" } });
    assert.equal(despues.estado, antes.estado);
    assert.equal((await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-1" } })).estado, "ACEPTADA");
  });

  test("un fallo de Piazza no rompe la operacion: queda el error visible y 'Reinvia' lo reenvia", async () => {
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-1" } });
    const { sincronizza } = await import("../src/services/collegamentoInvio.service.js");
    piazzaFalla = 99;
    await assert.rejects(sincronizza({ solicitudId: sol.id }, { forzar: true, esperas: [1, 1, 1] }), /L'altra app/);
    await new Promise((res) => setTimeout(res, 200));
    let fila = await prisma.collegamento.findUnique({ where: { id: collegamentoId } });
    assert.match(fila.ultimoErrore, /duerme/);
    assert.ok(fila.ultimoErroreAt);
    piazzaFalla = 0;
    const r = await oficina("POST", `/collegamenti/solicitudes/${sol.id}/reinvia`);
    assert.equal(r.status, 200, r.text);
    await new Promise((res) => setTimeout(res, 200));
    fila = await prisma.collegamento.findUnique({ where: { id: collegamentoId } });
    assert.equal(fila.ultimoErrore, null);
  });

  test("limitador: tantos 401 desde la misma IP terminan en 429", async () => {
    let ultimo = 0;
    for (let i = 0; i < 40; i += 1) {
      ultimo = (await api("POST", `/collegamenti/pubblico/${collegamentoId}/scollega`, { token: "falso-falso-falso-falso-falso-falso" })).status;
      if (ultimo === 429) break;
    }
    assert.equal(ultimo, 429);
    // Con 429 en curso, ni el token bueno pasa desde esa IP (la ventana es de 15 min por IP, solo cuentan los fallos).
  });

  test("scollega de Piazza borra la fila; el historial de solicitudes se conserva", async () => {
    // El limitador anterior bloquea esta IP: se prueba directo contra el servicio.
    const { riceviScollega } = await import("../src/services/collegamento.service.js");
    await riceviScollega(await prisma.collegamento.findUnique({ where: { id: collegamentoId } }));
    assert.equal(await prisma.collegamento.count(), 0);
    assert.ok((await prisma.solicitudServicio.count()) >= 1);
  });
});
