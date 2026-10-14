import { env } from "../config/env.js";
import { TIPOS, norm, tokenClose } from "./telegramEngine.js";

// Respaldo con IA: solo se llama cuando las reglas del motor (telegramEngine.js) dejaron texto sin ubicar y todavia falta un
// dato obligatorio. No conversa ni decide que preguntar: solo devuelve los datos que encuentra. Si falla o no hay clave,
// devuelve null y el bot sigue preguntando como siempre.
// Modelo barato primero; si la cuenta no lo tiene, se reintenta con el que ya usaba el bot antes.
const MODELS = [...new Set([process.env.TELEGRAM_AI_MODEL || "claude-haiku-5-5", "claude-opus-5"])];

// Se le mandan SOLO los clientes que se parecen al texto (no los ~230): la lista completa con ids eran ~11.000 tokens por
// llamada y casi todos inutiles. El vehiculo y el chofer no se mandan: siempre se eligen con botones.
const MAX_CLIENT_CANDIDATES = 15;

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

// Clientes cuyo nombre comparte alguna palabra (con 1 letra de tolerancia en las largas) con el texto; primero los que
// comparten mas palabras.
export const candidateClients = (text, clients) => {
  const words = [...new Set(norm(text).split(" ").filter((w) => w.length >= 3))];
  return clients
    .map((c) => {
      const tokens = norm(c.nombre).split(" ").filter((t) => t.length >= 3);
      const hits = tokens.filter((t) => words.some((w) => tokenClose(w, t))).length;
      return { c, score: hits ? hits + hits / tokens.length / 10 : 0 };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CLIENT_CANDIDATES)
    .map((x) => x.c);
};

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

const buildTool = (clientNames) => {
  const properties = {
    ...(clientNames.length ? { cliente: nullable({ type: "string", enum: clientNames, description: "el cliente del servicio, solo si el texto lo nombra" }) } : {}),
    fecha: nullable({ type: "string", description: "YYYY-MM-DD" }),
    hora: nullable({ type: "string", description: "HH:mm de la ETA (llegada/entrega)" }),
    horaSalida: nullable({ type: "string", description: "HH:mm de salida" }),
    destinos: nullable({
      type: "array",
      items: { type: "string" },
      description: "ciudad(es) de DESTINO en orden, sin la base. En italiano suele ir tras 'per' o 'verso' (ej. 'per Brescia'). Nunca frases ni preguntas.",
    }),
    km: nullable({ type: "number", description: "km que dice el mensaje, solo si los menciona" }),
    aplicativoN: nullable({ type: "integer", description: "numero de aplicativo" }),
  };
  return {
    name: "extract_service_fields",
    description: "Devuelve los datos del servicio que se encuentran en el mensaje. null en lo que no aparece.",
    strict: true,
    input_schema: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
  };
};

export const aiExtractFields = async ({ text, state, refs, today }) => {
  try {
    const anthropic = await getClient();
    if (!anthropic) return null;
    // Si el cliente ya esta claro (el escrito en el mensaje) no hace falta pedirselo a la IA; uno puesto solo por defecto si.
    const needsClient = !state.clientId || state.clientAuto;
    const candidates = needsClient ? candidateClients(text, refs.clients) : [];
    const tool = buildTool(candidates.map((c) => c.nombre));
    const system = `Extraes datos de un mensaje de Telegram (suele ser una orden de transporte en italiano o español, a veces larga) que carga un servicio de transporte (${TIPOS[state.tipo].label}). Las hora tipo "ORE 13.14" son la ETA. Hoy es ${today} (Europe/Rome). Los nombres de personas con que abre el mensaje son de la oficina: ignóralos. Si hay duda, null. No inventes nada.`;
    let response = null;
    for (const model of MODELS) {
      try {
        response = await anthropic.messages.create({
          model,
          max_tokens: 800,
          system,
          tools: [tool],
          tool_choice: { type: "tool", name: tool.name },
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
      if (k === "cliente") {
        const found = candidates.find((c) => c.nombre === v);
        if (found) out.clientId = found.id;
        continue;
      }
      out[k] = v;
    }
    return out;
  } catch (err) {
    console.error("[telegram] La IA no pudo leer el mensaje:", err.message);
    return null;
  }
};
