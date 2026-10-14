import { env } from "../config/env.js";
import { TIPOS } from "./telegramEngine.js";

// Respaldo con IA: solo se llama cuando las reglas del motor (telegramEngine.js) dejaron texto sin ubicar y todavia falta un
// dato obligatorio. No conversa ni decide que preguntar: solo devuelve los datos que encuentra. Si falla o no hay clave,
// devuelve null y el bot sigue preguntando como siempre.
const MODEL = process.env.TELEGRAM_AI_MODEL || "claude-haiku-5-5";

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
      driverId: nullable({ type: "string", description: "id exacto de la lista de choferes" }),
      vehicleId: nullable({ type: "string", description: "id exacto de la lista de vehiculos" }),
      clientId: nullable({ type: "string", description: "id exacto de la lista de clientes" }),
      fecha: nullable({ type: "string", description: "YYYY-MM-DD" }),
      hora: nullable({ type: "string", description: "HH:mm de la ETA (llegada/entrega)" }),
      horaSalida: nullable({ type: "string", description: "HH:mm de salida" }),
      destinos: nullable({ type: "array", items: { type: "string" }, description: "ciudades en orden, sin la base" }),
      descripcion: nullable({ type: "string" }),
      km: nullable({ type: "number", description: "km que dice el mensaje, solo si los menciona" }),
      aplicativoN: nullable({ type: "integer", description: "numero de aplicativo" }),
    },
    required: ["driverId", "vehicleId", "clientId", "fecha", "hora", "horaSalida", "destinos", "descripcion", "km", "aplicativoN"],
  },
};

export const aiExtractFields = async ({ text, state, refs, today }) => {
  try {
    const anthropic = await getClient();
    if (!anthropic) return null;
    const system = `Extraes datos de un mensaje de Telegram que carga un servicio de transporte (${TIPOS[state.tipo].label}). Hoy es ${today} (Europe/Rome). Usa SOLO los ids de estas listas, tolerando errores de tipeo; si hay duda, null. No inventes nada.
Choferes:
${refs.drivers.map((d) => `${d.id} | ${d.nombre} ${d.apellido}`).join("\n")}
Vehiculos:
${refs.vehicles.map((v) => `${v.id} | ${v.targa}`).join("\n")}
Clientes:
${refs.clients.map((c) => `${c.id} | ${c.nombre}`).join("\n")}`;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      system,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: text }],
    });
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse) return null;
    const out = {};
    for (const [k, v] of Object.entries(toolUse.input)) {
      if (v == null) continue;
      if (k === "driverId" && !refs.drivers.some((d) => d.id === v)) continue;
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
