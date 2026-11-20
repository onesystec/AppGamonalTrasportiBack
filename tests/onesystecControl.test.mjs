// Interruptor de ONESYSTEC GENERALE: con la app apagada en el portal, la API responde 503 APP_SUSPENDIDA.
// Pruebas puras: un servidor Express pequeño y una respuesta de GENERALE simulada (sin red ni base).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import cors from "cors";
import express from "express";
import { onesystecControl } from "../src/middlewares/onesystecControl.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  delete process.env.GENERALE_URL;
  delete process.env.GENERALE_KEY;
});

async function arrancar() {
  const app = express();
  app.use(cors({ origin: "https://app-gamonal-trasporti-front.vercel.app" }));
  app.use(onesystecControl());
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/records", (_req, res) => res.json({ ok: true }));
  await new Promise((r) => setTimeout(r, 20)); // deja terminar la primera consulta a GENERALE
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, cerrar: () => new Promise((r) => server.close(r)) };
}

test("sin GENERALE_URL ni GENERALE_KEY no cambia nada", async () => {
  delete process.env.GENERALE_URL;
  delete process.env.GENERALE_KEY;
  const { url, cerrar } = await arrancar();
  const res = await realFetch(url + "/api/records");
  assert.equal(res.status, 200);
  await cerrar();
});

test("apagada en GENERALE: 503 con el aviso y cabeceras CORS, salvo /api/health", async () => {
  process.env.GENERALE_URL = "https://generale.example.test";
  process.env.GENERALE_KEY = "osg_prueba";
  let pedido;
  globalThis.fetch = async (u, init) => {
    if (String(u).startsWith("https://generale.example.test")) {
      pedido = { u: String(u), auth: init.headers.Authorization };
      return new Response(JSON.stringify({ activa: false, mensaje: "Mantenimiento programado" }), { status: 200 });
    }
    return realFetch(u, init);
  };
  const { url, cerrar } = await arrancar();
  assert.deepEqual(pedido, { u: "https://generale.example.test/api/estado", auth: "Bearer osg_prueba" });

  const res = await realFetch(url + "/api/records", { headers: { Origin: "https://app-gamonal-trasporti-front.vercel.app" } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://app-gamonal-trasporti-front.vercel.app");
  const body = await res.json();
  assert.equal(body.code, "APP_SUSPENDIDA");
  assert.equal(body.mensaje, "Mantenimiento programado");

  assert.equal((await realFetch(url + "/api/health")).status, 200);
  await cerrar();
});

test("si GENERALE no responde, la app sigue abierta", async () => {
  process.env.GENERALE_URL = "https://generale.example.test";
  process.env.GENERALE_KEY = "osg_prueba";
  globalThis.fetch = async (u, init) => {
    if (String(u).startsWith("https://generale.example.test")) throw new Error("sin conexión");
    return realFetch(u, init);
  };
  const { url, cerrar } = await arrancar();
  assert.equal((await realFetch(url + "/api/records")).status, 200);
  await cerrar();
});
