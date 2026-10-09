import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";
import { r2Client } from "../config/r2.js";

export const uploadObject = (key, buffer, contentType) =>
  r2Client.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

export const deleteObject = (key) =>
  r2Client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }));

// El bucket es privado: nunca se persiste una URL, se firma una fresca en cada respuesta.
export const getSignedUrlForKey = (key, expiresIn = env.R2_SIGNED_URL_EXPIRES_SECONDS) =>
  getSignedUrl(r2Client, new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key }), { expiresIn });
