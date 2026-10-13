import v8 from "node:v8";

// Rastro de memoria para los logs de Render. Cuando la instancia se reinicia por pasar el limite (512 MB), el servidor muere antes de
// poder escribir nada, y morgan solo anota una peticion cuando termina: la que la mato nunca aparece. Por eso:
//  - cada minuto se anota cuanta memoria usa (y el pico del minuto);
//  - cada 5 segundos se mira: si pasa del umbral o salta de golpe, se anota que peticiones estaban EN CURSO en ese momento y cuales
//    terminaron hace poco. Esa lista es la que dice que fue.
const MB = 1024 * 1024;
const SAMPLE_MS = 5000;
const LOG_EVERY_MS = 60 * 1000;
const WARN_COOLDOWN_MS = 20 * 1000;
const WARN_MB = Number(process.env.MEMORY_WARN_MB) || 400;
const JUMP_MB = 80;
const RECENT_MAX = 8;

const inflight = new Map();
const recent = [];
let seq = 0;

const mb = (bytes) => Math.round(bytes / MB);
const shortUrl = (url) => (url.length > 140 ? `${url.slice(0, 140)}...` : url);

// Middleware: lleva la cuenta de las peticiones en curso y de las ultimas que terminaron (el health check de Render no cuenta).
export const trackRequests = (req, res, next) => {
  if (req.originalUrl === "/api/health") return next();
  const id = (seq += 1);
  const info = { method: req.method, url: shortUrl(req.originalUrl), startedAt: Date.now() };
  inflight.set(id, info);
  res.on("close", () => {
    inflight.delete(id);
    recent.push({ ...info, status: res.statusCode, ms: Date.now() - info.startedAt });
    if (recent.length > RECENT_MAX) recent.shift();
  });
  next();
};

const describeInflight = () =>
  [...inflight.values()].map((r) => `${r.method} ${r.url} (${Math.round((Date.now() - r.startedAt) / 1000)} s)`).join(" | ") || "ninguna";
const describeRecent = () => recent.slice(-5).map((r) => `${r.method} ${r.url} -> ${r.status} en ${r.ms} ms`).join(" | ") || "ninguna";

const snapshot = () => {
  const m = process.memoryUsage();
  return `rss=${mb(m.rss)} MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)} MB external=${mb(m.external)} MB buffers=${mb(m.arrayBuffers)} MB`;
};

// Para el cierre ordenado (Render manda SIGTERM al desplegar): deja anotado el estado final.
export const logMemoryNow = (label) => console.log(`[mem] ${label}: ${snapshot()} | en curso: ${describeInflight()}`);

export const startMemoryMonitor = () => {
  const limit = mb(v8.getHeapStatistics().heap_size_limit);
  console.log(`[mem] monitor activo: limite de heap de Node ${limit} MB, aviso desde ${WARN_MB} MB de RSS. Ahora: ${snapshot()}`);

  let lastRss = process.memoryUsage().rss;
  let peak = lastRss;
  let lastLogAt = Date.now();
  let lastWarnAt = 0;

  const tick = () => {
    const rss = process.memoryUsage().rss;
    peak = Math.max(peak, rss);
    const now = Date.now();
    const jumped = rss - lastRss >= JUMP_MB * MB;
    if ((mb(rss) >= WARN_MB || jumped) && now - lastWarnAt >= WARN_COOLDOWN_MS) {
      lastWarnAt = now;
      console.warn(
        `[mem] ALERTA ${jumped ? `salto de ${mb(rss - lastRss)} MB en ${SAMPLE_MS / 1000} s` : `memoria alta`}: ${snapshot()} | en curso: ${describeInflight()} | ultimas: ${describeRecent()}`
      );
    }
    if (now - lastLogAt >= LOG_EVERY_MS) {
      lastLogAt = now;
      console.log(`[mem] ${snapshot()} pico=${mb(peak)} MB | peticiones en curso: ${inflight.size}`);
      peak = rss;
    }
    lastRss = rss;
  };

  setInterval(tick, SAMPLE_MS).unref();
};
