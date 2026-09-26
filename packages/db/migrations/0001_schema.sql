-- TopCam — modelo de dados completo (versão final), especificação §6.
-- Todas as datas em UTC (timestamptz). Tabelas de negócio têm tenant_id e
-- chaves estrangeiras compostas (id, tenant_id) para impedir, no próprio banco,
-- que um registro aponte para dados de outro cliente.

CREATE EXTENSION IF NOT EXISTS citext;

-- Papel usado pela API e pelo worker. Sem SUPERUSER e sem BYPASSRLS: as
-- políticas de Row Level Security sempre se aplicam a ele. A senha é definida
-- pelo executor de migrations a partir de APP_DB_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'topcam_app') THEN
    CREATE ROLE topcam_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------- planos / clientes
CREATE TABLE plans (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  max_cameras         integer NOT NULL CHECK (max_cameras >= 0),
  max_storage_bytes   bigint NOT NULL CHECK (max_storage_bytes >= 0),
  max_retention_hours integer NOT NULL CHECK (max_retention_hours > 0),
  features            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                text NOT NULL,
  legal_name          text,
  document            text,
  plan_id             uuid NOT NULL REFERENCES plans(id),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'cancelled')),
  storage_quota_bytes bigint CHECK (storage_quota_bytes >= 0),
  timezone            text NOT NULL DEFAULT 'America/Sao_Paulo',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);

-- ---------------------------------------------------------------- usuários / acesso
CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('platform', 'tenant')),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid REFERENCES tenants(id),       -- NULL = equipe da plataforma
  role_id              uuid NOT NULL REFERENCES roles(id),
  name                 text NOT NULL,
  email                citext NOT NULL UNIQUE,
  password_hash        text,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invited')),
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  UNIQUE (id, tenant_id)
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id          uuid REFERENCES tenants(id),
  refresh_token_hash text NOT NULL UNIQUE,
  client             text NOT NULL CHECK (client IN ('web', 'mobile')),
  ip                 inet,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_active_idx ON sessions (last_seen_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- locais / grupos
CREATE TABLE locations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  address    text,
  timezone   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id)
);

CREATE TABLE camera_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  location_id uuid NOT NULL,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (tenant_id, location_id, name),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES locations (id, tenant_id)
);

-- ---------------------------------------------------------------- retenção / infraestrutura
CREATE TABLE retention_policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid REFERENCES tenants(id),             -- NULL = política global
  name            text NOT NULL,
  retention_hours integer NOT NULL CHECK (retention_hours > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (tenant_id, name)
);

CREATE TABLE ingest_nodes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL UNIQUE,
  public_host      text NOT NULL,
  rtmp_port        integer NOT NULL DEFAULT 1935,
  rtmps_port       integer,
  api_url          text NOT NULL,
  capacity_streams integer NOT NULL DEFAULT 5 CHECK (capacity_streams > 0),
  status           text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'degraded', 'maintenance')),
  last_seen_at     timestamptz,
  metrics          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE storage_nodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL UNIQUE,
  mount_path        text NOT NULL,
  quota_bytes       bigint CHECK (quota_bytes >= 0),
  total_bytes       bigint,
  used_bytes        bigint,
  free_bytes        bigint,
  warn_pct          smallint NOT NULL DEFAULT 70 CHECK (warn_pct BETWEEN 1 AND 100),
  high_pct          smallint NOT NULL DEFAULT 85 CHECK (high_pct BETWEEN 1 AND 100),
  critical_pct      smallint NOT NULL DEFAULT 95 CHECK (critical_pct BETWEEN 1 AND 100),
  status            text NOT NULL DEFAULT 'offline' CHECK (status IN ('ok', 'warning', 'high', 'critical', 'offline')),
  recording_blocked boolean NOT NULL DEFAULT false,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (warn_pct < high_pct AND high_pct < critical_pct)
);

-- ---------------------------------------------------------------- câmeras
CREATE TABLE cameras (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  location_id             uuid NOT NULL,
  group_id                uuid,
  code                    text NOT NULL,
  name                    text NOT NULL,
  description             text,
  ingest_protocol         text NOT NULL DEFAULT 'rtmp_push' CHECK (ingest_protocol IN ('rtmp_push', 'rtsp_pull')),
  stream_key_hash         text UNIQUE,
  stream_key_enc          text,
  stream_key_prefix       text,
  stream_key_rotated_at   timestamptz,
  recording_enabled       boolean NOT NULL DEFAULT false,
  recording_mode          text NOT NULL DEFAULT 'continuous' CHECK (recording_mode IN ('continuous', 'motion', 'event')),
  retention_policy_id     uuid REFERENCES retention_policies(id),
  ingest_node_id          uuid REFERENCES ingest_nodes(id),
  storage_node_id         uuid REFERENCES storage_nodes(id),
  status                  text NOT NULL DEFAULT 'aguardando_transmissao' CHECK (status IN (
                            'aguardando_transmissao', 'conectando', 'recebendo', 'validando',
                            'ao_vivo', 'gravando', 'offline', 'erro', 'desabilitada')),
  status_changed_at       timestamptz NOT NULL DEFAULT now(),
  status_reason           text,
  last_publish_at         timestamptz,
  last_publish_ip         inet,
  last_video_at           timestamptz,   -- último vídeo recebido (online)
  last_durable_segment_at timestamptz,   -- último segmento durável confirmado (gravando)
  video_codec             text,
  audio_codec             text,
  width                   integer,
  height                  integer,
  fps                     numeric(6, 2),
  bitrate_kbps            integer,
  enabled                 boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  deleted_at              timestamptz,
  UNIQUE (tenant_id, code),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (location_id, tenant_id) REFERENCES locations (id, tenant_id),
  FOREIGN KEY (group_id, tenant_id) REFERENCES camera_groups (id, tenant_id),
  CHECK (ingest_protocol <> 'rtmp_push' OR (stream_key_hash IS NOT NULL AND stream_key_enc IS NOT NULL)),
  CHECK (recording_enabled = false OR retention_policy_id IS NOT NULL)
);
CREATE INDEX cameras_tenant_status_idx ON cameras (tenant_id, status);

CREATE TABLE user_camera_permissions (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  camera_id    uuid NOT NULL,
  can_live     boolean NOT NULL DEFAULT true,
  can_playback boolean NOT NULL DEFAULT false,
  can_export   boolean NOT NULL DEFAULT false,
  granted_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, camera_id),
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (camera_id, tenant_id) REFERENCES cameras (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ucp_camera_idx ON user_camera_permissions (camera_id);

-- ---------------------------------------------------------------- gravação
CREATE TABLE recording_segments (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  camera_id       uuid NOT NULL,
  storage_node_id uuid NOT NULL REFERENCES storage_nodes(id),
  path            text NOT NULL UNIQUE,
  started_at      timestamptz NOT NULL,
  ended_at        timestamptz,
  duration_ms     integer CHECK (duration_ms >= 0),
  video_codec     text,
  audio_codec     text,
  size_bytes      bigint CHECK (size_bytes >= 0),
  checksum_sha256 text,
  state           text NOT NULL DEFAULT 'writing' CHECK (state IN ('writing', 'verified', 'corrupt', 'missing', 'deleting', 'deleted')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_at     timestamptz,
  deleted_at      timestamptz,
  FOREIGN KEY (camera_id, tenant_id) REFERENCES cameras (id, tenant_id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX segments_camera_time_idx ON recording_segments (camera_id, started_at);
CREATE INDEX segments_expiry_idx ON recording_segments (expires_at) WHERE state IN ('writing', 'verified', 'corrupt', 'missing');

-- ---------------------------------------------------------------- eventos / alertas / auditoria
CREATE TABLE camera_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid REFERENCES tenants(id),  -- NULL para eventos sem cliente identificado (ex.: chave inválida)
  camera_id   uuid,
  type        text NOT NULL,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  message     text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ip   inet,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (camera_id, tenant_id) REFERENCES cameras (id, tenant_id),
  CHECK (camera_id IS NULL OR tenant_id IS NOT NULL)
);
CREATE INDEX camera_events_tenant_time_idx ON camera_events (tenant_id, occurred_at DESC);
CREATE INDEX camera_events_camera_time_idx ON camera_events (camera_id, occurred_at DESC);
CREATE INDEX camera_events_type_time_idx ON camera_events (type, occurred_at DESC);

CREATE TABLE alerts (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid REFERENCES tenants(id),
  camera_id       uuid,
  ingest_node_id  uuid REFERENCES ingest_nodes(id),
  storage_node_id uuid REFERENCES storage_nodes(id),
  rule            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  title           text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key       text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  resolved_at     timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (camera_id, tenant_id) REFERENCES cameras (id, tenant_id),
  CHECK (camera_id IS NULL OR tenant_id IS NOT NULL)
);
CREATE UNIQUE INDEX alerts_open_dedup_idx ON alerts (dedup_key) WHERE status <> 'resolved';
CREATE INDEX alerts_tenant_status_idx ON alerts (tenant_id, status, opened_at DESC);

CREATE TABLE exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  camera_id    uuid NOT NULL,
  requested_by uuid REFERENCES users(id),
  start_at     timestamptz NOT NULL,
  end_at       timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed', 'expired')),
  file_path    text,
  size_bytes   bigint,
  error        text,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (camera_id, tenant_id) REFERENCES cameras (id, tenant_id),
  CHECK (end_at > start_at)
);

CREATE TABLE audit_logs (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id),
  actor_user_id uuid REFERENCES users(id),
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'system', 'cli')),
  action        text NOT NULL,
  entity_type   text,
  entity_id     text,
  ip            inet,
  user_agent    text,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs (tenant_id, created_at DESC);

-- Trilha de auditoria somente de inserção (vale até para o dono das tabelas).
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs é somente de inserção';
END
$$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ---------------------------------------------------------------- tarefas duráveis / configurações
CREATE TABLE durable_jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key    text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  run_at       timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX durable_jobs_dedup_idx ON durable_jobs (dedup_key) WHERE status IN ('pending', 'running');
CREATE INDEX durable_jobs_pending_idx ON durable_jobs (run_at) WHERE status = 'pending';

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------- updated_at automático
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['plans', 'tenants', 'users', 'locations', 'camera_groups',
    'retention_policies', 'ingest_nodes', 'storage_nodes', 'cameras',
    'user_camera_permissions', 'alerts', 'exports', 'durable_jobs', 'system_settings']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_updated_at', t);
  END LOOP;
END
$$;
