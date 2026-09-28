import { enqueueJob, withScope, type PoolClient } from "@topcam/db";
import { JOBS_WAKE_CHANNEL, isPlatformRole } from "@topcam/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { forbidden } from "./http.js";
import { scopeOf } from "../plugins/auth.js";

/** Executa `fn` numa transação com o escopo de RLS do usuário autenticado. */
export function db<T>(
  app: FastifyInstance,
  req: FastifyRequest,
  fn: (c: PoolClient) => Promise<T>,
) {
  return withScope(app.deps.pool, scopeOf(req.user!), fn);
}

export function isPlatform(req: FastifyRequest): boolean {
  return isPlatformRole(req.user!.role);
}

/**
 * Cliente efetivo de uma operação: usuários de cliente só operam no próprio
 * cliente; a equipe da plataforma informa o cliente (ou nenhum, para listar todos).
 */
export function effectiveTenant(req: FastifyRequest, requested?: string | null): string | null {
  const u = req.user!;
  if (isPlatformRole(u.role)) return requested ?? null;
  if (requested && requested !== u.tenantId)
    throw forbidden("Você só pode acessar dados do seu cliente");
  return u.tenantId;
}

/** Agenda a reconciliação do servidor de mídia (chamar dentro da transação). */
export async function scheduleReconcile(c: PoolClient, reason: string): Promise<void> {
  await enqueueJob(c, "mediamtx.reconcile", { reason }, { dedupKey: "reconcile" });
}

/** Acorda o worker (chamar depois do commit). */
export async function wakeWorker(app: FastifyInstance): Promise<void> {
  await app.deps.redis.publish(JOBS_WAKE_CHANNEL, "1").catch(() => undefined);
}

export function slugify(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "cliente"
  );
}

export function paged<T extends { total?: number | string }>(
  rows: T[],
  page: number,
  pageSize: number,
) {
  const total = rows.length ? Number(rows[0]!.total ?? 0) : 0;
  return {
    items: rows.map(({ total: _t, ...rest }) => rest),
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
