import { createHash, timingSafeEqual } from "node:crypto";
import express, { Router } from "express";
import { env } from "../config/env.js";
import { authenticate } from "../middlewares/authenticate.js";
import { getAndroidUpdate, publishAndroidApk } from "../services/appUpdate.service.js";
import { AppError } from "../utils/AppError.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = Router();

const sameSecret = (given, expected) => {
  const digest = (value) => createHash("sha256").update(String(value)).digest();
  return timingSafeEqual(digest(given), digest(expected));
};

// Publica un APK nuevo (lo llama GitHub Actions al compilar). No usa sesion: va con la clave APP_PUBLISH_TOKEN en la cabecera
// x-publish-token. El APK va como cuerpo binario y los datos en cabeceras (x-version-code, x-version-name, x-notas codificada).
router.post(
  "/android/publicar",
  express.raw({ type: () => true, limit: "150mb" }),
  asyncHandler(async (req, res) => {
    if (!env.APP_PUBLISH_TOKEN) throw new AppError("La publicacion automatica de APK no esta activada en el servidor", 503);
    if (!sameSecret(req.get("x-publish-token") ?? "", env.APP_PUBLISH_TOKEN)) throw new AppError("Clave de publicacion invalida", 401);

    const versionCode = Number(req.get("x-version-code"));
    const versionName = (req.get("x-version-name") ?? "").trim();
    if (!Number.isInteger(versionCode) || versionCode < 1) throw new AppError("x-version-code invalido", 400);
    if (!/^[\w.+-]{1,30}$/.test(versionName)) throw new AppError("x-version-name invalido", 400);
    let notas = "";
    try {
      notas = decodeURIComponent(req.get("x-notas") ?? "").slice(0, 500);
    } catch {
      notas = "";
    }
    const body = req.body;
    // Un APK es un ZIP ("PK") de varios MB: evita guardar por error cualquier otra cosa.
    if (!Buffer.isBuffer(body) || body.length < 1_000_000 || body[0] !== 0x50 || body[1] !== 0x4b) {
      throw new AppError("El cuerpo no parece un APK", 400);
    }

    const data = await publishAndroidApk({ buffer: body, versionCode, versionName, notas });
    res.status(201).json({ success: true, data: { versionCode: data.versionCode, versionName: data.versionName, size: data.size } });
  })
);

router.use(authenticate);

// Ultima version publicada del APK (o null si no se publico ninguna) con una URL firmada para descargarla.
router.get(
  "/android",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, data: { android: await getAndroidUpdate() } });
  })
);

export default router;
