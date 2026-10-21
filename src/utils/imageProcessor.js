import sharp from "sharp";

// Sin cache interna de libvips (por defecto guarda hasta 50 MB de operaciones recientes) y un solo hilo: en una instancia de 512 MB
// una foto de 50 megapixeles no puede sumar a eso.
sharp.cache(false);
sharp.concurrency(1);

const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 82;

// Comprime y normaliza cualquier imagen subida (foto de un documento, etc.) a webp.
// rotate() sin argumentos aplica la orientacion EXIF y despues la descarta.
export const compressImage = async (buffer) =>
  sharp(buffer)
    .rotate()
    .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

// Logo de una empresa cliente: se muestra entero (sin recortar, aunque sea apaisado) sobre fondo transparente.
const LOGO_DIMENSION = 320;
export const compressLogo = async (buffer) =>
  sharp(buffer)
    .rotate()
    .resize({ width: LOGO_DIMENSION, height: LOGO_DIMENSION, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 85 })
    .toBuffer();

const AVATAR_DIMENSION = 256;
const AVATAR_WEBP_QUALITY = 80;

// Los avatares solo se muestran en circulos chicos: se recortan a cuadrado y se
// bajan a un tamano fijo para que cada foto pese unos KB en vez de cientos,
// sin importar la resolucion original que suba el usuario.
export const compressAvatar = async (buffer) =>
  sharp(buffer)
    .rotate()
    .resize({
      width: AVATAR_DIMENSION,
      height: AVATAR_DIMENSION,
      fit: "cover",
      position: sharp.strategy.attention,
    })
    .webp({ quality: AVATAR_WEBP_QUALITY })
    .toBuffer();
