-- Sesiones que se cierran al cambiar la contrasena: los tokens emitidos antes de esta fecha ya no valen.
ALTER TABLE "users" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
