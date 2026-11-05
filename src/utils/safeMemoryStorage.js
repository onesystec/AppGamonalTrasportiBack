import multer from "multer";
import { AppError } from "./AppError.js";

// multer solo mira el tipo que DECLARA quien sube el archivo. Aca se comprueba ademas que un "PDF" lo sea de verdad (empieza por %PDF-):
// si no, se guardaba cualquier cosa con la etiqueta application/pdf. Las imagenes ya las valida sharp al recomprimirlas.
const base = multer.memoryStorage();

export const safeMemoryStorage = () => ({
  _handleFile(req, file, cb) {
    base._handleFile(req, file, (err, info) => {
      if (err) return cb(err);
      if (file.mimetype === "application/pdf" && info.buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
        return cb(new AppError("El archivo no es un PDF valido", 400));
      }
      cb(null, info);
    });
  },
  _removeFile(req, file, cb) {
    base._removeFile(req, file, cb);
  },
});
