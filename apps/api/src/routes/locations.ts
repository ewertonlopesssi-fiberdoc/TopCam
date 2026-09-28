import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { db, effectiveTenant } from "../lib/ctx.js";
import { badRequest, conflict, notFound, parseBody, uuid } from "../lib/http.js";

/** Locais (ex.: Matriz, Filial 01) e grupos de câmeras dentro de cada local. */

const locationBody = z.object({
  tenantId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(300).nullable().optional(),
  timezone: z.string().trim().max(60).nullable().optional(),
});

const groupBody = z.object({
  locationId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

function uniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === "23505";
}

export async function locationRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: app.requirePermission("locations.read") };
  const write = { preHandler: app.requirePermission("locations.write") };

  /** Árvore Cliente › Local › Grupo com contagem de câmeras (visíveis ao usuário). */
  app.get("/api/v1/locations", read, async (req) => {
    const q = parseBody(z.object({ tenantId: z.string().uuid().optional() }), req.query);
    const tenant = effectiveTenant(req, q.tenantId ?? null);
    const granted = req.user!.role === "operator" || req.user!.role === "viewer";
    return db(app, req, async (c) => {
      const cams = `SELECT c.id, c.location_id, c.group_id FROM cameras c
                     WHERE c.deleted_at IS NULL
                       AND ($2::boolean = false OR EXISTS (SELECT 1 FROM user_camera_permissions p
                             WHERE p.camera_id = c.id AND p.user_id = $3))`;
      const locations = (
        await c.query(
          `SELECT l.id, l.tenant_id AS "tenantId", t.name AS "tenantName", l.name, l.address, l.timezone,
                  (SELECT count(*)::int FROM (${cams}) x WHERE x.location_id = l.id) AS "cameraCount"
             FROM locations l JOIN tenants t ON t.id = l.tenant_id
            WHERE l.deleted_at IS NULL AND ($1::uuid IS NULL OR l.tenant_id = $1)
            ORDER BY t.name, l.name`,
          [tenant, granted, req.user!.id],
        )
      ).rows;
      const groups = (
        await c.query(
          `SELECT g.id, g.location_id AS "locationId", g.name, g.sort_order AS "sortOrder",
                  (SELECT count(*)::int FROM (${cams}) x WHERE x.group_id = g.id) AS "cameraCount"
             FROM camera_groups g
            WHERE g.deleted_at IS NULL AND ($1::uuid IS NULL OR g.tenant_id = $1)
            ORDER BY g.sort_order, g.name`,
          [tenant, granted, req.user!.id],
        )
      ).rows;
      return {
        items: locations
          .map((l) => ({ ...l, groups: groups.filter((g) => g.locationId === l.id) }))
          // Operador/visualizador só enxerga locais onde tem alguma câmera.
          .filter((l) => !granted || l.cameraCount > 0),
      };
    });
  });

  app.post("/api/v1/locations", write, async (req, reply) => {
    const b = parseBody(locationBody, req.body);
    effectiveTenant(req, b.tenantId);
    try {
      const row = await db(app, req, async (c) => {
        if (
          !(
            await c.query("SELECT 1 FROM tenants WHERE id = $1 AND deleted_at IS NULL", [
              b.tenantId,
            ])
          ).rowCount
        ) {
          throw badRequest("Cliente inexistente");
        }
        const { rows } = await c.query(
          `INSERT INTO locations (tenant_id, name, address, timezone) VALUES ($1, $2, $3, $4)
           RETURNING id, tenant_id AS "tenantId", name, address, timezone`,
          [b.tenantId, b.name, b.address ?? null, b.timezone ?? null],
        );
        await audit(c, req, "location.created", {
          tenantId: b.tenantId,
          entityType: "location",
          entityId: rows[0].id,
          data: { name: b.name },
        });
        return rows[0];
      });
      return reply.code(201).send({ ...row, groups: [], cameraCount: 0 });
    } catch (err) {
      if (uniqueViolation(err)) throw conflict("Já existe um local com este nome neste cliente");
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/v1/locations/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(locationBody.omit({ tenantId: true }).partial(), req.body);
    try {
      return await db(app, req, async (c) => {
        const { rows } = await c.query(
          `UPDATE locations SET name = COALESCE($2, name),
                  address = CASE WHEN $3::boolean THEN $4 ELSE address END,
                  timezone = CASE WHEN $5::boolean THEN $6 ELSE timezone END
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, tenant_id AS "tenantId", name, address, timezone`,
          [
            id,
            b.name ?? null,
            b.address !== undefined,
            b.address ?? null,
            b.timezone !== undefined,
            b.timezone ?? null,
          ],
        );
        if (!rows[0]) throw notFound("Local não encontrado");
        await audit(c, req, "location.updated", {
          tenantId: rows[0].tenantId,
          entityType: "location",
          entityId: id,
          data: { changes: b },
        });
        return rows[0];
      });
    } catch (err) {
      if (uniqueViolation(err)) throw conflict("Já existe um local com este nome neste cliente");
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/locations/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    return db(app, req, async (c) => {
      const loc = (
        await c.query(
          "SELECT tenant_id, name FROM locations WHERE id = $1 AND deleted_at IS NULL",
          [id],
        )
      ).rows[0];
      if (!loc) throw notFound("Local não encontrado");
      if (
        (await c.query("SELECT 1 FROM cameras WHERE location_id = $1 AND deleted_at IS NULL", [id]))
          .rowCount
      ) {
        throw conflict("Mova ou remova as câmeras deste local antes de excluí-lo", "not_empty");
      }
      // Libera o nome para reutilização mantendo o histórico.
      await c.query(
        `UPDATE locations SET deleted_at = now(), name = name || ' (removido ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')' WHERE id = $1`,
        [id],
      );
      await c.query(
        `UPDATE camera_groups SET deleted_at = now(), name = name || ' (removido ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')'
          WHERE location_id = $1 AND deleted_at IS NULL`,
        [id],
      );
      await audit(c, req, "location.deleted", {
        tenantId: loc.tenant_id,
        entityType: "location",
        entityId: id,
        data: { name: loc.name },
      });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------------ grupos
  app.post("/api/v1/camera-groups", write, async (req, reply) => {
    const b = parseBody(groupBody, req.body);
    try {
      const row = await db(app, req, async (c) => {
        const loc = (
          await c.query<{ tenant_id: string }>(
            "SELECT tenant_id FROM locations WHERE id = $1 AND deleted_at IS NULL",
            [b.locationId],
          )
        ).rows[0];
        if (!loc) throw badRequest("Local inexistente");
        effectiveTenant(req, loc.tenant_id);
        const { rows } = await c.query(
          `INSERT INTO camera_groups (tenant_id, location_id, name, sort_order) VALUES ($1, $2, $3, $4)
           RETURNING id, location_id AS "locationId", name, sort_order AS "sortOrder"`,
          [loc.tenant_id, b.locationId, b.name, b.sortOrder ?? 0],
        );
        await audit(c, req, "camera_group.created", {
          tenantId: loc.tenant_id,
          entityType: "camera_group",
          entityId: rows[0].id,
          data: { name: b.name, location: b.locationId },
        });
        return rows[0];
      });
      return reply.code(201).send({ ...row, cameraCount: 0 });
    } catch (err) {
      if (uniqueViolation(err)) throw conflict("Já existe um grupo com este nome neste local");
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/v1/camera-groups/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    const b = parseBody(groupBody.omit({ locationId: true }).partial(), req.body);
    try {
      return await db(app, req, async (c) => {
        const { rows } = await c.query(
          `UPDATE camera_groups SET name = COALESCE($2, name), sort_order = COALESCE($3, sort_order)
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id, tenant_id AS "tenantId", location_id AS "locationId", name, sort_order AS "sortOrder"`,
          [id, b.name ?? null, b.sortOrder ?? null],
        );
        if (!rows[0]) throw notFound("Grupo não encontrado");
        await audit(c, req, "camera_group.updated", {
          tenantId: rows[0].tenantId,
          entityType: "camera_group",
          entityId: id,
          data: { changes: b },
        });
        return rows[0];
      });
    } catch (err) {
      if (uniqueViolation(err)) throw conflict("Já existe um grupo com este nome neste local");
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/api/v1/camera-groups/:id", write, async (req) => {
    const id = parseBody(uuid, req.params.id);
    return db(app, req, async (c) => {
      const g = (
        await c.query(
          "SELECT tenant_id, name FROM camera_groups WHERE id = $1 AND deleted_at IS NULL",
          [id],
        )
      ).rows[0];
      if (!g) throw notFound("Grupo não encontrado");
      if (
        (await c.query("SELECT 1 FROM cameras WHERE group_id = $1 AND deleted_at IS NULL", [id]))
          .rowCount
      ) {
        throw conflict("Mova ou remova as câmeras deste grupo antes de excluí-lo", "not_empty");
      }
      await c.query(
        `UPDATE camera_groups SET deleted_at = now(), name = name || ' (removido ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')' WHERE id = $1`,
        [id],
      );
      await audit(c, req, "camera_group.deleted", {
        tenantId: g.tenant_id,
        entityType: "camera_group",
        entityId: id,
        data: { name: g.name },
      });
      return { ok: true };
    });
  });
}
