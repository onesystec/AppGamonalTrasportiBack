import multer from "multer";
import { AppError } from "../utils/AppError.js";
import { safeMemoryStorage } from "../utils/safeMemoryStorage.js";

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024; // 15MB

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

const fileFilter = (req, file, cb) => {
  if (file.fieldname === "imagen") {
    if (!IMAGE_MIME_TYPES.includes(file.mimetype)) {
      return cb(new AppError("La imagen debe ser JPEG, PNG o WEBP", 400));
    }
    return cb(null, true);
  }

  if (file.fieldname === "libreto" || file.fieldname === "assicurazione") {
    if (file.mimetype !== "application/pdf") {
      return cb(new AppError(`${file.fieldname} debe ser un PDF`, 400));
    }
    return cb(null, true);
  }

  cb(new AppError(`Campo de archivo no reconocido: ${file.fieldname}`, 400));
};

export const vehicleUpload = multer({
  storage: safeMemoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter,
});
