import nodemailer from "nodemailer";
import { decryptStreamKey, encryptStreamKey } from "./stream-key.js";

/**
 * E-mail (SMTP) — Integrações (Fase 7). Usado pela API (e-mail de teste) e pelo
 * worker (avisos de alerta). A configuração fica em system_settings
 * ("integrations.smtp"); a senha fica cifrada e nunca vai para o navegador.
 *
 * Gmail: smtp.gmail.com, porta 587, STARTTLS, usuário = e-mail completo e senha =
 * "senha de app" (a conta precisa de verificação em 2 etapas; a senha normal da
 * conta é recusada pelo Google).
 */

export type SmtpSecurity = "starttls" | "tls" | "none";
export type AlertLevel = "warning" | "error" | "critical";

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password_enc: string | null;
  from_name: string;
  from_email: string;
  recipients: string[];
  min_severity: AlertLevel;
  notify_resolved: boolean;
}

export const SMTP_DEFAULTS: SmtpSettings = {
  enabled: false,
  host: "smtp.gmail.com",
  port: 587,
  security: "starttls",
  username: "",
  password_enc: null,
  from_name: "TopCam",
  from_email: "",
  recipients: [],
  min_severity: "error",
  notify_resolved: true,
};

export const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, error: 2, critical: 3 };

export const encryptSecret = encryptStreamKey;
export const decryptSecret = decryptStreamKey;

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** Envia um e-mail. Lança erro com mensagem em português (útil para o painel). */
export async function sendMail(
  s: SmtpSettings,
  encKey: Buffer,
  msg: MailMessage,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  if (!s.host) throw new Error("Servidor SMTP não configurado");
  if (!msg.to.length) throw new Error("Nenhum destinatário");
  const password = s.password_enc ? decryptSecret(s.password_enc, encKey) : "";
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "tls",
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: s.username ? { user: s.username, pass: password } : undefined,
    connectionTimeout: opts.timeoutMs ?? 15_000,
    greetingTimeout: opts.timeoutMs ?? 15_000,
    socketTimeout: (opts.timeoutMs ?? 15_000) * 2,
  });
  try {
    await transport.sendMail({
      from: s.from_email ? { name: s.from_name || "TopCam", address: s.from_email } : s.username,
      to: msg.to.join(", "),
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
  } catch (err) {
    throw new Error(explainSmtpError(err as Error & { code?: string; responseCode?: number }), {
      cause: err,
    });
  } finally {
    transport.close();
  }
}

export function explainSmtpError(err: Error & { code?: string; responseCode?: number }): string {
  const raw = (err.message ?? String(err)).slice(0, 300);
  if (
    err.responseCode === 535 ||
    /535|Username and Password not accepted|BadCredentials/i.test(raw)
  )
    return "Usuário ou senha recusados pelo servidor. No Gmail, use uma senha de app (conta com verificação em 2 etapas), não a senha normal.";
  if (err.code === "ETIMEDOUT" || err.code === "ECONNECTION" || /timeout/i.test(raw))
    return `Sem conexão com o servidor SMTP (${raw}). Verifique servidor, porta e se a VM tem saída para a internet nessa porta.`;
  if (err.code === "EDNS" || /ENOTFOUND|EAI_AGAIN/.test(raw))
    return `Servidor SMTP não encontrado (${raw}).`;
  if (/wrong version number|ssl/i.test(raw))
    return `Falha de criptografia (${raw}). Porta 587 usa STARTTLS; porta 465 usa SSL/TLS.`;
  return `Falha no envio: ${raw}`;
}

export function parseRecipients(text: string | string[]): string[] {
  const list = Array.isArray(text) ? text : text.split(/[\s,;]+/);
  return [...new Set(list.map((x) => x.trim().toLowerCase()).filter(Boolean))];
}
