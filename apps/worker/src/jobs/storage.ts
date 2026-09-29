import { open, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  PLATFORM,
  enqueueJob,
  getSetting,
  insertAudit,
  insertCameraEvent,
  openAlert,
  raiseAlert,
  resolveAlert,
  withScope,
  type AlertSeverity,
} from "@topcam/db";
import type { PoolClient } from "pg";
import type { WorkerContext } from "../context.js";
import { applyRetention } from "./recordings.js";

/**
 * Armazenamento (Fase 6) — vigia de disco, executado a cada STORAGE_CHECK_INTERVAL_S:
 *
 *  - mede o disco de vídeo (espaço do sistema de arquivos) e o volume gravado no nó
 *    (soma dos segmentos). Com cota no nó, vale o maior dos dois percentuais;
 *  - níveis: ok < atenção (70%) < alto (85%) < crítico (95%), com evento e alerta;
 *  - crítico: limpeza de emergência (decisão do cliente) — apaga os segmentos mais
 *    antigos do nó, mesmo dentro da retenção, até voltar abaixo de crítico − 5 pp.
 *    Nunca apaga o que tem menos de storage.purge_min_age_minutes;
 *  - sem nada apagável e ainda crítico: a gravação do nó para (proteção final) e
 *    volta sozinha abaixo de crítico − 5 pp;
 *  - mede a latência de escrita (64 KiB + fsync): acima de STORAGE_SLOW_MS abre o
 *    alerta de disco lento (travadas como as do armazenamento do Proxmox);
 *  - cota por cliente: só alerta (90% atenção, 100% erro);
 *  - guarda uma amostra a cada STORAGE_SAMPLE_INTERVAL_S (7 dias) para gráficos.
 */

export type StorageLevel = "ok" | "warning" | "high" | "critical";

export interface StorageState {
  lastSample: Map<string, number>;
  goodLatency: Map<string, number>;
}
export const newStorageState = (): StorageState => ({
  lastSample: new Map(),
  goodLatency: new Map(),
});

interface NodeRow {
  id: string;
  name: string;
  mount_path: string;
  quota_bytes: string | null;
  warn_pct: number;
  high_pct: number;
  critical_pct: number;
  status: string;
  recording_blocked: boolean;
  segments_bytes: string;
}

export interface FsInfo {
  total: number;
  free: number;
}

const LEVEL_LABEL: Record<StorageLevel, string> = {
  ok: "normal",
  warning: "atenção",
  high: "alto",
  critical: "crítico",
};
const LEVEL_SEVERITY: Record<Exclude<StorageLevel, "ok">, AlertSeverity> = {
  warning: "warning",
  high: "error",
  critical: "critical",
};

export async function measureFs(path: string): Promise<FsInfo> {
  const s = await statfs(path);
  return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
}

/** Tempo (ms) para gravar 64 KiB com fsync no disco — detecta travadas do armazenamento. */
export async function measureWriteLatency(dir: string): Promise<number> {
  const file = join(dir, ".topcam-latencia");
  const buf = Buffer.alloc(64 * 1024, 0x5a);
  const t0 = process.hrtime.bigint();
  const fh = await open(file, "w");
  try {
    await fh.write(buf);
    await fh.sync();
  } finally {
    await fh.close();
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  await rm(file, { force: true });
  return Math.round(ms);
}

export function levelOf(pct: number, n: Pick<NodeRow, "warn_pct" | "high_pct" | "critical_pct">) {
  if (pct >= n.critical_pct) return "critical" as const;
  if (pct >= n.high_pct) return "high" as const;
  if (pct >= n.warn_pct) return "warning" as const;
  return "ok" as const;
}

/**
 * Uso efetivo do nó (%) e bytes a liberar para chegar a `targetPct`.
 *  - sem cota: vale o disco (total − livre) / total;
 *  - com cota: vale o gravado / cota (a cota é o orçamento de vídeo do nó). O disco
 *    físico só entra quando ele mesmo está no nível crítico — proteção contra o
 *    disco encher por outro motivo.
 */
export function usage(
  fs: FsInfo,
  segBytes: number,
  quota: number | null,
  targetPct: number,
  criticalPct = 95,
) {
  const fsPct = fs.total > 0 ? ((fs.total - fs.free) / fs.total) * 100 : 0;
  const quotaPct = quota ? (segBytes / quota) * 100 : 0;
  const fsCounts = !quota || fsPct >= criticalPct;
  const pct = quota ? Math.max(quotaPct, fsCounts ? fsPct : 0) : fsPct;
  const needFs = fsCounts ? fs.total - fs.free - (fs.total * targetPct) / 100 : 0;
  const needQuota = quota ? segBytes - (quota * targetPct) / 100 : 0;
  return { pct, fsPct, quotaPct, needBytes: Math.max(0, needFs, needQuota) };
}

export interface StorageReport {
  nodes: number;
  purgedBytes: number;
  purgedSegments: number;
  blocked: string[];
}

export async function checkStorage(
  ctx: WorkerContext,
  state: StorageState,
  deps: { measure?: typeof measureFs; latency?: typeof measureWriteLatency } = {},
): Promise<StorageReport> {
  const measure = deps.measure ?? measureFs;
  const latencyOf = deps.latency ?? measureWriteLatency;
  const report: StorageReport = { nodes: 0, purgedBytes: 0, purgedSegments: 0, blocked: [] };
  const { nodes, purgeEnabled, minAgeMin } = await withScope(ctx.pool, PLATFORM, async (c) => ({
    nodes: (
      await c.query<NodeRow>(
        `SELECT n.id, n.name, n.mount_path, n.quota_bytes::text, n.warn_pct, n.high_pct, n.critical_pct,
                n.status, n.recording_blocked,
                coalesce((SELECT sum(size_bytes) FROM recording_segments s
                           WHERE s.storage_node_id = n.id AND s.state <> 'deleted'), 0)::text AS segments_bytes
           FROM storage_nodes n ORDER BY n.created_at`,
      )
    ).rows,
    purgeEnabled: await getSetting<boolean>(c, "storage.emergency_purge", true),
    minAgeMin: Number(await getSetting<number>(c, "storage.purge_min_age_minutes", 60)),
  }));

  // Vários nós podem estar no mesmo disco (ex.: nó de teste): mede cada caminho uma vez.
  const fsCache = new Map<string, FsInfo>();
  const latCache = new Map<string, number | null>();
  for (const n of nodes) {
    report.nodes++;
    const path = await pickPath(ctx, n.mount_path);
    let fs = fsCache.get(path);
    if (!fs) {
      fs = await measure(path);
      fsCache.set(path, fs);
    }
    if (!latCache.has(path))
      latCache.set(
        path,
        await latencyOf(path).catch((err) => {
          ctx.log.warn({ node: n.name, err: (err as Error).message }, "latência: falha ao medir");
          return null;
        }),
      );
    const latency = latCache.get(path) ?? null;
    const quota = n.quota_bytes ? Number(n.quota_bytes) : null;
    let segBytes = Number(n.segments_bytes);
    const target = n.critical_pct - 5;
    let u = usage(fs, segBytes, quota, target, n.critical_pct);

    // ---- crítico: limpeza de emergência (mais antigo primeiro)
    let purged = { bytes: 0, segments: 0 };
    if (u.pct >= n.critical_pct && purgeEnabled && u.needBytes > 0) {
      purged = await emergencyPurge(ctx, n, u.needBytes, minAgeMin, u.pct);
      if (purged.bytes > 0) {
        report.purgedBytes += purged.bytes;
        report.purgedSegments += purged.segments;
        segBytes -= purged.bytes;
        fs = await measure(path).catch(() => ({ total: fs!.total, free: fs!.free + purged.bytes }));
        fsCache.set(path, fs);
        u = usage(fs, segBytes, quota, target, n.critical_pct);
      }
    }
    const level = levelOf(u.pct, n);

    await withScope(ctx.pool, PLATFORM, async (c) => {
      // ---- bloqueio (proteção final) e retomada com histerese
      let blocked = n.recording_blocked;
      if (!blocked && level === "critical") {
        blocked = true;
        await setBlocked(c, n, true, u.pct, minAgeMin);
      } else if (blocked && u.pct < target) {
        blocked = false;
        await setBlocked(c, n, false, u.pct, minAgeMin);
      }
      if (blocked) report.blocked.push(n.name);

      // ---- nível: evento na mudança e alerta aberto/atualizado/resolvido
      if (level !== n.status) {
        await insertCameraEvent(c, {
          tenantId: null,
          cameraId: null,
          type: "storage_level",
          severity: level === "ok" ? "info" : level === "warning" ? "warning" : "error",
          message: `Disco de vídeo ${n.name}: ${LEVEL_LABEL[level]} (${u.pct.toFixed(1)}%)`,
          data: { node: n.name, from: n.status, to: level, pct: round1(u.pct) },
        });
      }
      const key = `storage_level:${n.id}`;
      if (level === "ok") await resolveAlert(c, key);
      else
        await raiseAlert(c, {
          dedupKey: key,
          rule: "storage_level",
          severity: LEVEL_SEVERITY[level],
          title: `Disco de vídeo ${n.name} em ${u.pct.toFixed(0)}% (${LEVEL_LABEL[level]})`,
          details: {
            pct: round1(u.pct),
            disk_pct: round1(u.fsPct),
            quota_pct: quota ? round1(u.quotaPct) : null,
            free_bytes: fs!.free,
          },
          storageNodeId: n.id,
        });
      // Apagar gravação antes do prazo fica visível até o disco voltar ao normal.
      if (level === "ok") await resolveAlert(c, `storage_purge:${n.id}`);

      // ---- latência de escrita
      if (latency !== null) {
        const slowKey = `storage_slow:${n.id}`;
        if (latency >= ctx.env.STORAGE_SLOW_MS) {
          state.goodLatency.set(n.id, 0);
          const opened = await raiseAlert(c, {
            dedupKey: slowKey,
            rule: "storage_slow",
            severity: "warning",
            title: `Disco de vídeo ${n.name} lento: escrita levou ${fmtMs(latency)}`,
            details: { latency_ms: latency, threshold_ms: ctx.env.STORAGE_SLOW_MS },
            storageNodeId: n.id,
          });
          if (opened)
            await insertCameraEvent(c, {
              tenantId: null,
              cameraId: null,
              type: "storage_slow",
              severity: "warning",
              message: `Disco de vídeo ${n.name} lento: gravar 64 KiB levou ${fmtMs(latency)}`,
              data: { node: n.name, latency_ms: latency },
            });
        } else if (latency < ctx.env.STORAGE_SLOW_MS / 5) {
          const good = (state.goodLatency.get(n.id) ?? 0) + 1;
          state.goodLatency.set(n.id, good);
          // ~5 min estável antes de dar o alerta como resolvido.
          if (good >= 10) await resolveAlert(c, slowKey);
        }
      }

      await c.query(
        `UPDATE storage_nodes
            SET total_bytes = $2::bigint, free_bytes = $3::bigint, used_bytes = $2::bigint - $3::bigint, used_pct = $4,
                segments_bytes = $5, status = $6, write_latency_ms = coalesce($7, write_latency_ms),
                last_seen_at = now(), updated_at = now(),
                last_purge_at = CASE WHEN $8::boolean THEN now() ELSE last_purge_at END
          WHERE id = $1`,
        [n.id, fs!.total, fs!.free, round1(u.pct), segBytes, level, latency, purged.bytes > 0],
      );
      const last = state.lastSample.get(n.id) ?? 0;
      if (Date.now() - last >= ctx.env.STORAGE_SAMPLE_INTERVAL_S * 1000 || purged.bytes > 0) {
        state.lastSample.set(n.id, Date.now());
        await c.query(
          `INSERT INTO storage_samples (storage_node_id, total_bytes, free_bytes, segments_bytes, used_pct, write_latency_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [n.id, fs!.total, fs!.free, segBytes, round1(u.pct), latency],
        );
      }
    });
  }

  await checkTenantQuotas(ctx);
  await withScope(ctx.pool, PLATFORM, (c) =>
    c.query("DELETE FROM storage_samples WHERE sampled_at < now() - interval '7 days'"),
  );
  return report;
}

/** O caminho do nó como o worker o enxerga (o disco de vídeo é o mesmo volume). */
async function pickPath(ctx: WorkerContext, mountPath: string): Promise<string> {
  if (mountPath && mountPath !== ctx.env.RECORDINGS_PATH) {
    try {
      await statfs(mountPath);
      return mountPath;
    } catch {
      /* caminho do host, não montado aqui */
    }
  }
  return ctx.env.RECORDINGS_PATH;
}

/**
 * Apaga os segmentos mais antigos do nó (mesmo dentro da retenção) até liberar
 * `needBytes`. Protege os mais novos que `minAgeMin`. Reusa a retenção: marca a
 * validade como vencida e chama applyRetention (que nunca sai da pasta de gravações).
 */
async function emergencyPurge(
  ctx: WorkerContext,
  n: NodeRow,
  needBytes: number,
  minAgeMin: number,
  pct: number,
): Promise<{ bytes: number; segments: number }> {
  const chosen = await withScope(ctx.pool, PLATFORM, async (c) => {
    const { rows } = await c.query<{
      id: string;
      size: string;
      code: string;
      tenant_id: string;
      started_at: Date;
    }>(
      `SELECT s.id::text, coalesce(s.size_bytes, 0)::text AS size, c.code, s.tenant_id, s.started_at
         FROM recording_segments s JOIN cameras c ON c.id = s.camera_id
        WHERE s.storage_node_id = $1 AND s.state IN ('verified', 'corrupt', 'missing')
          AND s.started_at < now() - make_interval(mins => $2)
        ORDER BY s.started_at
        LIMIT 5000`,
      [n.id, minAgeMin],
    );
    const pick: typeof rows = [];
    let sum = 0;
    for (const r of rows) {
      if (sum >= needBytes) break;
      pick.push(r);
      sum += Number(r.size);
    }
    if (!pick.length) return null;
    await c.query(
      "UPDATE recording_segments SET expires_at = now() - interval '1 second' WHERE id = ANY($1::bigint[])",
      [pick.map((p) => p.id)],
    );
    const byCamera: Record<string, number> = {};
    for (const p of pick) byCamera[p.code] = (byCamera[p.code] ?? 0) + 1;
    const data = {
      node: n.name,
      pct: round1(pct),
      segments: pick.length,
      bytes: sum,
      oldest: pick[0]!.started_at.toISOString(),
      newest: pick.at(-1)!.started_at.toISOString(),
      cameras: byCamera,
      min_age_minutes: minAgeMin,
    };
    await insertCameraEvent(c, {
      tenantId: null,
      cameraId: null,
      type: "storage_purge",
      severity: "warning",
      message: `Disco de vídeo ${n.name} a ${pct.toFixed(1)}%: ${pick.length} segmentos mais antigos apagados antes da retenção`,
      data,
    });
    await raiseAlert(c, {
      dedupKey: `storage_purge:${n.id}`,
      rule: "storage_purge",
      severity: "warning",
      title: `Disco de vídeo ${n.name} cheio: gravações mais antigas apagadas antes do prazo`,
      details: data,
      storageNodeId: n.id,
    });
    await insertAudit(c, {
      tenantId: null,
      actorType: "system",
      action: "storage.emergency_purge",
      entityType: "storage_node",
      entityId: n.id,
      data,
    });
    return { bytes: sum, segments: pick.length };
  });
  if (!chosen) return { bytes: 0, segments: 0 };
  await applyRetention(ctx);
  ctx.log.warn({ node: n.name, ...chosen }, "armazenamento: limpeza de emergência");
  return chosen;
}

async function setBlocked(
  c: PoolClient,
  n: NodeRow,
  blocked: boolean,
  pct: number,
  minAgeMin: number,
): Promise<void> {
  await c.query("UPDATE storage_nodes SET recording_blocked = $2 WHERE id = $1", [n.id, blocked]);
  await insertCameraEvent(c, {
    tenantId: null,
    cameraId: null,
    type: blocked ? "storage_recording_blocked" : "storage_recording_resumed",
    severity: blocked ? "critical" : "info",
    message: blocked
      ? `Disco de vídeo ${n.name} a ${pct.toFixed(1)}% sem gravações apagáveis (mais antigas que ${minAgeMin} min): gravação parada`
      : `Disco de vídeo ${n.name} com espaço (${pct.toFixed(1)}%): gravação retomada`,
    data: { node: n.name, pct: round1(pct) },
  });
  const key = `storage_blocked:${n.id}`;
  if (blocked)
    await raiseAlert(c, {
      dedupKey: key,
      rule: "storage_blocked",
      severity: "critical",
      title: `Gravação parada: disco de vídeo ${n.name} cheio`,
      details: { pct: round1(pct), min_age_minutes: minAgeMin },
      storageNodeId: n.id,
    });
  else await resolveAlert(c, key);
  await enqueueJob(c, "mediamtx.reconcile", {
    reason: blocked ? "storage_blocked" : "storage_resumed",
  });
}

/** Cota de vídeo por cliente: só alerta (decisão do cliente). */
async function checkTenantQuotas(ctx: WorkerContext): Promise<void> {
  await withScope(ctx.pool, PLATFORM, async (c) => {
    const { rows } = await c.query<{ id: string; name: string; quota: string; used: string }>(
      `SELECT t.id, t.name, t.storage_quota_bytes::text AS quota,
              coalesce((SELECT sum(s.size_bytes) FROM recording_segments s
                         WHERE s.tenant_id = t.id AND s.state <> 'deleted'), 0)::text AS used
         FROM tenants t WHERE t.deleted_at IS NULL`,
    );
    for (const t of rows) {
      const key = `tenant_quota:${t.id}`;
      const quota = t.quota ? Number(t.quota) : 0;
      if (!quota) {
        await resolveAlert(c, key);
        continue;
      }
      const pct = (Number(t.used) / quota) * 100;
      const cur = await openAlert(c, key);
      if (pct >= 90) {
        const severity: AlertSeverity = pct >= 100 ? "error" : "warning";
        await raiseAlert(c, {
          dedupKey: key,
          rule: "tenant_quota",
          severity,
          title: `${t.name}: vídeo em ${pct.toFixed(0)}% da cota`,
          details: { pct: round1(pct), used_bytes: Number(t.used), quota_bytes: quota },
          tenantId: t.id,
        });
        if (!cur || cur.severity !== severity)
          await insertCameraEvent(c, {
            tenantId: t.id,
            cameraId: null,
            type: "tenant_quota",
            severity,
            message: `Vídeo gravado de ${t.name} em ${pct.toFixed(0)}% da cota contratada`,
            data: { pct: round1(pct), used_bytes: Number(t.used), quota_bytes: quota },
          });
      } else if (pct < 85) await resolveAlert(c, key);
    }
  });
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const fmtMs = (ms: number) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1).replace(".", ",")} s` : `${ms} ms`;
