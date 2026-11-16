import { z } from "zod";

const id = z.string().trim().min(1).max(100);
const testo = (max) => z.string().trim().max(max);
const opz = (max) => testo(max).nullish();

export const idParamSchema = z.object({ id });
export const annulloParamSchema = z.object({ id, recordId: id });

// Oficina (solo Owner, salvo "Reinvia")
export const accettaSchema = z.object({ clientId: id.nullish() });

// API publica (la llama la otra app One Driver). Mismo contrato que App Piazza: no se cambia la forma en que ella habla.
export const richiestaRemotaSchema = z.object({
  segreto: testo(20),
  idRemoto: id,
  url: z.string().url().max(300),
  nome: testo(200).min(1),
  partitaIva: opz(40),
  token: z.string().min(20).max(200),
});
export const servizioRemotoSchema = z
  .object({
    recordId: id,
    codigo: opz(100),
    cliente: opz(200),
    destinazione: testo(500).min(1),
    ritiro: opz(500),
    tappe: z.array(testo(500)).max(30).optional(),
    ciudad: opz(200),
    pais: opz(5),
    eta: z.coerce.date().nullish(),
    fechaServicio: z.coerce.date().nullish(),
    shipment: opz(100),
    orderNumero: opz(100),
    // Km planificados del servicio, tal cual los manda la otra app (en DHL y AB Service son los de ida del cliente): se muestran sin interpretar.
    km: z.number().nonnegative().max(100000).nullish(),
    pesoKg: z.number().nonnegative().max(100000).nullish(),
    dimensioni: opz(200),
    colli: z.number().int().nonnegative().max(100000).nullish(),
    mittente: opz(200),
    note: opz(4000),
  })
  .refine((s) => s.eta || s.fechaServicio, { message: "Manca la data del servizio" });
export const annulloRemotoSchema = z.object({ motivo: opz(300) });
