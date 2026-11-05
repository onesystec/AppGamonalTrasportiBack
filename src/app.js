import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { apiLimiter } from "./middlewares/apiLimiter.js";
import { errorHandler, notFound } from "./middlewares/errorHandler.js";
import routes from "./routes/index.js";
import { trackRequests } from "./utils/memoryMonitor.js";

const app = express();

// Render pone UN proxy delante de la app: con esto req.ip es la IP real del cliente (si no, todos comparten la del proxy y el
// limitador de intentos de login bloquea a todo el mundo a la vez). Es un numero de saltos, no una lista de subredes.
app.set("trust proxy", 1);

app.use(helmet());
// gzip de las respuestas JSON: GET /records del historial pesa MBs sin comprimir y el
// trafico de salida de Render se cobra por GB pasado el cupo incluido.
app.use(compression());
app.use(
  cors({
    origin: env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(",").map((o) => o.trim()),
  })
);
// Antes de leer el cuerpo: una peticion de mas no gasta memoria ni CPU en parsear.
app.use("/api", apiLimiter);
app.use(express.json());
if (env.NODE_ENV !== "test") {
  app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));
}

// Lleva la cuenta de las peticiones en curso para el rastro de memoria (ver utils/memoryMonitor.js).
app.use(trackRequests);

app.get("/api/health", (req, res) => {
  res.status(200).json({ success: true, message: "RegistrosGTBack esta activo" });
});

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
