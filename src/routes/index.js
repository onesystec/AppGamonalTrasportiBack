import { Router } from "express";
import authRoutes from "./auth.routes.js";
import clientRoutes from "./client.routes.js";
import combustibleRoutes from "./combustible.routes.js";
import documentRoutes from "./document.routes.js";
import fileRoutes from "./file.routes.js";
import finanzasRoutes from "./finanzas.routes.js";
import horasRoutes from "./horas.routes.js";
import paradaRoutes from "./parada.routes.js";
import mancatoRoutes from "./mancato.routes.js";
import multaRoutes from "./multa.routes.js";
import recordRoutes from "./record.routes.js";
import syncRoutes from "./sync.routes.js";
import telegramRoutes from "./telegram.routes.js";
import userRoutes from "./user.routes.js";
import vehicleRoutes from "./vehicle.routes.js";

const router = Router();

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/documents", documentRoutes);
router.use("/vehiculos", vehicleRoutes);
router.use("/clients", clientRoutes);
router.use("/records", recordRoutes);
router.use("/files", fileRoutes);
router.use("/mancato-pagamentos", mancatoRoutes);
router.use("/multas", multaRoutes);
router.use("/combustible", combustibleRoutes);
router.use("/finanzas", finanzasRoutes);
router.use("/horas", horasRoutes);
router.use("/paradas", paradaRoutes);
router.use("/sync", syncRoutes);
router.use("/telegram", telegramRoutes);

export default router;
