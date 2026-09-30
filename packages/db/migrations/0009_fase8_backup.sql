-- TopCam — Fase 8 (parte 3): histórico do backup e pedidos do painel.
--
-- O painel cria pedidos (status 'pending': teste de conexão ou backup agora); o serviço
-- de backup (contêiner próprio) executa um de cada vez e grava o resultado aqui.
-- A configuração fica em system_settings 'integrations.backup' (senhas cifradas).

CREATE TABLE IF NOT EXISTS backup_runs (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('backup', 'test')),
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'success', 'failed')),
  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  file_name     text,
  size_bytes    bigint,
  destination   text,
  message       text,
  error         text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS backup_runs_created_idx ON backup_runs (created_at DESC);
-- Um pedido por vez (pendente ou em execução).
CREATE UNIQUE INDEX IF NOT EXISTS backup_runs_one_active_idx
  ON backup_runs ((true)) WHERE status IN ('pending', 'running');

ALTER TABLE backup_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON backup_runs;
CREATE POLICY platform_only ON backup_runs
  USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT, UPDATE ON backup_runs TO topcam_app;
GRANT USAGE, SELECT ON SEQUENCE backup_runs_id_seq TO topcam_app;
