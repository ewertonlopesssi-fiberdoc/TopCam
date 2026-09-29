"use client";

import {
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  HardDrive,
  Info,
  Pencil,
  ShieldAlert,
  Timer,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LineChart } from "@/components/line-chart";
import {
  Badge,
  DataTable,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  useToast,
} from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtBytes, fmtDateTime, fmtDuration, fmtRelative, type Tone } from "@/lib/format";

interface StorageNode {
  id: string;
  name: string;
  mountPath: string;
  status: "ok" | "warning" | "high" | "critical" | "offline";
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
  usedPct: number | null;
  segmentsBytes: number | null;
  quotaBytes: number | null;
  warnPct: number;
  highPct: number;
  criticalPct: number;
  recordingBlocked: boolean;
  writeLatencyMs: number | null;
  latencyMax24h: number | null;
  lastSeenAt: string | null;
  lastPurgeAt: string | null;
  recordingCameras: number;
  projectedBytes: number;
  last24hBytes: number;
}
interface Sample {
  nodeId: string;
  at: string;
  usedPct: number | null;
  latencyMs: number | null;
}
interface TenantUse {
  id: string;
  name: string;
  quotaBytes: number | null;
  usedBytes: number;
  cameras: number;
}
interface CameraUse {
  id: string;
  code: string;
  name: string;
  tenantName: string;
  nodeName: string | null;
  recordingEnabled: boolean;
  retentionHours: number;
  bytes: number;
  segments: number;
  oldest: string | null;
  seconds: number;
  bitsPerSecond: number;
}
interface AlertRow {
  id: string;
  rule: string;
  severity: "info" | "warning" | "error" | "critical";
  title: string;
  openedAt: string;
}
interface EventRow {
  id: string;
  type: string;
  severity: string;
  message: string;
  occurredAt: string;
}
interface StorageData {
  nodes: StorageNode[];
  samples: Sample[];
  tenants: TenantUse[];
  cameras: CameraUse[];
  alerts: AlertRow[];
  events: EventRow[];
  settings: { emergencyPurge: boolean; purgeMinAgeMinutes: number };
}

const GB = 1e9;

const LEVEL: Record<StorageNode["status"], { label: string; tone: Tone; icon: React.ReactNode }> = {
  ok: { label: "Normal", tone: "green", icon: <CheckCircle2 size={13} /> },
  warning: { label: "Atenção", tone: "amber", icon: <AlertTriangle size={13} /> },
  high: { label: "Alto", tone: "red", icon: <AlertTriangle size={13} /> },
  critical: { label: "Crítico", tone: "red", icon: <AlertOctagon size={13} /> },
  offline: { label: "Sem leitura", tone: "slate", icon: <Info size={13} /> },
};
const SEVERITY: Record<AlertRow["severity"], { label: string; tone: Tone }> = {
  info: { label: "Info", tone: "blue" },
  warning: { label: "Atenção", tone: "amber" },
  error: { label: "Erro", tone: "red" },
  critical: { label: "Crítico", tone: "red" },
};

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toFixed(1).replace(".", ",")}%`;
const ms = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : v >= 1000
      ? `${(v / 1000).toFixed(1).replace(".", ",")} s`
      : `${v} ms`;

export default function Page() {
  const auth = useAuth();
  const canEdit = auth.can("storage.write");
  const [data, setData] = useState<StorageData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<StorageNode | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<StorageData>("/storage"));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Armazenamento"
        subtitle="Discos de vídeo, limites, limpeza de emergência e uso por cliente e câmera"
      />
      <ErrorBox error={error} />
      {!data ? (
        <div className="card">
          <Loading />
        </div>
      ) : (
        <div className="space-y-4">
          {data.alerts.length > 0 && (
            <div className="card divide-y divide-line" data-testid="storage-alerts">
              {data.alerts.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <Badge tone={SEVERITY[a.severity].tone} dot>
                    {SEVERITY[a.severity].label}
                  </Badge>
                  <span className="font-medium text-slate-800">{a.title}</span>
                  <span className="ml-auto text-xs text-muted">
                    desde {fmtDateTime(a.openedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {data.nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              samples={data.samples.filter((s) => s.nodeId === n.id)}
              canEdit={canEdit}
              onEdit={() => setEditing(n)}
            />
          ))}

          <PurgeSettings settings={data.settings} canEdit={canEdit} onSaved={load} />

          <div className="card">
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">
              Uso por cliente
            </h2>
            <DataTable
              rows={data.tenants.filter((t) => t.usedBytes > 0 || t.quotaBytes)}
              rowKey={(t) => t.id}
              mobileTitle={(t) => t.name}
              columns={[
                {
                  key: "name",
                  header: "Cliente",
                  cell: (t) => <span className="font-medium">{t.name}</span>,
                },
                { key: "used", header: "Vídeo gravado", cell: (t) => fmtBytes(t.usedBytes) },
                {
                  key: "quota",
                  header: "Cota",
                  cell: (t) =>
                    t.quotaBytes ? (
                      <QuotaBar used={t.usedBytes} quota={t.quotaBytes} />
                    ) : (
                      <span className="text-muted">sem cota</span>
                    ),
                },
                {
                  key: "cams",
                  header: "Câmeras com gravação",
                  cell: (t) => t.cameras,
                  mobileHidden: true,
                },
              ]}
            />
            <p className="border-t border-line px-4 py-2 text-xs text-muted">
              {data.tenants.filter((t) => !(t.usedBytes > 0 || t.quotaBytes)).length} cliente(s) sem
              gravação e sem cota não aparecem. A cota do cliente (no cadastro do cliente) só gera
              alerta em 90% e 100%; nada é apagado por ela.
            </p>
          </div>

          <div className="card">
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">Uso por câmera</h2>
            {data.cameras.length === 0 ? (
              <Empty icon={<HardDrive size={36} />} title="Nenhuma câmera com gravação" />
            ) : (
              <DataTable
                rows={data.cameras}
                rowKey={(c) => c.id}
                mobileTitle={(c) => `${c.code} · ${c.name}`}
                columns={[
                  {
                    key: "cam",
                    header: "Câmera",
                    cell: (c) => (
                      <span>
                        <span className="font-medium">{c.code}</span> · {c.name}
                        {!c.recordingEnabled && (
                          <span className="ml-1 text-xs text-muted">(gravação desligada)</span>
                        )}
                      </span>
                    ),
                  },
                  {
                    key: "tenant",
                    header: "Cliente",
                    cell: (c) => c.tenantName,
                    mobileHidden: true,
                  },
                  { key: "bytes", header: "Espaço", cell: (c) => fmtBytes(c.bytes) },
                  { key: "hours", header: "Disponível", cell: (c) => fmtDuration(c.seconds) },
                  {
                    key: "ret",
                    header: "Retenção",
                    cell: (c) => `${c.retentionHours} h`,
                    mobileHidden: true,
                  },
                  {
                    key: "rate",
                    header: "Taxa (última hora)",
                    cell: (c) =>
                      c.bitsPerSecond > 0
                        ? `${(c.bitsPerSecond / 1e6).toFixed(2).replace(".", ",")} Mbps`
                        : "—",
                    mobileHidden: true,
                  },
                  {
                    key: "day",
                    header: "24 h ocupam",
                    cell: (c) =>
                      c.bitsPerSecond > 0 ? fmtBytes((c.bitsPerSecond / 8) * 86400) : "—",
                    mobileHidden: true,
                  },
                ]}
              />
            )}
          </div>

          <div className="card">
            <h2 className="border-b border-line px-4 py-3 text-sm font-semibold">
              Eventos recentes
            </h2>
            {data.events.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">Nenhum evento de armazenamento.</p>
            ) : (
              <ul className="divide-y divide-line text-sm" data-testid="storage-events">
                {data.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-3 gap-y-0.5 px-4 py-2">
                    <span className="w-32 shrink-0 text-xs text-muted">
                      {fmtRelative(e.occurredAt)}
                    </span>
                    <span className="min-w-0 flex-1">{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {editing && (
        <EditNode
          node={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function NodeCard({
  node: n,
  samples,
  canEdit,
  onEdit,
}: {
  node: StorageNode;
  samples: Sample[];
  canEdit: boolean;
  onEdit: () => void;
}) {
  const level = LEVEL[n.status] ?? LEVEL.offline;
  const used = n.usedPct ?? 0;
  const capacity = n.quotaBytes ?? n.totalBytes ?? 0;
  const projectedPct = capacity ? (n.projectedBytes / capacity) * 100 : null;
  return (
    <div className="card p-4" data-testid="storage-node" data-status={n.status}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <HardDrive size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">Disco de vídeo · {n.name}</h2>
            <Badge tone={level.tone}>
              <span className="inline-flex items-center gap-1">
                {level.icon} {level.label}
              </span>
            </Badge>
          </div>
          <p className="text-xs text-muted">
            {n.mountPath} · {n.recordingCameras} câmera(s) gravando · atualizado{" "}
            {fmtRelative(n.lastSeenAt)}
          </p>
        </div>
        {canEdit && (
          <button className="btn-secondary h-9 px-3" onClick={onEdit}>
            <Pencil size={15} /> Limites e cota
          </button>
        )}
      </div>

      {n.recordingBlocked && (
        <div
          className="mt-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          Gravação parada neste disco: está acima de {n.criticalPct}% e não há gravações apagáveis.
          Volta sozinha abaixo de {n.criticalPct - 5}%. O ao vivo continua funcionando.
        </div>
      )}

      <div className="mt-4">
        <div className="mb-1 flex items-baseline justify-between text-sm">
          <span className="text-2xl font-semibold text-ink">{pct(n.usedPct)}</span>
          <span className="text-xs text-muted">
            {fmtBytes(n.usedBytes)} usados de {fmtBytes(n.totalBytes)} · livre{" "}
            {fmtBytes(n.freeBytes)}
          </span>
        </div>
        <Meter value={used} marks={[n.warnPct, n.highPct, n.criticalPct]} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm md:grid-cols-4">
        <Stat k="Gravações no disco" v={fmtBytes(n.segmentsBytes)} />
        <Stat
          k="Cota do disco"
          v={n.quotaBytes ? fmtBytes(n.quotaBytes) : "sem cota (disco inteiro)"}
        />
        <Stat
          k="Uso estimado em regime"
          v={`${fmtBytes(n.projectedBytes)}${projectedPct !== null ? ` (${pct(projectedPct)})` : ""}`}
          hint="Gravado na última hora × retenção de cada câmera"
        />
        <Stat k="Gravado nas últimas 24 h" v={fmtBytes(n.last24hBytes)} />
        <Stat
          k="Latência de escrita"
          v={ms(n.writeLatencyMs)}
          hint={`Máxima em 24 h: ${ms(n.latencyMax24h)}. Acima de 1 s abre alerta de disco lento.`}
        />
        <Stat
          k="Limites"
          v={`${n.warnPct}% · ${n.highPct}% · ${n.criticalPct}%`}
          hint="Atenção · alto · crítico"
        />
        <Stat
          k="Última limpeza de emergência"
          v={n.lastPurgeAt ? fmtDateTime(n.lastPurgeAt) : "nunca"}
        />
      </dl>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted">Uso do disco nas últimas 24 h (%)</h3>
          <LineChart
            testId="chart-usage"
            label="Uso do disco de vídeo nas últimas 24 horas"
            points={samples.map((s) => ({ t: Date.parse(s.at), v: s.usedPct }))}
            yMax={100}
            format={(v) => `${Math.round(v)}%`}
            thresholds={[
              { v: n.warnPct, label: `atenção ${n.warnPct}%` },
              { v: n.criticalPct, label: `crítico ${n.criticalPct}%` },
            ]}
          />
        </div>
        <div>
          <h3 className="mb-1 flex items-center gap-1 text-xs font-medium text-muted">
            <Timer size={12} /> Latência de escrita nas últimas 24 h
          </h3>
          <LineChart
            testId="chart-latency"
            label="Latência de escrita do disco de vídeo nas últimas 24 horas"
            points={samples.map((s) => ({ t: Date.parse(s.at), v: s.latencyMs }))}
            yMax={Math.max(1200, ...samples.map((s) => s.latencyMs ?? 0))}
            format={ms}
            thresholds={[{ v: 1000, label: "lento (1 s)" }]}
          />
        </div>
      </div>
    </div>
  );
}

function Meter({ value, marks }: { value: number; marks: number[] }) {
  const tone =
    value >= marks[2]! ? "bg-red-500" : value >= marks[0]! ? "bg-amber-500" : "bg-brand-500";
  return (
    <div
      className="relative h-3 rounded-full bg-slate-100"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-label="Uso do disco"
    >
      <div className={`h-3 rounded-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} />
      {marks.map((m) => (
        <span
          key={m}
          className="absolute -top-0.5 h-4 w-0.5 bg-slate-500"
          style={{ left: `${m}%` }}
          title={`${m}%`}
        />
      ))}
    </div>
  );
}

function QuotaBar({ used, quota }: { used: number; quota: number }) {
  const p = (used / quota) * 100;
  return (
    <div className="min-w-40">
      <div className="mb-0.5 text-xs">
        {fmtBytes(used)} de {fmtBytes(quota)} ({pct(p)})
      </div>
      <div className="h-1.5 rounded-full bg-slate-100">
        <div
          className={`h-1.5 rounded-full ${p >= 100 ? "bg-red-500" : p >= 90 ? "bg-amber-500" : "bg-brand-500"}`}
          style={{ width: `${Math.min(100, p)}%` }}
        />
      </div>
    </div>
  );
}

function Stat({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="font-medium text-slate-800">{v}</dd>
      {hint && <dd className="text-[11px] text-muted">{hint}</dd>}
    </div>
  );
}

function PurgeSettings({
  settings,
  canEdit,
  onSaved,
}: {
  settings: StorageData["settings"];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(settings.emergencyPurge);
  const [minAge, setMinAge] = useState(String(settings.purgeMinAgeMinutes));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEnabled(settings.emergencyPurge);
    setMinAge(String(settings.purgeMinAgeMinutes));
  }, [settings.emergencyPurge, settings.purgeMinAgeMinutes]);

  async function save() {
    setBusy(true);
    try {
      await api.put("/storage/settings", {
        emergencyPurge: enabled,
        purgeMinAgeMinutes: Number(minAge),
      });
      toast("Configuração do armazenamento salva");
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Falha ao salvar", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4" data-testid="purge-settings">
      <h2 className="text-sm font-semibold">Disco cheio (nível crítico)</h2>
      <p className="mt-1 text-sm text-muted">
        Com a limpeza de emergência ligada, ao chegar ao nível crítico o sistema apaga as gravações
        mais antigas daquele disco, <strong>mesmo dentro da retenção</strong>, até voltar 5 pontos
        abaixo do crítico. As gravações mais novas que a idade mínima nunca são apagadas; se não
        houver o que apagar, a gravação para até liberar espaço. Cada limpeza gera evento, alerta e
        registro na auditoria.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canEdit}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4"
          />
          Limpeza de emergência ligada
        </label>
        <Field label="Idade mínima protegida (minutos)" className="w-56">
          <input
            className="input h-9"
            type="number"
            min={0}
            max={10080}
            value={minAge}
            disabled={!canEdit}
            onChange={(e) => setMinAge(e.target.value)}
          />
        </Field>
        {canEdit && (
          <button className="btn-primary h-9 px-4" onClick={() => void save()} disabled={busy}>
            Salvar
          </button>
        )}
      </div>
    </div>
  );
}

function EditNode({
  node,
  onClose,
  onSaved,
}: {
  node: StorageNode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    warnPct: String(node.warnPct),
    highPct: String(node.highPct),
    criticalPct: String(node.criticalPct),
    quotaGb: node.quotaBytes ? String(Math.round((node.quotaBytes / GB) * 10) / 10) : "",
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/storage/nodes/${node.id}`, {
        warnPct: Number(form.warnPct),
        highPct: Number(form.highPct),
        criticalPct: Number(form.criticalPct),
        quotaGb: form.quotaGb.trim() === "" ? null : Number(form.quotaGb.replace(",", ".")),
      });
      toast("Limites salvos");
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open
      title={`Limites do disco ${node.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={busy}>
            Salvar
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="grid grid-cols-3 gap-3">
        <Field label="Atenção (%)">
          <input className="input" type="number" value={form.warnPct} onChange={set("warnPct")} />
        </Field>
        <Field label="Alto (%)">
          <input className="input" type="number" value={form.highPct} onChange={set("highPct")} />
        </Field>
        <Field label="Crítico (%)">
          <input
            className="input"
            type="number"
            value={form.criticalPct}
            onChange={set("criticalPct")}
          />
        </Field>
      </div>
      <Field
        label="Cota de vídeo do disco (GB)"
        hint="Vazio = usa o disco inteiro. Com cota, vale o maior entre o uso do disco e o gravado ÷ cota."
        className="mt-3"
      >
        <input
          className="input"
          inputMode="decimal"
          value={form.quotaGb}
          onChange={set("quotaGb")}
        />
      </Field>
    </Modal>
  );
}
