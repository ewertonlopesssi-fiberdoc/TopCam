import type { PoolClient } from "pg";

/**
 * Alertas (tela Eventos e Alertas, Fase 7; usados pelo armazenamento na Fase 6).
 *
 * Um alerta aberto por dedup_key (índice único parcial). "Abrir" um alerta que já
 * está aberto só atualiza gravidade, título e detalhes — nunca duplica.
 */

export type AlertSeverity = "info" | "warning" | "error" | "critical";

export interface AlertInput {
  dedupKey: string;
  rule: string;
  severity: AlertSeverity;
  title: string;
  details?: Record<string, unknown>;
  tenantId?: string | null;
  cameraId?: string | null;
  storageNodeId?: string | null;
  ingestNodeId?: string | null;
}

/** Abre (ou atualiza) o alerta. Retorna true se foi aberto agora. */
export async function raiseAlert(client: PoolClient, a: AlertInput): Promise<boolean> {
  const { rows } = await client.query<{ inserted: boolean }>(
    `INSERT INTO alerts (rule, severity, title, details, dedup_key, tenant_id, camera_id,
                         storage_node_id, ingest_node_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (dedup_key) WHERE status <> 'resolved'
     DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title,
                   details = EXCLUDED.details, updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      a.rule,
      a.severity,
      a.title,
      JSON.stringify(a.details ?? {}),
      a.dedupKey,
      a.tenantId ?? null,
      a.cameraId ?? null,
      a.storageNodeId ?? null,
      a.ingestNodeId ?? null,
    ],
  );
  return rows[0]?.inserted ?? false;
}

/** Resolve o alerta aberto, se houver. Retorna true se havia um aberto. */
export async function resolveAlert(client: PoolClient, dedupKey: string): Promise<boolean> {
  const res = await client.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = now(), updated_at = now()
      WHERE dedup_key = $1 AND status <> 'resolved'`,
    [dedupKey],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function openAlert(
  client: PoolClient,
  dedupKey: string,
): Promise<{ severity: AlertSeverity; opened_at: Date } | null> {
  const { rows } = await client.query<{ severity: AlertSeverity; opened_at: Date }>(
    "SELECT severity, opened_at FROM alerts WHERE dedup_key = $1 AND status <> 'resolved'",
    [dedupKey],
  );
  return rows[0] ?? null;
}
