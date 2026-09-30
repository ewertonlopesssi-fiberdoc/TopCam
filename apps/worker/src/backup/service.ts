import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PLATFORM, raiseAlert, resolveAlert, withScope, type Pool } from "@topcam/db";
import {
  backupFileName,
  decryptSecret,
  filesToPrune,
  lastScheduledSlot,
  mergeBackupSettings,
  type BackupSettings,
} from "@topcam/shared";
import type { Logger } from "pino";
import { createArchive, type OwnerDb } from "./archive.js";
import {
  removeRemote,
  scanHostKey,
  testDestination,
  TransferError,
  uploadBackup,
  type Destination,
} from "./transfer.js";
import { privateDir, writePrivate } from "./tools.js";

export interface BackupContext {
  pool: Pool;
  log: Logger;
  encKey: Buffer;
  ownerDb: OwnerDb;
  envFile: string;
  backupDir: string;
  appVersion: string;
  publicHost: string;
}

interface RunRow {
  id: string;
  kind: "backup" | "test";
  trigger: "schedule" | "manual";
}

/** Sem backup concluído há mais que isto → alerta. */
const STALE_MS = 26 * 3_600_000;
/** Agendado que falhou: novas tentativas até 3, com 30 min de intervalo. */
const SCHEDULE_ATTEMPTS = 3;
const RETRY_AFTER_MS = 30 * 60_000;

const ALERT_FAILED = "backup.failed";
const ALERT_STALE = "backup.stale";

export async function loadSettings(pool: Pool): Promise<BackupSettings> {
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

function configured(s: BackupSettings): string | null {
  if (s.local_only) return null;
  if (!s.host) return "Informe o servidor de destino";
  if (!s.username) return "Informe o usuário do destino";
  if (s.auth === "key" ? !s.private_key_enc : !s.password_enc)
    return s.auth === "key" ? "Informe a chave SSH" : "Informe a senha do destino";
  return null;
}

function destination(ctx: BackupContext, s: BackupSettings): Destination {
  const open = (v: string | null) => (v ? decryptSecret(v, ctx.encKey) : null);
  return {
    protocol: s.protocol,
    host: s.host,
    port: s.port,
    username: s.username,
    password: s.auth === "key" ? null : open(s.password_enc),
    privateKey: s.protocol === "sftp" && s.auth === "key" ? open(s.private_key_enc) : null,
    path: s.path,
    verifyCertificate: s.verify_certificate,
    hostKeys: s.host_keys,
  };
}

const describeDest = (s: BackupSettings) =>
  s.local_only ? "somente no servidor" : `${s.protocol}://${s.host}:${s.port}/${s.path}`;

async function saveHostKey(ctx: BackupContext, lines: string, fingerprint: string) {
  await withScope(ctx.pool, PLATFORM, (c) =>
    c.query(
      `UPDATE system_settings
          SET value = value || jsonb_build_object('host_keys', $1::text, 'host_key_fingerprint', $2::text)
        WHERE key = 'integrations.backup'`,
      [lines, fingerprint],
    ),
  );
}

/** SFTP: registra a identidade no primeiro uso; depois, só confere. */
async function ensureHostKey(ctx: BackupContext, s: BackupSettings): Promise<string | null> {
  if (s.protocol !== "sftp") return null;
  const scanned = await scanHostKey(s.host, s.port);
  if (!s.host_keys) {
    await saveHostKey(ctx, scanned.lines, scanned.fingerprint);
    s.host_keys = scanned.lines;
    s.host_key_fingerprint = scanned.fingerprint;
    return `identidade do servidor registrada: ${scanned.fingerprint}`;
  }
  const blobs = (t: string) =>
    new Set(
      t
        .split("\n")
        .map((l) => l.trim().split(/\s+/).slice(1).join(" "))
        .filter(Boolean),
    );
  const pinned = blobs(s.host_keys);
  if (![...blobs(scanned.lines)].some((b) => pinned.has(b)))
    throw Object.assign(
      new TransferError(
        `A identidade do servidor SFTP mudou (agora: ${scanned.fingerprint}). Se a troca foi de propósito, use "Aceitar nova identidade" e teste de novo.`,
        true,
      ),
      { newFingerprint: scanned.fingerprint },
    );
  return null;
}

async function finish(
  ctx: BackupContext,
  id: string,
  status: "success" | "failed",
  fields: {
    message?: string;
    error?: string;
    file_name?: string;
    size_bytes?: number;
    destination?: string;
    details?: Record<string, unknown>;
  },
) {
  await withScope(ctx.pool, PLATFORM, (c) =>
    c.query(
      `UPDATE backup_runs SET status = $2, finished_at = now(), message = $3, error = $4,
              file_name = coalesce($5, file_name), size_bytes = coalesce($6, size_bytes),
              destination = coalesce($7, destination), details = details || $8::jsonb
        WHERE id = $1`,
      [
        id,
        status,
        fields.message ?? null,
        fields.error ?? null,
        fields.file_name ?? null,
        fields.size_bytes ?? null,
        fields.destination ?? null,
        JSON.stringify(fields.details ?? {}),
      ],
    ),
  );
}

// ------------------------------------------------------------------ teste de conexão
async function runTest(ctx: BackupContext, run: RunRow) {
  const s = await loadSettings(ctx.pool);
  if (s.local_only)
    return finish(ctx, run.id, "failed", {
      error: 'Backup configurado como "somente no servidor": não há destino externo para testar',
    });
  const missing = configured(s);
  if (missing) return finish(ctx, run.id, "failed", { error: missing });
  const tmp = await privateDir("topcam-probe-");
  try {
    const note = await ensureHostKey(ctx, s);
    const probe = join(tmp.dir, "probe.txt");
    await writePrivate(probe, `teste do TopCam em ${new Date().toISOString()}\n`);
    const names = await testDestination(destination(ctx, s), probe);
    const ours = names.filter((n) => /^topcam-\d{8}-\d{6}\.tar\.gpg$/.test(n)).length;
    await finish(ctx, run.id, "success", {
      destination: describeDest(s),
      message:
        `Conexão ok: pasta "${s.path}" gravável; ${ours} backup(s) do TopCam no destino` +
        (note ? `; ${note}` : ""),
      details: { host_key_fingerprint: s.host_key_fingerprint },
    });
  } catch (err) {
    await finish(ctx, run.id, "failed", {
      destination: describeDest(s),
      error: (err as Error).message,
      details: {
        host_key_changed: err instanceof TransferError && err.hostKeyChanged,
        new_fingerprint: (err as { newFingerprint?: string }).newFingerprint,
      },
    });
  } finally {
    await tmp.cleanup();
  }
}

// ------------------------------------------------------------------ backup
async function pruneLocal(dir: string, keep: number): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const gone = filesToPrune(names, keep);
  for (const n of gone) await unlink(join(dir, n)).catch(() => undefined);
  return gone;
}

async function runBackup(ctx: BackupContext, run: RunRow) {
  const started = Date.now();
  const s = await loadSettings(ctx.pool);
  const missing = configured(s) ?? (s.passphrase_enc ? null : "Defina a senha do backup");
  if (missing) return fail(ctx, run, s, missing);

  let archive: Awaited<ReturnType<typeof createArchive>>;
  try {
    archive = await createArchive({
      db: ctx.ownerDb,
      envFile: ctx.envFile,
      passphrase: decryptSecret(s.passphrase_enc!, ctx.encKey),
      outDir: ctx.backupDir,
      name: backupFileName(new Date()),
      appVersion: ctx.appVersion,
      publicHost: ctx.publicHost,
    });
  } catch (err) {
    return fail(ctx, run, s, (err as Error).message);
  }
  const name = archive.file.split("/").at(-1)!;

  if (s.local_only) {
    // Sem destino externo: guarda no servidor (mínimo 1 cópia) para baixar pelo painel.
    const removedLocal = await pruneLocal(ctx.backupDir, Math.max(1, s.retention_local));
    const secs = Math.round((Date.now() - started) / 1000);
    await finish(ctx, run.id, "success", {
      file_name: name,
      size_bytes: archive.size,
      destination: describeDest(s),
      message: `Backup salvo no servidor em ${secs} s (sem destino externo; baixe pelo painel)`,
      details: {
        duration_s: secs,
        counts: archive.manifest.counts,
        migrations: archive.manifest.migrations.length,
        removed_local: removedLocal,
        local_only: true,
      },
    });
    await withScope(ctx.pool, PLATFORM, async (c) => {
      await resolveAlert(c, ALERT_FAILED);
      await resolveAlert(c, ALERT_STALE);
    });
    ctx.log.info(
      { file: name, size: archive.size, secs },
      "backup concluído (somente no servidor)",
    );
    return;
  }

  try {
    await ensureHostKey(ctx, s);
    const dest = destination(ctx, s);
    const names = await uploadBackup(dest, archive.file, name);
    const removedRemote = filesToPrune(names, s.retention_remote).filter((n) => n !== name);
    await removeRemote(dest, removedRemote);
    // Cópias locais: só depois do envio (com 0, nenhuma fica no servidor).
    const removedLocal = await pruneLocal(ctx.backupDir, s.retention_local);
    const secs = Math.round((Date.now() - started) / 1000);
    await finish(ctx, run.id, "success", {
      file_name: name,
      size_bytes: archive.size,
      destination: describeDest(s),
      message: `Backup enviado em ${secs} s; ${Math.min(names.length - removedRemote.length, s.retention_remote)} cópia(s) no destino`,
      details: {
        duration_s: secs,
        counts: archive.manifest.counts,
        migrations: archive.manifest.migrations.length,
        removed_remote: removedRemote,
        removed_local: removedLocal,
      },
    });
    await withScope(ctx.pool, PLATFORM, async (c) => {
      await resolveAlert(c, ALERT_FAILED);
      await resolveAlert(c, ALERT_STALE);
    });
    ctx.log.info({ file: name, size: archive.size, secs }, "backup concluído");
  } catch (err) {
    await fail(ctx, run, s, `${(err as Error).message} (a cópia local ${name} foi mantida)`, {
      file_name: name,
      size_bytes: archive.size,
      host_key_changed: err instanceof TransferError && err.hostKeyChanged,
    });
  }
}

async function fail(
  ctx: BackupContext,
  run: RunRow,
  s: BackupSettings,
  error: string,
  extra: { file_name?: string; size_bytes?: number; host_key_changed?: boolean } = {},
) {
  await finish(ctx, run.id, "failed", {
    error,
    file_name: extra.file_name,
    size_bytes: extra.size_bytes,
    destination: s.host ? describeDest(s) : undefined,
    details: { host_key_changed: extra.host_key_changed ?? false },
  });
  ctx.log.error({ error, run: run.id }, "backup falhou");
  await withScope(ctx.pool, PLATFORM, (c) =>
    raiseAlert(c, {
      dedupKey: ALERT_FAILED,
      rule: ALERT_FAILED,
      severity: "error",
      title: `Backup falhou: ${error}`.slice(0, 300),
      details: {
        run_id: run.id,
        trigger: run.trigger,
        destination: s.host ? describeDest(s) : null,
      },
    }),
  );
}

// ------------------------------------------------------------------ laço
async function claimPending(ctx: BackupContext): Promise<RunRow | null> {
  return withScope(
    ctx.pool,
    PLATFORM,
    async (c) =>
      (
        await c.query<RunRow>(
          `UPDATE backup_runs SET status = 'running', started_at = now()
          WHERE id = (SELECT id FROM backup_runs WHERE status = 'pending' ORDER BY id LIMIT 1
                      FOR UPDATE SKIP LOCKED)
          RETURNING id::text, kind, trigger`,
        )
      ).rows[0] ?? null,
  );
}

/** Cria a execução agendada se estiver na hora (ou para nova tentativa). */
async function claimScheduled(ctx: BackupContext, now: Date): Promise<RunRow | null> {
  const s = await loadSettings(ctx.pool);
  if (!s.enabled || configured(s) || !s.passphrase_enc) return null;
  const slot = lastScheduledSlot(now, s.schedule_time);
  return withScope(ctx.pool, PLATFORM, async (c) => {
    const st = (
      await c.query<{ n: string; ok: boolean; last_fail: Date | null }>(
        `SELECT count(*) AS n, bool_or(status = 'success') AS ok,
                max(finished_at) FILTER (WHERE status = 'failed') AS last_fail
           FROM backup_runs WHERE kind = 'backup' AND trigger = 'schedule' AND created_at >= $1`,
        [slot],
      )
    ).rows[0]!;
    const n = Number(st.n);
    if (st.ok || n >= SCHEDULE_ATTEMPTS) return null;
    if (n > 0 && (!st.last_fail || now.getTime() - st.last_fail.getTime() < RETRY_AFTER_MS))
      return null;
    try {
      return (
        await c.query<RunRow>(
          `INSERT INTO backup_runs (kind, trigger, status, started_at)
           VALUES ('backup', 'schedule', 'running', now()) RETURNING id::text, kind, trigger`,
        )
      ).rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return null; // outro pedido em andamento
      throw err;
    }
  });
}

async function checkStale(ctx: BackupContext, now: Date) {
  const s = await loadSettings(ctx.pool);
  await withScope(ctx.pool, PLATFORM, async (c) => {
    if (!s.enabled) {
      await resolveAlert(c, ALERT_STALE);
      return;
    }
    const last = (
      await c.query<{ at: Date | null }>(
        "SELECT max(finished_at) AS at FROM backup_runs WHERE kind = 'backup' AND status = 'success'",
      )
    ).rows[0]!.at;
    const since = last ?? (s.enabled_at ? new Date(s.enabled_at) : null);
    if (since && now.getTime() - since.getTime() > STALE_MS) {
      await raiseAlert(c, {
        dedupKey: ALERT_STALE,
        rule: ALERT_STALE,
        severity: "error",
        title: last
          ? "Nenhum backup concluído nas últimas 26 horas"
          : "Backup ligado há mais de 26 horas e nenhum foi concluído",
        details: { last_success: last?.toISOString() ?? null },
      });
    }
  });
}

export async function heartbeat(ctx: BackupContext, busy: RunRow | null) {
  await withScope(ctx.pool, PLATFORM, (c) =>
    c.query(
      `INSERT INTO system_settings (key, value) VALUES ('backup.heartbeat', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [
        JSON.stringify({
          at: new Date().toISOString(),
          version: ctx.appVersion,
          busy: busy?.id ?? null,
        }),
      ],
    ),
  );
}

export async function recoverInterrupted(ctx: BackupContext) {
  await withScope(ctx.pool, PLATFORM, (c) =>
    c.query(
      `UPDATE backup_runs SET status = 'failed', finished_at = now(),
              error = 'Interrompido: o serviço de backup reiniciou durante a execução'
        WHERE status = 'running'`,
    ),
  );
}

/** Uma volta do laço: pedidos do painel primeiro, depois a agenda, depois o alerta de atraso. */
export async function tick(ctx: BackupContext, now = new Date()): Promise<RunRow | null> {
  const run = (await claimPending(ctx)) ?? (await claimScheduled(ctx, now));
  if (run) {
    await heartbeat(ctx, run);
    if (run.kind === "test") await runTest(ctx, run);
    else await runBackup(ctx, run);
  }
  await checkStale(ctx, now);
  return run;
}
