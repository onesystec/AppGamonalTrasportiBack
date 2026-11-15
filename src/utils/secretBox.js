import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "./AppError.js";

// Cifrado simetrico (AES-256-GCM) para guardar en la base el token con el que Gamonal llama a otra app One Driver (Collegamento.tokenUscente).
// La clave sale de COLLEGAMENTI_ENCRYPTION_KEY (variable de entorno, nunca en el repo). Sin ella no se cifra nada: se responde 503 en vez de guardar en claro.
const key = () => {
  if (!env.COLLEGAMENTI_ENCRYPTION_KEY) throw new AppError("Collegamenti non configurati: manca COLLEGAMENTI_ENCRYPTION_KEY", 503);
  return createHash("sha256").update(env.COLLEGAMENTI_ENCRYPTION_KEY).digest();
};

export const encryptSecret = (plain) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
};

export const decryptSecret = (packed) => {
  const [iv, tag, data] = String(packed).split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
};
