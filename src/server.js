import app from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./config/prisma.js";
import { startFaltantesReminder, startRetentionScheduler } from "./services/retentionScheduler.js";

const server = app.listen(env.PORT, () => {
  console.log(`RegistrosGTBack escuchando en el puerto ${env.PORT} (${env.NODE_ENV})`);
});

startRetentionScheduler();
startFaltantesReminder();

const shutdown = async (signal) => {
  console.log(`\n${signal} recibido, cerrando servidor...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
