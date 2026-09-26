-- TopCam — isolamento entre clientes com Row Level Security.
--
-- Cada transação da aplicação define, via set_config(..., true):
--   app.scope     = 'platform' (equipe da plataforma / tarefas do sistema) ou 'tenant'
--   app.tenant_id = UUID do cliente quando scope = 'tenant'
-- Sem esses valores, o papel topcam_app não enxerga nenhuma linha de negócio.
-- Mesmo que uma consulta esqueça o filtro por tenant_id, o banco o aplica.

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_is_platform() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.scope', true), '') = 'platform'
$$;

-- Tabelas com tenant_id obrigatório ou opcional: plataforma vê tudo; cliente vê só o seu.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'sessions', 'locations', 'camera_groups', 'cameras',
    'user_camera_permissions', 'recording_segments', 'camera_events', 'alerts',
    'exports', 'audit_logs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (app_is_platform() OR tenant_id = app_current_tenant())
      WITH CHECK (app_is_platform() OR tenant_id = app_current_tenant())$p$, t);
  END LOOP;
END
$$;

-- tenants: o cliente enxerga apenas o próprio cadastro e não o altera.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self_read ON tenants FOR SELECT
  USING (app_is_platform() OR id = app_current_tenant());
CREATE POLICY tenant_platform_write ON tenants FOR ALL
  USING (app_is_platform()) WITH CHECK (app_is_platform());

-- Políticas de retenção: globais (tenant_id NULL) visíveis a todos; escrita por cliente só nas próprias.
ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY retention_read ON retention_policies FOR SELECT
  USING (app_is_platform() OR tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY retention_write ON retention_policies FOR ALL
  USING (app_is_platform() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_platform() OR tenant_id = app_current_tenant());

-- Catálogos legíveis por todos, alteráveis só pela plataforma.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'roles']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY catalog_read ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY catalog_write ON %I FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform())', t);
  END LOOP;
END
$$;

-- Infraestrutura e controle interno: somente plataforma.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingest_nodes', 'storage_nodes', 'durable_jobs', 'system_settings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY platform_only ON %I USING (app_is_platform()) WITH CHECK (app_is_platform())', t);
  END LOOP;
END
$$;

-- Permissões do papel da aplicação.
GRANT USAGE ON SCHEMA public TO topcam_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO topcam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO topcam_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM topcam_app;
REVOKE ALL ON schema_migrations FROM topcam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO topcam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO topcam_app;
