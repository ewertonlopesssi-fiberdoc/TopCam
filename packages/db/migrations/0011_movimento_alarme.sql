-- TopCam — detecção de movimento, gravação só com movimento e alarme.
--
-- Origem do movimento (cameras.motion_source):
--   off    — sem detecção
--   camera — a própria câmera avisa por e-mail (SMTP) a cada detecção (ex.: Intelbras VIP)
--   server — o servidor analisa os quadros-chave do vídeo que já recebe
--
-- Gravação só com movimento (cameras.recording_mode = 'motion'): a câmera continua
-- gravando segmentos normalmente, mas cada segmento nasce "em espera" (motion_hold) com
-- validade curta. Os que encostam num movimento (com folga antes e depois) passam a
-- valer a retenção normal; os outros são apagados com o motivo 'no_motion'. Assim os
-- segundos antes do movimento ficam guardados e o servidor de mídia não é reconfigurado.
--
-- Alarme: notificação do movimento aos usuários com acesso à câmera, só nos horários
-- cadastrados e com intervalo mínimo entre avisos. Os horários não afetam a gravação.
-- Migration só aditiva.

ALTER TABLE cameras
  ADD COLUMN IF NOT EXISTS motion_source text NOT NULL DEFAULT 'off'
    CHECK (motion_source IN ('off', 'camera', 'server')),
  -- Sensibilidade do detector do servidor (1 = pouco sensível … 10 = muito sensível).
  ADD COLUMN IF NOT EXISTS motion_sensitivity smallint NOT NULL DEFAULT 5
    CHECK (motion_sensitivity BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS alarm_enabled boolean NOT NULL DEFAULT false,
  -- {"rules": [{"days": [0..6, domingo = 0], "from": "HH:MM", "to": "HH:MM"}]}; sem regras = sempre.
  -- "from" maior que "to" atravessa a meia-noite (o dia é o do início).
  ADD COLUMN IF NOT EXISTS alarm_schedule jsonb NOT NULL DEFAULT '{"rules": []}'::jsonb,
  ADD COLUMN IF NOT EXISTS alarm_cooldown_s integer NOT NULL DEFAULT 300
    CHECK (alarm_cooldown_s BETWEEN 0 AND 86400),
  ADD COLUMN IF NOT EXISTS alarm_email boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS alarm_last_notified_at timestamptz,
  -- Credencial SMTP exclusiva da câmera (só o hash da senha; a senha aparece uma vez).
  ADD COLUMN IF NOT EXISTS motion_smtp_user text UNIQUE,
  ADD COLUMN IF NOT EXISTS motion_smtp_hash text,
  ADD COLUMN IF NOT EXISTS motion_smtp_rotated_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_motion_at timestamptz;

-- Gravação só com movimento exige uma origem de movimento.
ALTER TABLE cameras DROP CONSTRAINT IF EXISTS cameras_motion_recording_needs_source;
ALTER TABLE cameras ADD CONSTRAINT cameras_motion_recording_needs_source
  CHECK (recording_mode <> 'motion' OR motion_source <> 'off') NOT VALID;

ALTER TABLE recording_segments
  ADD COLUMN IF NOT EXISTS motion_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_reason text;
CREATE INDEX IF NOT EXISTS segments_motion_hold_idx
  ON recording_segments (camera_id, started_at) WHERE motion_hold;

CREATE TABLE IF NOT EXISTS motion_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  camera_id    uuid NOT NULL,
  source       text NOT NULL CHECK (source IN ('camera', 'server')),
  -- motion | human | audio | other (o que a câmera informou)
  kind         text NOT NULL DEFAULT 'motion',
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz NOT NULL,
  hits         integer NOT NULL DEFAULT 1,
  -- Alarme: null = ainda não avaliado; sent | suppressed_schedule | suppressed_cooldown |
  -- disabled | no_recipients | failed
  alarm_status text,
  alarm_at     timestamptz,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (camera_id, tenant_id) REFERENCES cameras (id, tenant_id),
  CHECK (ended_at >= started_at)
);
CREATE INDEX IF NOT EXISTS motion_events_camera_time_idx ON motion_events (camera_id, started_at);
CREATE INDEX IF NOT EXISTS motion_events_tenant_time_idx ON motion_events (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS motion_events_alarm_pending_idx ON motion_events (id) WHERE alarm_status IS NULL;

ALTER TABLE motion_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON motion_events;
CREATE POLICY tenant_isolation ON motion_events
  USING (app_is_platform() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON motion_events TO topcam_app;
GRANT USAGE, SELECT ON SEQUENCE motion_events_id_seq TO topcam_app;

-- Notificações de alarme por usuário (e-mail hoje; push quando o app existir).
CREATE TABLE IF NOT EXISTS alarm_notifications (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  camera_id       uuid NOT NULL,
  motion_event_id bigint REFERENCES motion_events(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  channel         text NOT NULL CHECK (channel IN ('email', 'push')),
  status          text NOT NULL CHECK (status IN ('sent', 'failed', 'pending')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alarm_notifications_time_idx ON alarm_notifications (created_at DESC);
ALTER TABLE alarm_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON alarm_notifications;
CREATE POLICY tenant_isolation ON alarm_notifications
  USING (app_is_platform() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON alarm_notifications TO topcam_app;
GRANT USAGE, SELECT ON SEQUENCE alarm_notifications_id_seq TO topcam_app;
