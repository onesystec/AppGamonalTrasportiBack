// Puntaje de estilo de manejo de un chofer a partir de los datos crudos de OneSystec de cada uno de sus servicios.
// OneSystec puntua por 100 km: cada incidente por 100 km resta `puntosPorIncidente` (5) puntos, minimo 1; el
// general es el promedio de las categorias que se pudieron medir. Aqui se suman incidentes y km de todos los
// servicios y se aplica la misma formula, asi un servicio corto no distorsiona y el vehiculo que comparte con
// otros choferes no mezcla su manejo.
export const CATEGORIAS_ESTILO = ["harshBraking", "harshAcceleration", "harshCornering", "speeding"];

// Tramo (ms) en el que el chofer manejo un servicio, para pedirle a OneSystec su estilo de manejo SOLO en ese rato (el vehiculo lo usan otros).
// Con jornada declarada es la jornada; sin ella (desde octubre de 2026 se paga por km y no se declaran horas) va de la salida del servicio
// (fechaRetiro) hasta que el GPS lo vio llegar a la ultima parada o, si eso no esta, la duracion del circuito (ida y vuelta). Un viaje
// compactado se mide una sola vez, con el circuito completo en su servicio principal. null = no hay como saber el tramo.
export const estiloWindow = (r) => {
  if (r.horaInicioReal && r.horaFinReal) return { from: r.horaInicioReal.getTime(), to: r.horaFinReal.getTime() };
  if ((r.compactadoOrden ?? 1) > 1 || !r.fechaRetiro) return null;
  const from = r.fechaRetiro.getTime();
  const minutes = r.circuitoMin > 0 ? r.circuitoMin : r.rutaDuracionMin > 0 ? r.rutaDuracionMin * 2 : 0;
  const llegada = !r.compactadoId && r.llegadaGpsAt && r.llegadaGpsAt.getTime() > from ? r.llegadaGpsAt.getTime() : null;
  const to = llegada ?? (minutes > 0 ? from + minutes * 60000 : null);
  return to && to > from ? { from, to } : null;
};

const DEFAULT_PUNTOS = 5;
const DEFAULT_MIN_KM = 20;

// items: [{ km, calidad, incidentes: { harshBraking, ... } (null = no se pudo detectar), puntosPorIncidente?, minKm? }]
export const aggregateEstilo = (items) => {
  const usable = items.filter((i) => i && i.calidad !== "no_data" && typeof i.km === "number" && i.km > 0);
  const puntos = usable.find((i) => typeof i.puntosPorIncidente === "number")?.puntosPorIncidente ?? DEFAULT_PUNTOS;
  const minKm = usable.find((i) => typeof i.minKm === "number")?.minKm ?? DEFAULT_MIN_KM;

  const porCategoria = {};
  for (const cat of CATEGORIAS_ESTILO) {
    let incidentes = 0;
    let km = 0;
    for (const item of usable) {
      const n = item.incidentes?.[cat];
      if (typeof n !== "number") continue; // esa categoria no se pudo medir en este servicio
      incidentes += n;
      km += item.km;
    }
    if (km >= minKm) porCategoria[cat] = Math.max(1, Math.min(100, 100 - puntos * (incidentes / km) * 100));
  }

  const values = Object.values(porCategoria);
  if (values.length === 0) return null;
  const overall = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    puntaje: Math.round(overall),
    categorias: Object.fromEntries(Object.entries(porCategoria).map(([k, v]) => [k, Math.round(v)])),
    km: Math.round(usable.reduce((a, i) => a + i.km, 0) * 10) / 10,
  };
};
