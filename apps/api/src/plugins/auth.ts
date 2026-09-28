import { createHash, randomBytes } from "node:crypto";
import { PLATFORM, withScope, type DbScope, type PoolClient } from "@topcam/db";
import { can, isPlatformRole, isRoleKey, type Permission, type RoleKey } from "@topcam/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { HttpError, forbidden, unauthorized } from "../lib/http.js";

/**
 * Autenticação do painel e do app.
 *  - Token de acesso: JWT HS256 de curta duração (padrão 15 min), enviado em
 *    `Authorization: Bearer`. Carrega apenas sub (usuário) e sid (sessão).
 *  - Refresh token: opaco, guardado só como hash em `sessions`, rotacionado a
 *    cada uso. No painel fica em cookie httpOnly; no app, no armazenamento seguro.
 *  - A cada requisição o usuário, o papel, o cliente e a sessão são relidos do
 *    banco: desativar um usuário, suspender um cliente ou encerrar uma sessão
 *    vale imediatamente.
 */

export interface AuthUser {
  id: string;
  sessionId: string;
  name: string;
  email: string;
  role: RoleKey;
  tenantId: string | null;
  tenantName: string | null;
  mustChangePassword: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const REFRESH_COOKIE = "topcam_rt";

export function scopeOf(user: AuthUser): DbScope {
  if (isPlatformRole(user.role) || !user.tenantId) return PLATFORM;
  return { kind: "tenant", tenantId: user.tenantId };
}

export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Rotas liberadas enquanto a troca de senha obrigatória não é feita. */
const ALLOWED_WITH_PENDING_PASSWORD = new Set([
  "/api/v1/auth/me",
  "/api/v1/auth/change-password",
  "/api/v1/auth/logout",
]);

export async function authPlugin(app: FastifyInstance): Promise<void> {
  const { env, pool } = app.deps;
  const secret = new TextEncoder().encode(env.JWT_SECRET);

  app.decorate("signAccessToken", async (user: { id: string; sessionId: string }) =>
    new SignJWT({ sid: user.sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("topcam")
      .setIssuedAt()
      .setExpirationTime(`${env.ACCESS_TOKEN_TTL_S}s`)
      .sign(secret),
  );

  app.decorate("authenticate", async (req: FastifyRequest) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) throw unauthorized();
    let sub: string;
    let sid: string;
    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: "topcam",
        algorithms: ["HS256"],
      });
      sub = String(payload.sub ?? "");
      sid = String(payload.sid ?? "");
    } catch {
      throw new HttpError(401, "token_invalid", "Sessão expirada. Entre novamente.");
    }
    const user = await withScope(pool, PLATFORM, (c) => loadActiveUser(c, sub, sid));
    if (!user) throw new HttpError(401, "session_invalid", "Sessão encerrada. Entre novamente.");
    if (user.mustChangePassword && !ALLOWED_WITH_PENDING_PASSWORD.has(req.routeOptions.url ?? "")) {
      throw new HttpError(403, "password_change_required", "Troque sua senha para continuar.");
    }
    req.user = user;
  });

  app.decorate("requirePermission", (permission: Permission) => async (req: FastifyRequest) => {
    if (!req.user) await app.authenticate(req);
    if (!can(req.user!.role, permission)) throw forbidden();
  });
}

/** Usuário ativo, com sessão válida e cliente ativo (quando houver). */
export async function loadActiveUser(
  c: PoolClient,
  userId: string,
  sessionId: string,
): Promise<AuthUser | null> {
  const { rows } = await c.query<{
    id: string;
    name: string;
    email: string;
    role: string;
    tenant_id: string | null;
    tenant_name: string | null;
    tenant_status: string | null;
    must_change_password: boolean;
  }>(
    `SELECT u.id, u.name, u.email, r.key AS role, u.tenant_id, t.name AS tenant_name,
            t.status AS tenant_status, u.must_change_password
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN sessions s ON s.user_id = u.id AND s.id = $2
       LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.status = 'active' AND u.deleted_at IS NULL
        AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [userId, sessionId],
  );
  const r = rows[0];
  if (!r || !isRoleKey(r.role)) return null;
  if (r.tenant_id && r.tenant_status !== "active") return null;
  await c.query(
    "UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'",
    [sessionId],
  );
  return {
    id: r.id,
    sessionId,
    name: r.name,
    email: r.email,
    role: r.role,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    mustChangePassword: r.must_change_password,
  };
}

declare module "fastify" {
  interface FastifyInstance {
    signAccessToken: (user: { id: string; sessionId: string }) => Promise<string>;
    authenticate: (req: FastifyRequest) => Promise<void>;
    requirePermission: (p: Permission) => (req: FastifyRequest) => Promise<void>;
  }
}
