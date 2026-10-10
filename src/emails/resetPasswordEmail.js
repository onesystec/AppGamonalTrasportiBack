import { env } from "../config/env.js";

export const buildResetPasswordEmail = ({ nombre, rawToken }) => {
  const resetLink = `${env.RESET_PASSWORD_URL}?token=${rawToken}`;

  const subject = "Recuperacion de contrasena - Gamonal Driver 2.0";

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1f2933;">
      <h2>Hola ${nombre},</h2>
      <p>Recibimos una solicitud para restablecer tu contrasena en Gamonal Driver 2.0.</p>
      <p>Hace clic en el siguiente boton para elegir una nueva contrasena. Este enlace expira en ${env.RESET_TOKEN_EXPIRES_MINUTES} minutos.</p>
      <p style="margin: 24px 0;">
        <a href="${resetLink}" style="background: #1f6feb; color: #ffffff; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: bold;">
          Restablecer contrasena
        </a>
      </p>
      <p>Si el boton no funciona, copia y pega este enlace en tu navegador:</p>
      <p><a href="${resetLink}">${resetLink}</a></p>
      <p>Si no solicitaste este cambio, puedes ignorar este correo.</p>
    </div>
  `;

  return { subject, html };
};
