import { connect } from "node:http2";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Notificaciones push al iPhone directo por APNs (servidores de Apple), sin pasar por
// Firebase: el plugin de Capacitor en iOS entrega el token de APNs en hexadecimal y
// aqui se le manda el aviso con la clave .p8 del equipo de desarrollador. Android sigue
// por Firebase (pushNotification.service.js). Opcional: sin las variables APNS_* el
// envio a iPhone queda apagado y el resto de la app sigue igual.
const ORIGEN_PRODUCCION = "https://api.push.apple.com";
const ORIGEN_PRUEBAS = "https://api.sandbox.push.apple.com";
// Apple pide renovar el JWT entre cada 20 y 60 minutos.
const VIGENCIA_JWT_MS = 40 * 60 * 1000;
const TIEMPO_MAX_MS = 15_000;
// Motivos por los que ese token ya no sirve y se borra (la app se desinstalo o es de otra app).
const MOTIVOS_TOKEN_INVALIDO = new Set(["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"]);

const clavePrivada = () => (env.APNS_KEY ? env.APNS_KEY.replace(/\\n/g, "\n") : null);

export const apnsConfigurado = () =>
  Boolean(clavePrivada() && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID);

let jwtCache = null;
const tokenJwt = () => {
  const ahora = Date.now();
  if (jwtCache && ahora - jwtCache.creadoEn < VIGENCIA_JWT_MS) return jwtCache.valor;
  const valor = jwt.sign({}, clavePrivada(), {
    algorithm: "ES256",
    issuer: env.APNS_TEAM_ID,
    header: { alg: "ES256", kid: env.APNS_KEY_ID },
  });
  jwtCache = { valor, creadoEn: ahora };
  return valor;
};

export const getApnsDiagnostics = () => ({
  configurado: apnsConfigurado(),
  bundleId: env.APNS_BUNDLE_ID,
  faltan: [
    ["APNS_KEY", clavePrivada()],
    ["APNS_KEY_ID", env.APNS_KEY_ID],
    ["APNS_TEAM_ID", env.APNS_TEAM_ID],
  ]
    .filter(([, valor]) => !valor)
    .map(([nombre]) => nombre),
});

// Una peticion por token sobre una sola conexion HTTP/2. Devuelve { ok, status, motivo }.
const enviarUno = (sesion, token, cuerpo) =>
  new Promise((resolve) => {
    const peticion = sesion.request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${tokenJwt()}`,
      "apns-topic": env.APNS_BUNDLE_ID,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let status = 0;
    let texto = "";
    peticion.setTimeout(TIEMPO_MAX_MS, () => {
      peticion.close();
      resolve({ ok: false, status: 0, motivo: "Timeout" });
    });
    peticion.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    peticion.setEncoding("utf8");
    peticion.on("data", (trozo) => {
      texto += trozo;
    });
    peticion.on("end", () => {
      let motivo = null;
      try {
        motivo = texto ? JSON.parse(texto).reason : null;
      } catch {
        motivo = null;
      }
      resolve({ ok: status === 200, status, motivo });
    });
    peticion.on("error", (err) => resolve({ ok: false, status: 0, motivo: err.code ?? err.message }));
    peticion.end(cuerpo);
  });

const enviarLote = async (origen, tokens, cuerpo) => {
  let sesion;
  try {
    sesion = connect(origen);
    sesion.on("error", () => {});
    await new Promise((resolve, reject) => {
      sesion.once("connect", resolve);
      sesion.once("error", reject);
    });
  } catch (err) {
    sesion?.destroy();
    return tokens.map(() => ({ ok: false, status: 0, motivo: err.code ?? err.message }));
  }
  try {
    return await Promise.all(tokens.map((token) => enviarUno(sesion, token, cuerpo)));
  } finally {
    sesion.close();
  }
};

// Devuelve los tokens que Apple dio por invalidos para borrarlos. Los de una compilacion de
// desarrollo (instalada desde Xcode) solo existen en el servidor de pruebas: si el de produccion
// dice BadDeviceToken se reintenta ahi antes de darlos por perdidos.
export const sendApnsToTokens = async (tokens, { title, body, data } = {}, { origenProduccion = ORIGEN_PRODUCCION, origenPruebas = ORIGEN_PRUEBAS } = {}) => {
  if (!tokens?.length || !apnsConfigurado()) return [];

  const cuerpo = JSON.stringify({
    ...Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v)])),
    aps: { alert: { title, body }, sound: "default" },
  });

  const resultados = await enviarLote(origenProduccion, tokens, cuerpo);
  const dudosos = tokens.filter((_, i) => !resultados[i].ok && resultados[i].motivo === "BadDeviceToken");
  const sandbox = dudosos.length ? await enviarLote(origenPruebas, dudosos, cuerpo) : [];

  const invalidos = [];
  tokens.forEach((token, i) => {
    const r = resultados[i];
    if (r.ok) return;
    const reintento = sandbox[dudosos.indexOf(token)];
    if (reintento?.ok) return;
    const motivo = reintento ? reintento.motivo : r.motivo;
    if (MOTIVOS_TOKEN_INVALIDO.has(motivo)) invalidos.push(token);
    else console.error(`APNs rechazo un aviso (${r.status} ${motivo ?? "sin motivo"})`);
  });
  return invalidos;
};
