// Calcula el circuito (y su columna circuitoKm) de los servicios desde el 1/10/2026 que todavia no lo tienen: es la base del
// pago a los choferes por km. Uso: node scripts/backfill-circuito-km.mjs [--dry]
import { prisma } from "../src/config/prisma.js";
import { ensureCircuitSafe } from "../src/services/rutaEstimada.service.js";

const DESDE = new Date("2026-09-30T22:00:00Z"); // 1/10/2026 00:00 en Roma
const dry = process.argv.includes("--dry");

const records = await prisma.record.findMany({
  where: {
    fechaServicio: { gte: DESDE },
    circuitoKm: null,
    estado: { notIn: ["ANNULLATO", "RISCHEDULATO"] },
    servicioOrigenId: null,
  },
  select: { id: true, codigo: true },
  orderBy: { fechaServicio: "asc" },
});
console.log(`${records.length} servicios sin circuito${dry ? " (simulacro)" : ""}`);

let ok = 0;
let sinCircuito = 0;
for (const record of records) {
  if (dry) continue;
  const circuito = await ensureCircuitSafe(record.id);
  if (circuito?.km) {
    ok += 1;
    console.log(`${record.codigo}: ${circuito.km} km`);
  } else {
    sinCircuito += 1;
    console.log(`${record.codigo}: sin circuito (paradas sin ubicar, traspaso o viaje)`);
  }
  // Pausa corta para no saturar el servicio de rutas.
  await new Promise((resolve) => setTimeout(resolve, 400));
}
console.log(`Listo: ${ok} calculados, ${sinCircuito} sin circuito.`);
await prisma.$disconnect();
