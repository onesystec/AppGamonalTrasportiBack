import { env } from "../config/env.js";
import { duracion, fechaEnFrase, fechaLarga, hora } from "../utils/fechaEs.js";

export { duracion, fechaEnFrase, fechaLarga, hora };

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const NAVY = "#0b1f33";
const RED = "#c62828";
const AMBER_BG = "#fff6e0";
const AMBER_BORDER = "#f2b84b";

// Correo unico a Responsables y Admin cuando un vehiculo sin autorizacion entra al Area C: que vehiculo, cuando entro y hasta cuando
// hay para pagar. Maquetado con tablas y estilos en linea (es lo unico que respetan Gmail y Outlook); el logo es PNG (WebP no se ve en
// todos los clientes) servido por la propia app.
export const buildAreaCEntryEmail = ({ nombre, targa, modelo, enteredAt, plazoHasta }) => {
  const appUrl = env.APP_URL.replace(/\/$/, "");
  const logoUrl = `${appUrl}/apple-touch-icon.png`;
  const areaCUrl = `${appUrl}/finanzas/area-c`;
  const restante = duracion((plazoHasta.getTime() - enteredAt.getTime()) / 60000);

  const subject = `Área C: ${targa} entró sin autorización · pagar antes del ${fechaEnFrase(plazoHasta)}, ${hora(plazoHasta)}`;

  const fila = (etiqueta, valor, ultimo = false) => `
              <tr>
                <td style="padding:12px 0;${ultimo ? "" : "border-bottom:1px solid #e6eaf0;"}font-size:13px;color:#6b7785;width:42%;">${etiqueta}</td>
                <td style="padding:12px 0;${ultimo ? "" : "border-bottom:1px solid #e6eaf0;"}font-size:15px;color:#1f2933;font-weight:600;">${valor}</td>
              </tr>`;

  const paso = (n, texto) => `
              <tr>
                <td style="width:32px;vertical-align:top;padding:6px 0;">
                  <div style="width:24px;height:24px;border-radius:12px;background:${NAVY};color:#ffffff;font-size:13px;font-weight:bold;line-height:24px;text-align:center;">${n}</div>
                </td>
                <td style="padding:6px 0 6px 8px;font-size:14px;line-height:21px;color:#33414f;">${texto}</td>
              </tr>`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#eef1f5;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(targa)} entró al Área C a las ${hora(enteredAt)}. Plazo para pagar: ${fechaLarga(plazoHasta)}, ${hora(plazoHasta)}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dde3ea;">

          <!-- Cabecera de marca -->
          <tr>
            <td style="background:${NAVY};padding:22px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:64px;vertical-align:middle;">
                    <img src="${logoUrl}" width="56" height="56" alt="Gamonal Driver 2.0" style="display:block;border-radius:28px;background:#ffffff;border:0;">
                  </td>
                  <td style="vertical-align:middle;padding-left:14px;">
                    <div style="font-size:19px;font-weight:700;color:#ffffff;letter-spacing:0.2px;">Gamonal Driver 2.0</div>
                    <div style="font-size:12px;color:#9fb3c8;letter-spacing:1px;text-transform:uppercase;margin-top:3px;">Gestión de flota · Gamonal Trasporti</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Franja de alerta -->
          <tr>
            <td style="background:${RED};padding:11px 28px;font-size:12px;font-weight:700;color:#ffffff;letter-spacing:1.4px;text-transform:uppercase;">
              Aviso importante · Área C de Milán
            </td>
          </tr>

          <!-- Contenido -->
          <tr>
            <td style="padding:30px 28px 8px 28px;">
              <p style="margin:0 0 6px 0;font-size:15px;color:#33414f;">Hola ${esc(nombre)},</p>
              <h1 style="margin:0 0 14px 0;font-size:23px;line-height:30px;color:#12202e;">El vehículo ${esc(targa)} entró al Área C sin autorización</h1>
              <p style="margin:0 0 22px 0;font-size:14px;line-height:22px;color:#33414f;">
                Nuestro sistema de seguimiento detectó que este vehículo circula dentro de la zona de tráfico limitado y <strong>no cuenta con permiso de acceso</strong>.
                Para evitar una multa, el ticket del Área C debe pagarse dentro del plazo indicado.
              </p>

              <!-- Detalle -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid ${NAVY};">
                ${fila("Vehículo", `${esc(targa)}${modelo ? ` · ${esc(modelo)}` : ""}`)}
                ${fila("Zona", "Área C · Milán")}
                ${fila("Fecha de entrada", esc(fechaLarga(enteredAt)))}
                ${fila("Hora de entrada", hora(enteredAt), true)}
              </table>
            </td>
          </tr>

          <!-- Plazo -->
          <tr>
            <td style="padding:20px 28px 8px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${AMBER_BG};border:1px solid ${AMBER_BORDER};border-radius:10px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <div style="font-size:11px;font-weight:700;color:#8a5a00;letter-spacing:1.2px;text-transform:uppercase;">Plazo para pagar sin recargo</div>
                    <div style="font-size:22px;line-height:30px;font-weight:700;color:#5c3b00;margin-top:4px;">${esc(fechaLarga(plazoHasta))} · ${hora(plazoHasta)}</div>
                    <div style="font-size:13px;color:#8a5a00;margin-top:4px;">Quedan ${restante} para pagar. Pasado el plazo, el pago tiene recargo.</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Qué hacer -->
          <tr>
            <td style="padding:22px 28px 6px 28px;">
              <div style="font-size:13px;font-weight:700;color:#12202e;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Qué hay que hacer</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${paso(1, `Pagar el ticket del Área C de <strong>${esc(targa)}</strong> en el portal oficial del Comune di Milano.`)}
                ${paso(2, "Abrir la sección Área C de la app y marcar la entrada como <strong>pagada</strong>, adjuntando la foto del comprobante.")}
                ${paso(3, "Hasta que se marque como pagada, la app seguirá enviando recordatorios al celular de los responsables.")}
              </table>
            </td>
          </tr>

          <!-- Botón -->
          <tr>
            <td align="center" style="padding:26px 28px 30px 28px;">
              <a href="${areaCUrl}" style="display:inline-block;background:${NAVY};color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 32px;border-radius:8px;">
                Abrir Área C en la app
              </a>
              <div style="font-size:12px;color:#7a8794;margin-top:12px;">
                Si el botón no funciona, copie este enlace: <a href="${areaCUrl}" style="color:#1f6feb;">${areaCUrl}</a>
              </div>
            </td>
          </tr>

          <!-- Pie -->
          <tr>
            <td style="background:#f6f8fa;border-top:1px solid #e6eaf0;padding:20px 28px;">
              <div style="font-size:12px;line-height:19px;color:#6b7785;">
                Este es un mensaje automático de <strong>Gamonal Driver 2.0</strong>, enviado a los responsables y administradores a cargo de este vehículo.
                Se envía una sola vez por entrada; los recordatorios posteriores llegan como notificaciones en la app.
              </div>
              <div style="font-size:12px;color:#9aa5b1;margin-top:10px;">© Gamonal Trasporti · Gestión de flota</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    `Hola ${nombre},`,
    "",
    `AVISO IMPORTANTE - ÁREA C DE MILÁN`,
    `El vehículo ${targa}${modelo ? ` (${modelo})` : ""} entró al Área C sin autorización.`,
    "",
    `Entrada: ${fechaLarga(enteredAt)}, ${hora(enteredAt)}`,
    `Plazo para pagar sin recargo: ${fechaLarga(plazoHasta)}, ${hora(plazoHasta)}`,
    "",
    "Qué hay que hacer:",
    "1. Pagar el ticket del Área C en el portal oficial del Comune di Milano.",
    "2. Marcar la entrada como pagada en la app (sección Área C) y adjuntar el comprobante.",
    "3. Hasta entonces, la app enviará recordatorios al celular de los responsables.",
    "",
    `Abrir Área C: ${areaCUrl}`,
    "",
    "Mensaje automático de Gamonal Driver 2.0 - Gamonal Trasporti.",
  ].join("\n");

  return { subject, html, text };
};
