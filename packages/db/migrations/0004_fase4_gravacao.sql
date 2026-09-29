-- Fase 4: gravação e retenção.
--
-- Até aqui a chave geral da gravação ficava desligada (o indexador de segmentos
-- não existia). Agora o worker confere, indexa e apaga os segmentos; a chave é
-- ligada e cada câmera grava conforme o próprio cadastro ("gravação" marcada).
UPDATE system_settings SET value = 'true'::jsonb, updated_at = now()
 WHERE key = 'recording.globally_enabled';

-- Consultas da linha do tempo e da conferência (câmera + estado + início).
CREATE INDEX segments_camera_state_time_idx
    ON recording_segments (camera_id, state, started_at);
