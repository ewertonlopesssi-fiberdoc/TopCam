import { generateTempPassword, parseEncryptionKey, validatePassword } from "@topcam/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { audit } from "./audit.js";
import { db } from "./ctx.js";
import { badRequest } from "./http.js";
import { sendAccessMail } from "./mail.js";

/**
 * Senha de acesso de um usuário (cadastro de usuário, de cliente e integração):
 * a digitada (validada pela política) ou uma gerada, e se a troca no próximo acesso
 * é obrigatória (padrão: só quando a senha é gerada).
 */
export function choosePassword(b: { password?: string; mustChangePassword?: boolean }) {
  const typed = b.password ? b.password : null;
  if (typed) {
    const problem = validatePassword(typed);
    if (problem) throw badRequest(problem);
  }
  const password = typed ?? generateTempPassword();
  return { password, generated: !typed, mustChange: b.mustChangePassword ?? !typed };
}

export interface AccessTarget {
  id: string;
  name: string;
  email: string;
  tenantId: string | null;
}

/** Envia usuário e senha por e-mail e registra na auditoria (sem a senha). */
export function accessMailer(app: FastifyInstance) {
  const encKey = parseEncryptionKey(app.deps.env.STREAM_KEY_ENC_KEY);
  const panelUrl = () =>
    (app.deps.env.PANEL_URL || `http://${app.deps.env.PUBLIC_HOST}`).replace(/\/$/, "");
  return async function emailAccess(
    req: FastifyRequest,
    target: AccessTarget,
    password: string,
    mustChange: boolean,
  ): Promise<{ sent: boolean; error: string | null }> {
    const error = await sendAccessMail(app.deps.pool, encKey, {
      to: target.email,
      name: target.name,
      password,
      mustChange,
      panelUrl: panelUrl(),
    });
    await db(app, req, (c) =>
      audit(c, req, "user.access_emailed", {
        tenantId: target.tenantId,
        entityType: "user",
        entityId: target.id,
        data: { to: target.email, ok: !error, error },
      }),
    );
    return { sent: !error, error };
  };
}
