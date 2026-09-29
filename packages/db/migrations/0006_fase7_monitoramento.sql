-- Fase 7: monitoramento, alertas por e-mail, dashboard e relatórios.

-- 1. Integrações: e-mail (SMTP). A senha fica cifrada (AES-256-GCM, mesma chave das
--    chaves RTMP) e nunca volta para o navegador.
INSERT INTO system_settings (key, value) VALUES
  ('integrations.smtp', jsonb_build_object(
     'enabled', false,
     'host', 'smtp.gmail.com',
     'port', 587,
     'security', 'starttls',
     'username', '',
     'password_enc', null,
     'from_name', 'TopCam',
     'from_email', '',
     'recipients', '[]'::jsonb,
     'min_severity', 'error',
     'notify_resolved', true
  ))
ON CONFLICT (key) DO NOTHING;

-- 2. Notificação dos alertas: gravidade já avisada (reavisa se piorar) e aviso de resolução.
ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS notified_severity text,
  ADD COLUMN IF NOT EXISTS notified_at       timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by       uuid REFERENCES users(id);
CREATE INDEX IF NOT EXISTS alerts_status_opened_idx ON alerts (status, opened_at DESC);

-- Histórico de envios (evidência e diagnóstico; 90 dias).
CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  alert_id    bigint REFERENCES alerts(id) ON DELETE SET NULL,
  channel     text NOT NULL DEFAULT 'email',
  kind        text NOT NULL CHECK (kind IN ('alert', 'resolved', 'test', 'digest')),
  recipients  text NOT NULL,
  subject     text NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent', 'failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_time_idx ON notifications (created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON notifications;
CREATE POLICY platform_only ON notifications USING (app_is_platform()) WITH CHECK (app_is_platform());

-- 3. Disponibilidade por câmera e hora (relatórios): segundos no ar e gravando.
--    Uma linha por câmera e hora (24 por dia), somada pelo worker a cada minuto.
CREATE TABLE IF NOT EXISTS camera_hourly (
  camera_id    uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  hour         timestamptz NOT NULL,
  observed_s   integer NOT NULL DEFAULT 0,
  online_s     integer NOT NULL DEFAULT 0,
  recording_s  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (camera_id, hour),
  FOREIGN KEY (camera_id, tenant_id) REFERENCES cameras (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS camera_hourly_tenant_hour_idx ON camera_hourly (tenant_id, hour);
ALTER TABLE camera_hourly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON camera_hourly;
CREATE POLICY tenant_isolation ON camera_hourly
  USING (app_is_platform() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_current_tenant());

-- 4. Amostras do dashboard (a cada 5 min, 7 dias): câmeras por estado e tráfego recebido.
CREATE TABLE IF NOT EXISTS status_samples (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  sampled_at   timestamptz NOT NULL DEFAULT now(),
  cameras      integer NOT NULL,
  online       integer NOT NULL,
  recording    integer NOT NULL,
  offline      integer NOT NULL,
  ingress_bps  bigint
);
CREATE INDEX IF NOT EXISTS status_samples_tenant_time_idx ON status_samples (tenant_id, sampled_at);
ALTER TABLE status_samples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON status_samples;
CREATE POLICY tenant_isolation ON status_samples
  USING (app_is_platform() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications, camera_hourly, status_samples TO topcam_app;
GRANT USAGE, SELECT ON SEQUENCE notifications_id_seq, status_samples_id_seq TO topcam_app;
