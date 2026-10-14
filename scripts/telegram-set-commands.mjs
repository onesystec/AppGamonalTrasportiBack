// Registra el menu de comandos del bot de Telegram (lo que aparece al escribir "/"). Se corre una sola vez, o cuando cambian los
// comandos:  node --env-file=.env scripts/telegram-set-commands.mjs
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Falta TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const commands = [
  { command: "dm", description: "Nuevo servicio DHL Milano" },
  { command: "dr", description: "Nuevo servicio DHL Roma" },
  { command: "pm", description: "Nuevo servicio Extras Piazza Milano" },
  { command: "pr", description: "Nuevo servicio Extras Piazza Roma" },
  { command: "ab", description: "Nuevo servicio AB Service" },
  { command: "o", description: "Nuevo servicio Otros" },
  { command: "hoy", description: "Servicios de hoy" },
  { command: "deshacer", description: "Anula lo ultimo que cargaste (10 min)" },
  { command: "ayuda", description: "Como cargar un servicio" },
];

const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ commands }),
});
console.log(res.status, await res.text());
