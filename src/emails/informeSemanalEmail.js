import { env } from "../config/env.js";
import { romeDay } from "../utils/romeTime.js";

// Correo del informe semanal (ver services/informeSemanal.service.js): resumen por chofer, detalle de peajes y combustible,
// entregas DHL y km por vehiculo. Maquetado con tablas y estilos en linea (es lo unico que respetan Gmail y Outlook). El detalle
// completo va tambien en el Excel adjunto.

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

const EUR = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" });
const KM = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 });
const euro = (n) => EUR.format(n ?? 0);
const km = (n) => `${KM.format(n ?? 0)} km`;
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const diaLargo = (day) => `${Number(day.slice(8, 10))} de ${MESES[Number(day.slice(5, 7)) - 1]} de ${day.slice(0, 4)}`;
const diaConSemana = (day) => `${DIAS[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${diaLargo(day)}`;
const ddmm = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
const diaCorto = (date) => {
  const d = romeDay(date);
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
};

const th = (text, align = "left") =>
  `<th style="padding:8px 10px;background:${NAVY};color:#ffffff;font-size:12px;font-weight:600;text-align:${align};white-space:nowrap;">${text}</th>`;
const td = (text, { align = "left", bold = false, bg = "" } = {}) =>
  `<td style="padding:7px 10px;border-bottom:1px solid ${LINE};font-size:13px;color:#1f2933;text-align:${align};${bold ? "font-weight:700;" : ""}${bg ? `background:${bg};` : ""}">${text}</td>`;
const tabla = (head, rows) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 4px;">${head}${rows}</table>`;
const titulo = (n, text) =>
  `<h2 style="margin:28px 0 6px;font-size:16px;color:${NAVY};border-bottom:2px solid ${NAVY};padding-bottom:6px;">${n}. ${text}</h2>`;
const nota = (text) => `<p style="margin:6px 0 0;font-size:12px;line-height:18px;color:${MUTED};">${text}</p>`;
const subtitulo = (text, total) =>
  `<p style="margin:16px 0 2px;font-size:14px;color:#1f2933;font-weight:700;">${esc(text)}<span style="float:right;">${total}</span></p>`;

export const buildInformeSemanalEmail = (informe, { prueba = false, presentacion = false } = {}) => {
  const { semana, choferes, vehiculos, totales } = informe;
  const periodo = `del ${diaConSemana(semana.desdeDia)} al ${diaConSemana(semana.hastaDia)}`;
  const dias = Math.round((Date.parse(`${semana.hastaDia}T00:00:00Z`) - Date.parse(`${semana.desdeDia}T00:00:00Z`)) / 86400000) + 1;
  const nombreInforme = dias === 7 ? "Informe semanal de flota" : "Informe de flota";
  const subject = `${prueba ? "[PRUEBA] " : ""}${nombreInforme} · ${ddmm(semana.desdeDia)} al ${ddmm(semana.hastaDia)}/${semana.hastaDia.slice(0, 4)}`;
  const logoUrl = `${env.APP_URL.replace(/\/$/, "")}/apple-touch-icon.png`;

  // Resumen
  const resumenRows =
    choferes
      .map((c, i) =>
        [
          `<tr>`,
          td(esc(c.nombre), { bg: i % 2 ? SOFT : "" }),
          td(c.servicios, { align: "right", bg: i % 2 ? SOFT : "" }),
          td(`${c.dhl.total}${c.dhl.total ? ` <span style="color:${MUTED};font-size:11px;">(${c.dhl.entregados} entreg.)</span>` : ""}`, { align: "right", bg: i % 2 ? SOFT : "" }),
          td(km(c.km), { align: "right", bg: i % 2 ? SOFT : "" }),
          td(euro(c.peajes.total), { align: "right", bg: i % 2 ? SOFT : "" }),
          td(euro(c.combustible.total), { align: "right", bg: i % 2 ? SOFT : "" }),
          `</tr>`,
        ].join("")
      )
      .join("") +
    `<tr>${td("TOTAL", { bold: true, bg: "#e9edf3" })}${td(totales.servicios, { align: "right", bold: true, bg: "#e9edf3" })}${td(`${totales.dhl} <span style="font-size:11px;">(${totales.dhlEntregados} entreg.)</span>`, { align: "right", bold: true, bg: "#e9edf3" })}${td(km(totales.km), { align: "right", bold: true, bg: "#e9edf3" })}${td(euro(totales.peajes), { align: "right", bold: true, bg: "#e9edf3" })}${td(euro(totales.combustible), { align: "right", bold: true, bg: "#e9edf3" })}</tr>`;
  const resumen = tabla(
    `<tr>${th("Chofer")}${th("Servicios", "right")}${th("Entregas DHL", "right")}${th("Km", "right")}${th("Peajes", "right")}${th("Combustible", "right")}</tr>`,
    resumenRows
  );

  // Peajes
  const conPeajes = choferes.filter((c) => c.peajes.items.length > 0);
  const peajes = conPeajes.length
    ? conPeajes
        .map(
          (c) =>
            subtitulo(c.nombre, euro(c.peajes.total)) +
            tabla(
              `<tr>${th("Fecha")}${th("Servicio")}${th("Detalle")}${th("Targa")}${th("Origen")}${th("Importe", "right")}</tr>`,
              c.peajes.items
                .map((i) => `<tr>${td(diaCorto(i.fecha))}${td(esc(i.servicio) || "—")}${td(esc(i.detalle))}${td(esc(i.targa))}${td(esc(i.fuente))}${td(euro(i.importe), { align: "right" })}</tr>`)
                .join("")
            )
        )
        .join("")
    : nota("No hay peajes registrados en este periodo.");

  // Combustible
  const conCombustible = choferes.filter((c) => c.combustible.items.length > 0);
  const combustible = conCombustible.length
    ? conCombustible
        .map(
          (c) =>
            subtitulo(c.nombre, euro(c.combustible.total)) +
            tabla(
              `<tr>${th("Fecha")}${th("Targa")}${th("Gasolinera / origen")}${th("Servicio")}${th("Importe", "right")}</tr>`,
              c.combustible.items
                .map((i) => `<tr>${td(diaCorto(i.fecha))}${td(esc(i.targa))}${td(esc(i.lugar))}${td(esc(i.servicio) || "—")}${td(euro(i.importe), { align: "right" })}</tr>`)
                .join("")
            )
        )
        .join("")
    : nota("No hay cargas de combustible registradas en este periodo.");

  // Entregas DHL (en el correo, cantidad por chofer; la lista completa va en el Excel)
  const conDhl = choferes.filter((c) => c.dhl.total > 0);
  const dhl = conDhl.length
    ? tabla(
        `<tr>${th("Chofer")}${th("Servicios DHL", "right")}${th("Entregados", "right")}${th("Km DHL", "right")}</tr>`,
        conDhl
          .map((c) => `<tr>${td(esc(c.nombre))}${td(c.dhl.total, { align: "right" })}${td(c.dhl.entregados, { align: "right" })}${td(km(c.dhl.items.reduce((s, i) => s + (i.km ?? 0), 0)), { align: "right" })}</tr>`)
          .join("") +
          `<tr>${td("TOTAL", { bold: true, bg: "#e9edf3" })}${td(totales.dhl, { align: "right", bold: true, bg: "#e9edf3" })}${td(totales.dhlEntregados, { align: "right", bold: true, bg: "#e9edf3" })}${td("", { bg: "#e9edf3" })}</tr>`
      ) + nota("La lista de cada entrega (servicio, shipment, destino y estado) está en la hoja «Entregas DHL» del Excel adjunto.")
    : nota("No hubo entregas DHL en este periodo.");

  // Km
  const kmChoferes = tabla(
    `<tr>${th("Chofer")}${th("Servicios", "right")}${th("Km recorridos", "right")}</tr>`,
    choferes.filter((c) => c.servicios > 0).map((c) => `<tr>${td(esc(c.nombre))}${td(c.servicios, { align: "right" })}${td(km(c.km), { align: "right" })}</tr>`).join("") +
      `<tr>${td("TOTAL", { bold: true, bg: "#e9edf3" })}${td(totales.servicios, { align: "right", bold: true, bg: "#e9edf3" })}${td(km(totales.km), { align: "right", bold: true, bg: "#e9edf3" })}</tr>`
  );
  const kmVehiculos = vehiculos.length
    ? `<p style="margin:16px 0 2px;font-size:14px;color:#1f2933;font-weight:700;">Km por vehículo (GPS)</p>` +
      tabla(
        `<tr>${th("Targa")}${th("Modelo")}${th("Km GPS", "right")}</tr>`,
        vehiculos.map((v) => `<tr>${td(esc(v.targa))}${td(esc(v.modelo))}${td(km(v.km), { align: "right" })}</tr>`).join("")
      )
    : "";

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px;background:#ffffff;border-radius:10px;overflow:hidden;">
  <tr><td style="background:${NAVY};padding:20px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:48px;"><img src="${logoUrl}" width="40" height="40" alt="Gamonal Trasporti" style="display:block;border-radius:8px;"></td>
      <td style="padding-left:12px;color:#ffffff;">
        <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.8;">Gamonal Trasporti S.R.L.</div>
        <div style="font-size:20px;font-weight:700;margin-top:2px;">${nombreInforme}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:22px 28px 30px;">
    ${prueba ? `<p style="margin:0 0 14px;padding:10px 12px;background:#fff6e0;border:1px solid #f2b84b;border-radius:6px;font-size:13px;color:#7a5200;"><b>Envío de prueba.</b> Solo lo recibes tú para revisarlo; el envío oficial sale cada sábado a primera hora a la oficina.</p>` : ""}
    ${presentacion ? `<p style="margin:0 0 14px;padding:10px 12px;background:#eaf2ff;border:1px solid #9cbcf0;border-radius:6px;font-size:13px;color:#123a75;"><b>Aviso:</b> a partir de este sábado recibirán este informe <b>todos los sábados a primera hora</b>, con la actividad de la semana anterior (de sábado a viernes).</p>` : ""}
    <p style="margin:0;font-size:14px;line-height:21px;color:#33414f;">Buenos días,</p>
    <p style="margin:8px 0 0;font-size:14px;line-height:21px;color:#33414f;">a continuación el resumen de la actividad de la flota <b>${periodo}</b>: peajes, combustible, entregas DHL y kilómetros por chofer. El detalle completo va en el Excel adjunto.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0 4px;"><tr>
      ${[
        ["Peajes", euro(totales.peajes)],
        ["Combustible", euro(totales.combustible)],
        ["Entregas DHL", `${totales.dhl}`],
        ["Km recorridos", km(totales.km)],
      ]
        .map(
          ([k, v]) =>
            `<td style="width:25%;padding:4px;"><div style="background:${SOFT};border-radius:8px;padding:12px 10px;text-align:center;"><div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.5px;">${k}</div><div style="font-size:18px;font-weight:700;color:${NAVY};margin-top:4px;">${v}</div></div></td>`
        )
        .join("")}
    </tr></table>

    ${titulo(1, "Resumen por chofer")}
    ${resumen}

    ${titulo(2, "Peajes por chofer")}
    ${peajes}
    ${nota("Se cuentan los mancatos asignados a cada servicio o, si no hay, el importe cargado en el servicio, más los mancatos del periodo que todavía no tienen servicio. Los avisos de mancato llegan con días de retraso: este total puede aumentar en las próximas semanas.")}

    ${titulo(3, "Combustible por chofer")}
    ${combustible}
    ${nota("Se cuentan los comprobantes subidos con fecha dentro del periodo y, en los servicios sin comprobantes, el importe cargado en el servicio.")}

    ${titulo(4, "Entregas DHL del periodo")}
    ${dhl}

    ${titulo(5, "Kilómetros del periodo")}
    ${kmChoferes}
    ${nota("Km recorridos de los servicios trabajados (los km reales cargados por el chofer o, si faltan, los del servicio).")}
    ${kmVehiculos}

    <p style="margin:28px 0 0;font-size:14px;line-height:21px;color:#33414f;">Un saludo,<br><b>Gamonal Trasporti S.R.L.</b></p>
  </td></tr>
  <tr><td style="background:${SOFT};padding:14px 28px;font-size:11px;line-height:17px;color:${MUTED};">
    Informe generado automáticamente por la app de Gamonal Trasporti con los datos registrados hasta el momento del envío. Período: ${semana.desdeDia} a ${semana.hastaDia} (hora de Italia).
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${prueba ? "[PRUEBA] " : ""}${nombreInforme} - Gamonal Trasporti S.R.L.`,
    `Período: ${periodo}`,
    ...(presentacion ? ["", "Aviso: a partir de este sábado recibirán este informe todos los sábados a primera hora, con la actividad de la semana anterior (de sábado a viernes)."] : []),
    "",
    `Totales: peajes ${euro(totales.peajes)} · combustible ${euro(totales.combustible)} · entregas DHL ${totales.dhl} (${totales.dhlEntregados} entregadas) · ${km(totales.km)}`,
    "",
    "Resumen por chofer:",
    ...choferes.map((c) => `- ${c.nombre}: ${c.servicios} servicios, ${c.dhl.total} DHL, ${km(c.km)}, peajes ${euro(c.peajes.total)}, combustible ${euro(c.combustible.total)}`),
    "",
    "El detalle completo va en el Excel adjunto.",
  ].join("\n");

  return { subject, html, text };
};
