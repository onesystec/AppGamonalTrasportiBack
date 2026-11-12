import { randomBytes } from "node:crypto";
import { prisma } from "../config/prisma.js";
import { SIN_ASIGNAR_CORREO, SIN_ASIGNAR_NOMBRE, SIN_ASIGNAR_TARGA } from "../constants/sinAsignar.js";
import { hashPassword } from "../utils/password.js";

// Chofer y vehiculo "Sin asignar": un servicio no puede existir sin chofer ni vehiculo, asi que los servicios que entran directo desde el portal del
// cliente (ver servicioDirecto.service.js) llevan estas fichas internas hasta que la oficina elige los reales. Se crean solas la primera vez que
// hacen falta. El chofer esta INACTIVO (no sale en las listas para elegir ni puede iniciar sesion: su clave es aleatoria y nadie la conoce) y el
// vehiculo esta fuera de servicio y oculto del mapa.

let cache = null;

export const getSinAsignar = async () => {
  if (cache) return cache;
  const driver =
    (await prisma.user.findUnique({ where: { correoElectronico: SIN_ASIGNAR_CORREO }, select: { id: true } })) ??
    (await prisma.user.create({
      data: {
        nombre: SIN_ASIGNAR_NOMBRE,
        apellido: "",
        area: "SIN_ASIGNAR",
        cargo: "CHOFER",
        estado: "INACTIVO",
        fechaNacimiento: new Date("2000-01-01"),
        numeroCelular: "",
        correoElectronico: SIN_ASIGNAR_CORREO,
        password: await hashPassword(randomBytes(32).toString("hex")),
      },
      select: { id: true },
    }));
  const vehicle =
    (await prisma.vehiculo.findUnique({ where: { targa: SIN_ASIGNAR_TARGA }, select: { id: true } })) ??
    (await prisma.vehiculo.create({
      data: { targa: SIN_ASIGNAR_TARGA, modelo: SIN_ASIGNAR_NOMBRE, area: "SIN_ASIGNAR", estado: "FUERA_DE_SERVICIO", mostrarEnMapa: false },
      select: { id: true },
    }));
  cache = { driverId: driver.id, vehicleId: vehicle.id };
  return cache;
};
