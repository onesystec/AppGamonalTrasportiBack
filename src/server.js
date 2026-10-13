import app from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { logMemoryNow, startMemoryMonitor } from "./utils/memoryMonitor.js";
import { startFaltantesReminder, startRetentionScheduler, startSeguimientoMonitor } from "./services/retentionScheduler.js";

const server = app.listen(env.PORT, () => {
  console.log(`RegistrosGTBack escuchando en el puerto ${env.PORT} (${env.NODE_ENV})`);
});

if (env.NODE_ENV === "production") startMemoryMonitor();
startRetentionScheduler();
startFaltantesReminder();
startSeguimientoMonitor();

const shutdown = async (signal) => {
  console.log(`\n${signal} recibido, cerrando servidor...`);
  if (env.NODE_ENV === "production") logMemoryNow("al cerrar");
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
