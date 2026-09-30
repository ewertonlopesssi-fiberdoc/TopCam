import { PLATFORM, getSetting, withScope, type Pool } from "@topcam/db";
import { SMTP_DEFAULTS, sendMail, type SmtpSettings } from "@topcam/shared";

/** Configuração de e-mail salva em Configurações → Integrações (sempre no escopo da plataforma). */
export async function loadSmtp(pool: Pool): Promise<SmtpSettings> {
  return withScope(pool, PLATFORM, async (c) => ({
    ...SMTP_DEFAULTS,
    ...(await getSetting<Partial<SmtpSettings>>(c, "integrations.smtp", {})),
  }));
}

/** E-mail pronto para envio: ligado e com servidor configurado. */
export const smtpReady = (s: SmtpSettings) => s.enabled && Boolean(s.host);

export interface AccessMail {
  to: string;
  name: string;
  password: string;
  mustChange: boolean;
  panelUrl: string;
}

/**
 * Envia os dados de acesso (e-mail + senha). A senha vai só no corpo do e-mail;
 * o registro de envios guarda apenas destinatário, assunto e resultado.
 * Retorna null se enviado ou a mensagem de erro.
 */
export async function sendAccessMail(
  pool: Pool,
  encKey: Buffer,
  m: AccessMail,
): Promise<string | null> {
  const s = await loadSmtp(pool);
  const subject = "[TopCam] Seus dados de acesso";
  let error: string | null = null;
  if (!smtpReady(s)) {
    error = "O envio de e-mail não está configurado (Configurações → Integrações).";
  } else {
    try {
      await sendMail(s, encKey, {
        to: [m.to],
        subject,
        text: [
          `Olá, ${m.name}.`,
          "",
          "Seus dados de acesso ao TopCam:",
          "",
          `Endereço: ${m.panelUrl}`,
          `Usuário: ${m.to}`,
          `Senha: ${m.password}`,
          "",
          m.mustChange
            ? "No primeiro acesso você deverá trocar a senha."
            : "Recomendamos trocar a senha em Configurações → Minha conta.",
          "",
          "Não compartilhe estes dados. Se você não esperava este e-mail, avise o administrador.",
          "",
          "— TopCam (mensagem automática)",
        ].join("\n"),
      });
    } catch (err) {
      error = (err as Error).message;
    }
  }
  await withScope(pool, PLATFORM, (c) =>
    c.query(
      `INSERT INTO notifications (kind, recipients, subject, status, error) VALUES ('access', $1, $2, $3, $4)`,
      [m.to, subject, error ? "failed" : "sent", error],
    ),
  );
  return error;
}
