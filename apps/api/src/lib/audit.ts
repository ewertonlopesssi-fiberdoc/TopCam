import { insertAudit, type PoolClient } from "@topcam/db";
import type { FastifyRequest } from "fastify";

/** Registra uma ação do usuário autenticado na trilha de auditoria (somente inserção). */
export async function audit(
  c: PoolClient,
  req: FastifyRequest,
  action: string,
  opts: {
    tenantId?: string | null;
    entityType?: string;
    entityId?: string;
    data?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await insertAudit(c, {
    tenantId: opts.tenantId === undefined ? (req.user?.tenantId ?? null) : opts.tenantId,
    actorType: req.user ? "user" : "system",
    actorUserId: req.user?.id ?? null,
    action,
    entityType: opts.entityType,
    entityId: opts.entityId,
    data: opts.data,
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? null,
  });
}
