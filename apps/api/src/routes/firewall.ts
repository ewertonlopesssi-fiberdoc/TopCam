import { PLATFORM, withScope, type PoolClient } from "@topcam/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { badRequest, conflict, notFound, parseBody } from "../lib/http.js";

/**
 * Firewall do servidor (Fase 8) — só o Super Admin (settings.write).
 *
 * O painel só grava a LISTA de redes que podem acessar o SSH. Quem aplica as regras é o
 * serviço do host (scripts/host/topcam-host, fora do Docker), que confere a lista a cada
 * minuto e devolve o resultado em system_settings "firewall.status".
 *
 *  GET    /api/v1/firewall                        redes, portas públicas e status da aplicação
 *  POST   /api/v1/firewall/ssh-networks           { cidr, description }
 *  PATCH  /api/v1/firewall/ssh-networks/:id       { cidr?, description? }
 *  DELETE /api/v1/firewall/ssh-networks/:id       (a última rede não pode ser removida)
 */

/** Portas abertas para qualquer origem (fixas; mudam só com nova versão). */
export const PUBLIC_PORTS = [
  { port: "80/tcp", use: "Painel (redireciona para HTTPS) e emissão do certificado" },
  { port: "443/tcp", use: "Painel e app (HTTPS)" },
  { port: "1935/tcp", use: "Câmeras enviando vídeo (RTMP)" },
  { port: "1936/tcp", use: "Câmeras enviando vídeo com criptografia (RTMPS)" },
  { port: "8189/tcp+udp", use: "Vídeo ao vivo no navegador (WebRTC)" },
];

/** O serviço do host confere a cada minuto; sem notícia há 5 min = parado. */
const STALE_MS = 5 * 60_000;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;
const IPV6 = /^[0-9a-f:]+(?:\/(\d{1,3}))?$/i;

/**
 * Aceita "172.31.0.0/16", "172.31.141.20/16" (vira 172.31.0.0/16) e IP sem máscara (/32).
 * Devolve o texto para o banco normalizar, ou lança 400 com a regra em português.
 */
export function parseNetwork(raw: string): string {
  const s = raw.trim();
  const v4 = IPV4.exec(s);
  if (v4) {
    if (v4.slice(1, 5).some((o) => Number(o) > 255)) throw badRequest(`IP inválido: ${s}`);
    const mask = v4[5] === undefined ? 32 : Number(v4[5]);
    if (mask > 32) throw badRequest(`Máscara inválida: /${mask} (use de /8 a /32)`);
    if (mask < 8)
      throw badRequest(`Máscara /${mask} libera quase a internet inteira; o mínimo é /8`);
    return `${v4.slice(1, 5).join(".")}/${mask}`;
  }
  const v6 = IPV6.exec(s);
  if (v6 && s.includes(":")) {
    const mask = v6[1] === undefined ? 128 : Number(v6[1]);
    if (mask > 128) throw badRequest(`Máscara inválida: /${mask}`);
    if (mask < 16) throw badRequest(`Máscara /${mask} é ampla demais; o mínimo em IPv6 é /16`);
    return s.includes("/") ? s : `${s}/128`;
  }
  throw badRequest(`Rede inválida: "${s}". Use IP/máscara, por exemplo 172.31.0.0/16`);
}

const description = z.string().trim().max(120);
const createBody = z
  .object({ cidr: z.string().max(60), description: description.default("") })
  .strict();
const patchBody = z
  .object({ cidr: z.string().max(60).optional(), description: description.optional() })
  .strict();
const idParam = z.object({ id: z.coerce.number().int().positive() });

type Row = { id: string; cidr: string; description: string; createdAt: string; updatedAt: string };
const COLS = `id::text, cidr::text, description, created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Normaliza no banco (tira os bits de host) e traduz os erros do Postgres. */
async function normalize(c: PoolClient, cidr: string): Promise<string> {
  try {
    return (await c.query<{ n: string }>("SELECT network($1::inet)::text AS n", [cidr])).rows[0]!.n;
  } catch {
    throw badRequest(`Rede inválida: "${cidr}"`);
  }
}
function uniqueViolation(err: unknown, cidr: string): never {
  if ((err as { code?: string }).code === "23505")
    throw conflict(`A rede ${cidr} já está na lista`);
  throw err;
}

export async function firewallRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;
  const admin = { preHandler: app.requirePermission("settings.write") };

  app.get("/api/v1/firewall", admin, async () => {
    return withScope(pool, PLATFORM, async (c) => {
      const networks = (await c.query<Row>(`SELECT ${COLS} FROM firewall_ssh_networks ORDER BY id`))
        .rows;
      const st = (
        await c.query<{ value: Record<string, unknown> }>(
          "SELECT value FROM system_settings WHERE key = 'firewall.status'",
        )
      ).rows[0]?.value;
      const checkedAt = typeof st?.checked_at === "string" ? st.checked_at : null;
      const applied = new Set(Array.isArray(st?.networks) ? (st.networks as string[]) : []);
      const pending = st?.ok === true && networks.some((n) => !applied.has(n.cidr));
      return {
        networks,
        publicPorts: PUBLIC_PORTS,
        status: {
          /** not_installed | stale | error | pending | applied */
          state: !st
            ? "not_installed"
            : !checkedAt || Date.now() - Date.parse(checkedAt) > STALE_MS
              ? "stale"
              : st.ok !== true
                ? "error"
                : pending || applied.size !== networks.length
                  ? "pending"
                  : "applied",
          appliedAt: typeof st?.applied_at === "string" ? st.applied_at : null,
          checkedAt,
          error: typeof st?.error === "string" ? st.error : null,
          applied: [...applied],
        },
      };
    });
  });

  app.post("/api/v1/firewall/ssh-networks", admin, async (req, reply) => {
    const b = parseBody(createBody, req.body);
    const wanted = parseNetwork(b.cidr);
    const row = await withScope(pool, PLATFORM, async (c) => {
      const cidr = await normalize(c, wanted);
      const r = await c
        .query<Row>(
          `INSERT INTO firewall_ssh_networks (cidr, description, created_by) VALUES ($1, $2, $3)
           RETURNING ${COLS}`,
          [cidr, b.description, req.user!.id],
        )
        .catch((err) => uniqueViolation(err, cidr));
      await audit(c, req, "firewall.rule_created", {
        tenantId: null,
        entityType: "firewall",
        entityId: r.rows[0]!.id,
        data: { cidr, description: b.description },
      });
      return r.rows[0]!;
    });
    return reply.code(201).send(row);
  });

  app.patch("/api/v1/firewall/ssh-networks/:id", admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = parseBody(patchBody, req.body);
    return withScope(pool, PLATFORM, async (c) => {
      const cur = (
        await c.query<Row>(`SELECT ${COLS} FROM firewall_ssh_networks WHERE id = $1 FOR UPDATE`, [
          id,
        ])
      ).rows[0];
      if (!cur) throw notFound("Rede não encontrada");
      const cidr = b.cidr === undefined ? cur.cidr : await normalize(c, parseNetwork(b.cidr));
      const desc = b.description ?? cur.description;
      const r = await c
        .query<Row>(
          `UPDATE firewall_ssh_networks SET cidr = $2, description = $3, updated_at = now()
           WHERE id = $1 RETURNING ${COLS}`,
          [id, cidr, desc],
        )
        .catch((err) => uniqueViolation(err, cidr));
      await audit(c, req, "firewall.rule_updated", {
        tenantId: null,
        entityType: "firewall",
        entityId: String(id),
        data: { before: { cidr: cur.cidr, description: cur.description }, cidr, description: desc },
      });
      return r.rows[0]!;
    });
  });

  app.delete("/api/v1/firewall/ssh-networks/:id", admin, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await withScope(pool, PLATFORM, async (c) => {
      // Trava a tabela para duas exclusões simultâneas não esvaziarem a lista.
      await c.query("LOCK TABLE firewall_ssh_networks IN SHARE ROW EXCLUSIVE MODE");
      const cur = (
        await c.query<Row>(`SELECT ${COLS} FROM firewall_ssh_networks WHERE id = $1`, [id])
      ).rows[0];
      if (!cur) throw notFound("Rede não encontrada");
      const total = Number(
        (await c.query<{ n: string }>("SELECT count(*) AS n FROM firewall_ssh_networks")).rows[0]!
          .n,
      );
      if (total <= 1)
        throw conflict(
          "Esta é a última rede liberada para o SSH. Adicione outra antes de remover esta, para ninguém ficar sem acesso.",
          "last_network",
        );
      await c.query("DELETE FROM firewall_ssh_networks WHERE id = $1", [id]);
      await audit(c, req, "firewall.rule_deleted", {
        tenantId: null,
        entityType: "firewall",
        entityId: String(id),
        data: { cidr: cur.cidr, description: cur.description },
      });
    });
    return reply.code(204).send();
  });
}
