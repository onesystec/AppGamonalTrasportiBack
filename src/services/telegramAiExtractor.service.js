import { env } from "../config/env.js";
import { TIPOS } from "./telegramEngine.js";

// Respaldo con IA: solo se llama cuando las reglas del motor (telegramEngine.js) dejaron texto sin ubicar y todavia falta un
// dato obligatorio. No conversa ni decide que preguntar: solo devuelve los datos que encuentra. Si falla o no hay clave,
// devuelve null y el bot sigue preguntando como siempre.
// Modelo barato primero; si la cuenta no lo tiene, se reintenta con el que ya usaba el bot antes.
const MODELS = [...new Set([process.env.TELEGRAM_AI_MODEL || "claude-haiku-5-5", "claude-opus-5"])];

let client = null;
const getClient = async () => {
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    // Carga perezosa: el SDK ocupa memoria y casi nunca hace falta.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
};

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

const TOOL = {
  name: "extract_service_fields",
  description: "Devuelve los datos del servicio que se encuentran en el mensaje. null en lo que no aparece.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      vehicleId: nullable({ type: "string", description: "id exacto de la lista de vehiculos" }),
      clientId: nullable({ type: "string", description: "id exacto de la lista de clientes" }),
      fecha: nullable({ type: "string", description: "YYYY-MM-DD" }),
      hora: nullable({ type: "string", description: "HH:mm de la ETA (llegada/entrega)" }),
      horaSalida: nullable({ type: "string", description: "HH:mm de salida" }),
      destinos: nullable({
        type: "array",
        items: { type: "string" },
        description: "ciudad(es) de DESTINO en orden, sin la base. En italiano suele ir tras 'per' o 'verso' (ej. 'per Brescia'). Nunca frases ni preguntas.",
      }),
      descripcion: nullable({
        type: "string",
        description: "resumen breve del encargo en el idioma original: que se lleva, cantidad (colli/parti), urgencia, avisos importantes y contactos. Sin repetir hora, km ni chofer.",
      }),
      km: nullable({ type: "number", description: "km que dice el mensaje, solo si los menciona" }),
      aplicativoN: nullable({ type: "integer", description: "numero de aplicativo" }),
    },
    required: ["vehicleId", "clientId", "fecha", "hora", "horaSalida", "destinos", "descripcion", "km", "aplicativoN"],
  },
};

export const aiExtractFields = async ({ text, state, refs, today }) => {
  try {
    const anthropic = await getClient();
    if (!anthropic) return null;
    const system = `Extraes datos de un mensaje de Telegram (suele ser una orden de transporte en italiano o español, a veces larga) que carga un servicio de transporte (${TIPOS[state.tipo].label}). Las hora tipo "ORE 13.14" son la ETA. Hoy es ${today} (Europe/Rome). Los nombres de personas con que abre el mensaje son de la oficina: ignóralos, nunca elijas chofer. Usa SOLO los ids de estas listas, tolerando errores de tipeo; si hay duda, null. No inventes nada.
Vehiculos:
${refs.vehicles.map((v) => `${v.id} | ${v.targa}`).join("\n")}
Clientes:
${refs.clients.map((c) => `${c.id} | ${c.nombre}`).join("\n")}`;
    let response = null;
    for (const model of MODELS) {
      try {
        response = await anthropic.messages.create({
          model,
          max_tokens: 800,
          system,
          tools: [TOOL],
          tool_choice: { type: "tool", name: TOOL.name },
          messages: [{ role: "user", content: text }],
        });
        break;
      } catch (err) {
        console.error(`[telegram] La IA (${model}) fallo: ${err.status ?? ""} ${err.message}`);
        if (!(err.status === 400 || err.status === 404) || model === MODELS.at(-1)) return null;
      }
    }
    if (!response) return null;
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse) return null;
    const out = {};
    for (const [k, v] of Object.entries(toolUse.input)) {
      if (v == null) continue;
      if (k === "vehicleId") {
        const vehicle = refs.vehicles.find((x) => x.id === v);
        if (!vehicle) continue;
        out.targa = vehicle.targa.replace(/\s/g, "").toUpperCase();
        continue;
      }
      if (k === "clientId" && !refs.clients.some((c) => c.id === v)) continue;
      out[k] = v;
    }
    return out;
  } catch (err) {
    console.error("[telegram] La IA no pudo leer el mensaje:", err.message);
    return null;
  }
};
