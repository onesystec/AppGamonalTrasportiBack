import { festivosDelAnio } from "../utils/feriadosIt.js";

// UNICO lugar con las tarifas de pago a choferes. Si algo cambia, se agrega una tarifa nueva al
// final de PAY_TARIFFS con su mes de inicio ("desde") y NO se toca la anterior: cada servicio se paga
// con la tarifa vigente en el mes en que se hizo, asi los meses ya pagados no se mueven. El pago no
// se guarda: se calcula en cada consulta (ver computeServicePay en services/finanzas.service.js).
//
// Campos de cada tarifa:
//  - horaDiaEur / horaNocheEur: pago por hora trabajada.
//  - kmBloque / kmBloqueDiaEur / kmBloqueNocheEur: sin horas aprobadas se paga por distancia:
//    cada kmBloque km valen tantos EUR segun salga de dia o de noche (equivale a 1 hora de manejo).
//  - esperaHoraEur: hora de espera, se suma encima de cualquiera de las dos modalidades.
//  - banda: de diaInicio a nocheInicio es de dia; el resto es de noche (hora de pared de Roma).
//  - redondeoHoras: las horas (dia, noche y espera) se redondean al multiplo mas cercano (0 = sin redondeo).
//  - reperibilidad: extra por servicio fuera del horario laboral (un solo extra por servicio). Horario laboral = los
//    dias de diasLaborales (1 = lunes ... 7 = domingo); sabado, domingo y festivos son reperibilidad. Con nocheCuenta,
//    tambien lo es el servicio que SALE de noche (fuera de la banda de dia) o que pasa la mayor parte de su duracion en la noche.
//  - pagoPorKm: el chofer NO declara horas: se le paga siempre por distancia (km del sistema / kmBloque = horas de manejo, de
//    dia o de noche segun la salida) mas la espera que declara, sin aprobacion de horas.
//  - tiempoRutaHastaKm: con pago por km, los servicios de menos de estos km se pagan por el TIEMPO de ruta del circuito (ida + vuelta,
//    con o sin peaje segun lo declarado) a la tarifa por hora; desde estos km, km / kmBloque como siempre (en trayectos cortos
//    km / 85 sale muy por debajo del tiempo real de manejo).
//  - jornadaDesdeInicioFin: las horas de dia/noche se recalculan del inicio y fin declarados con la
//    banda de esta tarifa (en vez de usar lo guardado al cargar la jornada).
export const PAY_TARIFFS = [
  {
    desde: "2000-01",
    horaDiaEur: 10,
    horaNocheEur: 12,
    kmBloque: 100,
    kmBloqueDiaEur: 10,
    kmBloqueNocheEur: 10,
    esperaHoraEur: 10,
    banda: { diaInicio: "07:00", nocheInicio: "19:00" },
    redondeoHoras: 0,
    reperibilidad: null,
    jornadaDesdeInicioFin: false,
  },
  {
    desde: "2026-10",
    horaDiaEur: 10,
    horaNocheEur: 12,
    kmBloque: 85,
    kmBloqueDiaEur: 10,
    kmBloqueNocheEur: 12,
    esperaHoraEur: 7,
    banda: { diaInicio: "06:30", nocheInicio: "22:00" },
    redondeoHoras: 0, // sin redondeo: se paga minuto a minuto lo que se declara
    reperibilidad: { extraEur: 10, diasLaborales: [1, 2, 3, 4, 5], festivosCuentan: true, nocheCuenta: true },
    jornadaDesdeInicioFin: true,
    pagoPorKm: true,
    tiempoRutaHastaKm: 200,
  },
];

// Tarifa vigente en un mes "AAAA-MM" (la ultima cuyo "desde" ya empezo).
export const tariffForMonth = (month) => {
  let found = PAY_TARIFFS[0];
  for (const tariff of PAY_TARIFFS) if (tariff.desde <= month) found = tariff;
  return found;
};

export const CURRENT_TARIFF = PAY_TARIFFS[PAY_TARIFFS.length - 1];

// Lo que se le muestra al front: la tarifa + el valor por 100 km (para pantallas viejas) + los
// festivos del año (para que la vista previa del chofer use la misma lista que el servidor).
export const tariffForDisplay = (month) => {
  const tariff = tariffForMonth(month);
  const year = Number(month.slice(0, 4));
  return {
    ...tariff,
    cada100KmEur: Math.round((tariff.kmBloqueDiaEur / tariff.kmBloque) * 10000) / 100,
    festivos: tariff.reperibilidad ? [...festivosDelAnio(year), ...festivosDelAnio(year + 1)] : [],
  };
};

// Solo se paga lo que ya se hizo: entregado o retirado. Anulado, en espera o en curso no generan pago todavia. Un
// servicio reprogramado por la oficina (con reprogramadoAt) tambien se paga: por los km y las horas que hizo el chofer.
export const PAYABLE_STATUSES = ["CONSEGNATO", "RITIRATO"];
