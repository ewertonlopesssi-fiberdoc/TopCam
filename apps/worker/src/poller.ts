import {
  PLATFORM,
  enqueueJob,
  insertCameraEvent,
  listActiveRtmpCameras,
  transitionCamera,
  withScope,
  type CameraRow,
} from "@topcam/db";
import { RECEIVING_STATUSES, cameraPathName, type MtxPath } from "@topcam/shared";
import { cameraMediaPath, type WorkerContext } from "./context.js";

/**
 * Poller de status (a cada POLL_INTERVAL_S):
 *  - atualiza last_video_at e bitrate só quando os bytes recebidos crescem
 *    (câmera "congelada" deixa de ser considerada online);
 *  - detecta queda sem depender do hook: caminho sem publicador → offline na hora;
 *    vídeo parado ou servidor inacessível → offline após OFFLINE_AFTER_S;
 *  - recupera estados após reinício da API/worker (stream ativo mas câmera marcada offline);
 *  - encerra "conectando" que nunca virou stream (CONNECT_TIMEOUT_S);
 *  - registra disponibilidade do nó de ingestão.
 */

interface ByteSample {
  bytes: number;
  at: number;
}

export interface PollerState {
  samples: Map<string, ByteSample>;
  mediaReachable: boolean | null;
}

export function newPollerState(): PollerState {
  return { samples: new Map(), mediaReachable: null };
}

export interface PollResult {
  reachable: boolean;
  /** true quando o MediaMTX voltou a responder (pede reconciliação imediata). */
  recovered: boolean;
  missingPathConfs: boolean;
}

export async function pollOnce(ctx: WorkerContext, state: PollerState): Promise<PollResult> {
  const now = Date.now();
  let paths: MtxPath[] = [];
  let reachable = true;
  let confNames: Set<string> | null = null;
  try {
    paths = await ctx.mediamtx.listPaths();
    confNames = new Set((await ctx.mediamtx.listPathConfs()).map((c) => c.name));
  } catch (err) {
    reachable = false;
    ctx.log.warn({ err: (err as Error).message }, "MediaMTX inacessível");
  }
  const recovered = reachable && state.mediaReachable === false;
  await recordIngestState(ctx, state, reachable, paths);

  const byName = new Map(paths.map((p) => [p.name, p]));
  const cameras = await withScope(ctx.pool, PLATFORM, (c) => listActiveRtmpCameras(c));

  const videoUpdates: Array<{ id: string; kbps: number | null }> = [];
  let missingPathConfs = false;

  for (const cam of cameras) {
    const name = cameraMediaPath(cam, ctx.encKey);
    if (!name) continue;
    if (confNames && (!confNames.has(name) || !confNames.has(cameraPathName(cam.id))))
      missingPathConfs = true;
    const p = byName.get(name);
    const live = Boolean(p?.ready && p.online !== false && p.source);

    if (live && p) {
      const prev = state.samples.get(cam.id);
      const bytes = p.bytesReceived ?? p.inboundBytes ?? 0;
      state.samples.set(cam.id, { bytes, at: now });
      if (!prev || bytes > prev.bytes) {
        const kbps =
          prev && now > prev.at ? Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)) : null;
        videoUpdates.push({ id: cam.id, kbps });
        if (
          cam.status === "aguardando_transmissao" ||
          cam.status === "offline" ||
          cam.status === "conectando"
        ) {
          await recoverLive(ctx, cam);
        } else if (cam.status === "recebendo") {
          // Garante que existe validação pendente (ex.: tarefa perdida).
          await withScope(ctx.pool, PLATFORM, (c) =>
            enqueueJob(
              c,
              "camera.probe",
              { cameraId: cam.id },
              { dedupKey: `probe:${cam.id}`, maxAttempts: 3 },
            ),
          );
        }
        continue;
      }
      // Bytes parados: cai no teste de "sem vídeo" abaixo.
    } else {
      state.samples.delete(cam.id);
    }

    const silentFor = cam.last_video_at ? now - cam.last_video_at.getTime() : Infinity;
    // Caminho sem publicador (com o MediaMTX respondendo) → offline imediato.
    // Vídeo parado ou MediaMTX inacessível → espera OFFLINE_AFTER_S sem vídeo.
    const gone = reachable && !live;
    if (
      RECEIVING_STATUSES.has(cam.status) &&
      (gone || silentFor > ctx.env.OFFLINE_AFTER_S * 1000)
    ) {
      await markOffline(ctx, cam, live ? "video_stalled" : "stream_gone", silentFor);
    } else if (
      cam.status === "conectando" &&
      now - cam.status_changed_at.getTime() > ctx.env.CONNECT_TIMEOUT_S * 1000
    ) {
      await withScope(ctx.pool, PLATFORM, async (c) => {
        const t = await transitionCamera(c, cam.id, "connect_timeout");
        if (t?.changed)
          await insertCameraEvent(c, {
            tenantId: cam.tenant_id,
            cameraId: cam.id,
            type: "connect_timeout",
            severity: "warning",
            message: `${cam.code} foi autorizada mas não chegou a enviar vídeo em ${ctx.env.CONNECT_TIMEOUT_S}s`,
            data: { from: t.from, to: t.to },
          });
      });
    }
  }

  if (videoUpdates.length) {
    await withScope(ctx.pool, PLATFORM, (c) =>
      c.query(
        `UPDATE cameras AS c SET last_video_at = now(),
                bitrate_kbps = COALESCE(u.kbps, c.bitrate_kbps)
           FROM unnest($1::uuid[], $2::int[]) AS u(id, kbps)
          WHERE c.id = u.id`,
        [videoUpdates.map((u) => u.id), videoUpdates.map((u) => u.kbps)],
      ),
    );
  }
  return { reachable, recovered, missingPathConfs };
}

async function recoverLive(ctx: WorkerContext, cam: CameraRow): Promise<void> {
  await withScope(ctx.pool, PLATFORM, async (c) => {
    const t = await transitionCamera(c, cam.id, "stream_online", "recovered_by_poller");
    if (!t?.changed) return;
    await insertCameraEvent(c, {
      tenantId: cam.tenant_id,
      cameraId: cam.id,
      type: "stream_online",
      message: `${cam.code} está enviando vídeo (detectado pelo monitoramento)`,
      data: { source: "poller", from: t.from, to: t.to },
    });
    await enqueueJob(
      c,
      "camera.probe",
      { cameraId: cam.id },
      { dedupKey: `probe:${cam.id}`, maxAttempts: 3 },
    );
  });
}

async function markOffline(ctx: WorkerContext, cam: CameraRow, reason: string, silentMs: number) {
  await withScope(ctx.pool, PLATFORM, async (c) => {
    const t = await transitionCamera(c, cam.id, "stream_offline", reason);
    if (!t?.changed) return;
    await insertCameraEvent(c, {
      tenantId: cam.tenant_id,
      cameraId: cam.id,
      type: "stream_offline",
      severity: "warning",
      message:
        reason === "video_stalled"
          ? `${cam.code} está conectada mas parou de enviar vídeo`
          : `${cam.code} parou de transmitir`,
      data: {
        source: "poller",
        reason,
        silent_seconds: Number.isFinite(silentMs) ? Math.round(silentMs / 1000) : null,
        from: t.from,
        to: t.to,
      },
    });
  });
}

async function recordIngestState(
  ctx: WorkerContext,
  state: PollerState,
  reachable: boolean,
  paths: MtxPath[],
): Promise<void> {
  const changed = state.mediaReachable !== null && state.mediaReachable !== reachable;
  state.mediaReachable = reachable;
  const metrics = {
    paths_ready: paths.filter((p) => p.ready).length,
    bytes_received_total: paths.reduce((s, p) => s + (p.bytesReceived ?? 0), 0),
  };
  await withScope(ctx.pool, PLATFORM, async (c) => {
    if (reachable) {
      await c.query(
        `UPDATE ingest_nodes SET status = 'online', last_seen_at = now(), metrics = $1 WHERE name = 'ingest-01'`,
        [JSON.stringify(metrics)],
      );
    } else {
      await c.query(`UPDATE ingest_nodes SET status = 'offline' WHERE name = 'ingest-01'`);
    }
    if (changed) {
      await insertCameraEvent(c, {
        tenantId: null,
        cameraId: null,
        type: reachable ? "ingest_recovered" : "ingest_unreachable",
        severity: reachable ? "info" : "critical",
        message: reachable
          ? "Servidor de mídia voltou a responder"
          : "Servidor de mídia não responde",
      });
      if (!reachable) {
        await c.query(
          `INSERT INTO alerts (rule, severity, title, dedup_key, ingest_node_id)
           SELECT 'ingest_unreachable', 'critical', 'Servidor de mídia não responde', 'ingest_unreachable:ingest-01', id
             FROM ingest_nodes WHERE name = 'ingest-01'
           ON CONFLICT (dedup_key) WHERE status <> 'resolved' DO NOTHING`,
        );
      } else {
        await c.query(
          `UPDATE alerts SET status = 'resolved', resolved_at = now()
            WHERE dedup_key = 'ingest_unreachable:ingest-01' AND status <> 'resolved'`,
        );
      }
    }
  });
}
