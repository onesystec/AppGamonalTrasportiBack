import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middlewares/errorHandler.js";
import routes from "./routes/index.js";

const app = express();

app.use(helmet());
// gzip de las respuestas JSON: GET /records del historial pesa MBs sin comprimir y el
// trafico de salida de Render se cobra por GB pasado el cupo incluido.
app.use(compression());
app.use(
  cors({
    origin: env.CORS_ORIGIN === "*" ? "*" : env.CORS_ORIGIN.split(",").map((o) => o.trim()),
  })
);
app.use(express.json());
if (env.NODE_ENV !== "test") {
  app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));
}

app.get("/api/health", (req, res) => {
  res.status(200).json({ success: true, message: "RegistrosGTBack esta activo" });
});

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler);

export default app;
