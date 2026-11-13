import { prisma } from "../config/prisma.js";

// upsert por "token" (no por userId): si el mismo celular reinstala la app o cambia de
// cuenta, el token nuevo (o el mismo, reasignado) queda apuntando al usuario correcto
// en vez de acumular filas viejas de otra sesion.
export const upsertPushToken = (userId, token, platform) =>
  prisma.pushToken.upsert({
    where: { token },
    update: { userId, platform },
    create: { userId, token, platform },
  });

export const deletePushToken = (userId, token) =>
  prisma.pushToken.deleteMany({ where: { userId, token } });

// Limpieza de tokens que Firebase reporto como invalidos/desinstalados (ver
// pushNotification.service.js) - evita reintentar en vano en cada alerta futura.
export const deletePushTokensByToken = (tokens) =>
  prisma.pushToken.deleteMany({ where: { token: { in: tokens } } });

export const findPushTokensForUserIds = (userIds) =>
  prisma.pushToken.findMany({
    where: { userId: { in: userIds } },
    select: { token: true, platform: true },
  });
