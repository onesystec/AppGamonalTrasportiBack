// Publica un APK para que los testers lo bajen desde la app (Ajustes > Acerca de > Actualizar aplicacion).
//
//   node scripts/publicar-apk.mjs <ruta/al/app-debug.apk> [--notas "Que hay de nuevo"] [--forzar]
//
// Lee la version del propio APK (con aapt del SDK de Android), lo sube al bucket privado (R2) y guarda la version publicada en la
// tabla de configuracion. Solo publica si el versionCode es MAYOR que el ya publicado (--forzar lo salta, p. ej. para volver
// atras). Antes de compilar hay que subir versionCode (y versionName) en android/app/build.gradle del frontend: Android no instala
// un APK con el mismo versionCode ni con otra firma (se firma siempre con la misma clave: ver ~/.android/debug.keystore).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/config/prisma.js";
import { getPublishedAndroidUpdate, publishAndroidUpdate } from "../src/services/appUpdate.service.js";
import { uploadObject } from "../src/services/storage.service.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--notas");

if (!file || !existsSync(file)) {
  console.error('Uso: node scripts/publicar-apk.mjs <app-debug.apk> [--notas "texto"] [--forzar]');
  process.exit(1);
}

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), "Library/Android/sdk");
const buildTools = join(sdk, "build-tools");
const newest = existsSync(buildTools) ? readdirSync(buildTools).filter((d) => existsSync(join(buildTools, d, "aapt"))).sort().at(-1) : null;
if (!newest) {
  console.error(`No encuentro aapt en ${buildTools}. Instala las build-tools del SDK de Android.`);
  process.exit(1);
}
const badging = execFileSync(join(buildTools, newest, "aapt"), ["dump", "badging", file], { encoding: "utf8" });
const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/.exec(badging);
if (!pkg) {
  console.error("No pude leer la version del APK.");
  process.exit(1);
}
const [, packageName, versionCodeText, versionName] = pkg;
const versionCode = Number(versionCodeText);
if (packageName !== "com.gamonaltrasporti.app") {
  console.error(`El APK es de ${packageName}, no de com.gamonaltrasporti.app.`);
  process.exit(1);
}

const published = await getPublishedAndroidUpdate();
if (published && versionCode <= published.versionCode && !flag("--forzar")) {
  console.error(`El APK es la version ${versionCode} (${versionName}) y ya esta publicada la ${published.versionCode} (${published.versionName}). Sube versionCode en build.gradle y vuelve a compilar.`);
  await prisma.$disconnect();
  process.exit(1);
}

const buffer = readFileSync(file);
const sha256 = createHash("sha256").update(buffer).digest("hex");
const apkKey = `app/android/gamonal-driver-${versionCode}-${sha256.slice(0, 8)}.apk`;
await uploadObject(apkKey, buffer, "application/vnd.android.package-archive");
await publishAndroidUpdate({
  versionCode,
  versionName,
  notas: option("--notas") ?? "",
  apkKey,
  size: statSync(file).size,
  sha256,
  publicadoAt: new Date().toISOString(),
});
console.log(`Publicado: version ${versionCode} (${versionName}), ${(buffer.length / 1048576).toFixed(1)} MB -> ${apkKey}`);
console.log("Los testers veran 'Hay una version nueva' al abrir la app y en Ajustes > Acerca de.");
await prisma.$disconnect();
