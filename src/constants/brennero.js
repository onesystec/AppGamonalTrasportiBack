// Paso de Brennero (frontera con Austria): casi todos los servicios al exterior de Italia pasan primero por aca. Cuando un servicio lo marca
// ("¿Pasa por Brennero?"), la ruta se calcula salida -> Brennero -> paradas.
export const BRENNERO = { direccion: "Brennero", lat: 47.003391258222486, lng: 11.505058370120228 };

// Puntos de la ruta de un servicio: salida, (Brennero si corresponde) y paradas.
export const routePoints = (salida, stops, pasaPorBrennero) => [salida, ...(pasaPorBrennero ? [BRENNERO] : []), ...stops];
