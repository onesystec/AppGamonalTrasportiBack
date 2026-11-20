// Recursos Humanos ve los Registros (la vista de siempre, solo lectura y sin importes) solo si el Owner le activa el interruptor "Ver la lista de servicios".
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

// Campos con dinero que Recursos Humanos nunca debe recibir.
const CAMPOS_CON_DINERO = ["precioKm", "pagoRecibido", "costoEspera", "costoTraforoFrejusBrennero", "peajes", "peajesManual", "peajesDetalle", "vignetta", "costoHotel", "costoOtros", "costoCombustible", "combustible", "total", "totalKm", "facturacion", "areaC"];

describe("Registros para Recursos Humanos (base local)", { skip: !dbOk && "falta GAMONAL_TEST_DATABASE_URL (localhost)" }, () => {
  let server, base, prisma, signToken;
  const tokens = {};
  const ids = {};
  let recordIds = [];

  const api = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const mkUser = (cargo, correo, extra = {}) =>
    prisma.user.create({ data: { nombre: cargo, apellido: "Test", area: "DHL", cargo, fechaNacimiento: new Date("1985-01-01"), numeroCelular: "3331234567", correoElectronico: correo, password: "x", ...extra } });

  before(async () => {
    const { default: app } = await import("../src/app.js");
    ({ prisma } = await import("../src/config/prisma.js"));
    ({ signToken } = await import("../src/utils/jwt.js"));
    await prisma.$executeRawUnsafe('TRUNCATE "records","clients","vehiculos","users" RESTART IDENTITY CASCADE');
    const owner = await mkUser("OWNER", "owner@t.it");
    const admin = await mkUser("ADMIN", "admin@t.it");
    const chofer1 = await mkUser("CHOFER", "chofer1@t.it", { nombre: "Carlos", apellido: "Perez" });
    const chofer2 = await mkUser("CHOFER", "chofer2@t.it", { nombre: "Marta", apellido: "Lopez" });
    const rrhhNo = await mkUser("RRHH", "rrhh-no@t.it");
    const rrhhSi = await mkUser("RRHH", "rrhh-si@t.it", { rrhhVeServicios: true });
    Object.assign(ids, { owner: owner.id, admin: admin.id, chofer1: chofer1.id, chofer2: chofer2.id, rrhhNo: rrhhNo.id, rrhhSi: rrhhSi.id });
    for (const [k, v] of Object.entries(ids)) tokens[k] = signToken({ sub: v });
    const veh = await prisma.vehiculo.create({ data: { targa: "GA111AA", modelo: "Ducato", area: "DHL" } });
    const cli = await prisma.client.create({ data: { nombre: "HP" } });
    const dinero = { precioKm: 0.75, pagoRecibido: 123.45, costoEspera: 9.99, costoOtros: 5.5, peajes: 12.34, costoCombustible: 44.4 };
    const mk = (codigo, driverId, fecha, extra = {}) =>
      prisma.record.create({ data: { driverId, vehicleId: veh.id, clientId: cli.id, descripcion: "d", kilometros: 42, ...dinero, codigo, destinazione: `Via ${codigo} 1, Milano`, fechaServicio: new Date(`${fecha}T00:00:00Z`), eta: new Date(`${fecha}T09:00:00Z`), spedizzione: "DHL", ...extra } });
    const r1 = await mk("R-1", chofer1.id, "2026-11-20");
    const r2 = await mk("R-2", chofer2.id, "2026-11-20", { estado: "CONSEGNATO" });
    const r3 = await mk("R-3", chofer1.id, "2026-11-25");
    recordIds = [r1.id, r2.id, r3.id];
    await prisma.mancatoPagamento.create({ data: { numero: "M1", fechaHoraTransito: new Date("2026-11-20T08:00:00Z"), tramo: "ida", costo: 7.7, driverId: chofer1.id, vehicleId: veh.id, recordId: r1.id, asignacion: "AUTOMATICA" } }).catch(() => {});
    server = createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://localhost:${server.address().port}`;
  });
  after(async () => {
    server?.close();
    await prisma?.$disconnect();
  });

  test("RRHH sin el interruptor no ve ningun Registro", async () => {
    for (const ruta of ["/records", "/records/2026/11", "/records/2026/11/20", "/records/2026/11/summary", "/records/pending", "/records/search?q=R-1", "/clients"]) {
      const r = await api("GET", ruta, { token: tokens.rrhhNo });
      assert.equal(r.status, 403, `${ruta} -> ${r.status}`);
    }
  });

  test("con el interruptor ve TODOS los servicios del dia (de cualquier chofer) y sin ningun importe", async () => {
    const r = await api("GET", "/records/2026/11/20", { token: tokens.rrhhSi });
    assert.equal(r.status, 200, r.text);
    const lista = r.body.data.records;
    assert.deepEqual(lista.map((x) => x.codigo).sort(), ["R-1", "R-2"], "ve los de todos los choferes");
    for (const x of lista) {
      for (const campo of CAMPOS_CON_DINERO) assert.ok(!(campo in x), `no debe llevar ${campo}`);
      assert.ok(x.driver && x.vehicle && x.client && x.estado && x.destinazione && x.eta, "si lleva lo operativo");
    }
    for (const numero of ["123.45", "0.75", "9.99", "12.34", "44.4", "7.7"]) assert.ok(!r.text.includes(numero), `no debe aparecer ${numero}`);
  });

  test("las demas listas: mes, resumen del mes, historial completo, pendientes y busqueda", async () => {
    const mes = await api("GET", "/records/2026/11", { token: tokens.rrhhSi });
    assert.equal(mes.body.data.records.length, 3);
    const resumen = await api("GET", "/records/2026/11/summary", { token: tokens.rrhhSi });
    assert.equal(resumen.status, 200, resumen.text);
    assert.equal((resumen.body.data.records ?? resumen.body.data.summary ?? resumen.body.data.items).length, 3);
    assert.ok(!/precioKm|pagoRecibido|costo/.test(resumen.text));
    const todos = await api("GET", "/records", { token: tokens.rrhhSi });
    assert.equal(todos.status, 200, todos.text);
    assert.equal((await api("GET", "/records/pending", { token: tokens.rrhhSi })).status, 200);
    const q = await api("GET", "/records/search?q=R-2", { token: tokens.rrhhSi });
    assert.equal(q.status, 200, q.text);
    assert.deepEqual(q.body.data.records.map((x) => x.codigo), ["R-2"]);
    assert.ok(!/precioKm|pagoRecibido|costoEspera/.test(q.text));
  });

  test("el filtro por importe se ignora para RRHH (no puede deducir importes)", async () => {
    const r = await api("GET", "/records/search?montoMin=100&montoMax=200&estado=CONSEGNATO", { token: tokens.rrhhSi });
    assert.equal(r.status, 200, r.text);
    // el filtro de monto no se aplica: el servicio entregado aparece aunque el monto del filtro no tenga relacion con el suyo
    const sinMonto = await api("GET", "/records/search?estado=CONSEGNATO", { token: tokens.rrhhSi });
    assert.deepEqual(r.body.data.records.map((x) => x.codigo), sinMonto.body.data.records.map((x) => x.codigo));
    const fuera = await api("GET", "/records/search?montoMin=9999&estado=CONSEGNATO", { token: tokens.rrhhSi });
    assert.deepEqual(fuera.body.data.records.map((x) => x.codigo), ["R-2"], "aunque el monto pedido sea imposible, no se filtra por el");
  });

  test("solo lectura: no abre el detalle, ni archivos, ni exporta, ni crea o cambia nada, ni ve finanzas", async () => {
    const id = recordIds[0];
    const cierre = [
      ["GET", `/records/${id}`],
      ["GET", `/records/${id}/files`],
      ["GET", `/records/${id}/circuito`],
      ["GET", "/records/export"],
      ["GET", "/records/sin-asignar"],
      ["GET", "/finanzas/resumen"],
      ["GET", "/seguimiento"],
      ["GET", "/solicitudes"],
      ["GET", "/cambios"],
      ["POST", "/records"],
      ["PATCH", `/records/${id}`],
      ["DELETE", `/records/${id}`],
      ["POST", "/clients"],
    ];
    for (const [metodo, ruta] of cierre) {
      const r = await api(metodo, ruta, { token: tokens.rrhhSi, body: metodo === "GET" || metodo === "DELETE" ? undefined : {} });
      assert.equal(r.status, 403, `${metodo} ${ruta} -> ${r.status}`);
    }
    assert.equal(await prisma.record.count(), 3, "no cambio nada");
  });

  test("la lista de clientes para los filtros solo trae nombres", async () => {
    const r = await api("GET", "/clients", { token: tokens.rrhhSi });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.keys(r.body.data.clients[0]).sort(), ["createdAt", "id", "nombre", "serviciosDirectos"]);
  });

  test("Owner y Responsable siguen viendo todo con importes (nada cambia para ellos)", async () => {
    for (const quien of ["owner", "admin"]) {
      const r = await api("GET", "/records/2026/11/20", { token: tokens[quien] });
      assert.equal(r.status, quien === "admin" ? 200 : 200);
    }
    const o = await api("GET", "/records/2026/11/20", { token: tokens.owner });
    assert.ok("precioKm" in o.body.data.records[0] && "pagoRecibido" in o.body.data.records[0]);
  });

  test("solo el Owner activa o apaga el interruptor", async () => {
    const adm = await api("PATCH", `/users/${ids.rrhhNo}`, { token: tokens.admin, body: { rrhhVeServicios: true } });
    assert.equal(adm.status, 403);
    const propio = await api("PATCH", `/users/${ids.rrhhNo}`, { token: tokens.rrhhNo, body: { rrhhVeServicios: true } });
    assert.ok([200, 403].includes(propio.status));
    assert.equal((await prisma.user.findUnique({ where: { id: ids.rrhhNo } })).rrhhVeServicios, false, "RRHH no se lo da a si mismo");
    const ok = await api("PATCH", `/users/${ids.rrhhNo}`, { token: tokens.owner, body: { rrhhVeServicios: true } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.data.user.rrhhVeServicios, true);
    assert.equal((await api("GET", "/records/2026/11/20", { token: tokens.rrhhNo })).status, 200, "ya ve los Registros");
    const off = await api("PATCH", `/users/${ids.rrhhNo}`, { token: tokens.owner, body: { rrhhVeServicios: false } });
    assert.equal(off.body.data.user.rrhhVeServicios, false);
    assert.equal((await api("GET", "/records/2026/11/20", { token: tokens.rrhhNo })).status, 403, "al apagarlo vuelve a cerrarse");
  });

  test("un Responsable puede guardar la ficha de un chofer aunque el formulario mande el interruptor sin cambiarlo", async () => {
    const r = await api("PATCH", `/users/${ids.chofer1}`, { token: tokens.admin, body: { nombre: "Carlos", rrhhVeServicios: false } });
    assert.equal(r.status, 200, r.text);
    const cambio = await api("PATCH", `/users/${ids.chofer1}`, { token: tokens.admin, body: { rrhhVeServicios: true } });
    assert.equal(cambio.status, 403);
  });

  test("el interruptor solo existe para Recursos Humanos: en otro cargo queda apagado", async () => {
    const r = await api("PATCH", `/users/${ids.chofer2}`, { token: tokens.owner, body: { rrhhVeServicios: true } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.data.user.rrhhVeServicios, false);
    const cambio = await api("PATCH", `/users/${ids.rrhhSi}`, { token: tokens.owner, body: { cargo: "CHOFER" } });
    assert.equal(cambio.status, 200, cambio.text);
    assert.equal((await prisma.user.findUnique({ where: { id: ids.rrhhSi } })).rrhhVeServicios, false);
  });

  test("al crear un usuario RRHH el Owner puede dejarlo activado", async () => {
    const r = await api("POST", "/users", {
      token: tokens.owner,
      body: { nombre: "Nueva", apellido: "Rrhh", cargo: "RRHH", rrhhVeServicios: true, correoElectronico: "nueva@t.it", password: "Clave12345!", fechaNacimiento: "1990-01-01", numeroCelular: "3331234567", area: "DHL" },
    });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.data.user.rrhhVeServicios, true);
  });
});
