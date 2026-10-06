import { Router } from "express";
import authRoutes from "./auth.routes.js";
import clientRoutes from "./client.routes.js";
import documentRoutes from "./document.routes.js";
import fileRoutes from "./file.routes.js";
import mancatoRoutes from "./mancato.routes.js";
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
router.use("/sync", syncRoutes);
router.use("/telegram", telegramRoutes);

export default router;
