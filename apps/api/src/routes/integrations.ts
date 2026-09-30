import { PLATFORM, withScope } from "@topcam/db";
import {
  encryptSecret,
  parseEncryptionKey,
  parseRecipients,
  sendMail,
  type SmtpSettings,
} from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { badRequest, parseBody } from "../lib/http.js";
import { loadSmtp } from "../lib/mail.js";

/**
 * Integrações (Fase 7) — só o Super Admin (settings.write).
 *
 *  GET  /api/v1/integrations              configuração do e-mail (sem a senha) e últimos envios
 *  PUT  /api/v1/integrations/smtp         salva (senha cifrada; em branco = mantém)
 *  POST /api/v1/integrations/smtp/test    envia um e-mail de teste com a configuração salva
 */

const email = z.string().trim().toLowerCase().email().max(200);
const smtpBody = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().max(200),
    port: z.number().int().min(1).max(65535),
    security: z.enum(["starttls", "tls", "none"]),
    username: z.string().trim().max(200),
    /** undefined = mantém a senha salva; "" = apaga; texto = nova senha. */
    password: z.string().max(500).optional(),
    fromName: z.string().trim().max(80),
    fromEmail: email.or(z.literal("")),
    recipients: z.union([z.string().max(4000), z.array(z.string().max(200)).max(50)]),
    minSeverity: z.enum(["warning", "error", "critical"]),
    notifyResolved: z.boolean(),
  })
  .strict();

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  const { env, pool } = app.deps;
  const encKey = parseEncryptionKey(env.STREAM_KEY_ENC_KEY);
  const admin = { preHandler: app.requirePermission("settings.write") };

  const load = (): Promise<SmtpSettings> => loadSmtp(pool);

  app.get("/api/v1/integrations", admin, async () => {
    const s = await load();
    const { password_enc, ...rest } = s;
    const sent = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query(
            `SELECT n.id::text, n.kind, n.recipients, n.subject, n.status, n.error, n.created_at AS "createdAt"
             FROM notifications n ORDER BY n.id DESC LIMIT 15`,
          )
        ).rows,
    );
    return {
      smtp: {
        enabled: rest.enabled,
        host: rest.host,
        port: rest.port,
        security: rest.security,
        username: rest.username,
        hasPassword: Boolean(password_enc),
        fromName: rest.from_name,
        fromEmail: rest.from_email,
        recipients: rest.recipients,
        minSeverity: rest.min_severity,
        notifyResolved: rest.notify_resolved,
      },
      notifications: sent,
    };
  });

  app.put("/api/v1/integrations/smtp", admin, async (req) => {
    const b = parseBody(smtpBody, req.body);
    const cur = await load();
    const recipients = parseRecipients(b.recipients);
    const bad = recipients.filter((r) => !email.safeParse(r).success);
    if (bad.length) throw badRequest(`Destinatário inválido: ${bad.join(", ")}`);
    const passwordEnc =
      b.password === undefined
        ? cur.password_enc
        : b.password === ""
          ? null
          : encryptSecret(b.password, encKey);
    if (b.enabled) {
      if (!b.host) throw badRequest("Informe o servidor SMTP");
      if (!recipients.length) throw badRequest("Informe ao menos um destinatário");
      if (!b.fromEmail && !b.username) throw badRequest("Informe o e-mail do remetente");
      if (b.username && !passwordEnc)
        throw badRequest("Informe a senha (no Gmail, a senha de app)");
    }
    const next: SmtpSettings = {
      enabled: b.enabled,
      host: b.host,
      port: b.port,
      security: b.security,
      username: b.username,
      password_enc: passwordEnc,
      from_name: b.fromName,
      from_email: b.fromEmail,
      recipients,
      min_severity: b.minSeverity,
      notify_resolved: b.notifyResolved,
    };
    await withScope(pool, PLATFORM, async (c) => {
      await c.query(
        `INSERT INTO system_settings (key, value, updated_by) VALUES ('integrations.smtp', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
        [JSON.stringify(next), req.user!.id],
      );
      // A senha nunca vai para a auditoria: só a informação de que mudou.
      await audit(c, req, "integrations.smtp_updated", {
        tenantId: null,
        entityType: "integration",
        entityId: "smtp",
        data: {
          enabled: next.enabled,
          host: next.host,
          port: next.port,
          security: next.security,
          username: next.username,
          recipients: next.recipients.length,
          minSeverity: next.min_severity,
          passwordChanged: b.password !== undefined,
        },
      });
    });
    return { ok: true };
  });

  const testBody = z.object({ to: z.string().max(200).optional() }).strict();
  const testLimit = {
    preHandler: [app.requirePermission("settings.write"), app.rateLimit("smtp-test", 10, 600)],
  };
  app.post("/api/v1/integrations/smtp/test", testLimit, async (req) => {
    const raw = parseBody(testBody, req.body ?? {});
    const typed = raw.to?.trim() ? email.safeParse(raw.to) : null;
    if (typed && !typed.success)
      throw badRequest(
        'Informe um e-mail válido em "Enviar teste para" (ou deixe em branco para usar os destinatários salvos).',
      );
    const b = { to: typed?.success ? typed.data : undefined };
    const s = await load();
    const to = b.to ? [b.to] : s.recipients;
    if (!to.length) throw badRequest("Informe um destinatário para o teste");
    const subject = "[TopCam] E-mail de teste";
    let error: string | null = null;
    try {
      await sendMail(s, encKey, {
        to,
        subject,
        text: [
          "Este é um e-mail de teste do TopCam.",
          "",
          `Servidor: ${s.host}:${s.port} (${s.security})`,
          `Enviado por: ${req.user!.email} em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
          "",
          "Se chegou, os alertas por e-mail estão prontos para uso.",
        ].join("\n"),
      });
    } catch (err) {
      error = (err as Error).message;
    }
    await withScope(pool, PLATFORM, async (c) => {
      await c.query(
        `INSERT INTO notifications (kind, recipients, subject, status, error) VALUES ('test', $1, $2, $3, $4)`,
        [to.join(", "), subject, error ? "failed" : "sent", error],
      );
      await audit(c, req, "integrations.smtp_tested", {
        tenantId: null,
        entityType: "integration",
        entityId: "smtp",
        data: { to: to.length, ok: !error },
      });
    });
    if (error) throw badRequest(error);
    return { ok: true, to };
  });
}
