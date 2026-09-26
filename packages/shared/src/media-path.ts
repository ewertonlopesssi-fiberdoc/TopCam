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
