import {
  encryptStreamKey,
  generateStreamKey,
  hashPassword,
  hashStreamKey,
  parseEncryptionKey,
  streamKeyPrefix,
} from "@topcam/shared";
import pg from "pg";

/**
 * Seed idempotente. Pode rodar a cada inicialização: nunca sobrescreve dados
 * editados nem regenera chaves já existentes.
 *
 * - Dados de referência (sempre): planos, papéis, política de retenção de 24 h,
 *   nó de ingestão, nó de armazenamento, configurações do sistema e
 *   administrador inicial (se ADMIN_EMAIL/ADMIN_INITIAL_PASSWORD definidos).
 * - Dados de demonstração (SEED_DEMO=true): dois clientes fictícios e as câmeras
 *   do laboratório (CAM-001 gravando; CAM-002..005 somente ao vivo).
 */

export interface SeedOptions {
  streamKeyEncKey: string;
  publicHost: string;
  mediamtxApiUrl: string;
  recordingsPath: string;
  videoQuotaBytes?: number;
  adminEmail?: string;
  adminPassword?: string;
  demo: boolean;
  log?: (msg: string) => void;
}

const PLANS = [
  {
    code: "basico",
    name: "Básico",
    max_cameras: 50,
    max_storage_bytes: 10e12,
    max_retention_hours: 168,
  },
  {
    code: "pro",
    name: "Pro",
    max_cameras: 200,
    max_storage_bytes: 30e12,
    max_retention_hours: 720,
  },
  {
    code: "enterprise",
    name: "Enterprise",
    max_cameras: 1000,
    max_storage_bytes: 150e12,
    max_retention_hours: 2160,
  },
];

const ROLES = [
  {
    key: "platform_admin",
    name: "Administrador da plataforma",
    scope: "platform",
    description: "Acesso total a todos os clientes, infraestrutura e auditoria",
  },
  {
    key: "platform_operator",
    name: "Operador da plataforma",
    scope: "platform",
    description: "Operação e suporte a todos os clientes, sem alterar infraestrutura",
  },
  {
    key: "tenant_admin",
    name: "Administrador do cliente",
    scope: "tenant",
    description: "Gerencia usuários, câmeras e permissões do próprio cliente",
  },
  {
    key: "operator",
    name: "Operador",
    scope: "tenant",
    description: "Opera as câmeras autorizadas do cliente",
  },
  {
    key: "viewer",
    name: "Visualizador",
    scope: "tenant",
    description: "Apenas visualiza as câmeras e gravações autorizadas",
  },
];

interface DemoCamera {
  code: string;
  name: string;
  group: string;
  recording: boolean;
}

const DEMO_TENANTS: Array<{
  slug: string;
  name: string;
  legal_name: string;
  plan: string;
  location: string;
  groups: string[];
  cameras: DemoCamera[];
}> = [
  {
    slug: "empresa-alfa",
    name: "Empresa Alfa",
    legal_name: "Empresa Alfa Ltda (fictícia)",
    plan: "pro",
    location: "Matriz",
    groups: ["Externo", "Interno"],
    cameras: [
      { code: "CAM-001", name: "Entrada Principal", group: "Externo", recording: true },
      { code: "CAM-002", name: "Estacionamento", group: "Externo", recording: false },
      { code: "CAM-003", name: "Recepção", group: "Interno", recording: false },
      { code: "CAM-004", name: "Caixa 01", group: "Interno", recording: false },
      { code: "CAM-005", name: "Corredor", group: "Interno", recording: false },
    ],
  },
  {
    slug: "condominio-sol",
    name: "Condomínio Sol",
    legal_name: "Condomínio Residencial Sol (fictício)",
    plan: "basico",
    location: "Bloco A",
    groups: ["Portaria"],
    cameras: [{ code: "CAM-001", name: "Portão Social", group: "Portaria", recording: false }],
  },
];

export async function seed(connectionString: string, opts: SeedOptions): Promise<void> {
  const log = opts.log ?? (() => undefined);
  const encKey = parseEncryptionKey(opts.streamKeyEncKey);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");

    for (const p of PLANS) {
      await client.query(
        `INSERT INTO plans (code, name, max_cameras, max_storage_bytes, max_retention_hours)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (code) DO NOTHING`,
        [p.code, p.name, p.max_cameras, p.max_storage_bytes, p.max_retention_hours],
      );
    }
    for (const r of ROLES) {
      await client.query(
        `INSERT INTO roles (key, name, scope, description) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, scope = EXCLUDED.scope,
           description = EXCLUDED.description`,
        [r.key, r.name, r.scope, r.description],
      );
    }
    await client.query(
      `INSERT INTO retention_policies (tenant_id, name, retention_hours)
       VALUES (NULL, '24 horas', 24) ON CONFLICT (tenant_id, name) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO ingest_nodes (name, public_host, api_url, capacity_streams)
       VALUES ('ingest-01', $1, $2, 5)
       ON CONFLICT (name) DO UPDATE SET public_host = EXCLUDED.public_host, api_url = EXCLUDED.api_url`,
      [opts.publicHost, opts.mediamtxApiUrl],
    );
    await client.query(
      `INSERT INTO storage_nodes (name, mount_path, quota_bytes)
       VALUES ('storage-01', $1, $2)
       ON CONFLICT (name) DO UPDATE SET mount_path = EXCLUDED.mount_path,
         quota_bytes = COALESCE(EXCLUDED.quota_bytes, storage_nodes.quota_bytes)`,
      [opts.recordingsPath, opts.videoQuotaBytes ?? null],
    );
    // Chave geral da gravação: ligada desde a Fase 4 (indexação e retenção prontas).
    // Só grava quem tem "gravação" marcada no cadastro. Desligável em Configurações.
    await client.query(
      `INSERT INTO system_settings (key, value) VALUES ('recording.globally_enabled', 'true'::jsonb)
       ON CONFLICT (key) DO NOTHING`,
    );

    if (opts.adminEmail && opts.adminPassword) {
      const exists = await client.query("SELECT 1 FROM users WHERE email = $1", [opts.adminEmail]);
      if (exists.rowCount === 0) {
        await client.query(
          `INSERT INTO users (tenant_id, role_id, name, email, password_hash, must_change_password)
           VALUES (NULL, (SELECT id FROM roles WHERE key = 'platform_admin'), 'Administrador', $1, $2, true)`,
          [opts.adminEmail, await hashPassword(opts.adminPassword)],
        );
        log(`administrador criado: ${opts.adminEmail}`);
      }
    }

    if (opts.demo) {
      const ingest = await client.query<{ id: string }>(
        "SELECT id FROM ingest_nodes WHERE name = 'ingest-01'",
      );
      const storage = await client.query<{ id: string }>(
        "SELECT id FROM storage_nodes WHERE name = 'storage-01'",
      );
      const retention = await client.query<{ id: string }>(
        "SELECT id FROM retention_policies WHERE tenant_id IS NULL AND name = '24 horas'",
      );
      for (const t of DEMO_TENANTS) {
        const tenant = await client.query<{ id: string }>(
          `INSERT INTO tenants (slug, name, legal_name, plan_id)
           VALUES ($1, $2, $3, (SELECT id FROM plans WHERE code = $4))
           ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id`,
          [t.slug, t.name, t.legal_name, t.plan],
        );
        const tenantId = tenant.rows[0]!.id;
        const loc = await client.query<{ id: string }>(
          `INSERT INTO locations (tenant_id, name) VALUES ($1, $2)
           ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [tenantId, t.location],
        );
        const locationId = loc.rows[0]!.id;
        const groupIds = new Map<string, string>();
        for (const [i, g] of t.groups.entries()) {
          const grp = await client.query<{ id: string }>(
            `INSERT INTO camera_groups (tenant_id, location_id, name, sort_order) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, location_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [tenantId, locationId, g, i],
          );
          groupIds.set(g, grp.rows[0]!.id);
        }
        for (const c of t.cameras) {
          const existing = await client.query(
            "SELECT 1 FROM cameras WHERE tenant_id = $1 AND code = $2",
            [tenantId, c.code],
          );
          if (existing.rowCount) continue;
          const key = generateStreamKey();
          await client.query(
            `INSERT INTO cameras (tenant_id, location_id, group_id, code, name, stream_key_hash,
               stream_key_enc, stream_key_prefix, stream_key_rotated_at, recording_enabled,
               retention_policy_id, ingest_node_id, storage_node_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10, $11, $12)`,
            [
              tenantId,
              locationId,
              groupIds.get(c.group) ?? null,
              c.code,
              c.name,
              hashStreamKey(key),
              encryptStreamKey(key, encKey),
              streamKeyPrefix(key),
              c.recording,
              c.recording ? retention.rows[0]!.id : null,
              ingest.rows[0]!.id,
              c.recording ? storage.rows[0]!.id : null,
            ],
          );
          await client.query(
            `INSERT INTO audit_logs (tenant_id, actor_type, action, entity_type, data)
             VALUES ($1, 'system', 'camera.created', 'camera', $2)`,
            [tenantId, JSON.stringify({ code: c.code, source: "seed" })],
          );
          log(`câmera criada: ${t.slug}/${c.code}`);
        }
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}
