-- Idioma de la app de cada usuario (es / it), elegido en Ajustes de la app. Por defecto espanol.
ALTER TABLE "users" ADD COLUMN "idioma" TEXT NOT NULL DEFAULT 'es';
