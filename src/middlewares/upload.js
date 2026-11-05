import multer from "multer";
import { AppError } from "../utils/AppError.js";
import { safeMemoryStorage } from "../utils/safeMemoryStorage.js";

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

const fileFilter = (req, file, cb) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return cb(new AppError("Tipo de archivo no permitido. Solo se aceptan PDF, JPEG, PNG o WEBP", 400));
  }
  cb(null, true);
};

export const upload = multer({
  storage: safeMemoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});
