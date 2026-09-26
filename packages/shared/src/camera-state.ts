/**
 * Máquina de estados da câmera (especificação §4 e §5).
 *
 * Regra central: "online" não é "gravando". O estado `gravando` só é alcançado
 * pelo evento `first_segment_verified`, emitido depois que um segmento durável
 * foi verificado e indexado no PostgreSQL (Fase 4).
 */

export const CAMERA_STATUSES = [
  "aguardando_transmissao",
  "conectando",
  "recebendo",
  "validando",
  "ao_vivo",
  "gravando",
  "offline",
  "erro",
  "desabilitada",
] as const;

export type CameraStatus = (typeof CAMERA_STATUSES)[number];

export const CAMERA_STATE_EVENTS = [
  "publish_authorized",
  "stream_online",
  "probe_started",
  "probe_succeeded",
  "probe_failed",
  "first_segment_verified",
  "recording_stopped",
  "stream_offline",
  "connect_timeout",
  "disabled",
  "enabled",
] as const;

export type CameraStateEvent = (typeof CAMERA_STATE_EVENTS)[number];

export interface TransitionContext {
  /** A câmera já transmitiu alguma vez (last_video_at não nulo). */
  everStreamed?: boolean;
}

/** Estados em que a câmera está (ou tenta estar) transmitindo. */
export const STREAMING_STATUSES: ReadonlySet<CameraStatus> = new Set([
  "conectando",
  "recebendo",
  "validando",
  "ao_vivo",
  "gravando",
]);

/** Estados em que há vídeo chegando ao servidor. */
export const RECEIVING_STATUSES: ReadonlySet<CameraStatus> = new Set([
  "recebendo",
  "validando",
  "ao_vivo",
  "gravando",
]);

const IDLE: ReadonlySet<CameraStatus> = new Set(["aguardando_transmissao", "offline", "erro"]);

/**
 * Retorna o próximo estado para `event`, ou `null` quando o evento não altera o
 * estado atual (evento irrelevante ou transição não permitida).
 */
export function nextCameraStatus(
  current: CameraStatus,
  event: CameraStateEvent,
  ctx: TransitionContext = {},
): CameraStatus | null {
  if (current === "desabilitada" && event !== "enabled") return null;

  switch (event) {
    case "publish_authorized":
      return IDLE.has(current) ? "conectando" : null;
    case "stream_online":
      return IDLE.has(current) || current === "conectando" ? "recebendo" : null;
    case "probe_started":
      return current === "recebendo" ? "validando" : null;
    case "probe_succeeded":
      return current === "validando" || current === "recebendo" ? "ao_vivo" : null;
    case "probe_failed":
      return current === "validando" || current === "recebendo" ? "erro" : null;
    case "first_segment_verified":
      return current === "ao_vivo" ? "gravando" : null;
    case "recording_stopped":
      return current === "gravando" ? "ao_vivo" : null;
    case "stream_offline":
      return STREAMING_STATUSES.has(current) || current === "erro" ? "offline" : null;
    case "connect_timeout":
      if (current !== "conectando") return null;
      return ctx.everStreamed ? "offline" : "aguardando_transmissao";
    case "disabled":
      return "desabilitada";
    case "enabled":
      return current === "desabilitada" ? "aguardando_transmissao" : null;
  }
}

export function isCameraStatus(value: string): value is CameraStatus {
  return (CAMERA_STATUSES as readonly string[]).includes(value);
}
