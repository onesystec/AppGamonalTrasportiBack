// Memorandums: tipos, quien puede emitir cada uno y el texto de partida. El nivel de firma por defecto de cada tipo se puede subir a FIRMA al
// emitir (menos en POLITICA, que siempre se firma). Ver memorandum.service.js.
//  - ENTENDIDO: un toque ("he leido y entiendo") antes de abrirlo.
//  - FIRMA: firma manuscrita en pantalla antes de abrirlo, como la busta paga.
const TODOS = ["OWNER", "RRHH", "ADMIN"];
const OFICINA = ["OWNER", "RRHH"];

export const MEMO_TIPOS = {
  CIRCULAR: {
    label: "Circular operativa",
    descripcion: "Cambio de procedimiento o norma de trabajo para todos o para una zona.",
    nivel: "ENTENDIDO",
    roles: TODOS,
    plantilla: `A partir del [fecha] se aplica el siguiente procedimiento:

- [Primera indicación]
- [Segunda indicación]

Motivo: [explica por qué cambia].

Si tienes dudas, consúltalas con tu responsable.`,
  },
  COMUNICACION: {
    label: "Comunicación individual",
    descripcion: "Mensaje formal dirigido a una persona o a un grupo reducido.",
    nivel: "FIRMA",
    roles: OFICINA,
    plantilla: `Por medio del presente te comunicamos que:

[Detalle de la comunicación]

Quedamos a tu disposición para cualquier aclaración.`,
  },
  EQUIPO: {
    label: "Uso del vehículo o equipo",
    descripcion: "Entrega o devolución de furgoneta, tarjeta de carburante, Telepass u otro equipo, y normas de uso.",
    nivel: "FIRMA",
    roles: TODOS,
    plantilla: `Se te entrega para uso laboral:

- Equipo: [descripción]
- Fecha de entrega: [fecha]
- Estado: [estado al entregarlo]

Te comprometes a usarlo solo para el trabajo, cuidarlo y avisar de inmediato cualquier daño o pérdida.`,
  },
  ASIGNACION: {
    label: "Cambio de asignación",
    descripcion: "Nuevo vehículo, zona, turno o cliente.",
    nivel: "FIRMA",
    roles: TODOS,
    plantilla: `A partir del [fecha] tu asignación cambia:

- Antes: [vehículo, zona o turno anterior]
- Ahora: [nueva asignación]

Si hay algún inconveniente, avísanos antes de esa fecha.`,
  },
  VENCIMIENTO: {
    label: "Aviso de vencimiento",
    descripcion: "Aviso formal de un documento por vencer: patente, visita médica, tagliando.",
    nivel: "ENTENDIDO",
    roles: OFICINA,
    plantilla: `Te recordamos que el siguiente documento vence pronto:

- Documento: [patente, visita médica, etc.]
- Fecha de vencimiento: [fecha]

Debes renovarlo antes de esa fecha y entregarnos una copia.`,
  },
  SEGURIDAD: {
    label: "Seguridad y normas",
    descripcion: "Velocidad, descansos, uso del celular al volante, zonas de tráfico limitado.",
    nivel: "ENTENDIDO",
    roles: OFICINA,
    plantilla: `Recordamos a todo el personal de conducción las siguientes normas de seguridad:

- [Norma 1]
- [Norma 2]

El cumplimiento de estas normas es obligatorio.`,
  },
  RECONOCIMIENTO: {
    label: "Reconocimiento",
    descripcion: "Felicitación por metas, puntualidad o buen trabajo.",
    nivel: "ENTENDIDO",
    roles: TODOS,
    plantilla: `Queremos reconocer tu trabajo:

[Motivo del reconocimiento]

Gracias por tu compromiso.`,
  },
  POLITICA: {
    label: "Política de la empresa",
    descripcion: "Privacidad, uso del GPS, confidencialidad u otras normas internas que se firman.",
    nivel: "FIRMA",
    fijo: true,
    roles: OFICINA,
    plantilla: `[Nombre de la política]

Objeto: [qué regula]

Normas:
- [Norma 1]
- [Norma 2]

Con tu firma confirmas que has leído y aceptas esta política.`,
  },
};

export const MEMO_TIPO_KEYS = Object.keys(MEMO_TIPOS);

export const MEMO_EMISOR_LABEL = { OWNER: "Administración", RRHH: "Recursos Humanos", ADMIN: "Responsable" };

// Los recordatorios por push (ver memorandumAvisos.service.js) viven en las variables MEMO_* de env.js.
