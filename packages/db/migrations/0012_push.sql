-- TopCam — notificação push dos alarmes no app (Fase 9.3).
--
-- Cada celular logado no app registra o seu endereço de push (token do serviço de push da
-- Expo, que entrega pelo Google/FCM no Android e pela Apple/APNs no iPhone). O token fica
-- ligado ao usuário e à sessão do app: sessão encerrada ou vencida não recebe mais push.
-- O usuário pode desligar as notificações no próprio celular (enabled = false).
-- Migration só aditiva.

CREATE TABLE IF NOT EXISTS push_devices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       uuid REFERENCES tenants(id),
  session_id      uuid REFERENCES sessions(id) ON DELETE SET NULL,
  token           text NOT NULL UNIQUE CHECK (length(token) BETWEEN 10 AND 300),
  platform        text NOT NULL CHECK (platform IN ('android', 'ios')),
  brand           text NOT NULL DEFAULT 'topcam' CHECK (brand ~ '^[a-z0-9-]{1,40}$'),
  device_name     text CHECK (length(device_name) <= 100),
  app_version     text CHECK (length(app_version) <= 30),
  enabled         boolean NOT NULL DEFAULT true,
  disabled_reason text,
  last_sent_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_devices_user_idx ON push_devices (user_id) WHERE enabled;
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON push_devices;
CREATE POLICY tenant_isolation ON push_devices
  USING (app_is_platform() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON push_devices TO topcam_app;

-- Recibo do serviço de push: o "ticket" do envio é conferido depois (entregue ao Google/Apple
-- ou não; celular desinstalou o app → o token é desligado).
ALTER TABLE alarm_notifications
  ADD COLUMN IF NOT EXISTS push_device_id uuid REFERENCES push_devices(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS push_ticket text,
  ADD COLUMN IF NOT EXISTS receipt_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS alarm_notifications_receipt_idx
  ON alarm_notifications (created_at) WHERE push_ticket IS NOT NULL AND receipt_checked_at IS NULL;
