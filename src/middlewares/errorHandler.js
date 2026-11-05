import { AppError } from "../utils/AppError.js";

export const notFound = (req, res, next) => {
  next(new AppError(`Ruta no encontrada: ${req.method} ${req.originalUrl}`, 404));
};

export const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message;
  let details = err.details;
  let handled = err.isOperational === true;

  // Prisma: violacion de restriccion unica (ej. correo electronico repetido)
  if (err.code === "P2002") {
    statusCode = 409;
    message = `Ya existe un registro con ese ${err.meta?.target?.join(", ") ?? "valor"}`;
    details = undefined;
    handled = true;
  }

  // Prisma: registro no encontrado en update/delete
  if (err.code === "P2025") {
    statusCode = 404;
    message = "Registro no encontrado";
    details = undefined;
    handled = true;
  }

  // Prisma: clave foranea invalida (ej. usuarioId inexistente al crear un documento)
  if (err.code === "P2003") {
    statusCode = 400;
    message = "Referencia invalida: el recurso relacionado no existe";
    details = undefined;
    handled = true;
  }

  // body-parser: JSON mal formado o cuerpo demasiado grande (son errores de quien llama, no del servidor)
  if (err.type === "entity.parse.failed") {
    statusCode = 400;
    message = "El cuerpo de la peticion no es un JSON valido";
    details = undefined;
    handled = true;
  }
  if (err.type === "entity.too.large") {
    statusCode = 413;
    message = "La peticion es demasiado grande";
    details = undefined;
    handled = true;
  }

  // Multer: archivo demasiado grande, campo inesperado, etc.
  if (err.name === "MulterError") {
    statusCode = 400;
    message =
      err.code === "LIMIT_FILE_SIZE"
        ? "El archivo supera el tamano maximo permitido (15MB)"
        : `Error al subir el archivo: ${err.message}`;
    details = undefined;
    handled = true;
  }

  // Cualquier otro error (fallo de conexion a la DB, bug no previsto, etc.) no debe
  // filtrar detalles internos al cliente: se loguea completo y se responde un mensaje generico.
  if (!handled) {
    console.error(err);
    statusCode = 500;
    message = "Error interno del servidor";
    details = undefined;
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(details ? { details } : {}),
  });
};
