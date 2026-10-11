import { Router } from "express";
import { authenticate } from "../middlewares/authenticate.js";
import { authorize } from "../middlewares/authorize.js";
import { getOfficeScope } from "../services/notificationScope.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

router.use(authenticate);

// A que vehiculos y choferes se refieren los avisos de gestion de quien pregunta. { todo: true } para el Admin; para un Responsable, solo los ids
// de su asignacion (el front filtra con esto documentos, tagliando, cumpleanios, etc.).
router.get(
  "/alcance",
  authorize("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const scope = await getOfficeScope(req.user);
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, data: { alcance: scope ? { todo: false, ...scope } : { todo: true } } });
  })
);

export default router;
