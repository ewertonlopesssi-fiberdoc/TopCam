import {
  PLATFORM,
  getSetting,
  insertCameraEvent,
  listActiveRtmpCameras,
  withScope,
} from "@topcam/db";
import {
  CAMERA_PREFIX,
  LIVE_PREFIX,
  cameraPathName,
  decryptStreamKey,
  mediaPathForKey,
  type MtxPathConf,
} from "@topcam/shared";
import type { WorkerContext } from "../context.js";

/**
 * Reconciliação do servidor de mídia com o banco (fonte da verdade).
 *
 * Para cada câmera ativa existem dois caminhos:
 *   live/<chave>  entrada: a câmera publica aqui; nunca grava; segunda
 *                 publicação é recusada (overridePublisher: false).
 *   cam/<id>      relay interno que lê live/<chave> por RTSP local, sem
 *                 transcodificar. Grava somente quando a câmera tem gravação
 *                 habilitada, a gravação global está ligada e o armazenamento
 *                 não está bloqueado. Sem gravação, só é ativado sob demanda
 *                 (quando alguém assiste — Fase 3), então não consome nada.
 *
 * Também remove caminhos de chaves que deixaram de valer (rotação, câmera
 * desabilitada, cliente suspenso) e desconecta quem ainda publica neles.
 */

export interface DesiredPath {
  name: string;
  cameraId: string;
  code: string;
  conf: Record<string, string | boolean>;
}

export interface ReconcileReport {
  added: number;
  patched: number;
  removed: number;
  kicked: number;
  recording: number;
}

const MANAGED = (name: string) => name.startsWith(LIVE_PREFIX) || name.startsWith(CAMERA_PREFIX);

export function diffPathConfs(desired: DesiredPath[], existing: MtxPathConf[]) {
  const want = new Map(desired.map((d) => [d.name, d]));
  const have = new Map(existing.filter((e) => MANAGED(e.name)).map((e) => [e.name, e]));
  const add: DesiredPath[] = [];
  const patch: DesiredPath[] = [];
  const remove: string[] = [];
  for (const d of desired) {
    const cur = have.get(d.name);
    if (!cur) add.push(d);
    else if (Object.entries(d.conf).some(([k, v]) => cur[k] !== v)) patch.push(d);
  }
  for (const name of have.keys()) if (!want.has(name)) remove.push(name);
  return { add, patch, remove };
}

export async function reconcileMediaServer(ctx: WorkerContext): Promise<ReconcileReport> {
  const { cameras, globalRecording } = await withScope(ctx.pool, PLATFORM, async (c) => ({
    cameras: await listActiveRtmpCameras(c),
    globalRecording: await getSetting<boolean>(c, "recording.globally_enabled", false),
  }));

  const { env } = ctx;
  const internalRtsp = env.MEDIAMTX_SELF_RTSP_URL.replace(
    "rtsp://",
    `rtsp://${encodeURIComponent(env.MEDIA_READ_USER)}:${encodeURIComponent(env.MEDIA_READ_PASSWORD)}@`,
  );

  const desired: DesiredPath[] = [];
  let recording = 0;
  for (const cam of cameras) {
    if (!cam.stream_key_enc) continue;
    const livePath = mediaPathForKey(decryptStreamKey(cam.stream_key_enc, ctx.encKey));
    const record = cam.recording_enabled && globalRecording && cam.storage_blocked !== true;
    if (record) recording++;
    desired.push({
      name: livePath,
      cameraId: cam.id,
      code: cam.code,
      conf: { source: "publisher", overridePublisher: false, record: false },
    });
    desired.push({
      name: cameraPathName(cam.id),
      cameraId: cam.id,
      code: cam.code,
      conf: {
        source: `${internalRtsp}/${livePath}`,
        rtspTransport: "tcp",
        sourceOnDemand: !record,
        record,
      },
    });
  }

  // Desconecta primeiro quem publica com chave que deixou de valer (antes de
  // remover o caminho, para que o evento registre a conexão).
  const valid = new Set(desired.filter((d) => d.name.startsWith(LIVE_PREFIX)).map((d) => d.name));
  let kicked = 0;
  for (const pub of await ctx.mediamtx.listPublishers()) {
    if (!pub.path.startsWith(LIVE_PREFIX) || valid.has(pub.path)) continue;
    try {
      await ctx.mediamtx.kick(pub.kind, pub.id);
      kicked++;
      await withScope(ctx.pool, PLATFORM, (c) =>
        insertCameraEvent(c, {
          tenantId: null,
          cameraId: null,
          type: "publisher_kicked",
          severity: "warning",
          message:
            "Publicador desconectado: chave deixou de ser válida (rotação, câmera desabilitada ou cliente suspenso)",
          data: { conn_id: pub.id },
          sourceIp: pub.remoteAddr,
        }),
      );
    } catch (err) {
      ctx.log.warn({ err: (err as Error).message }, "falha ao desconectar publicador");
    }
  }

  const existing = await ctx.mediamtx.listPathConfs();
  const { add, patch, remove } = diffPathConfs(desired, existing);
  // Remove antes de adicionar: após rotação, o relay aponta para a chave nova.
  for (const name of remove) await ctx.mediamtx.deletePathConf(name);
  for (const d of add) await ctx.mediamtx.addPathConf(d.name, d.conf);
  for (const d of patch) await ctx.mediamtx.patchPathConf(d.name, d.conf);

  const report = {
    added: add.length,
    patched: patch.length,
    removed: remove.length,
    kicked,
    recording,
  };
  if (report.added || report.patched || report.removed || report.kicked) {
    ctx.log.info(report, "servidor de mídia reconciliado");
  }
  return report;
}
