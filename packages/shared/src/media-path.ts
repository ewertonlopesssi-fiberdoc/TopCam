import { isValidStreamKeyFormat } from "./stream-key.js";

/**
 * Caminhos no servidor de mídia.
 *
 * A câmera publica em rtmp://<host>/live/<CHAVE>. O caminho interno, portanto,
 * contém a chave e nunca é exposto a quem assiste (as portas de leitura do
 * MediaMTX ficam só na rede interna; o acesso público passa pelo gateway com
 * tokens temporários — Fase 3).
 */

export const LIVE_PREFIX = "live/";

export function mediaPathForKey(key: string): string {
  return `${LIVE_PREFIX}${key}`;
}

/** Extrai a chave de um caminho `live/<chave>`; `null` se o formato for inválido. */
export function streamKeyFromPath(path: string): string | null {
  if (!path.startsWith(LIVE_PREFIX)) return null;
  const key = path.slice(LIVE_PREFIX.length);
  return isValidStreamKeyFormat(key) ? key : null;
}

/**
 * Caminho interno da câmera: `cam/<id da câmera>`.
 *
 * É um "relay" dentro do próprio MediaMTX que lê `live/<chave>` (sem
 * transcodificar). Gravação e, na Fase 3, visualização usam este caminho, de
 * modo que a chave nunca aparece em nomes de arquivo nem em URLs de leitura, e
 * rotacionar a chave não muda o histórico da câmera.
 */
export const CAMERA_PREFIX = "cam/";

export function cameraPathName(cameraId: string): string {
  return `${CAMERA_PREFIX}${cameraId}`;
}

/** Diretório onde o MediaMTX grava os segmentos da câmera (recordPath = <raiz>/%path/...). */
export function recordDirForCamera(recordingsRoot: string, cameraId: string): string {
  return `${recordingsRoot.replace(/\/+$/, "")}/${cameraPathName(cameraId)}`;
}

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** cam/<id>/AAAA-MM-DD_hh-mm-ss-ffffff.mp4 (recordPath do mediamtx.yml; horário UTC). */
const SEGMENT_RE = new RegExp(
  `^cam/(${UUID_RE})/(\\d{4})-(\\d{2})-(\\d{2})_(\\d{2})-(\\d{2})-(\\d{2})-(\\d{6})\\.mp4$`,
);

export interface SegmentPathInfo {
  cameraId: string;
  /** Caminho relativo à raiz das gravações (é o que vai para o banco). */
  relPath: string;
  /** Início do segmento, pelo nome do arquivo (UTC, precisão de ms). */
  startedAt: Date;
}

/**
 * Interpreta o caminho de um segmento gravado. Aceita o caminho absoluto que o
 * MediaMTX informa (/recordings/cam/<id>/...) ou o relativo (cam/<id>/...).
 * Recusa qualquer coisa fora do padrão (inclusive "..").
 */
export function parseSegmentPath(
  path: string,
  recordingsRoot = "/recordings",
): SegmentPathInfo | null {
  const root = recordingsRoot.replace(/\/+$/, "") + "/";
  const rel = path.startsWith(root) ? path.slice(root.length) : path;
  const m = SEGMENT_RE.exec(rel);
  if (!m) return null;
  const [, cameraId, y, mo, d, h, mi, s, us] = m as unknown as string[];
  const startedAt = new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, Math.floor(+us! / 1000)));
  if (Number.isNaN(startedAt.getTime())) return null;
  return { cameraId: cameraId!, relPath: rel, startedAt };
}

/** Duração informada pelo MediaMTX (ex.: "60.033s", "1m0.5s", "60.03") em ms. */
export function parseMtxDuration(v: string | undefined | null): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|µs|us|ns)/g)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total +=
      unit === "h"
        ? n * 3600000
        : unit === "m"
          ? n * 60000
          : unit === "s"
            ? n * 1000
            : unit === "ms"
              ? n
              : 0;
  }
  return matched ? Math.round(total) : null;
}
