import { PLATFORM, getSetting, withScope } from "@topcam/db";
import { ROLE_LABELS, assignableRoles, isRoleKey } from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { db, effectiveTenant, paged } from "../lib/ctx.js";
import { conflict, notFound, pagination, parseBody } from "../lib/http.js";

/** Metadados para os formulários, configurações da plataforma e trilha de auditoria. */

const EDITABLE_SETTINGS = {
  "platform.name": z.string().trim().min(2).max(60),
  "platform.support_email": z.string().trim().toLowerCase().email().max(200).or(z.literal("")),
} as const;
type EditableKey = keyof typeof EDITABLE_SETTINGS;

const settingsBody = z.object({
  platformName: EDITABLE_SETTINGS["platform.name"].optional(),
  supportEmail: EDITABLE_SETTINGS["platform.support_email"].optional(),
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { env, pool } = app.deps;

  app.get("/api/v1/meta", { preHandler: app.authenticate }, async (req) => {
    const platformName = await withScope(pool, PLATFORM, (c) =>
      getSetting<string>(c, "platform.name", "TopCam"),
    );
    return db(app, req, async (c) => ({
      platformName,
      roles: (
        await c.query<{ key: string; name: string; scope: string }>(
          "SELECT key, name, scope FROM roles ORDER BY scope, key",
        )
      ).rows
        .filter((r) => isRoleKey(r.key))
        .map((r) => ({
          key: r.key,
          label: ROLE_LABELS[r.key as keyof typeof ROLE_LABELS],
          scope: r.scope,
          assignable: assignableRoles(req.user!.role).includes(r.key as never),
        })),
      plans: (
        await c.query(
          `SELECT code, name, max_cameras AS "maxCameras", max_storage_bytes::float8 AS "maxStorageBytes",
                  max_retention_hours AS "maxRetentionHours" FROM plans ORDER BY max_cameras`,
        )
      ).rows,
      retentionPolicies: (
        await c.query(
          `SELECT id, name, retention_hours AS "retentionHours", tenant_id AS "tenantId"
             FROM retention_policies ORDER BY retention_hours`,
        )
      ).rows,
      ingest: {
        server: `rtmp://${env.PUBLIC_HOST}:${env.RTMP_PUBLIC_PORT}/live`,
        publicHost: env.PUBLIC_HOST,
      },
    }));
  });

  // ------------------------------------------------------------------ configurações
  app.get("/api/v1/settings", { preHandler: app.requirePermission("settings.read") }, async () =>
    withScope(pool, PLATFORM, async (c) => ({
      platformName: await getSetting<string>(c, "platform.name", "TopCam"),
      supportEmail: await getSetting<string>(c, "platform.support_email", ""),
      recordingGloballyEnabled: await getSetting<boolean>(c, "recording.globally_enabled", false),
      publicHost: env.PUBLIC_HOST,
      rtmpServer: `rtmp://${env.PUBLIC_HOST}:${env.RTMP_PUBLIC_PORT}/live`,
      sessionMinutes: Math.round(env.ACCESS_TOKEN_TTL_S / 60),
      refreshHours: env.REFRESH_TOKEN_TTL_H,
      cookieSecure: env.COOKIE_SECURE,
    })),
  );

  app.put(
    "/api/v1/settings",
    { preHandler: app.requirePermission("settings.write") },
    async (req) => {
      const b = parseBody(settingsBody, req.body);
      const changes: Partial<Record<EditableKey, string>> = {};
      if (b.platformName !== undefined) changes["platform.name"] = b.platformName;
      if (b.supportEmail !== undefined) changes["platform.support_email"] = b.supportEmail;
      await withScope(pool, PLATFORM, async (c) => {
        for (const [key, value] of Object.entries(changes)) {
          await c.query(
            `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
            [key, JSON.stringify(value), req.user!.id],
          );
        }
        await audit(c, req, "settings.updated", {
          tenantId: null,
          entityType: "settings",
          data: { changes },
        });
      });
      return { ok: true };
    },
  );

  // ------------------------------------------------------------------ planos
  const GB = 1024 ** 3;
  const planBody = z.object({
    name: z.string().trim().min(2).max(40).optional(),
    maxCameras: z.number().int().min(1).max(100_000).optional(),
    maxStorageGb: z.number().min(1).max(10_000_000).optional(),
    maxRetentionHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 3650)
      .optional(),
  });
  const planSelect = `
    SELECT p.code, p.name, p.max_cameras AS "maxCameras", p.max_storage_bytes::float8 AS "maxStorageBytes",
           p.max_retention_hours AS "maxRetentionHours",
           (SELECT count(*)::int FROM tenants t WHERE t.plan_id = p.id AND t.deleted_at IS NULL
              AND t.status <> 'cancelled') AS "tenantCount",
           (SELECT coalesce(max(n), 0)::int FROM (
              SELECT count(c.id) AS n FROM tenants t JOIN cameras c ON c.tenant_id = t.id AND c.deleted_at IS NULL
               WHERE t.plan_id = p.id AND t.deleted_at IS NULL GROUP BY t.id) x) AS "maxCamerasInUse"
      FROM plans p`;

  app.get("/api/v1/plans", { preHandler: app.requirePermission("plans.read") }, async () =>
    withScope(pool, PLATFORM, async (c) => ({
      items: (await c.query(`${planSelect} ORDER BY p.max_cameras`)).rows,
    })),
  );

  app.patch<{ Params: { code: string } }>(
    "/api/v1/plans/:code",
    { preHandler: app.requirePermission("settings.write") },
    async (req) => {
      const b = parseBody(planBody, req.body);
      return withScope(pool, PLATFORM, async (c) => {
        const cur = (
          await c.query<{ maxCamerasInUse: number; name: string }>(
            `${planSelect} WHERE p.code = $1 FOR UPDATE OF p`,
            [req.params.code],
          )
        ).rows[0];
        if (!cur) throw notFound("Plano não encontrado");
        if (b.maxCameras !== undefined && b.maxCameras < cur.maxCamerasInUse)
          throw conflict(
            `Um cliente deste plano já tem ${cur.maxCamerasInUse} câmeras. O limite não pode ficar abaixo disso.`,
          );
        await c.query(
          `UPDATE plans SET name = coalesce($2, name), max_cameras = coalesce($3, max_cameras),
                  max_storage_bytes = coalesce($4, max_storage_bytes),
                  max_retention_hours = coalesce($5, max_retention_hours), updated_at = now()
            WHERE code = $1`,
          [
            req.params.code,
            b.name ?? null,
            b.maxCameras ?? null,
            b.maxStorageGb !== undefined ? Math.round(b.maxStorageGb * GB) : null,
            b.maxRetentionHours ?? null,
          ],
        );
        await audit(c, req, "plan.updated", {
          tenantId: null,
          entityType: "plan",
          entityId: req.params.code,
          data: { changes: b, before: cur },
        });
        return (await c.query(`${planSelect} WHERE p.code = $1`, [req.params.code])).rows[0];
      });
    },
  );

  // ------------------------------------------------------------------ auditoria
  const auditQuery = pagination.extend({
    tenantId: z.string().uuid().optional(),
    action: z.string().max(80).optional(),
    entityType: z.string().max(40).optional(),
    entityId: z.string().max(80).optional(),
    search: z.string().trim().max(100).optional(),
  });

  app.get(
    "/api/v1/audit-logs",
    { preHandler: app.requirePermission("audit.read") },
    async (req) => {
      const q = parseBody(auditQuery, req.query);
      const tenant = effectiveTenant(req, q.tenantId ?? null);
      const rows = await db(
        app,
        req,
        async (c) =>
          (
            await c.query(
              `SELECT count(*) OVER() AS total, a.id::text, a.created_at AS "createdAt", a.action,
                  a.entity_type AS "entityType", a.entity_id AS "entityId", a.tenant_id AS "tenantId",
                  t.name AS "tenantName", a.actor_type AS "actorType", u.name AS "actorName",
                  u.email AS "actorEmail", host(a.ip) AS ip, a.data
             FROM audit_logs a
             LEFT JOIN tenants t ON t.id = a.tenant_id
             LEFT JOIN users u ON u.id = a.actor_user_id
            WHERE ($1::uuid IS NULL OR a.tenant_id = $1)
              AND ($2::text IS NULL OR a.action LIKE $2 || '%')
              AND ($3::text IS NULL OR a.entity_type = $3)
              AND ($4::text IS NULL OR a.entity_id = $4)
              AND ($5::text IS NULL OR a.action ILIKE '%' || $5 || '%' OR u.name ILIKE '%' || $5 || '%'
                   OR u.email ILIKE '%' || $5 || '%' OR t.name ILIKE '%' || $5 || '%')
            ORDER BY a.id DESC
            LIMIT $6 OFFSET $7`,
              [
                tenant,
                q.action ?? null,
                q.entityType ?? null,
                q.entityId ?? null,
                q.search ?? null,
                q.pageSize,
                (q.page - 1) * q.pageSize,
              ],
            )
          ).rows,
      );
      return paged(rows, q.page, q.pageSize);
    },
  );
}
