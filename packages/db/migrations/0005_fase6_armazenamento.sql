-- Fase 6: armazenamento e proteção de disco.
--
-- 1. Toda câmera passa a ter um nó de armazenamento explícito (antes ficava nulo e
--    o índice usava "o primeiro nó"). Assim o bloqueio de gravação por disco cheio
--    (storage_nodes.recording_blocked) vale para as câmeras daquele nó.
UPDATE cameras
   SET storage_node_id = (SELECT id FROM storage_nodes ORDER BY created_at LIMIT 1)
 WHERE storage_node_id IS NULL;

CREATE OR REPLACE FUNCTION cameras_default_storage_node() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.storage_node_id IS NULL THEN
    NEW.storage_node_id := (SELECT id FROM storage_nodes ORDER BY created_at LIMIT 1);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS cameras_default_storage_node ON cameras;
CREATE TRIGGER cameras_default_storage_node
  BEFORE INSERT OR UPDATE OF storage_node_id ON cameras
  FOR EACH ROW EXECUTE FUNCTION cameras_default_storage_node();

-- 2. Medições do vigia de disco.
ALTER TABLE storage_nodes
  ADD COLUMN IF NOT EXISTS used_pct          numeric(5, 2),
  ADD COLUMN IF NOT EXISTS segments_bytes    bigint,
  ADD COLUMN IF NOT EXISTS write_latency_ms  integer,
  ADD COLUMN IF NOT EXISTS last_purge_at     timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now();

-- Histórico curto (7 dias) para gráficos, previsão e latência.
CREATE TABLE IF NOT EXISTS storage_samples (
  id               bigserial PRIMARY KEY,
  storage_node_id  uuid NOT NULL REFERENCES storage_nodes(id) ON DELETE CASCADE,
  sampled_at       timestamptz NOT NULL DEFAULT now(),
  total_bytes      bigint,
  free_bytes       bigint,
  segments_bytes   bigint,
  used_pct         numeric(5, 2),
  write_latency_ms integer
);
CREATE INDEX IF NOT EXISTS storage_samples_node_time_idx ON storage_samples (storage_node_id, sampled_at);
ALTER TABLE storage_samples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON storage_samples;
CREATE POLICY platform_only ON storage_samples USING (app_is_platform()) WITH CHECK (app_is_platform());
GRANT SELECT, INSERT, UPDATE, DELETE ON storage_samples TO topcam_app;
GRANT USAGE, SELECT ON SEQUENCE storage_samples_id_seq TO topcam_app;

-- 3. Buracos dentro de um segmento (quadros perdidos numa travada de disco): a
--    conferência grava os trechos sem vídeo, em segundos desde o início do arquivo.
ALTER TABLE recording_segments ADD COLUMN IF NOT EXISTS holes jsonb;

-- 4. Limpeza de emergência (disco a 95%): apaga o mais antigo primeiro, mesmo dentro
--    da retenção, mas nunca o que tem menos de N minutos. Sem nada apagável, a
--    gravação para (proteção final) e volta quando houver espaço.
INSERT INTO system_settings (key, value) VALUES
  ('storage.emergency_purge', 'true'::jsonb),
  ('storage.purge_min_age_minutes', '60'::jsonb)
ON CONFLICT (key) DO NOTHING;
