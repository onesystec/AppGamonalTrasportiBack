// Correo del informe diario de vencimientos (ver services/informeDiario.service.js). Tablas y estilos en linea, como el
// informe semanal, para que se vea bien en Gmail, Zoho y Outlook.

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const NAVY = "#0b1f33";
const MUTED = "#6b7785";
const LINE = "#e6eaf0";
const SOFT = "#f4f6f9";
const RED = "#c62828";

const EUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const euro = (n) => EUR.format(n ?? 0);
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const diaLargo = (day) => `${DIAS[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${Number(day.slice(8, 10))} de ${MESES[Number(day.slice(5, 7)) - 1]}`;
const ddmm = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const TITULAR = { SRL: "S.R.L.", INDIVIDUAL: "Individual" };

const th = (t, right) => `<th style="text-align:${right ? "right" : "left"};padding:8px 10px;font-size:12px;color:${MUTED};font-weight:600;border-bottom:1px solid ${LINE}">${t}</th>`;
const td = (t, right, strong) =>
  `<td style="text-align:${right ? "right" : "left"};padding:8px 10px;font-size:14px;color:${NAVY};border-bottom:1px solid ${LINE};${strong ? "font-weight:700;" : ""}">${t}</td>`;

const kpi = (label, cantidad, total, rojo) => `
  <td style="padding:12px 14px;background:${SOFT};border-radius:8px;width:50%">
    <div style="font-size:12px;color:${MUTED}">${label}</div>
    <div style="font-size:22px;font-weight:700;color:${rojo && cantidad ? RED : NAVY}">${cantidad} · ${euro(total)}</div>
  </td>`;

const tabla = (headers, rows) =>
  rows.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:8px"><tr>${headers.join("")}</tr>${rows.join("")}</table>`
    : `<p style="font-size:14px;color:${MUTED};margin:8px 0 0">Nada que vence.</p>`;

export const buildInformeDiarioEmail = (r) => {
  const { hoy, manana, pasado } = r;
  const subject = `Vencimientos ${ddmm(hoy)}: ${r.multas.hoy.cantidad} multa(s) hoy, ${r.datosConductor.hoy + r.datosConductor.proximos} dato(s) del conductor por enviar`;
  const venceTxt = (d) => (d === hoy ? "Hoy" : d === manana ? "Mañana" : "Pasado mañana");
  const prox = `Próximos 2 días (${ddmm(manana)}–${ddmm(pasado)})`;

  const multasRows = r.multas.items.map((m) =>
    `<tr>${td(venceTxt(m.vence), false, m.vence === hoy)}${td(esc(m.verbale))}${td(esc(m.targa))}${td(esc(m.chofer ?? "Sin chofer"))}${td(esc(TITULAR[m.titular] ?? "—"))}${td(euro(m.costo), true, true)}</tr>`
  );
  const datosRows = r.datosConductor.items.map((d) =>
    `<tr>${td(venceTxt(d.limite), false, d.limite === hoy)}${td(esc(d.verbale))}${td(esc(d.targa))}${td(esc(d.chofer ?? "Sin chofer"))}${td(esc(TITULAR[d.titular] ?? "—"))}</tr>`
  );
  const mancatosRows = r.mancatos.items.map((m) =>
    `<tr>${td(venceTxt(m.vence), false, m.vence === hoy)}${td(esc(m.numero))}${td(esc(m.targa))}${td(esc(m.chofer ?? "Sin chofer"))}${td(esc(m.sitioWeb ?? "—"))}${td(euro(m.costo), true, true)}</tr>`
  );

  const html = `<!doctype html><html><body style="margin:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%">
<tr><td style="font-size:12px;color:${MUTED};letter-spacing:.06em;text-transform:uppercase">Oficina Virtual · Gamonal Trasporti</td></tr>
<tr><td style="font-size:22px;font-weight:700;color:${NAVY};padding:4px 0 16px">Vencimientos del ${diaLargo(hoy)}</td></tr>

<tr><td style="font-size:16px;font-weight:700;color:${NAVY};padding-top:8px">Multas</td></tr>
<tr><td><table role="presentation" width="100%" cellspacing="8" cellpadding="0"><tr>${kpi("Vencen hoy", r.multas.hoy.cantidad, r.multas.hoy.total, true)}${kpi(prox, r.multas.proximos.cantidad, r.multas.proximos.total)}</tr></table></td></tr>
<tr><td>${tabla([th("Vence"), th("Verbale"), th("Targa"), th("Chofer"), th("Titular"), th("Importe", true)], multasRows)}</td></tr>
${r.multas.vencidasSinPagar ? `<tr><td style="font-size:13px;color:${RED};padding-top:6px">Además hay ${r.multas.vencidasSinPagar} multa(s) ya vencida(s) sin pagar.</td></tr>` : ""}

<tr><td style="font-size:16px;font-weight:700;color:${NAVY};padding-top:22px">Datos del conductor por enviar</td></tr>
<tr><td style="font-size:13px;color:${MUTED}">Hoy: ${r.datosConductor.hoy} · Próximos 2 días: ${r.datosConductor.proximos} · hay que hacerlos firmar antes del plazo</td></tr>
<tr><td>${tabla([th("Plazo"), th("Verbale"), th("Targa"), th("Chofer"), th("Titular")], datosRows)}</td></tr>

<tr><td style="font-size:16px;font-weight:700;color:${NAVY};padding-top:22px">Mancatos y peajes</td></tr>
<tr><td><table role="presentation" width="100%" cellspacing="8" cellpadding="0"><tr>${kpi("Vencen hoy", r.mancatos.hoy.cantidad, r.mancatos.hoy.total, true)}${kpi(prox, r.mancatos.proximos.cantidad, r.mancatos.proximos.total)}</tr></table></td></tr>
<tr><td>${tabla([th("Vence"), th("Número"), th("Targa"), th("Chofer"), th("Autopista"), th("Importe", true)], mancatosRows)}</td></tr>
${r.mancatos.vencidosSinPagar ? `<tr><td style="font-size:13px;color:${RED};padding-top:6px">Además hay ${r.mancatos.vencidosSinPagar} mancato(s) ya vencido(s) sin pagar.</td></tr>` : ""}

<tr><td style="font-size:12px;color:${MUTED};padding-top:24px">Informe automático de Driver 2.0. Mancatos: vencimiento = fecha del aviso + 13 días.</td></tr>
</table></td></tr></table></body></html>`;

  const lineas = [
    `Vencimientos del ${diaLargo(hoy)}`,
    "",
    `MULTAS · hoy: ${r.multas.hoy.cantidad} (${euro(r.multas.hoy.total)}) · próximos 2 días: ${r.multas.proximos.cantidad} (${euro(r.multas.proximos.total)})`,
    ...r.multas.items.map((m) => `- ${venceTxt(m.vence)} · ${m.verbale} · ${m.targa} · ${m.chofer ?? "Sin chofer"} · ${euro(m.costo)}`),
    "",
    `DATOS DEL CONDUCTOR · hoy: ${r.datosConductor.hoy} · próximos 2 días: ${r.datosConductor.proximos}`,
    ...r.datosConductor.items.map((d) => `- ${venceTxt(d.limite)} · ${d.verbale} · ${d.targa} · ${d.chofer ?? "Sin chofer"}`),
    "",
    `MANCATOS · hoy: ${r.mancatos.hoy.cantidad} (${euro(r.mancatos.hoy.total)}) · próximos 2 días: ${r.mancatos.proximos.cantidad} (${euro(r.mancatos.proximos.total)})`,
    ...r.mancatos.items.map((m) => `- ${venceTxt(m.vence)} · ${m.numero} · ${m.targa} · ${m.chofer ?? "Sin chofer"} · ${euro(m.costo)}`),
  ];
  return { subject, html, text: lineas.join("\n") };
};
