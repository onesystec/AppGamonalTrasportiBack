// Parte una lista en tandas de `size` elementos (para leer o procesar mucho de a poco y no llenar la memoria).
export const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

// Cuantos servicios se leen por tanda en las exportaciones.
export const EXPORT_CHUNK_SIZE = 250;
