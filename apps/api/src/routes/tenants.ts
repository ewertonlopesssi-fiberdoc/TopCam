import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hashPassword } from "@topcam/shared";
import { accessMailer, choosePassword } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { db, effectiveTenant, paged, scheduleReconcile, slugify, wakeWorker } from "../lib/ctx.js";
import { badRequest, conflict, notFound, pagination, parseBody, uuid } from "../lib/http.js";

const listQuery = pagination.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(["active", "suspended", "cancelled"]).optional(),
  plan: z.string().max(40).optional(),
});

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const tenantBody = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: optText(200),
  document: optText(30),
  planCode: z.string().min(1).max(40),
  contactName: optText(120),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(200)
    .or(z.literal(""))
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  contactPhone: optText(40),
  notes: optText(2000),
  storageQuotaBytes: z.number().int().nonnegative().nullable().optional(),
});

/**
 * Cadastro de cliente com o usuário administrador dele (opcional, no mesmo passo):
 * e-mail de acesso, senha (em branco = gerada), troca no primeiro acesso e envio por e-mail.
 */
const createTenantBody = tenantBody.extend({
  admin: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      email: z.string().trim().toLowerCase().email().max(200),
      password: z.string().max(200).optional(),
      mustChangePassword: z.boolean().optional(),
      sendEmail: z.boolean().optional(),
    })
    .optional(),
});

const TENANT_SELECT = `
  SELECT t.id, t.seq, t.slug, t.name, t.legal_name AS "legalName", t.document, t.status,
         t.contact_name AS "contactName", t.contact_email AS "contactEmail",
         t.contact_phone AS "contactPhone", t.notes, t.timezone, t.created_at AS "createdAt",
         t.storage_quota_bytes::float8 AS "storageQuotaBytes",
         p.code AS "planCode", p.name AS "planName", p.max_cameras AS "maxCameras",
         p.max_storage_bytes::float8 AS "planStorageBytes",
         (SELECT count(*)::int FROM cameras c WHERE c.tenant_id = t.id AND c.deleted_at IS NULL) AS "cameraCount",
         (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.deleted_at IS NULL) AS "userCount",
         (SELECT coalesce(sum(s.size_bytes), 0)::float8 FROM recording_segments s
           WHERE s.tenant_id = t.id AND s.state IN ('writing', 'verified')) AS "storageUsedBytes"`;

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: app.requirePermission("tenants.read") };
  const write = { preHandler: app.requirePermission("tenants.write") };

  app.get("/api/v1/tenants", read, async (req) => {
    const q = parseBody(listQuery, req.query);
    const own = effectiveTenant(req, null);
    const rows = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `${TENANT_SELECT}, count(*) OVER() AS total
             FROM tenants t JOIN plans p ON p.id = t.plan_id
            WHERE t.deleted_at IS NULL
              AND ($1::uuid IS NULL OR t.id = $1)
              AND ($2::text IS NULL OR t.name ILIKE '%' || $2 || '%' OR t.legal_name ILIKE '%' || $2 || '%'
                   OR t.document ILIKE '%' || $2 || '%' OR t.slug ILIKE '%' || $2 || '%')
              AND ($3::text IS NULL OR t.status = $3)
              AND ($4::text IS NULL OR p.code = $4)
            ORDER BY t.seq
            LIMIT $5 OFFSET $6`,
            [
              own,
              q.search ?? null,
              q.status ?? null,
              q.plan ?? null,
              q.pageSize,
              (q.page - 1) * q.pageSize,
            ],
          )
        ).rows,
    );
    return paged(rows, q.page, q.pageSize);
  });

  app.get<{ Params: { id: string } }>("/api/v1/tenants/:id", read, async (req) => {
    const id = parseBody(uuid, req.params.id);
    effectiveTenant(req, id);
    const row = await db(
      app,
      req,
      async (c) =>
        (
          await c.query(
            `${TENANT_SELECT} FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
            [id],
          )
        ).rows[0],
    );
    if (!row) throw notFound("Cliente não encontrado");
    return row;
  });

  const emailAccess = accessMailer(app);

  app.post("/api/v1/tenants", write, async (req, reply) => {
    const b = parseBody(createTenantBody, req.body);
    const pw = b.admin ? choosePassword(b.admin) : null;
    const hashed = pw ? await hashPassword(pw.password) : null;
    let admin: { id: string; name: string; email: string; tenantId: string } | null = null;
    const created = await db(app, req, async (c) => {
      const plan = (
        await c.query<{ id: string }>("SELECT id FROM plans WHERE code = $1", [b.planCode])
      ).rows[0];
      if (!plan) throw badRequest("Plano inexistente");
      const base = slugify(b.name);
      let slug = base;
      for (
        let i = 2;
        (await c.query("SELECT 1 FROM tenants WHERE slug = $1", [slug])).rowCount;
        i++
      ) {
        slug = `${base}-${i}`;
      }
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO tenants (slug, name, legal_name, document, plan_id, contact_name, contact_email,
                              contact_phone, notes, storage_quota_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          slug,
          b.name,
          b.legalName ?? null,
          b.document ?? null,
          plan.id,
          b.contactName ?? null,
          b.contactEmail ?? null,
          b.contactPhone ?? null,
          b.notes ?? null,
          b.storageQuotaBytes ?? null,
        ],
      );
      const id = rows[0]!.id;
      await audit(c, req, "tenant.created", {
        tenantId: id,
        entityType: "tenant",
        entityId: id,
        data: { name: b.name, slug, plan: b.planCode },
      });
      // Usuário administrador do cliente, na mesma transação: se o e-mail já existir,
      // nada é criado (nem o cliente).
      if (b.admin && pw && hashed) {
        if ((await c.query("SELECT 1 FROM users WHERE email = $1", [b.admin.email])).rowCount)
          throw conflict("Já existe um usuário com o e-mail de acesso informado", "email_taken");
        const name = b.admin.name ?? b.contactName ?? b.name;
        const u = await c.query<{ id: string }>(
          `INSERT INTO users (tenant_id, role_id, name, email, password_hash, must_change_password)
           VALUES ($1, (SELECT id FROM roles WHERE key = 'tenant_admin'), $2, $3, $4, $5) RETURNING id`,
          [id, name, b.admin.email, hashed, pw.mustChange],
        );
        admin = { id: u.rows[0]!.id, name, email: b.admin.email, tenantId: id };
        await audit(c, req, "user.created", {
          tenantId: id,
          entityType: "user",
          entityId: admin.id,
          data: {
            email: b.admin.email,
            role: "tenant_admin",
            password: pw.generated ? "gerada" : "definida pelo administrador",
            mustChangePassword: pw.mustChange,
            viaTenant: true,
          },
        });
      }
      return (
        await c.query(
          `${TENANT_SELECT} FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
          [id],
        )
      ).rows[0];
    });
    if (!admin || !pw) return reply.code(201).send(created);
    const a = admin as { id: string; name: string; email: string; tenantId: string };
    const mail = b.admin?.sendEmail ? await emailAccess(req, a, pw.password, pw.mustChange) : null;
    return reply.code(201).send({
      ...created,
      admin: {
        user: { id: a.id, name: a.name, email: a.email },
        ...(pw.generated ? { temporaryPassword: pw.password } : {}),
        mustChangePassword: pw.mustChange,
        mail,
      },
    });
  });

  app.patch<{ Params: { id: string } }>("/api/v1/tenants/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(tenantBody.partial(), req.body);
    return db(app, req, async (c) => {
      const before = (
        await c.query(
          `${TENANT_SELECT} FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1 FOR UPDATE OF t`,
          [id],
        )
      ).rows[0];
      if (!before) throw notFound("Cliente não encontrado");
      let planId: string | null = null;
      if (b.planCode && b.planCode !== before.planCode) {
        const plan = (
          await c.query<{ id: string; max_cameras: number }>(
            "SELECT id, max_cameras FROM plans WHERE code = $1",
            [b.planCode],
          )
        ).rows[0];
        if (!plan) throw badRequest("Plano inexistente");
        if (before.cameraCount > plan.max_cameras) {
          throw conflict(
            `O cliente tem ${before.cameraCount} câmeras; o plano escolhido permite ${plan.max_cameras}.`,
            "plan_limit",
          );
        }
        planId = plan.id;
      }
      await c.query(
        `UPDATE tenants SET
           name = COALESCE($2, name),
           legal_name = CASE WHEN $3::boolean THEN $4 ELSE legal_name END,
           document = CASE WHEN $5::boolean THEN $6 ELSE document END,
           plan_id = COALESCE($7, plan_id),
           contact_name = CASE WHEN $8::boolean THEN $9 ELSE contact_name END,
           contact_email = CASE WHEN $10::boolean THEN $11 ELSE contact_email END,
           contact_phone = CASE WHEN $12::boolean THEN $13 ELSE contact_phone END,
           notes = CASE WHEN $14::boolean THEN $15 ELSE notes END,
           storage_quota_bytes = CASE WHEN $16::boolean THEN $17 ELSE storage_quota_bytes END
         WHERE id = $1`,
        [
          id,
          b.name ?? null,
          b.legalName !== undefined,
          b.legalName ?? null,
          b.document !== undefined,
          b.document ?? null,
          planId,
          b.contactName !== undefined,
          b.contactName ?? null,
          b.contactEmail !== undefined,
          b.contactEmail ?? null,
          b.contactPhone !== undefined,
          b.contactPhone ?? null,
          b.notes !== undefined,
          b.notes ?? null,
          b.storageQuotaBytes !== undefined,
          b.storageQuotaBytes ?? null,
        ],
      );
      await audit(c, req, "tenant.updated", {
        tenantId: id,
        entityType: "tenant",
        entityId: id,
        data: { changes: b },
      });
      return (
        await c.query(
          `${TENANT_SELECT} FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
          [id],
        )
      ).rows[0];
    });
  });

  app.post<{ Params: { id: string } }>("/api/v1/tenants/:id/status", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const { status } = parseBody(
      z.object({ status: z.enum(["active", "suspended", "cancelled"]) }),
      req.body,
    );
    const result = await db(app, req, async (c) => {
      const cur = (
        await c.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1 FOR UPDATE", [
          id,
        ])
      ).rows[0];
      if (!cur) throw notFound("Cliente não encontrado");
      if (cur.status === status) return { id, status };
      await c.query("UPDATE tenants SET status = $2 WHERE id = $1", [id, status]);
      await audit(c, req, `tenant.${status === "active" ? "activated" : status}`, {
        tenantId: id,
        entityType: "tenant",
        entityId: id,
        data: { from: cur.status, to: status },
      });
      if (status !== "active") {
        // Câmeras deixam de ser aceitas; quem publica é desconectado pelo reconciliador.
        await c.query(
          `UPDATE cameras SET status = 'offline', status_changed_at = now(), status_reason = 'tenant_inactive'
            WHERE tenant_id = $1 AND status IN ('conectando', 'recebendo', 'validando', 'ao_vivo', 'gravando')`,
          [id],
        );
      }
      await scheduleReconcile(c, "tenant_status");
      return { id, status };
    });
    await wakeWorker(app);
    return result;
  });
}
