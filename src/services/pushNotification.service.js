import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import { env } from "../config/env.js";
import { deletePushTokensByToken, findPushTokensForUserIds } from "../models/pushToken.model.js";
import { getApnsDiagnostics, sendApnsToTokens } from "./apns.service.js";

// Lazy init, igual que Velocity Fleet: sin FIREBASE_SERVICE_ACCOUNT_JSON configurado
// las notificaciones push quedan deshabilitadas sin romper nada (la campanita web
// sigue funcionando igual, solo que sin avisar tambien al celular con la app cerrada).
let firebaseApp;
let initAttempted = false;
let initError = null;

const getFirebaseApp = () => {
  if (initAttempted) return firebaseApp;
  initAttempted = true;
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  try {
    const credentials = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    firebaseApp = initializeApp({ credential: cert(credentials) });
  } catch (err) {
    console.error(
      "No se pudo inicializar Firebase Admin (revisar FIREBASE_SERVICE_ACCOUNT_JSON):",
      err.message
    );
    initError = err.message;
    firebaseApp = null;
  }
  return firebaseApp;
};

// Diagnostico (ver GET /vehiculos/push-status, OWNER) - para confirmar sin tener que
// buscar en los logs de Render si FIREBASE_SERVICE_ACCOUNT_JSON quedo bien pegado.
export const getPushDiagnostics = () => {
  const app = getFirebaseApp();
  return {
    envVarPresente: Boolean(env.FIREBASE_SERVICE_ACCOUNT_JSON),
    inicializado: Boolean(app),
    error: initError,
    // iPhone: envio directo por APNs (apns.service.js), aparte de Firebase.
    apns: getApnsDiagnostics(),
  };
};

const isUnregisteredError = (error) =>
  error?.code === "messaging/registration-token-not-registered" ||
  error?.code === "messaging/invalid-registration-token" ||
  error?.code === "messaging/invalid-argument";

// Best-effort: se llama desde deteccion en vivo (checkAreaCEntries/checkSpeedingEvents
// en vehicle.service.js), nunca debe romper esa respuesta. Si Firebase no esta
// configurado, o el usuario no tiene ningun dispositivo registrado, no hace nada.
export const sendPushToUserIds = async (userIds, { title, body, data } = {}) => {
  if (!userIds?.length) return;

  const tokens = await findPushTokensForUserIds(userIds);
  if (!tokens.length) return;

  // Android por Firebase, iPhone por APNs: cada uno con su propio token y su propio fallo,
  // para que uno apagado o caido no impida el aviso en el otro.
  const iosTokens = tokens.filter((t) => t.platform === "ios").map((t) => t.token);
  const androidTokens = tokens.filter((t) => t.platform !== "ios").map((t) => t.token);

  const [androidInvalidos, iosInvalidos] = await Promise.all([
    sendFirebase(androidTokens, { title, body, data }).catch((err) => {
      console.error("Push Android fallo:", err.message);
      return [];
    }),
    sendApnsToTokens(iosTokens, { title, body, data }).catch((err) => {
      console.error("Push iPhone fallo:", err.message);
      return [];
    }),
  ]);

  const invalidTokens = [...androidInvalidos, ...iosInvalidos];
  if (invalidTokens.length) await deletePushTokensByToken(invalidTokens);
};

const sendFirebase = async (tokens, { title, body, data }) => {
  if (!tokens.length) return [];
  const app = getFirebaseApp();
  if (!app) return [];

  const response = await getMessaging(app).sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: Object.fromEntries(Object.entries(data ?? {}).map(([k, v]) => [k, String(v)])),
    android: { priority: "high" },
  });

  return response.responses
    .map((r, i) => (!r.success && isUnregisteredError(r.error) ? tokens[i] : null))
    .filter(Boolean);
};
