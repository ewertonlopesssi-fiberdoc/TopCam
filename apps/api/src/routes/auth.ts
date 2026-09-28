import { createHash } from "node:crypto";
import { PLATFORM, withScope } from "@topcam/db";
import {
  ROLE_LABELS,
  hashPassword,
  isRoleKey,
  permissionsOf,
  validatePassword,
  verifyPassword,
} from "@topcam/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest, parseBody, unauthorized } from "../lib/http.js";
import { count, hit, reset } from "../lib/ratelimit.js";
import {
  REFRESH_COOKIE,
  hashToken,
  loadActiveUser,
  newRefreshToken,
  type AuthUser,
} from "../plugins/auth.js";

// Hash fixo usado quando o e-mail não existe, para o tempo de resposta não revelar isso.
const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

/** Janela em que o refresh token anterior ainda é aceito (respostas perdidas em recargas). */
const REUSE_GRACE_S = 30;

const loginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
  client: z.enum(["web", "mobile"]).default("web"),
});

const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

export function mePayload(u: AuthUser) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    roleLabel: ROLE_LABELS[u.role],
    tenant: u.tenantId ? { id: u.tenantId, name: u.tenantName } : null,
    permissions: permissionsOf(u.role),
    mustChangePassword: u.mustChangePassword,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { env, pool, redis } = app.deps;
  const refreshTtlS = env.REFRESH_TOKEN_TTL_H * 3600;

  function setRefreshCookie(reply: FastifyReply, token: string) {
    reply.setCookie(REFRESH_COOKIE, token, {
      path: "/api/v1/auth",
      httpOnly: true,
      sameSite: "strict",
      secure: env.COOKIE_SECURE,
      maxAge: refreshTtlS,
    });
  }

  function clearRefreshCookie(reply: FastifyReply) {
    reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
  }

  async function issue(reply: FastifyReply, user: AuthUser, refreshToken: string, client: string) {
    if (client === "web") setRefreshCookie(reply, refreshToken);
    return {
      accessToken: await app.signAccessToken({ id: user.id, sessionId: user.sessionId }),
      expiresIn: env.ACCESS_TOKEN_TTL_S,
      ...(client === "mobile" ? { refreshToken } : {}),
      user: mePayload(user),
    };
  }

  // ------------------------------------------------------------------ login
  app.post("/api/v1/auth/login", async (req, reply) => {
    const body = parseBody(loginBody, req.body);
    const emailKey = `topcam:login:email:${createHash("sha256").update(body.email).digest("hex").slice(0, 32)}`;
    const ipKey = `topcam:login:ip:${req.ip}`;
    if (
      (await count(redis, emailKey)) >= env.LOGIN_MAX_ATTEMPTS ||
      (await count(redis, ipKey)) >= env.LOGIN_MAX_ATTEMPTS * 4
    ) {
      // Registra só o primeiro bloqueio de cada janela (evita inundar a auditoria).
      const first = await redis.set(`${emailKey}:blocked`, "1", "EX", env.LOGIN_WINDOW_S, "NX");
      if (first)
        await withScope(pool, PLATFORM, (c) =>
          audit(c, req, "auth.login_rate_limited", {
            tenantId: null,
            data: { email: body.email },
          }),
        );
      throw new HttpError(
        429,
        "too_many_attempts",
        `Muitas tentativas. Aguarde ${Math.ceil(env.LOGIN_WINDOW_S / 60)} minutos e tente de novo.`,
      );
    }

    const found = await withScope(pool, PLATFORM, async (c) => {
      const { rows } = await c.query<{
        id: string;
        password_hash: string | null;
        status: string;
        tenant_id: string | null;
        tenant_status: string | null;
        role: string;
      }>(
        `SELECT u.id, u.password_hash, u.status, u.tenant_id, t.status AS tenant_status, r.key AS role
           FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN tenants t ON t.id = u.tenant_id
          WHERE u.email = $1 AND u.deleted_at IS NULL`,
        [body.email],
      );
      return rows[0] ?? null;
    });

    const ok = await verifyPassword(body.password, found?.password_hash ?? DUMMY_HASH);
    if (!found || !ok) {
      await hit(redis, emailKey, env.LOGIN_WINDOW_S);
      await hit(redis, ipKey, env.LOGIN_WINDOW_S);
      await withScope(pool, PLATFORM, (c) =>
        audit(c, req, "auth.login_failed", {
          tenantId: found?.tenant_id ?? null,
          entityType: "user",
          entityId: found?.id,
          data: { email: body.email, reason: found ? "wrong_password" : "unknown_email" },
        }),
      );
      throw new HttpError(401, "invalid_credentials", "E-mail ou senha inválidos.");
    }
    if (
      found.status !== "active" ||
      (found.tenant_id && found.tenant_status !== "active") ||
      !isRoleKey(found.role)
    ) {
      await withScope(pool, PLATFORM, (c) =>
        audit(c, req, "auth.login_blocked", {
          tenantId: found.tenant_id,
          entityType: "user",
          entityId: found.id,
          data: { user_status: found.status, tenant_status: found.tenant_status },
        }),
      );
      throw new HttpError(403, "account_disabled", "Acesso desativado. Procure o administrador.");
    }

    const refresh = newRefreshToken();
    const user = await withScope(pool, PLATFORM, async (c) => {
      const s = await c.query<{ id: string }>(
        `INSERT INTO sessions (user_id, tenant_id, refresh_token_hash, client, ip, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7)) RETURNING id`,
        [
          found.id,
          found.tenant_id,
          refresh.hash,
          body.client,
          req.ip,
          req.headers["user-agent"] ?? null,
          refreshTtlS,
        ],
      );
      await c.query("UPDATE users SET last_login_at = now() WHERE id = $1", [found.id]);
      const u = await loadActiveUser(c, found.id, s.rows[0]!.id);
      req.user = u ?? undefined;
      await audit(c, req, "auth.login", {
        tenantId: found.tenant_id,
        entityType: "user",
        entityId: found.id,
        data: { client: body.client },
      });
      return u;
    });
    if (!user) throw unauthorized();
    await reset(redis, emailKey);
    return issue(reply, user, refresh.token, body.client);
  });

  // ------------------------------------------------------------------ refresh
  app.post("/api/v1/auth/refresh", async (req, reply) => {
    const fromBody = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
    const token = typeof fromBody === "string" ? fromBody : req.cookies[REFRESH_COOKIE];
    const client = typeof fromBody === "string" ? "mobile" : "web";
    if (!token) throw unauthorized("Sessão expirada. Entre novamente.");
    const hash = hashToken(token);
    const next = newRefreshToken();

    const result = await withScope(pool, PLATFORM, async (c) => {
      const { rows } = await c.query<{
        id: string;
        user_id: string;
        tenant_id: string | null;
        current: boolean;
        in_grace: boolean;
      }>(
        `SELECT id, user_id, tenant_id, refresh_token_hash = $1 AS current,
                coalesce(rotated_at > now() - make_interval(secs => $2), false) AS in_grace
           FROM sessions
          WHERE (refresh_token_hash = $1 OR previous_refresh_hash = $1)
            AND revoked_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [hash, REUSE_GRACE_S],
      );
      const s = rows[0];
      if (!s) return null;
      if (!s.current && !s.in_grace) {
        // Token já rotacionado reutilizado fora da tolerância: possível roubo. Encerra a sessão.
        await c.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [s.id]);
        await audit(c, req, "auth.refresh_reuse_detected", {
          tenantId: s.tenant_id,
          entityType: "session",
          entityId: s.id,
        });
        return null;
      }
      // Dentro da tolerância (resposta anterior perdida, ex.: recarga da página no meio
      // da renovação) o token anterior ainda vale; a janela não é prorrogada.
      await c.query(
        `UPDATE sessions
            SET previous_refresh_hash = CASE WHEN $4 THEN refresh_token_hash ELSE previous_refresh_hash END,
                rotated_at = CASE WHEN $4 THEN now() ELSE rotated_at END,
                refresh_token_hash = $2, last_seen_at = now(),
                expires_at = now() + make_interval(secs => $3)
          WHERE id = $1`,
        [s.id, next.hash, refreshTtlS, s.current],
      );
      return loadActiveUser(c, s.user_id, s.id);
    });
    if (!result) {
      clearRefreshCookie(reply);
      throw unauthorized("Sessão expirada. Entre novamente.");
    }
    return issue(reply, result, next.token, client);
  });

  // ------------------------------------------------------------------ me / logout / senha
  app.get("/api/v1/auth/me", { preHandler: app.authenticate }, async (req) => mePayload(req.user!));

  app.post("/api/v1/auth/logout", { preHandler: app.authenticate }, async (req, reply) => {
    await withScope(pool, PLATFORM, async (c) => {
      await c.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [req.user!.sessionId]);
      await audit(c, req, "auth.logout", { entityType: "user", entityId: req.user!.id });
    });
    clearRefreshCookie(reply);
    return { ok: true };
  });

  app.post("/api/v1/auth/change-password", { preHandler: app.authenticate }, async (req) => {
    const body = parseBody(changePasswordBody, req.body);
    const user = req.user!;
    const current = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query<{ password_hash: string }>(
            "SELECT password_hash FROM users WHERE id = $1",
            [user.id],
          )
        ).rows[0]?.password_hash,
    );
    if (!current || !(await verifyPassword(body.currentPassword, current))) {
      throw badRequest("Senha atual incorreta.");
    }
    const problem = validatePassword(body.newPassword, user.email);
    if (problem) throw badRequest(problem);
    if (await verifyPassword(body.newPassword, current)) {
      throw badRequest("A nova senha deve ser diferente da atual.");
    }
    const hashed = await hashPassword(body.newPassword);
    await withScope(pool, PLATFORM, async (c) => {
      await c.query(
        "UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1",
        [user.id, hashed],
      );
      // Encerra as outras sessões do usuário.
      await c.query(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
        [user.id, user.sessionId],
      );
      await audit(c, req, "auth.password_changed", { entityType: "user", entityId: user.id });
    });
    return { ok: true, user: { ...mePayload(user), mustChangePassword: false } };
  });
}
