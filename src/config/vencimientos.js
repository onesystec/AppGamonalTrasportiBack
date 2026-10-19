// Vista de Vencimientos (choferes y vehiculos): que se muestra y cuando avisa cada fecha.

// Documentos de choferes con fecha de vencimiento, en el orden de las columnas.
export const DOCUMENTOS_CHOFER = [
  "UNILAV",
  "SOGGIORNO",
  "PATENTE",
  "TRADUZIONE_PATENTE",
  "CODICE_FISCALE",
  "CARTA_IDENTITA",
  "PASSAPORTO",
  "PERMESSO_TRASPORTO",
];

// Dias de aviso por documento: desde ahi la fecha pasa a "vence pronto". Los que tardan en renovarse avisan antes.
export const AVISO_DIAS = {
  SOGGIORNO: 90,
  PATENTE: 60,
  TRADUZIONE_PATENTE: 60,
};
export const AVISO_DIAS_DEFAULT = 30;

// Seguro y revision de los vehiculos.
export const AVISO_DIAS_VEHICULO = 30;

// Tagliando: mismos valores que la seccion Mecanica (TAGLIANDO_* en el front, lib/constants.js), en km restantes.
export const TAGLIANDO_INTERVALO_KM = 20000;
export const TAGLIANDO_KM_RECORDATORIO = 3500;
export const TAGLIANDO_KM_URGENTE = 1500;
