import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORM, insertAudit, withScope } from "@topcam/db";
import {
  BACKUP_DEFAULT_PORT,
  BACKUP_FILE_RE,
  BACKUP_PASSPHRASE_MIN,
  BACKUP_PATH_RE,
  encryptSecret,
  mergeBackupSettings,
  nextScheduledSlot,
  parseEncryptionKey,
  verifyPassword,
  type BackupSettings,
} from "@topcam/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../lib/audit.js";
import { HttpError, badRequest, conflict, notFound, parseBody } from "../lib/http.js";

/**
 * Backup (Fase 8, parte 3) — só o Super Admin (settings.write).
 *
 *  GET  /api/v1/backup                     configuração (sem segredos), histórico, estado do serviço
 *  PUT  /api/v1/backup/settings            salva (senhas cifradas; em branco = mantém)
 *  POST /api/v1/backup/test                pede um teste de conexão ao serviço de backup
 *  POST /api/v1/backup/run                 pede um backup agora
 *  POST /api/v1/backup/accept-host-key     esquece a identidade SFTP registrada (servidor trocado)
 *  POST /api/v1/backup/download            { runId, password } → link de uso único (60 s)
 *  GET  /api/v1/backup/download/:token     baixa o arquivo cifrado (sem cabeçalho de login:
 *                                          o próprio link é a autorização, e vale uma vez)
 *
 * Quem executa é o serviço "backup" (contêiner próprio). A API só grava pedidos em backup_runs.
 */

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9._@+-]{1,100}$/;

/**
 * Chave privada protegida por senha? PEM antigo traz "ENCRYPTED" no texto; o formato
 * OpenSSH novo guarda o nome da cifra dentro do conteúdo ("none" = sem senha).
 */
export function privateKeyHasPassphrase(pem: string): boolean {
  if (/ENCRYPTED/.test(pem)) return true;
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(
    pem,
  );
  if (!m) return false;
  const raw = Buffer.from(m[1]!.replace(/\s+/g, ""), "base64");
  const magic = "openssh-key-v1\0";
  if (raw.subarray(0, magic.length).toString("latin1") !== magic) return false;
  const len = raw.readUInt32BE(magic.length);
  const cipher = raw.subarray(magic.length + 4, magic.length + 4 + len).toString("latin1");
  return cipher !== "none";
}

const body = z
  .object({
    enabled: z.boolean(),
    /** Sem destino externo: o arquivo fica só no servidor e é baixado pelo painel. */
    localOnly: z.boolean().default(false),
    protocol: z.enum(["sftp", "ftps", "ftp"]),
    host: z.string().trim().max(253),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().max(100),
    auth: z.enum(["password", "key"]).default("password"),
    /** undefined = mantém; "" = apaga; texto = nova. */
    password: z.string().max(500).optional(),
    privateKey: z.string().max(20_000).optional(),
    path: z.string().trim().max(200),
    verifyCertificate: z.boolean().default(true),
    scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Horário no formato HH:MM"),
    retentionRemote: z.number().int().min(1).max(365),
    retentionLocal: z.number().int().min(0).max(30),
    /** undefined = mantém; texto = nova senha do arquivo de backup. */
    passphrase: z.string().max(500).optional(),
  })
  .strict();

/** Link de download: uso único, curto. */
const DOWNLOAD_TTL_S = 60;
const dlKey = (t: string) => `topcam:backup-dl:${t}`;

/** Serviço sem sinal de vida há mais que isto → "parado". */
const SERVICE_STALE_MS = 2 * 60_000;

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  const { env, pool } = app.deps;
  const encKey = parseEncryptionKey(env.STREAM_KEY_ENC_KEY);
  const admin = { preHandler: app.requirePermission("settings.write") };
  const limited = {
    preHandler: [app.requirePermission("settings.write"), app.rateLimit("backup-request", 10, 600)],
  };

  /** Backups que ainda estão no servidor (os únicos que dá para baixar). */
  async function localFiles(): Promise<string[]> {
    try {
      return (await readdir(env.BACKUP_DIR)).filter((n) => BACKUP_FILE_RE.test(n));
    } catch {
      return [];
    }
  }

  async function load(): Promise<BackupSettings> {
    const row = await withScope(
      pool,
      PLATFORM,
      async (c) =>
        (
          await c.query<{ value: unknown }>(
            "SELECT value FROM system_settings WHERE key = 'integrations.backup'",
          )
        ).rows[0],
    );
    return mergeBackupSettings(row?.value);
  }

  app.get("/api/v1/backup", admin, async () => {
    const s = await load();
    return withScope(pool, PLATFORM, async (c) => {
      const runs = (
        await c.query<{ kind: string; status: string; fileName: string | null }>(
          `SELECT r.id::text, r.kind, r.trigger, r.status, r.created_at AS "createdAt",
                  r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.file_name AS "fileName",
                  r.size_bytes::float8 AS "sizeBytes", r.destination, r.message, r.error, r.details,
                  u.name AS "requestedBy"
             FROM backup_runs r LEFT JOIN users u ON u.id = r.requested_by
            ORDER BY r.id DESC LIMIT 20`,
        )
      ).rows;
      const beat = (
        await c.query<{ value: { at?: string; busy?: string | null } }>(
          "SELECT value FROM system_settings WHERE key = 'backup.heartbeat'",
        )
      ).rows[0]?.value;
      const lastSuccess = (
        await c.query<{ at: Date | null }>(
          "SELECT max(finished_at) AS at FROM backup_runs WHERE kind = 'backup' AND status = 'success'",
        )
      ).rows[0]!.at;
      const alive = !!beat?.at && Date.now() - Date.parse(beat.at) < SERVICE_STALE_MS;
      const local = new Set(await localFiles());
      return {
        settings: {
          enabled: s.enabled,
          localOnly: s.local_only,
          protocol: s.protocol,
          host: s.host,
          port: s.port,
          username: s.username,
          auth: s.auth,
          hasPassword: Boolean(s.password_enc),
          hasPrivateKey: Boolean(s.private_key_enc),
          path: s.path,
          verifyCertificate: s.verify_certificate,
          hostKeyFingerprint: s.host_key_fingerprint,
          scheduleTime: s.schedule_time,
          retentionRemote: s.retention_remote,
          retentionLocal: s.retention_local,
          hasPassphrase: Boolean(s.passphrase_enc),
        },
        service: { alive, lastSeenAt: beat?.at ?? null, busy: Boolean(beat?.busy) },
        nextRunAt: s.enabled ? nextScheduledSlot(new Date(), s.schedule_time).toISOString() : null,
        lastSuccessAt: lastSuccess,
        runs: runs.map((r) => ({
          ...r,
          downloadable:
            r.kind === "backup" && r.status === "success" && !!r.fileName && local.has(r.fileName),
        })),
      };
    });
  });

  app.put("/api/v1/backup/settings", admin, async (req) => {
    const b = parseBody(body, req.body);
    const cur = await load();
    if (b.localOnly && b.retentionLocal < 1)
      throw badRequest("Sem destino externo, guarde ao menos 1 cópia no servidor");
    if (b.host && !HOST_RE.test(b.host))
      throw badRequest("Servidor inválido: use o nome ou o IP (IPv4)");
    if (b.username && !USER_RE.test(b.username))
      throw badRequest("Usuário inválido: use letras, números e . _ @ + -");
    if (!BACKUP_PATH_RE.test(b.path))
      throw badRequest('Pasta inválida: use letras, números e . _ - / (sem espaços e sem "..")');
    const auth = b.protocol === "sftp" ? b.auth : "password";

    const enc = (v: string | undefined, current: string | null) =>
      v === undefined ? current : v === "" ? null : encryptSecret(v, encKey);
    let privateKeyEnc = cur.private_key_enc;
    if (b.privateKey !== undefined) {
      const k = b.privateKey.trim();
      if (k && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(k))
        throw badRequest(
          "Chave SSH inválida: cole a chave PRIVADA completa (BEGIN ... PRIVATE KEY)",
        );
      if (privateKeyHasPassphrase(k))
        throw badRequest(
          "A chave SSH está protegida por senha; use uma chave sem senha, exclusiva para o backup",
        );
      privateKeyEnc = k ? encryptSecret(`${k}\n`, encKey) : null;
    }
    if (b.passphrase !== undefined && b.passphrase.length < BACKUP_PASSPHRASE_MIN)
      throw badRequest(
        `A senha do backup precisa de pelo menos ${BACKUP_PASSPHRASE_MIN} caracteres`,
      );

    const port = b.port ?? BACKUP_DEFAULT_PORT[b.protocol];
    const endpointChanged = cur.host !== b.host || cur.port !== port || cur.protocol !== b.protocol;
    const next: BackupSettings = {
      enabled: b.enabled,
      local_only: b.localOnly,
      protocol: b.protocol,
      host: b.host,
      port,
      username: b.username,
      auth,
      password_enc: enc(b.password, cur.password_enc),
      private_key_enc: auth === "key" ? privateKeyEnc : null,
      path: b.path,
      verify_certificate: b.verifyCertificate,
      // Servidor trocado → a identidade SFTP é registrada de novo no próximo teste.
      host_keys: endpointChanged ? null : cur.host_keys,
      host_key_fingerprint: endpointChanged ? null : cur.host_key_fingerprint,
      schedule_time: b.scheduleTime,
      retention_remote: b.retentionRemote,
      retention_local: b.retentionLocal,
      passphrase_enc:
        b.passphrase === undefined ? cur.passphrase_enc : encryptSecret(b.passphrase, encKey),
      enabled_at: b.enabled ? (cur.enabled ? cur.enabled_at : new Date().toISOString()) : null,
    };
    if (next.enabled && !next.local_only) {
      if (!next.host) throw badRequest("Informe o servidor de destino");
      if (!next.username) throw badRequest("Informe o usuário do destino");
      if (auth === "key" ? !next.private_key_enc : !next.password_enc)
        throw badRequest(
          auth === "key" ? "Cole a chave SSH privada" : "Informe a senha do destino",
        );
    }
    if (next.enabled && !next.passphrase_enc)
      throw badRequest("Defina a senha do backup (guarde-a fora do servidor)");

    await withScope(pool, PLATFORM, async (c) => {
      await c.query(
        `INSERT INTO system_settings (key, value, updated_by) VALUES ('integrations.backup', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
        [JSON.stringify(next), req.user!.id],
      );
      // Segredos nunca vão para a auditoria: só a informação de que mudaram.
      await audit(c, req, "backup.settings_updated", {
        tenantId: null,
        entityType: "integration",
        entityId: "backup",
        data: {
          enabled: next.enabled,
          localOnly: next.local_only,
          protocol: next.protocol,
          host: next.host,
          port: next.port,
          username: next.username,
          auth: next.auth,
          path: next.path,
          scheduleTime: next.schedule_time,
          retentionRemote: next.retention_remote,
          retentionLocal: next.retention_local,
          passwordChanged: b.password !== undefined,
          privateKeyChanged: b.privateKey !== undefined,
          passphraseChanged: b.passphrase !== undefined,
          hostKeyReset: endpointChanged && Boolean(cur.host_keys),
        },
      });
    });
    return { ok: true, hostKeyReset: endpointChanged && Boolean(cur.host_keys) };
  });

  async function request(
    kind: "test" | "backup",
    userId: string,
    req: Parameters<typeof audit>[1],
  ) {
    return withScope(pool, PLATFORM, async (c) => {
      try {
        const id = (
          await c.query<{ id: string }>(
            `INSERT INTO backup_runs (kind, trigger, requested_by) VALUES ($1, 'manual', $2) RETURNING id::text`,
            [kind, userId],
          )
        ).rows[0]!.id;
        await audit(c, req, kind === "test" ? "backup.test_requested" : "backup.run_requested", {
          tenantId: null,
          entityType: "backup_run",
          entityId: id,
        });
        return { id };
      } catch (err) {
        if ((err as { code?: string }).code === "23505")
          throw conflict("Já há um backup ou teste em andamento. Aguarde terminar.", "backup_busy");
        throw err;
      }
    });
  }

  app.post("/api/v1/backup/test", limited, async (req, reply) => {
    const s = await load();
    if (s.local_only)
      throw badRequest('Backup "somente no servidor": não há destino externo para testar');
    if (!s.host || !s.username) throw badRequest("Salve o destino antes de testar");
    return reply.code(202).send(await request("test", req.user!.id, req));
  });

  app.post("/api/v1/backup/run", limited, async (req, reply) => {
    const s = await load();
    if (!s.local_only && (!s.host || !s.username))
      throw badRequest("Salve o destino antes de fazer o backup");
    if (!s.passphrase_enc) throw badRequest("Defina a senha do backup antes");
    return reply.code(202).send(await request("backup", req.user!.id, req));
  });

  app.post("/api/v1/backup/accept-host-key", admin, async (req) => {
    await withScope(pool, PLATFORM, async (c) => {
      await c.query(
        `UPDATE system_settings SET value = value || '{"host_keys": null, "host_key_fingerprint": null}'::jsonb
          WHERE key = 'integrations.backup'`,
      );
      await audit(c, req, "backup.host_key_reset", {
        tenantId: null,
        entityType: "integration",
        entityId: "backup",
      });
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------ download
  const downloadBody = z
    .object({ runId: z.string().regex(/^\d+$/), password: z.string().max(200) })
    .strict();
  const downloadLimit = {
    preHandler: [
      app.requirePermission("settings.write"),
      app.rateLimit("backup-download", 10, 600),
    ],
  };

  app.post("/api/v1/backup/download", downloadLimit, async (req) => {
    const b = parseBody(downloadBody, req.body);
    const user = req.user!;
    const run = await withScope(pool, PLATFORM, async (c) => {
      const hash = (
        await c.query<{ password_hash: string | null }>(
          "SELECT password_hash FROM users WHERE id = $1",
          [user.id],
        )
      ).rows[0]?.password_hash;
      if (!hash || !(await verifyPassword(b.password, hash)))
        throw new HttpError(400, "wrong_password", "Senha incorreta");
      return (
        await c.query<{ file_name: string | null; kind: string; status: string }>(
          "SELECT file_name, kind, status FROM backup_runs WHERE id = $1",
          [b.runId],
        )
      ).rows[0];
    });
    if (!run || run.kind !== "backup" || run.status !== "success" || !run.file_name)
      throw notFound("Backup não encontrado");
    const file = run.file_name;
    if (!BACKUP_FILE_RE.test(file) || !(await localFiles()).includes(file))
      throw notFound(
        "Este backup não está mais no servidor (só as cópias mais recentes ficam guardadas)",
      );
    const token = randomBytes(32).toString("base64url");
    await app.deps.redis.set(
      dlKey(token),
      JSON.stringify({ file, userId: user.id, runId: b.runId }),
      "EX",
      DOWNLOAD_TTL_S,
    );
    return { url: `/api/v1/backup/download/${token}`, fileName: file, expiresInS: DOWNLOAD_TTL_S };
  });

  app.get<{ Params: { token: string } }>("/api/v1/backup/download/:token", async (req, reply) => {
    const token = req.params.token;
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound("Link inválido ou expirado");
    const raw = await app.deps.redis.getdel(dlKey(token));
    if (!raw) throw notFound("Link inválido ou expirado. Peça o download de novo pelo painel.");
    const { file, userId, runId } = JSON.parse(raw) as {
      file: string;
      userId: string;
      runId: string;
    };
    if (!BACKUP_FILE_RE.test(file)) throw notFound("Link inválido ou expirado");
    const path = join(env.BACKUP_DIR, file);
    const info = await stat(path).catch(() => null);
    if (!info) throw notFound("Este backup não está mais no servidor");
    await withScope(pool, PLATFORM, (c) =>
      insertAudit(c, {
        tenantId: null,
        actorType: "user",
        actorUserId: userId,
        action: "backup.downloaded",
        entityType: "backup_run",
        entityId: runId,
        data: { file, size: info.size },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      }),
    );
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${file}"`)
      .header("Content-Length", String(info.size))
      .header("Cache-Control", "no-store")
      .send(createReadStream(path));
  });
}
