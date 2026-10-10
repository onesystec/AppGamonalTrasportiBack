// Puntaje de estilo de manejo de un chofer a partir de los datos crudos de OneSystec de cada uno de sus servicios.
// OneSystec puntua por 100 km: cada incidente por 100 km resta `puntosPorIncidente` (5) puntos, minimo 1; el
// general es el promedio de las categorias que se pudieron medir. Aqui se suman incidentes y km de todos los
// servicios y se aplica la misma formula, asi un servicio corto no distorsiona y el vehiculo que comparte con
// otros choferes no mezcla su manejo.
export const CATEGORIAS_ESTILO = ["harshBraking", "harshAcceleration", "harshCornering", "speeding"];

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
