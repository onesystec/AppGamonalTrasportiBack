// Lugares donde los choferes esperan servicios (ademas del deposito, ver depot.js). Una parada del
// vehiculo cerca de uno de ellos es tiempo de trabajo (espera), no una parada "a revisar".
// Coordenadas obtenidas de la direccion con el geocodificador de la app.
// radioM (opcional): radio propio del lugar; sin el se usa STOP_SERVICE_RADIUS_METERS. Cargo City es
// un complejo grande de terminales de carga, por eso tiene un radio mayor.
// tipo "parqueo": donde se dejan los vehiculos al terminar el dia. Una parada ahi cuenta como trabajo, pero
// si la jornada ARRANCA con el vehiculo ahi parado, eso es la salida del vehiculo (se compara con el inicio
// declarado), no una espera: a diferencia de los lugares de espera, ahi nadie espera servicios.
export const WORK_PLACES = [
  {
    nombre: "Parqueo de vehiculos",
    tipo: "parqueo",
    direccion: "Bettola-Zeloforamagno MI (junto al deposito)",
    areas: ["Todas las areas de Milano"],
    lat: 45.431238,
    lng: 9.287778,
  },
  {
    nombre: "Lugar de espera Milano",
    direccion: "Via della Liberazione, 8, 20068 Peschiera Borromeo MI",
    areas: ["DHL Milano", "AB Service", "Extras Piazza Milano"],
    lat: 45.42317626065062,
    lng: 9.293531695992783,
  },
  {
    nombre: "Lugar de espera Roma",
    direccion: "Via Gaspare D'Urso, 94, 00166 La Massimina-Casal Lumbroso RM",
    areas: ["DHL Roma"],
    lat: 41.877128,
    lng: 12.359183,
  },
  {
    nombre: "Lugar de espera Roma (Extras Piazza)",
    direccion: "Cargo City, 00054 Fiumicino RM",
    areas: ["Extras Piazza Roma"],
    lat: 41.801626,
    lng: 12.271827,
    radioM: 500,
  },
];
