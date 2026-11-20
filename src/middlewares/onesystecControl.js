// Interruptor de ONESYSTEC GENERALE para servidores Express (Node 18+).
// Montado en src/app.js justo después de CORS, para que el 503 lleve las cabeceras CORS:
//   import { onesystecControl } from "./middlewares/onesystecControl.js";
//   app.use(onesystecControl());
// Variables de entorno: GENERALE_URL (p. ej. https://generale.onesystec.com) y GENERALE_KEY (clave generada en el portal).
// Sin esas variables no hace nada. Si GENERALE no responde, la app sigue con el último estado conocido.

const EVERY_MS = 30_000;

export function onesystecControl({ exempt = ["/health", "/api/health"] } = {}) {
  const base = (process.env.GENERALE_URL || "").replace(/\/+$/, "");
  const key = process.env.GENERALE_KEY || "";
  if (!base || !key) return (_req, _res, next) => next();

  let state = { activa: true, mensaje: "" };
  async function refresh() {
    try {
      const res = await fetch(base + "/api/estado", {
        headers: { Authorization: "Bearer " + key },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return; // clave mal puesta o portal caído: se mantiene el último estado
      const data = await res.json();
      state = { activa: data.activa !== false, mensaje: String(data.mensaje || "") };
    } catch {
      // sin conexión: se mantiene el último estado conocido
    }
  }
  refresh();
  setInterval(refresh, EVERY_MS).unref();

  return (req, res, next) => {
    if (state.activa || req.method === "OPTIONS" || exempt.some((p) => req.path.startsWith(p))) return next();
    res.set("Retry-After", "60").status(503).json({ code: "APP_SUSPENDIDA", error: state.mensaje, mensaje: state.mensaje });
  };
}
