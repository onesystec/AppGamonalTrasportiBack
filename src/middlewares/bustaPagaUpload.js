import multer from "multer";
import { AppError } from "../utils/AppError.js";

// La busta paga se sube siempre como PDF (maximo 10 MB).
export const bustaPagaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype === "application/pdf" ? cb(null, true) : cb(new AppError("La busta paga debe ser un archivo PDF", 400)),
});
