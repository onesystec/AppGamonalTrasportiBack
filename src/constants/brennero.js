// Pasos de frontera: casi todos los servicios al exterior de Italia pasan primero por uno de ellos. Cuando un servicio lo marca
// ("¿Pasa por Brennero?" / "¿Pasa por Frejus?"), la ruta se calcula salida -> paso -> paradas.
//  - Brennero: frontera con Austria (norte).
//  - Frejus: tunel hacia Francia (oeste).
// `clave` identifica el paso en la firma del circuito (ver rutaEstimada.service.js).
export const BRENNERO = { clave: "brennero", direccion: "Brennero", lat: 47.003391258222486, lng: 11.505058370120228 };
export const FREJUS = { clave: "frejus", direccion: "Frejus", lat: 45.13942932075698, lng: 6.688667283961707 };

// Pasos que marca un servicio (o los datos de uno), en el orden de la ruta.
export const pasosDe = (r) => [...(r?.pasaPorBrennero ? [BRENNERO] : []), ...(r?.pasaPorFrejus ? [FREJUS] : [])];

// Puntos de la ruta de un servicio: salida, (pasos de frontera si corresponde) y paradas.
export const routePoints = (salida, stops, pasos = []) => [salida, ...pasos, ...stops];
