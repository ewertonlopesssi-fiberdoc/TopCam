-- TopCam — novas opções de retenção (globais): 3 dias e 7 dias, ao lado das 24 horas.
-- A escolha continua por câmera (Câmeras → editar → Retenção). Nada existente muda.
INSERT INTO retention_policies (tenant_id, name, retention_hours) VALUES
  (NULL, '3 dias', 72),
  (NULL, '7 dias', 168)
ON CONFLICT (tenant_id, name) DO NOTHING;
