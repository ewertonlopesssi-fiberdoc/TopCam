import { type PoolClient } from "@topcam/db";
import {
  ROLE_LABELS,
  TENANT_ROLES,
  assignableRoles,
  generateTempPassword,
  hashPassword,
  isPlatformRole,
  isRoleKey,
  parseEncryptionKey,
  validatePassword,
  type RoleKey,
} from "@topcam/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { loadSmtp, sendAccessMail, smtpReady } from "../lib/mail.js";
import { db, effectiveTenant, isPlatform, paged } from "../lib/ctx.js";
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  pagination,
  parseBody,
  uuid,
} from "../lib/http.js";

const listQuery = pagination.extend({
  tenantId: z.string().uuid().optional(),
  scope: z.enum(["platform", "tenants", "all"]).default("all"),
  role: z.string().max(40).optional(),
  status: z.enum(["active", "disabled", "invited"]).optional(),
  search: z.string().trim().max(100).optional(),
});

/**
 * Senha no cadastro (opcional): em branco o sistema gera uma temporária.
 * mustChangePassword: troca obrigatória no próximo acesso (padrão: só quando a senha é gerada).
 * sendEmail: envia e-mail com usuário (o e-mail) e senha, pela integração de e-mail.
 */
const passwordFields = {
  password: z.string().max(200).optional(),
  mustChangePassword: z.boolean().optional(),
  sendEmail: z.boolean().optional(),
};

const createBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(200),
  role: z.string(),
  tenantId: z.string().uuid().nullable().optional(),
  ...passwordFields,
});

const patchBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.string().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  ...passwordFields,
});

const resetBody = z.object(passwordFields);

/** Senha escolhida (validada) ou gerada, e se a troca no próximo acesso é obrigatória. */
function choosePassword(b: { password?: string; mustChangePassword?: boolean }) {
  const typed = b.password ? b.password : null;
  if (typed) {
    const problem = validatePassword(typed);
    if (problem) throw badRequest(problem);
  }
  const password = typed ?? generateTempPassword();
  return { password, generated: !typed, mustChange: b.mustChangePassword ?? !typed };
}

const permissionsBody = z.object({
  items: z
    .array(
      z.object({
        cameraId: z.string().uuid(),
        canLive: z.boolean().default(true),
        canPlayback: z.boolean().default(false),
        canExport: z.boolean().default(false),
      }),
    )
    .max(5000),
});

const USER_SELECT = `
  SELECT u.id, u.name, u.email, r.key AS role, u.status, u.tenant_id AS "tenantId",
         t.name AS "tenantName", u.must_change_password AS "mustChangePassword",
         u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
         (SELECT count(*)::int FROM user_camera_permissions p WHERE p.user_id = u.id) AS "cameraPermissionCount",
         (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS "lastSeenAt"
    FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN tenants t ON t.id = u.tenant_id`;

function withLabel<T extends { role: string }>(row: T) {
  return { ...row, roleLabel: isRoleKey(row.role) ? ROLE_LABELS[row.role] : row.role };
}

async function loadTarget(c: PoolClient, req: FastifyRequest, id: string) {
  const row = (
    await c.query(`${USER_SELECT} WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u`, [id])
  ).rows[0] as
    | {
        id: string;
        role: RoleKey;
        tenantId: string | null;
        email: string;
        status: string;
        name: string;
      }
    | undefined;
  if (!row) throw notFound("Usuário não encontrado");
  // Administrador de cliente nunca altera equipe da plataforma (a RLS já esconde, esta é a 2ª barreira).
  if (!isPlatform(req) && (!row.tenantId || row.tenantId !== req.user!.tenantId))
    throw notFound("Usuário não encontrado");
  return row;
}

function checkRole(req: FastifyRequest, role: string, tenantId: string | null): RoleKey {
  if (!isRoleKey(role)) throw badRequest("Papel inválido");
  if (!assignableRoles(req.user!.role).includes(role))
    throw forbidden("Você não pode atribuir este papel");
  if (isPlatformRole(role) && tenantId)
    throw badRequest("Papéis da plataforma não pertencem a um cliente");
  if (TENANT_ROLES.has(role) && !tenantId) throw badRequest("Informe o cliente do usuário");
  return role;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: app.requirePermission("users.read") };
  const write = { preHandler: app.requirePermission("users.write") };
  const perms = { preHandler: app.requirePermission("permissions.write") };
  const encKey = parseEncryptionKey(app.deps.env.STREAM_KEY_ENC_KEY);
  const panelUrl = () =>
    (app.deps.env.PANEL_URL || `http://${app.deps.env.PUBLIC_HOST}`).replace(/\/$/, "");

  /** Envia os dados de acesso e registra na auditoria (sem a senha). */
  async function emailAccess(
    req: FastifyRequest,
    target: { id: string; name: string; email: string; tenantId: string | null },
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
  }

  // O formulário de usuários habilita "Enviar por e-mail" só com o e-mail configurado.
  app.get("/api/v1/users/mail-status", write, async () => {
    const s = await loadSmtp(app.deps.pool);
    return { enabled: smtpReady(s) };
  });

  app.get("/api/v1/users", read, async (req) => {
    const q = parseBody(listQuery, req.query);
    const tenant = effectiveTenant(req, q.tenantId ?? null);
    const scope = isPlatform(req) ? q.scope : "tenants";
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `${USER_SELECT.replace("SELECT u.id", "SELECT count(*) OVER() AS total, u.id")}
            WHERE u.deleted_at IS NULL
              AND ($1::uuid IS NULL OR u.tenant_id = $1)
              AND ($2 <> 'platform' OR u.tenant_id IS NULL)
              AND ($2 <> 'tenants' OR u.tenant_id IS NOT NULL)
              AND ($3::text IS NULL OR r.key = $3)
              AND ($4::text IS NULL OR u.status = $4)
              AND ($5::text IS NULL OR u.name ILIKE '%' || $5 || '%' OR u.email ILIKE '%' || $5 || '%')
            ORDER BY t.name NULLS FIRST, u.name
            LIMIT $6 OFFSET $7`,
            [
              tenant,
              scope,
              q.role ?? null,
              q.status ?? null,
              q.search ?? null,
              q.pageSize,
              (q.page - 1) * q.pageSize,
            ],
          )
        ).rows,
    );
    const p = paged(rows, q.page, q.pageSize);
    return { ...p, items: p.items.map((r) => withLabel(r as { role: string })) };
  });

  app.post("/api/v1/users", write, async (req, reply) => {
    const b = parseBody(createBody, req.body);
    const tenantId = isPlatform(req) ? (b.tenantId ?? null) : req.user!.tenantId;
    const role = checkRole(req, b.role, tenantId);
    const pw = choosePassword(b);
    const hashed = await hashPassword(pw.password);
    const user = await db(app, req, async (c) => {
      if (
        tenantId &&
        !(await c.query("SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL", [tenantId]))
          .rowCount
      ) {
        throw badRequest("Cliente inexistente");
      }
      if ((await c.query("SELECT 1 FROM users WHERE email = $1", [b.email])).rowCount) {
        throw conflict("Já existe um usuário com este e-mail", "email_taken");
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (tenant_id, role_id, name, email, password_hash, must_change_password)
         VALUES ($1, (SELECT id FROM roles WHERE key = $2), $3, $4, $5, $6) RETURNING id`,
        [tenantId, role, b.name, b.email, hashed, pw.mustChange],
      );
      const id = rows[0]!.id;
      await audit(c, req, "user.created", {
        tenantId,
        entityType: "user",
        entityId: id,
        data: {
          email: b.email,
          role,
          password: pw.generated ? "gerada" : "definida pelo administrador",
          mustChangePassword: pw.mustChange,
        },
      });
      return withLabel((await c.query(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0]) as {
        id: string;
        name: string;
        email: string;
        tenantId: string | null;
      };
    });
    const mail = b.sendEmail ? await emailAccess(req, user, pw.password, pw.mustChange) : null;
    // A senha gerada só aparece nesta resposta (a digitada o administrador já conhece).
    return reply.code(201).send({
      user,
      ...(pw.generated ? { temporaryPassword: pw.password } : {}),
      mustChangePassword: pw.mustChange,
      mail,
    });
  });

  app.patch<{ Params: { id: string } }>("/api/v1/users/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(patchBody, req.body);
    if (id === req.user!.id && (b.role || b.status)) {
      throw forbidden("Você não pode alterar o próprio papel ou desativar a si mesmo");
    }
    if (id === req.user!.id && b.password)
      throw forbidden("Para trocar a sua senha, use Configurações → Minha conta");
    const pw = b.password ? choosePassword(b) : null;
    const hashed = pw ? await hashPassword(pw.password) : null;
    const updated = await db(app, req, async (c) => {
      const target = await loadTarget(c, req, id);
      if (!assignableRoles(req.user!.role).includes(target.role))
        throw forbidden("Você não pode alterar este usuário");
      const role = b.role ? checkRole(req, b.role, target.tenantId) : null;
      await c.query(
        `UPDATE users SET name = COALESCE($2, name),
                role_id = COALESCE((SELECT id FROM roles WHERE key = $3), role_id),
                status = COALESCE($4, status)
          WHERE id = $1`,
        [id, b.name ?? null, role, b.status ?? null],
      );
      if (pw && hashed) {
        await c.query(
          "UPDATE users SET password_hash = $2, must_change_password = $3 WHERE id = $1",
          [id, hashed, pw.mustChange],
        );
        // Senha nova: as sessões abertas do usuário são encerradas.
        await c.query(
          "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
          [id],
        );
        await audit(c, req, "user.password_set", {
          tenantId: target.tenantId,
          entityType: "user",
          entityId: id,
          data: { mustChangePassword: pw.mustChange },
        });
      }
      if (b.status === "disabled") {
        await c.query(
          "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
          [id],
        );
      }
      await audit(c, req, b.status === "disabled" ? "user.disabled" : "user.updated", {
        tenantId: target.tenantId,
        entityType: "user",
        entityId: id,
        data: {
          changes: { name: b.name, role: b.role, status: b.status },
          before: { name: target.name, role: target.role, status: target.status },
        },
      });
      return withLabel((await c.query(`${USER_SELECT} WHERE u.id = $1`, [id])).rows[0]) as {
        id: string;
        name: string;
        email: string;
        tenantId: string | null;
      };
    });
    const mail =
      pw && b.sendEmail ? await emailAccess(req, updated, pw.password, pw.mustChange) : null;
    return { ...updated, mail };
  });

  // Exclusão lógica: o registro fica para a auditoria; o e-mail é liberado para novo cadastro.
  app.delete<{ Params: { id: string } }>("/api/v1/users/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    if (id === req.user!.id) throw forbidden("Você não pode excluir a si mesmo");
    await db(app, req, async (c) => {
      const target = await loadTarget(c, req, id);
      if (!assignableRoles(req.user!.role).includes(target.role))
        throw forbidden("Você não pode excluir este usuário");
      await c.query(
        `UPDATE users SET deleted_at = now(), status = 'disabled',
                email = email || '#excluido-' || extract(epoch from now())::bigint
          WHERE id = $1`,
        [id],
      );
      await c.query(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [id],
      );
      await c.query("DELETE FROM user_camera_permissions WHERE user_id = $1", [id]);
      await audit(c, req, "user.deleted", {
        tenantId: target.tenantId,
        entityType: "user",
        entityId: id,
        data: { email: target.email, name: target.name, role: target.role },
      });
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/v1/users/:id/reset-password", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(resetBody, req.body ?? {});
    if (id === req.user!.id)
      throw forbidden("Para trocar a sua senha, use Configurações → Minha conta");
    const pw = choosePassword(b);
    const hashed = await hashPassword(pw.password);
    const target = await db(app, req, async (c) => {
      const target = await loadTarget(c, req, id);
      if (!assignableRoles(req.user!.role).includes(target.role))
        throw forbidden("Você não pode alterar este usuário");
      await c.query(
        "UPDATE users SET password_hash = $2, must_change_password = $3 WHERE id = $1",
        [id, hashed, pw.mustChange],
      );
      await c.query(
        "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
        [id],
      );
      await audit(c, req, "user.password_reset", {
        tenantId: target.tenantId,
        entityType: "user",
        entityId: id,
        data: {
          password: pw.generated ? "gerada" : "definida pelo administrador",
          mustChangePassword: pw.mustChange,
        },
      });
      return target;
    });
    const mail = b.sendEmail ? await emailAccess(req, target, pw.password, pw.mustChange) : null;
    return {
      ...(pw.generated ? { temporaryPassword: pw.password } : {}),
      mustChangePassword: pw.mustChange,
      mail,
    };
  });

  // ------------------------------------------------------------------ permissões por câmera
  app.get<{ Params: { id: string } }>("/api/v1/users/:id/camera-permissions", read, async (req) => {
    const id = parseBody(uuid, req.params.id);
    return db(app, req, async (c) => {
      const target = await loadTarget(c, req, id);
      if (!target.tenantId) throw badRequest("Usuários da plataforma veem todas as câmeras");
      const { rows } = await c.query(
        `SELECT c.id AS "cameraId", c.code, c.name, l.name AS "locationName", g.name AS "groupName",
                c.recording_enabled AS "recordingEnabled",
                coalesce(p.can_live, false) AS "canLive", coalesce(p.can_playback, false) AS "canPlayback",
                coalesce(p.can_export, false) AS "canExport", p.user_id IS NOT NULL AS granted
           FROM cameras c
           JOIN locations l ON l.id = c.location_id
           LEFT JOIN camera_groups g ON g.id = c.group_id
           LEFT JOIN user_camera_permissions p ON p.camera_id = c.id AND p.user_id = $1
          WHERE c.tenant_id = $2 AND c.deleted_at IS NULL
          ORDER BY l.name, g.name NULLS FIRST, c.code`,
        [id, target.tenantId],
      );
      return { user: { id: target.id, name: target.name, role: target.role }, items: rows };
    });
  });

  app.put<{ Params: { id: string } }>(
    "/api/v1/users/:id/camera-permissions",
    perms,
    async (req) => {
      const id = parseBody(uuid, req.params.id);
      const b = parseBody(permissionsBody, req.body);
      return db(app, req, async (c) => {
        const target = await loadTarget(c, req, id);
        if (!target.tenantId) throw badRequest("Usuários da plataforma veem todas as câmeras");
        const ids = b.items.map((i) => i.cameraId);
        if (ids.length) {
          const valid = await c.query(
            "SELECT count(*)::int AS n FROM cameras WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND deleted_at IS NULL",
            [ids, target.tenantId],
          );
          if (valid.rows[0].n !== new Set(ids).size)
            throw badRequest("Há câmeras que não pertencem ao cliente do usuário");
        }
        const before = (
          await c.query("SELECT camera_id FROM user_camera_permissions WHERE user_id = $1", [id])
        ).rows.map((r) => r.camera_id as string);
        await c.query("DELETE FROM user_camera_permissions WHERE user_id = $1", [id]);
        for (const i of b.items) {
          if (!i.canLive && !i.canPlayback && !i.canExport) continue;
          await c.query(
            `INSERT INTO user_camera_permissions (tenant_id, user_id, camera_id, can_live, can_playback, can_export, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [target.tenantId, id, i.cameraId, i.canLive, i.canPlayback, i.canExport, req.user!.id],
          );
        }
        const after = b.items.filter((i) => i.canLive || i.canPlayback || i.canExport);
        await audit(c, req, "user.camera_permissions_updated", {
          tenantId: target.tenantId,
          entityType: "user",
          entityId: id,
          data: {
            granted: after.map((i) => ({
              camera: i.cameraId,
              live: i.canLive,
              playback: i.canPlayback,
              export: i.canExport,
            })),
            removed: before.filter((cid) => !after.some((i) => i.cameraId === cid)),
          },
        });
        return { ok: true, count: after.length };
      });
    },
  );
}
