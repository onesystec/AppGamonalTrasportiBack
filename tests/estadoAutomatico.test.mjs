// "En camino" automatico: cuando hace falta volver a mirar la base (para que Neon pueda dormir entre servicios).
//  - Pruebas puras: la decision de consultar o no.
//  - Prueba con base LOCAL (GAMONAL_TEST_DATABASE_URL a localhost): el calculo de cuando vence el siguiente servicio.
import assert from "node:assert/strict";
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
  AUTO_EN_CAMINO_MIN: "15",
});

const { MAX_SIN_REVISAR_MS, calcularProximaRevision, hayQueConsultar, proximoAutoEnCamino, advancePendingToEnCamino } = await import("../src/services/estadoAutomatico.service.js");
const { getCacheVersion, bumpCacheVersion } = await import("../src/utils/responseCache.js");

describe("decision de consultar la base", () => {
  const ahora = Date.parse("2026-11-20T10:00:00Z");

  test("la primera vez siempre se consulta", () => {
    assert.equal(hayQueConsultar({ proxima: null, version: 0, ahora }), true);
  });

  test("sin escrituras y antes de la hora del siguiente servicio: NO se consulta", () => {
    const proxima = calcularProximaRevision({ vence: ahora + 20 * 60 * 1000, version: 5, ahora });
    assert.equal(hayQueConsultar({ proxima, version: 5, ahora: ahora + 60_000 }), false);
    assert.equal(hayQueConsultar({ proxima, version: 5, ahora: ahora + 19 * 60_000 }), false);
  });

  test("al llegar la hora del siguiente servicio se consulta", () => {
    const proxima = calcularProximaRevision({ vence: ahora + 20 * 60 * 1000, version: 5, ahora });
    assert.equal(hayQueConsultar({ proxima, version: 5, ahora: ahora + 20 * 60 * 1000 }), true);
    assert.equal(hayQueConsultar({ proxima, version: 5, ahora: ahora + 25 * 60 * 1000 }), true);
  });

  test("si se escribio algo en los servicios (cambia el numero de escrituras) se consulta aunque no sea la hora", () => {
    const proxima = calcularProximaRevision({ vence: ahora + 20 * 60 * 1000, version: 5, ahora });
    assert.equal(hayQueConsultar({ proxima, version: 6, ahora: ahora + 60_000 }), true);
  });

  test("sin ningun servicio pendiente se vuelve a mirar a mas tardar a los 30 minutos (red de seguridad)", () => {
    const proxima = calcularProximaRevision({ vence: null, version: 1, ahora });
    assert.equal(MAX_SIN_REVISAR_MS, 30 * 60 * 1000);
    assert.equal(hayQueConsultar({ proxima, version: 1, ahora: ahora + 29 * 60_000 }), false);
    assert.equal(hayQueConsultar({ proxima, version: 1, ahora: ahora + 30 * 60_000 }), true);
  });

  test("un servicio que vence dentro de dias no alarga la espera mas de 30 minutos", () => {
    const proxima = calcularProximaRevision({ vence: ahora + 3 * 24 * 3600_000, version: 1, ahora });
    assert.equal(proxima.hasta, ahora + 30 * 60_000);
  });

  test("el numero de escrituras sube con bumpCacheVersion", () => {
    const antes = getCacheVersion();
    bumpCacheVersion();
    assert.equal(getCacheVersion(), antes + 1);
  });
});

describe("siguiente vencimiento (base local)", { skip: !dbOk && "falta GAMONAL_TEST_DATABASE_URL (localhost)" }, () => {
  let prisma, base;
  before(async () => {
    ({ prisma } = await import("../src/config/prisma.js"));
    await prisma.$executeRawUnsafe('TRUNCATE "records","clients","vehiculos","users" RESTART IDENTITY CASCADE');
    const chofer = await prisma.user.create({ data: { nombre: "C", apellido: "H", area: "DHL", cargo: "CHOFER", fechaNacimiento: new Date("1990-01-01"), numeroCelular: "1", correoElectronico: "c@t.it", password: "x" } });
    const veh = await prisma.vehiculo.create({ data: { targa: "TT111TT", modelo: "M", area: "DHL" } });
    const cli = await prisma.client.create({ data: { nombre: "Cli" } });
    base = { driverId: chofer.id, vehicleId: veh.id, clientId: cli.id, fechaServicio: new Date(), eta: new Date(), descripcion: "d", destinazione: "x" };
  });
  after(async () => prisma?.$disconnect());

  test("sin servicios pendientes: null", async () => {
    assert.equal(await proximoAutoEnCamino(Date.now()), null);
  });

  test("devuelve la hora de retiro del primero que aun no vence, mas 15 minutos", async () => {
    const now = Date.parse("2026-11-20T10:00:00Z");
    const mk = (codigo, retiro, estado = "IN_SOSPESO") => prisma.record.create({ data: { ...base, codigo, estado, fechaRetiro: retiro ? new Date(retiro) : null } });
    await mk("viejo", "2026-11-20T09:00:00Z"); // ya vencido (retiro hace 1 h): lo mueve advancePendingToEnCamino, no cuenta como "siguiente"
    await mk("tarde", "2026-11-20T14:00:00Z");
    await mk("pronto", "2026-11-20T10:30:00Z");
    await mk("otro-estado", "2026-11-20T10:10:00Z", "RITIRATO"); // no es pendiente
    await mk("sin-retiro", null); // sin hora de retiro: no hay desde cuando contar
    assert.equal(await proximoAutoEnCamino(now), Date.parse("2026-11-20T10:45:00Z"));
    // Y el vencido si se mueve (la logica que ya existia sigue igual).
    assert.equal(await advancePendingToEnCamino(now), 1);
    assert.equal((await prisma.record.findFirst({ where: { codigo: "viejo" } })).estado, "IN_CONSEGNA");
    assert.equal((await prisma.record.findFirst({ where: { codigo: "pronto" } })).estado, "IN_SOSPESO");
  });
});
