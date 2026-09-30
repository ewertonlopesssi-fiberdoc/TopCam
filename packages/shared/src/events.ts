/** Tipos de evento gravados em `camera_events.type`. */
export const CAMERA_EVENT_TYPES = [
  "publish_authorized",
  "auth_rejected",
  "publish_denied",
  "duplicate_publish_rejected",
  "stream_online",
  "stream_offline",
  "connect_timeout",
  "probe_started",
  "codec_detected",
  "codec_warning",
  "probe_failed",
  "key_rotated",
  "publisher_kicked",
  "status_changed",
  "ingest_unreachable",
  "ingest_recovered",
  // gravação (Fase 4)
  "recording_started",
  "recording_stopped",
  "recording_stalled",
  "recording_gap",
  "segment_corrupt",
  "segment_missing",
  "unexpected_recording",
  // armazenamento e servidor (Fase 6)
  "storage_level",
  "storage_purge",
  "storage_recording_blocked",
  "storage_recording_resumed",
  "storage_slow",
  "tenant_quota",
  "system_disk",
  // alertas e notificações (Fase 7)
  "alert_notified",
  // segurança (Fase 8)
  "rate_limited",
  "publish_ip_blocked",
] as const;

export type CameraEventType = (typeof CAMERA_EVENT_TYPES)[number];

export type EventSeverity = "info" | "warning" | "error" | "critical";

/** Tipos de tarefas duráveis (`durable_jobs.type`). */
export const JOB_TYPES = ["camera.probe", "mediamtx.reconcile", "segment.verify"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Canal Redis usado para acordar o worker quando há tarefa nova. */
export const JOBS_WAKE_CHANNEL = "topcam:jobs:wake";
