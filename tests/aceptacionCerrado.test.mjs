// Un servicio que la oficina entrega (o anula) antes de que el chofer lo acepte no debe quedar bloqueado: el chofer
// tiene que poder declarar peajes y carburante y cargar sus horas. Pruebas con base LOCAL (GAMONAL_TEST_DATABASE_URL a localhost).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  OSRM_BASE_URL: "http://127.0.0.1:9",
  VALHALLA_BASE_URL: "http://127.0.0.1:9",
});

const { assertChoferConfirmado, requiereConfirmacionChofer } = await import("../src/services/record.service.js");
const { datiAggiornamento } = await import("../src/services/collegamentoInvio.service.js");

describe("aceptación del chofer: solo se exige con el servicio abierto (reglas puras)", () => {
  const chofer = { cargo: "CHOFER" };
  const vehicle = { targa: "GA111AA" };

  test("abierto y sin aceptar: bloquea al chofer", () => {
    for (const estado of ["IN_SOSPESO", "RITIRATO", "IN_CONSEGNA"]) {
      assert.equal(requiereConfirmacionChofer({ estado, aceptacionChofer: "PENDIENTE" }), true, estado);
      assert.throws(() => assertChoferConfirmado(chofer, { estado, aceptacionChofer: "VEHICULO_PENDIENTE" }), /Acepta el servicio/);
    }
  });

  test("cerrado por la oficina sin aceptar: ya no bloquea (horas, cierre, recepción y declaraciones usan esta regla)", () => {
    for (const estado of ["CONSEGNATO", "ANNULLATO", "RISCHEDULATO"]) {
      assert.equal(requiereConfirmacionChofer({ estado, aceptacionChofer: "PENDIENTE" }), false, estado);
      assert.doesNotThrow(() => assertChoferConfirmado(chofer, { estado, aceptacionChofer: "PENDIENTE" }));
    }
  });

  test("a App Piazza: la targa se oculta solo mientras el servicio abierto espera la aceptación", () => {
    assert.equal(datiAggiornamento({ estado: "IN_SOSPESO", aceptacionChofer: "PENDIENTE", vehicle }).targa, null);
    assert.equal(datiAggiornamento({ estado: "CONSEGNATO", aceptacionChofer: "PENDIENTE", vehicle }).targa, "GA111AA");
  });
});

describe("servicio entregado por la oficina antes de que el chofer acepte (base local)", { skip: !dbOk && "falta GAMONAL_TEST_DATABASE_URL (localhost)" }, () => {
  let server, base, prisma, ownerToken, choferToken, chofer, vehiculo, cliente;

  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const nuevoServicio = (codigo, extra = {}) => prisma.record.create({
    data: {
      driverId: chofer.id, vehicleId: vehiculo.id, clientId: cliente.id, descripcion: "Prueba", codigo, destinazione: "Milano",
      fechaServicio: new Date("2026-11-24"), eta: new Date("2026-11-24T09:00:00Z"), spedizzione: "EXTRA_PIAZZA",
      estado: "IN_SOSPESO", aceptacionChofer: "PENDIENTE", ...extra,
    },
  });

  before(async () => {
    const { default: app } = await import("../src/app.js");
    ({ prisma } = await import("../src/config/prisma.js"));
    const { signToken } = await import("../src/utils/jwt.js");
    await prisma.$executeRawUnsafe('TRUNCATE "collegamenti","solicitudes_servicio","records","clients","vehiculos","users","configuracion","cambios_servicio","alertas_cambio" RESTART IDENTITY CASCADE');
    const mk = (cargo, correo, nombre) => prisma.user.create({ data: { nombre, apellido: "Test", area: "DHL", cargo, fechaNacimiento: new Date("1985-01-01"), numeroCelular: "3331234567", correoElectronico: correo, password: "x" } });
    const owner = await mk("OWNER", "owner-acept@t.it", "Olga");
    chofer = await mk("CHOFER", "chofer-acept@t.it", "Carlos");
    ownerToken = signToken({ sub: owner.id });
    choferToken = signToken({ sub: chofer.id });
    vehiculo = await prisma.vehiculo.create({ data: { targa: "GA222BB", modelo: "Ducato", area: "DHL" } });
    cliente = await prisma.client.create({ data: { nombre: "Cliente prueba" } });
    server = createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
  });
  after(async () => {
    server?.close();
    await prisma?.$disconnect();
  });

  test("abierto y sin aceptar: el chofer sigue sin poder declarar gastos", async () => {
    const record = await nuevoServicio("ACEPT-ABIERTO");
    const r = await api("PATCH", `/records/${record.id}/declaraciones`, { token: choferToken, body: { sinPeajeIda: true } });
    assert.equal(r.status, 409, r.text);
  });

  test("la oficina lo marca entregado: se borra el 'Por aceptar' y el chofer puede declarar peajes y carburante", async () => {
    const record = await nuevoServicio("ACEPT-ENTREGADO");
    const entregado = await api("PATCH", `/records/${record.id}`, { token: ownerToken, body: { estado: "CONSEGNATO" } });
    assert.equal(entregado.status, 200, entregado.text);
    assert.equal(entregado.body.data.record.estado, "CONSEGNATO");
    assert.equal(entregado.body.data.record.aceptacionChofer, null);
    const gastos = await api("PATCH", `/records/${record.id}/declaraciones`, { token: choferToken, body: { sinPeajeIda: true, sinCombustible: true } });
    assert.equal(gastos.status, 200, gastos.text);
    const guardado = await prisma.record.findUnique({ where: { id: record.id } });
    assert.equal(guardado.sinPeajeIda, true);
    assert.equal(guardado.sinCombustible, true);
  });

  test("un servicio que ya quedó atascado (entregado y 'Por aceptar') se desbloquea, y la migración lo limpia", async () => {
    const atascado = await nuevoServicio("ACEPT-ATASCADO", { estado: "CONSEGNATO" });
    const abierto = await nuevoServicio("ACEPT-SIGUE-ABIERTO");
    const gastos = await api("PATCH", `/records/${atascado.id}/declaraciones`, { token: choferToken, body: { sinPeajeVuelta: true } });
    assert.equal(gastos.status, 200, gastos.text);

    const sql = await readFile(new URL("../prisma/migrations/20261230100000_aceptacion_servicios_cerrados/migration.sql", import.meta.url), "utf8");
    await prisma.$executeRawUnsafe(sql);
    assert.equal((await prisma.record.findUnique({ where: { id: atascado.id } })).aceptacionChofer, null);
    assert.equal((await prisma.record.findUnique({ where: { id: abierto.id } })).aceptacionChofer, "PENDIENTE", "los abiertos siguen esperando al chofer");
  });
});
