import app from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { healCrossedAssignments } from "./services/assignmentRematch.service.js";
import { ensureKmhPago } from "./services/velocidadPago.service.js";
import { logMemoryNow, startMemoryMonitor } from "./utils/memoryMonitor.js";
import { startAreaCAvisos, startAutoEnCamino, startFaltantesReminder, startMemorandumReminders, startRetentionScheduler, startSeguimientoMonitor } from "./services/retentionScheduler.js";

// Velocidades de pago por chofer en memoria desde el arranque (si falla, se vuelve a intentar en cada consulta de pagos).
void ensureKmhPago();

const server = app.listen(env.PORT, () => {
  console.log(`RegistrosGTBack escuchando en el puerto ${env.PORT} (${env.NODE_ENV})`);
});

if (env.NODE_ENV === "production") startMemoryMonitor();
startRetentionScheduler();
startFaltantesReminder();
startSeguimientoMonitor();
startAutoEnCamino();
startAreaCAvisos();
startMemorandumReminders();
// Peajes y cargas de combustible que quedaron asignados al servicio de otra targa (ver findCandidateServices): se corrigen una vez al arrancar.
if (env.NODE_ENV === "production") setTimeout(() => void healCrossedAssignments().catch((err) => console.error("[asignaciones] fallo la correccion:", err.message)), 20 * 1000).unref();

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
