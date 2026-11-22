// Protocolo de "App collegate" de Gamonal (lado que RECIBE los servicios de App Piazza).
//  - Pruebas puras (sin base): estado que se avisa, mapeo de solicitud, comparacion del segreto, cifrado.
//  - Pruebas con base: arrancan la API de verdad contra una base LOCAL de prueba y una "Piazza" simulada (servidor http).
//    Solo corren con GAMONAL_TEST_DATABASE_URL apuntando a localhost (nunca a una base real):
//      GAMONAL_TEST_DATABASE_URL=postgresql://postgres@localhost:54329/gamonal_test node --test tests/
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { z } from "zod";

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
  // Estas pruebas recorren el camino de la bandeja de Solicitudes; el paso directo al Registro tiene las suyas (collegamentoAuto.test.mjs).
  COLLEGAMENTI_AUTO_ACEPTAR: "false",
});

const { datiAggiornamento, ESPERAS_MS, chiamaConRiprova, stessiDati, stessoHash, sha256 } = await import("../src/services/collegamentoInvio.service.js");
const { datiSolicitud, stessoSegreto } = await import("../src/services/collegamento.service.js");
const { confronta, normalizzaDati } = await import("../src/services/collegamentoCambi.service.js");
const { LIMITES_VIVO, aServizioVivo, esDireccionUtil, recorta } = await import("../src/services/collegamentoVivo.service.js");

// Contrato con App Piazza. /aggiornamenti: el esquema que Piazza valida al recibir (copia del suyo). /vivo: la forma y los limites del documento del protocolo.
const txt = (max) => z.string().trim().max(max);
const esquemaAggiornamento = z.object({
  recordId: z.string().trim().min(1).max(100),
  tipo: z.enum(["ACCETTATO", "RIFIUTATO", "AGGIORNAMENTO"]),
  motivo: txt(500).nullish(),
  estado: z.enum(["IN_SOSPESO", "RITIRATO", "IN_CONSEGNA", "CONSEGNATO", "ANNULLATO", "RISCHEDULATO"]).nullish(),
  autista: txt(200).nullish(),
  targa: txt(30).nullish(),
});
const esquemaVivo = z.object({
  servizi: z
    .array(
      z
        .object({
          id: z.string().min(1).max(100),
          codigo: z.string().max(100),
          estado: z.enum(["IN_SOSPESO", "RITIRATO", "IN_CONSEGNA"]),
          destino: z.string().min(1).max(300),
          ritiro: z.string().max(300).optional(),
          eta: z.string().datetime(),
          cliente: z.string().max(150).optional(),
          autista: z.string().max(120).optional(),
          targa: z.string().max(30).optional(),
          area: z.string().max(60).optional(),
          daPiazza: z.string().max(100).optional(),
          gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), rumbo: z.number().min(0).max(360).optional(), actualizada: z.string().datetime() }).strict().optional(),
        })
        .strict()
    )
    .max(300),
});
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

  test("avisa el estado actual del registro", () => {
    for (const estado of ["IN_SOSPESO", "RITIRATO", "IN_CONSEGNA", "CONSEGNATO", "ANNULLATO", "RISCHEDULATO"]) {
      assert.equal(datiAggiornamento(rec(estado)).estado, estado);
    }
  });

  test("/vivo: textos recortados a los limites del contrato; gps solo valido y con fecha real", () => {
    assert.deepEqual(LIMITES_VIVO, { id: 100, codigo: 100, destino: 300, ritiro: 300, cliente: 150, autista: 120, targa: 30, area: 60 });
    assert.equal(recorta("x".repeat(500), 300).length, 300);
    assert.equal(recorta("  hola  ", 10), "hola");
    const largo = "z".repeat(400);
    const s = { id: largo, codigo: largo, estado: "IN_CONSEGNA", etaPlan: "2026-11-19T10:56:00Z", cliente: largo, tipoLabel: largo, vehiculo: largo, chofer: { nombre: largo }, gps: { lat: 45.4, lng: 9.2, rumbo: 120, actualizada: "2026-11-19T10:31:00Z", velocidad: 50, motor: true } };
    const r = aServizioVivo(s, { da: { recordRemotoId: largo, ritiro: largo }, destino: largo });
    assert.equal(r.id.length, 100);
    assert.equal(r.codigo.length, 100);
    assert.equal(r.destino.length, 300);
    assert.equal(r.ritiro.length, 300);
    assert.equal(r.cliente.length, 150);
    assert.equal(r.autista.length, 120);
    assert.equal(r.targa.length, 30);
    assert.equal(r.area.length, 60);
    assert.equal(r.daPiazza.length, 100);
    assert.deepEqual(r.gps, { lat: 45.4, lng: 9.2, rumbo: 120, actualizada: "2026-11-19T10:31:00.000Z" });
    const sinGps = (gps) => "gps" in aServizioVivo({ ...s, gps }, { destino: "Via A 1" });
    assert.equal(sinGps({ lat: 45, lng: 9, actualizada: null }), false, "sin fecha no se manda");
    assert.equal(sinGps({ lat: 45, lng: 9, actualizada: "no-es-fecha" }), false);
    assert.equal(sinGps({ lat: 95, lng: 9, actualizada: "2026-11-19T10:31:00Z" }), false, "latitud imposible");
    assert.equal(sinGps({ lat: null, lng: 9, actualizada: "2026-11-19T10:31:00Z" }), false);
    assert.equal(sinGps({ fuente: "SIMULADO", lat: 45, lng: 9, actualizada: "2026-11-19T10:31:00Z" }), false);
    assert.equal("rumbo" in aServizioVivo({ ...s, gps: { ...s.gps, rumbo: 400 } }, { destino: "Via A 1" }).gps, false, "rumbo fuera de 0-360 se omite");
    assert.equal("rumbo" in aServizioVivo({ ...s, gps: { ...s.gps, rumbo: null } }, { destino: "Via A 1" }).gps, false);
  });

  test("/vivo: un destino como 'Giro (2 tappe)' no es una direccion", () => {
    assert.equal(esDireccionUtil("Giro (2 tappe)"), false);
    assert.equal(esDireccionUtil("  giro (4 tappe)"), false);
    assert.equal(esDireccionUtil(""), false);
    assert.equal(esDireccionUtil(null), false);
    assert.equal(esDireccionUtil("Via Italia 9, 20900 Monza MB"), true);
  });

  test("comparar lo ya avisado no depende del orden de las claves (jsonb las reordena)", () => {
    const a = { estado: "RITIRATO", autista: "Ana", targa: "X1" };
    assert.equal(stessiDati(a, { targa: "X1", estado: "RITIRATO", autista: "Ana" }), true);
    assert.equal(stessiDati(a, { targa: "X2", estado: "RITIRATO", autista: "Ana" }), false);
    assert.equal(stessiDati({ estado: "IN_SOSPESO", autista: null, targa: null }, { estado: "IN_SOSPESO" }), true);
    assert.equal(stessiDati(a, null), false);
  });

  test("cambios de la otra app: solo lo que cambio, con valores legibles", () => {
    const base = { recordId: "r", codigo: "P-1", cliente: "Farmacia", destinazione: "Via Roma 1", ritiro: "Via A", tappe: ["a", "b"], eta: "2026-11-20T10:00:00Z", pesoKg: 5, colli: 2, note: "x" };
    const antes = normalizzaDati(base);
    assert.deepEqual(confronta(antes, normalizzaDati(base)), [], "igual = sin cambios");
    assert.deepEqual(confronta(null, normalizzaDati(base)), [], "sin antes no hay nada que comparar");
    const c = confronta(antes, normalizzaDati({ ...base, destinazione: "Via Dante 5", eta: "2026-11-20T12:30:00Z", pesoKg: 7, note: null, tappe: ["a", "b", "c"] }));
    const por = Object.fromEntries(c.map((x) => [x.campo, x]));
    assert.deepEqual(Object.keys(por).sort(), ["app_destinazione", "app_fecha", "app_note", "app_peso", "app_tappe"]);
    assert.deepEqual(confronta(normalizzaDati({ ...base, tappe: ["a"] }), normalizzaDati({ ...base, tappe: ["b"] })), [], "con una parada no duplica la direccion de entrega");
    assert.equal(por.app_destinazione.anteriorVisible, "Via Roma 1");
    assert.equal(por.app_destinazione.nuevoVisible, "Via Dante 5");
    assert.equal(por.app_peso.nuevoVisible, "7 kg");
    assert.equal(por.app_note.nuevoVisible, null);
    assert.equal(por.app_tappe.nuevoVisible, "a → b → c");
    assert.match(por.app_fecha.anteriorVisible, /^20\/11 11:00$/, "hora de Roma");
    // espacios y vacios no cuentan como cambio
    assert.deepEqual(confronta(antes, normalizzaDati({ ...base, destinazione: "  Via Roma 1  ", ritiro: "Via A", tappe: ["a", "b", ""] })), []);
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
  const aggiornamentiTodos = []; // todos los /aggiornamenti que recibio, para comprobar el contrato
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
        if (req.url.endsWith("/aggiornamenti")) aggiornamentiTodos.push(JSON.parse(data));
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
    // El aviso lleva el estado persistido en Gamonal. Piazza decide si avanza su estado local.
    await prisma.record.update({ where: { id: record.id }, data: { estado: "IN_CONSEGNA" } });
    assert.equal((await sincronizza({ recordId: record.id })).inviato, true);
    assert.equal(recibido.at(-1).body.estado, "IN_CONSEGNA");
    await prisma.record.update({ where: { id: record.id }, data: { estado: "RITIRATO" } });
    assert.equal((await sincronizza({ recordId: record.id })).inviato, true);
    assert.equal(recibido.at(-1).body.estado, "RITIRATO");
    await prisma.record.update({ where: { id: record.id }, data: { estado: "CONSEGNATO" } });
    await sincronizza({ recordId: record.id });
    assert.equal(recibido.at(-1).body.estado, "CONSEGNATO");
  });

  test("cambios de Piazza con el servicio ya aceptado: linea de tiempo + alerta en 'Cambios'; el Record no se toca", async () => {
    const record = await prisma.record.findFirst({ where: { codigo: "GT-1" } });
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-1" } });
    // Lo ultimo que mando Piazza antes del cambio (la solicitud ya estaba aceptada).
    const antes = (await prisma.solicitudServicio.findUnique({ where: { id: sol.id } })).datosRemotos;
    assert.ok(antes, "se guarda lo que mando Piazza");
    // Sin cambios: nada.
    await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio() });
    const sinCambio = await prisma.cambioServicio.count({ where: { solicitudId: sol.id, campo: { startsWith: "app_" } } });
    const alertasAntes = await prisma.alertaCambio.count();
    // Piazza edita destino, hora y nota.
    const r = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ destinazione: "Via Verdi 9, Milano", eta: "2026-11-20T13:00:00Z", note: "Llamar antes" }) });
    assert.equal(r.status, 200, r.text);
    const filas = await prisma.cambioServicio.findMany({ where: { solicitudId: sol.id, campo: { startsWith: "app_" } }, orderBy: { createdAt: "asc" } });
    const nuevas = filas.slice(sinCambio);
    assert.deepEqual(nuevas.map((f) => f.campo).sort(), ["app_destinazione", "app_fecha", "app_note"]);
    assert.ok(nuevas.every((f) => f.editorNombre === "App Piazza" && f.recordId === record.id));
    assert.equal(nuevas.find((f) => f.campo === "app_destinazione").anterior, "Via Roma 1, Milano");
    assert.equal(nuevas.find((f) => f.campo === "app_destinazione").nuevo, "Via Verdi 9, Milano");
    // Alerta en "Cambios" para la oficina.
    assert.equal(await prisma.alertaCambio.count(), alertasAntes + 1);
    const alerta = await prisma.alertaCambio.findFirst({ orderBy: { createdAt: "desc" } });
    assert.equal(alerta.recordId, record.id);
    assert.equal(alerta.editorNombre, "App Piazza");
    assert.deepEqual(alerta.cambios.map((c) => c.label).sort(), ["Data / ETA", "Indirizzo di consegna", "Note"]);
    const lista = await oficina("GET", "/cambios");
    assert.equal(lista.body.data.items.some((a) => a.editor === "App Piazza"), true);
    // La linea de tiempo del servicio la trae (con el hito "Recibido") y el Record sigue igual.
    const hist = await oficina("GET", `/cambios?recordId=${record.id}`);
    const labels = hist.body.data.items.map((i) => i.label);
    assert.ok(labels.includes("Indirizzo di consegna") && labels.includes("Recibido"));
    assert.equal(hist.body.data.items.find((i) => i.label === "Recibido").hito, true);
    assert.equal((await prisma.record.findUnique({ where: { id: record.id } })).destinazione, record.destinazione);
    // Reenviar lo mismo (Reinvia de Piazza): no duplica nada.
    await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ destinazione: "Via Verdi 9, Milano", eta: "2026-11-20T13:00:00Z", note: "Llamar antes" }) });
    assert.equal(await prisma.cambioServicio.count({ where: { solicitudId: sol.id, campo: { startsWith: "app_" } } }), filas.length);
  });

  test("cambios de Piazza con el servicio todavia por aceptar: linea de tiempo en la solicitud (y la solicitud se actualiza)", async () => {
    const nueva = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-cambio", destinazione: "Via Uno 1" }) });
    await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-cambio", destinazione: "Via Due 2", ritiro: "Deposito Nord" }) });
    const lista = await oficina("GET", "/solicitudes");
    const item = lista.body.data.items.find((i) => i.id === nueva.body.data.id);
    assert.equal(item.destinazione, "Via Due 2");
    const campos = item.cambios.map((c) => c.label);
    assert.deepEqual(campos, ["Recibido", "Indirizzo di consegna", "Ritiro"].filter((l) => campos.includes(l)).length === 3 ? campos : ["?"]);
    assert.equal(item.cambios[0].hito, true);
    assert.equal(item.cambios.at(-1).editor, "App Piazza");
    assert.equal(await prisma.alertaCambio.count({ where: { recordId: nueva.body.data.id } }), 0, "sin servicio todavia no hay alerta de 'Cambios'");
  });

  test("km: alta con km, alta sin km (Piazza antiguo), y km invalido -> 400", async () => {
    const con = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-km", destinazione: "Via Km 1", km: 30 }) });
    assert.equal(con.status, 200, con.text);
    assert.equal((await prisma.solicitudServicio.findUnique({ where: { id: con.body.data.id } })).km, 30);
    const sin = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-sin-km", destinazione: "Via Sin 2" }) });
    assert.equal(sin.status, 200, sin.text);
    assert.equal((await prisma.solicitudServicio.findUnique({ where: { id: sin.body.data.id } })).km, null);
    const nulo = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-km-null", destinazione: "Via Null 3", km: null }) });
    assert.equal(nulo.status, 200, nulo.text);
    const cero = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-km-cero", destinazione: "Via Cero 4", km: 0 }) });
    assert.equal(cero.status, 200, cero.text);
    const cuenta = await prisma.solicitudServicio.count();
    for (const km of [-5, "abc", "30", 100001, {}]) {
      const r = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-km-mal", destinazione: "Via Mal 5", km }) });
      assert.equal(r.status, 400, `km ${JSON.stringify(km)} -> ${r.status}`);
    }
    assert.equal(await prisma.solicitudServicio.count(), cuenta, "un km invalido no crea nada");
    // La oficina lo ve en la bandeja.
    const lista = await oficina("GET", "/solicitudes");
    assert.equal(lista.body.data.items.find((i) => i.id === con.body.data.id).km, 30);
  });

  test("km: actualizacion en un servicio PENDIENTE (se guarda y queda en la linea de tiempo)", async () => {
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-km" } });
    await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-km", destinazione: "Via Km 1", km: 45.5 }) });
    const despues = await prisma.solicitudServicio.findUnique({ where: { id: sol.id } });
    assert.equal(despues.km, 45.5);
    assert.equal(despues.estado, "PENDIENTE");
    const fila = await prisma.cambioServicio.findFirst({ where: { solicitudId: sol.id, campo: "app_km" } });
    assert.equal(fila.anterior, "30 km");
    assert.equal(fila.nuevo, "45.5 km");
    // Si Piazza deja de mandar km, queda vacio (no se inventa).
    await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ recordId: "rec-km", destinazione: "Via Km 1" }) });
    assert.equal((await prisma.solicitudServicio.findUnique({ where: { id: sol.id } })).km, null);
  });

  test("km: con el servicio ya aceptado NO se sobrescribe el Record; se avisa (alerta + linea de tiempo) y los datos nuevos quedan en la fila", async () => {
    const record = await prisma.record.findFirst({ where: { codigo: "GT-1" } });
    const sol = await prisma.solicitudServicio.findFirst({ where: { recordRemotoId: "rec-1" } });
    const igual = { destinazione: "Via Verdi 9, Milano", eta: "2026-11-20T13:00:00Z", note: "Llamar antes" };
    await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ ...igual, km: 25 }) });
    const alertasAntes = await prisma.alertaCambio.findFirst({ where: { recordId: record.id }, orderBy: { updatedAt: "desc" } });
    const r = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi`, { token: T2, body: servizio({ ...igual, km: 31 }) });
    assert.equal(r.status, 200, r.text);
    const fila = await prisma.cambioServicio.findFirst({ where: { solicitudId: sol.id, campo: "app_km" }, orderBy: { createdAt: "desc" } });
    assert.equal(fila.anterior, "25 km");
    assert.equal(fila.nuevo, "31 km");
    assert.equal(fila.recordId, record.id);
    const alerta = await prisma.alertaCambio.findFirst({ where: { recordId: record.id }, orderBy: { updatedAt: "desc" } });
    assert.ok(alerta.cambios.some((c) => c.label === "Km pianificati" && c.nuevo === "31 km"));
    assert.ok(alerta.updatedAt >= alertasAntes.updatedAt);
    const despues = await prisma.record.findUnique({ where: { id: record.id } });
    assert.equal(despues.kilometros, record.kilometros, "el Record de Gamonal no se toca");
    const datos = (await prisma.solicitudServicio.findUnique({ where: { id: sol.id } })).datosRemotos;
    assert.equal(datos.app_km, "31");
    const hist = await oficina("GET", `/cambios?recordId=${record.id}`);
    const km = hist.body.data.items.find((i) => i.label === "Km pianificati");
    assert.equal(km.remoto, true);
  });

  test("annulla de Piazza con el servicio ya aceptado: queda en la linea de tiempo y hay alerta", async () => {
    const record = await prisma.record.findFirst({ where: { codigo: "GT-1" } });
    const antes = await prisma.alertaCambio.count();
    const a = await api("POST", `/collegamenti/pubblico/${collegamentoId}/servizi/rec-1/annulla`, { token: T2, body: { motivo: "cliente cancelo" } });
    assert.equal(a.status, 200);
    const fila = await prisma.cambioServicio.findFirst({ where: { recordId: record.id, campo: "app_annullata" } });
    assert.match(fila.nuevo, /^Anulado por App Piazza: cliente cancelo/);
    assert.ok((await prisma.alertaCambio.count()) >= antes, "alerta nueva o unida a la abierta");
    const alerta = await prisma.alertaCambio.findFirst({ where: { recordId: record.id }, orderBy: { updatedAt: "desc" } });
    assert.ok(alerta.cambios.some((c) => c.campo === "app_annullata"));
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

  // ---- /vivo: servicios en curso de Gamonal que Piazza puede pedir ----
  const vivo = (token = T2, id = collegamentoId) => api("POST", `/collegamenti/pubblico/${id}/vivo`, { token, body: {} });
  // Se carga la lectura compartida del seguimiento (la misma cache que usa el mapa de Gamonal) con servicios de ejemplo: asi no hace falta GPS ni rutas reales.
  const cargarSeguimiento = async (servicios) => {
    const { bumpCacheVersion, cachedResponse } = await import("../src/utils/responseCache.js");
    bumpCacheVersion();
    await cachedResponse("cliente-seguimiento", 20_000, async () => ({ servicios, generadoAt: new Date().toISOString() }), { small: true });
  };

  test("vivo: 401 identico con token falso o id inexistente; sin interruptor -> 403", async () => {
    const malo = await vivo("token-falso-token-falso-token-falso");
    const inexistente = await vivo(T2, "no-existe");
    assert.equal(malo.status, 401);
    assert.equal(inexistente.status, 401);
    assert.equal(malo.text, inexistente.text);
    assert.equal((await api("GET", `/collegamenti/pubblico/${collegamentoId}/vivo`, { token: T2 })).status === 200, false, "no hay GET");
    const apagado = await vivo();
    assert.equal(apagado.status, 403);
    assert.equal(apagado.body.message, "Questo collegamento non condivide i servizi in corso");
    assert.equal((await prisma.collegamento.findUnique({ where: { id: collegamentoId } })).condividiServiziInCorso, false, "apagado por defecto");
  });

  test("vivo: solo el Owner enciende el interruptor (y debe ser booleano)", async () => {
    const adminRow = await prisma.user.findFirst({ where: { cargo: "ADMIN" } });
    const { signToken } = await import("../src/utils/jwt.js");
    const adm = await api("PATCH", `/collegamenti/${collegamentoId}/condivisione`, { token: signToken({ sub: adminRow.id }), body: { condividiServiziInCorso: true } });
    assert.equal(adm.status, 403);
    assert.equal((await oficina("PATCH", `/collegamenti/${collegamentoId}/condivisione`, { condividiServiziInCorso: "si" })).status, 400);
    const r = await oficina("PATCH", `/collegamenti/${collegamentoId}/condivisione`, { condividiServiziInCorso: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.collegamento.condividiServiziInCorso, true);
    assert.equal((await oficina("GET", "/collegamenti")).body.data.collegamenti[0].condividiServiziInCorso, true);
  });

  test("vivo: 200 solo con RITIRATO / IN_CONSEGNA, sin campos extra, daPiazza solo en los que vienen de Piazza, ordenado por ETA", async () => {
    const record = await prisma.record.findFirst({ where: { codigo: "GT-1" } });
    const base = (id, estado, eta, extra = {}) => ({
      id, codigo: `C-${id}`, estado, destino: `Destino ${id}`, etaPlan: eta, tipoLabel: "Extra Piazza", cliente: "Cliente X", vehiculo: "AA000AA",
      chofer: { id: "d1", nombre: "Marta Lopez", telefono: "555-000" }, gps: null, pagos: 123, precioKm: 0.5, documentos: ["x"], ...extra,
    });
    await cargarSeguimiento([
      base(record.id, "IN_CONSEGNA", "2026-11-20T09:00:00Z", { gps: { fuente: "VEHICULO", lat: 45.46, lng: 9.19, rumbo: 90, velocidad: 40, motor: true, actualizada: "2026-11-20T08:55:00.000Z" } }),
      base("propio-1", "RITIRATO", "2026-11-20T08:00:00Z", { chofer: { id: "d2", nombre: "Sin asignar", telefono: null }, vehiculo: "SIN-ASIGNAR", cliente: null }),
      base("sim-1", "IN_CONSEGNA", "2026-11-20T10:00:00Z", { gps: { fuente: "SIMULADO", lat: 1, lng: 2, actualizada: null } }),
      base("entregado", "CONSEGNATO", "2026-11-20T07:00:00Z"),
      base("anulado", "ANNULLATO", "2026-11-20T07:30:00Z"),
      base("pendiente", "IN_SOSPESO", "2026-11-20T11:00:00Z"),
      base("repro", "RISCHEDULATO", "2026-11-20T12:00:00Z"),
    ]);
    const r = await vivo();
    assert.equal(r.status, 200, r.text);
    const lista = r.body.data.servizi;
    assert.deepEqual(lista.map((x) => x.id), ["propio-1", record.id, "sim-1"], "solo salidos, por ETA ascendente");
    assert.ok(lista.every((x) => ["RITIRATO", "IN_CONSEGNA"].includes(x.estado)));
    const permitidos = new Set(["id", "codigo", "estado", "destino", "ritiro", "eta", "cliente", "autista", "targa", "area", "daPiazza", "gps"]);
    for (const x of lista) for (const k of Object.keys(x)) assert.ok(permitidos.has(k), `campo no permitido: ${k}`);
    assert.ok(!r.text.includes("555-000") && !r.text.includes("precioKm") && !r.text.includes("documentos") && !r.text.includes("pagos"), "nada de telefonos, precios ni documentos");
    const deP = lista.find((x) => x.id === record.id);
    assert.equal(deP.daPiazza, "rec-1");
    assert.equal(deP.autista, "Marta Lopez");
    assert.equal(deP.targa, "AA000AA");
    assert.equal(deP.area, "Extra Piazza");
    assert.equal(deP.eta, "2026-11-20T09:00:00.000Z");
    assert.deepEqual(deP.gps, { lat: 45.46, lng: 9.19, rumbo: 90, actualizada: "2026-11-20T08:55:00.000Z" }, "sin velocidad ni motor");
    const propio = lista.find((x) => x.id === "propio-1");
    assert.equal("daPiazza" in propio, false);
    assert.equal("autista" in propio, false, "'Sin asignar' no se manda");
    assert.equal("targa" in propio, false);
    assert.equal("gps" in propio, false);
    assert.equal("gps" in lista.find((x) => x.id === "sim-1"), false, "la posicion simulada no se manda");
    assert.ok(lista.every((x) => x.daPiazza === undefined || x.id === record.id), "solo los de Piazza llevan daPiazza");
  });

  test("vivo: maximo 300 servicios", async () => {
    const muchos = Array.from({ length: 320 }, (_, i) => ({ id: `m${i}`, codigo: `M${i}`, estado: "IN_CONSEGNA", destino: "d", etaPlan: new Date(Date.UTC(2026, 10, 20, 0, 0, 0) + i * 60000).toISOString(), chofer: { nombre: "A B" }, vehiculo: "ZZ1", gps: null }));
    await cargarSeguimiento(muchos);
    const r = await vivo();
    assert.equal(r.body.data.servizi.length, 300);
    assert.equal(r.body.data.servizi[0].id, "m0");
  });

  test("vivo: conexion que no esta ATTIVO -> 409", async () => {
    const t = "t3-token-de-prueba-para-estado-no-activo-1234";
    const fila = await prisma.collegamento.create({ data: { ruolo: "CLIENTE", stato: "RIFIUTATO", remotoUrl: piazzaUrl, remotoId: "p-9", remotoNome: "Otra", tokenEntranteHash: sha256(t), condividiServiziInCorso: true } });
    const r = await vivo(t, fila.id);
    assert.equal(r.status, 409);
    await prisma.collegamento.delete({ where: { id: fila.id } });
  });

  test("contrato: la respuesta de /vivo cumple la forma y los limites; 'Giro' usa la ultima parada real; sin direccion no se manda; un item roto no tira a los demas", async () => {
    const chofer = await prisma.user.findFirst({ where: { cargo: "CHOFER" } });
    const veh = await prisma.vehiculo.findFirst();
    const cli = await prisma.client.findFirst();
    const base = { driverId: chofer.id, vehicleId: veh.id, clientId: cli.id, fechaServicio: new Date(), eta: new Date(), descripcion: "d" };
    const conParadas = await prisma.record.create({
      data: { ...base, codigo: "GT-GIRO", destinazione: "Giro (2 tappe)", stops: { create: [{ orden: 1, direccion: "Via Prima 1, 20100 Milano MI" }, { orden: 2, direccion: "Via Segunda 2, 20900 Monza MB" }] } },
    });
    const sinParadas = await prisma.record.create({ data: { ...base, codigo: "GT-GIRO-SIN", destinazione: "Giro (3 tappe)" } });
    const mk = (id, destino, extra = {}) => ({ id, codigo: `C-${id}`, estado: "IN_CONSEGNA", destino, etaPlan: "2026-11-20T10:00:00Z", tipoLabel: "DHL Milano", cliente: "HP", vehiculo: "CV627GV", chofer: { nombre: "José Guizado" }, gps: null, ...extra });
    await cargarSeguimiento([
      mk(conParadas.id, "Giro (2 tappe)", { gps: { fuente: "VEHICULO", lat: 45.4642, lng: 9.19, rumbo: 120, actualizada: "2026-11-19T10:31:00Z" } }),
      mk(sinParadas.id, "Giro (3 tappe)"),
      mk("sin-eta", "Via Eta 1, Milano", { etaPlan: null }),
      mk("roto", "Via Rota 1, Milano", { chofer: null, vehiculo: undefined, gps: { lat: "x", lng: "y", actualizada: "2026-11-19T10:31:00Z" } }),
      mk("normal", "Via Italia 9, 20900 Monza MB"),
    ]);
    const r = await vivo();
    assert.equal(r.status, 200, r.text);
    const parsed = esquemaVivo.safeParse(r.body.data);
    assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    const por = Object.fromEntries(r.body.data.servizi.map((x) => [x.id, x]));
    assert.equal(por[conParadas.id].destino, "Via Segunda 2, 20900 Monza MB", "ultima parada real");
    assert.deepEqual(por[conParadas.id].gps, { lat: 45.4642, lng: 9.19, rumbo: 120, actualizada: "2026-11-19T10:31:00.000Z" });
    assert.equal(por[sinParadas.id], undefined, "sin direccion ubicable no se manda");
    assert.equal(por["sin-eta"], undefined, "sin ETA no se manda (la otra app no podria ponerlo en rojo)");
    assert.ok(por.roto && !("gps" in por.roto) && !("autista" in por.roto) && !("targa" in por.roto), "un item raro sale sin lo que no sirve y sin tirar a los demas");
    assert.ok(por.normal);
  });

  test("vivo: pasado el limite de 30 por minuto por conexion -> 429", async () => {
    await cargarSeguimiento([]);
    let ultimo = 0;
    let n = 0;
    for (; n < 45; n += 1) {
      ultimo = (await vivo()).status;
      if (ultimo === 429) break;
    }
    assert.equal(ultimo, 429, "debe cortar");
    assert.ok(n <= 30, `corto despues de ${n + 1} peticiones`);
  });

  test("contrato: todo lo que Gamonal manda a /aggiornamenti cumple el esquema de Piazza", () => {
    assert.ok(aggiornamentiTodos.length >= 5, `se capturaron ${aggiornamentiTodos.length} avisos`);
    const tipos = new Set(aggiornamentiTodos.map((b) => b.tipo));
    assert.ok(tipos.has("ACCETTATO") && tipos.has("RIFIUTATO") && tipos.has("AGGIORNAMENTO"), `tipos vistos: ${[...tipos]}`);
    for (const body of aggiornamentiTodos) {
      const r = esquemaAggiornamento.safeParse(body);
      assert.ok(r.success, `${JSON.stringify(body)} -> ${r.success ? "" : JSON.stringify(r.error.issues)}`);
      assert.deepEqual(Object.keys(body).filter((k) => !["recordId", "tipo", "motivo", "estado", "autista", "targa"].includes(k)), [], "sin campos de mas (nada de importes ni datos personales)");
    }
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
