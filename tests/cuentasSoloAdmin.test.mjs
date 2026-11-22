// Las cuentas las crea y las claves de otros las cambia SOLO el Admin (OWNER); Responsables y Recursos Humanos no.
// Pruebas con base LOCAL (GAMONAL_TEST_DATABASE_URL a localhost): la API de verdad, con el token de cada rol.
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
});

describe("Cuentas y claves solo las gestiona el Admin (base local)", { skip: !dbOk && "falta GAMONAL_TEST_DATABASE_URL (localhost)" }, () => {
  let server, base, prisma, signToken;
  const tokens = {};
  const ids = {};

  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const mkUser = (cargo, correo, extra = {}) =>
    prisma.user.create({ data: { nombre: cargo, apellido: "Test", area: "DHL", cargo, fechaNacimiento: new Date("1985-01-01"), numeroCelular: "3331234567", correoElectronico: correo, password: "x", ...extra } });
  const nuevoChofer = (correo) => ({ nombre: "Nuevo", apellido: "Chofer", cargo: "CHOFER", correoElectronico: correo, password: "Clave12345!", fechaNacimiento: "1990-01-01", numeroCelular: "3331234567", area: "DHL" });

  before(async () => {
    const { default: app } = await import("../src/app.js");
    ({ prisma } = await import("../src/config/prisma.js"));
    ({ signToken } = await import("../src/utils/jwt.js"));
    await prisma.$executeRawUnsafe('TRUNCATE "records","clients","vehiculos","users" RESTART IDENTITY CASCADE');
    const owner = await mkUser("OWNER", "owner@t.it");
    const admin = await mkUser("ADMIN", "admin@t.it", { responsableTipo: "MILANO_SUD" });
    const rrhh = await mkUser("RRHH", "rrhh@t.it");
    const chofer = await mkUser("CHOFER", "chofer@t.it");
    Object.assign(ids, { owner: owner.id, admin: admin.id, rrhh: rrhh.id, chofer: chofer.id });
    for (const [k, v] of Object.entries(ids)) tokens[k] = signToken({ sub: v });
    server = createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
  });
  after(async () => {
    server?.close();
    await prisma?.$disconnect();
  });

  test("Responsable, Recursos Humanos y chofer no pueden crear cuentas", async () => {
    for (const quien of ["admin", "rrhh", "chofer"]) {
      const r = await api("POST", "/users", { token: tokens[quien], body: nuevoChofer(`${quien}-crea@t.it`) });
      assert.equal(r.status, 403, `${quien} -> ${r.status} ${r.text}`);
    }
  });

  test("el Admin crea la cuenta de un chofer", async () => {
    const r = await api("POST", "/users", { token: tokens.owner, body: nuevoChofer("owner-crea@t.it") });
    assert.equal(r.status, 201, r.text);
  });

  test("Responsable y Recursos Humanos no pueden cambiar la clave de un chofer", async () => {
    for (const quien of ["admin", "rrhh"]) {
      const r = await api("PATCH", `/users/${ids.chofer}`, { token: tokens[quien], body: { password: "OtraClave123!" } });
      assert.equal(r.status, 403, `${quien} -> ${r.status} ${r.text}`);
    }
    assert.equal((await prisma.user.findUnique({ where: { id: ids.chofer } })).password, "x");
  });

  test("el Responsable sigue pudiendo editar otros datos del chofer", async () => {
    const r = await api("PATCH", `/users/${ids.chofer}`, { token: tokens.admin, body: { numeroCelular: "3339999999" } });
    assert.equal(r.status, 200, r.text);
  });

  test("el Admin cambia la clave de un chofer", async () => {
    const r = await api("PATCH", `/users/${ids.chofer}`, { token: tokens.owner, body: { password: "OtraClave123!" } });
    assert.equal(r.status, 200, r.text);
    const u = await prisma.user.findUnique({ where: { id: ids.chofer } });
    assert.notEqual(u.password, "x");
    assert.ok(u.passwordChangedAt);
  });
});
