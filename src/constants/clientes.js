// Modulos que se le pueden activar a un usuario CLIENTE (User.clienteModulos). Todos son de solo lectura y siempre sobre los servicios
// de su propia empresa. El servidor los exige en cada ruta de /cliente (ver routes/cliente.routes.js).
export const CLIENTE_MODULOS = {
  MAPA: "Mapa de targas en camino",
  LISTA: "Lista de servicios en camino con hora estimada",
  AVISOS: "Avisos al celular de salida, retraso y entrega",
  HISTORIAL: "Historial de servicios",
  FOTOS: "Fotos de entrega y bolla",
  EXCEL: "Descargar sus servicios en Excel",
};
export const CLIENTE_MODULOS_KEYS = Object.keys(CLIENTE_MODULOS);

// Casillas que se marcan solas al crear un usuario cliente.
export const CLIENTE_MODULOS_DEFAULT = ["MAPA", "LISTA", "AVISOS"];

// Un servicio con mas retraso que esto (12 horas) casi seguro es uno viejo que nunca se cerro, no un envio realmente atrasado: no se le
// muestra al cliente ni se le avisa (la oficina lo sigue viendo en el seguimiento y puede cerrarlo).
export const CLIENTE_RETRASO_MAX_MIN = 12 * 60;
