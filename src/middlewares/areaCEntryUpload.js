import multer from "multer";
import { AppError } from "../utils/AppError.js";
import { safeMemoryStorage } from "../utils/safeMemoryStorage.js";

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

const fileFilter = (req, file, cb) => {
  if (!IMAGE_MIME_TYPES.includes(file.mimetype)) {
    return cb(new AppError("El comprobante debe ser una imagen (JPEG, PNG o WEBP)", 400));
  }
  cb(null, true);
};

export const areaCEntryUpload = multer({
  storage: safeMemoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});
