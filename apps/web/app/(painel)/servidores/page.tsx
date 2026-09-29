"use client";

import { Activity, CheckCircle2, Cpu, HardDrive, MemoryStick, Server, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, ErrorBox, Loading, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtBytes, fmtDateTime, fmtRelative, type Tone } from "@/lib/format";

interface HostMetrics {
  at: string;
  cpu_pct: number | null;
  cpus: number;
  load1: number;
  load5: number;
  mem_total: number;
  mem_available: number;
  uptime_s: number;
  io_pressure: { some10: number; full10: number; some300: number; full300: number } | null;
  cpu_pressure: { some10: number; some300: number } | null;
  system_disk: { total: number; free: number; pct: number };
  services: Record<string, "ok" | "fail">;
}
interface IngestNode {
  id: string;
  name: string;
  publicHost: string;
  rtmpPort: number;
  capacityStreams: number;
  status: "online" | "offline" | "degraded" | "maintenance";
  lastSeenAt: string | null;
  metrics: { paths_ready?: number; bytes_received_total?: number; host?: HostMetrics };
  camerasOnline: number;
  camerasRecording: number;
  camerasEnabled: number;
}
interface AlertRow {
  id: string;
  rule: string;
  severity: "info" | "warning" | "error" | "critical";
  title: string;
  openedAt: string;
}

const STATUS: Record<IngestNode["status"], { label: string; tone: Tone }> = {
  online: { label: "Online", tone: "green" },
  offline: { label: "Offline", tone: "red" },
  degraded: { label: "Degradado", tone: "amber" },
  maintenance: { label: "Manutenção", tone: "slate" },
};
const SERVICE_LABEL: Record<string, string> = {
  api: "API",
  worker: "Worker",
  database: "Banco de dados",
  redis: "Redis",
  mediamtx: "Servidor de mídia",
};

const num = (v: number, d = 1) => v.toFixed(d).replace(".", ",");
function uptime(s: number) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d} d ${h} h` : `${h} h ${Math.floor((s % 3600) / 60)} min`;
}

export default function Page() {
  const [data, setData] = useState<{ items: IngestNode[]; alerts: AlertRow[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get("/servers"));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div>
      <PageHeader title="Servidores" subtitle="Servidor de mídia, recursos da máquina e serviços" />
      <ErrorBox error={error} />
      {!data ? (
        <div className="card">
          <Loading />
        </div>
      ) : (
        <div className="space-y-4">
          {data.alerts.length > 0 && (
            <div className="card divide-y divide-line">
              {data.alerts.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                  <Badge tone={a.severity === "warning" ? "amber" : "red"} dot>
                    {a.severity === "warning"
                      ? "Atenção"
                      : a.severity === "critical"
                        ? "Crítico"
                        : "Erro"}
                  </Badge>
                  <span className="font-medium">{a.title}</span>
                  <span className="ml-auto text-xs text-muted">
                    desde {fmtDateTime(a.openedAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
          {data.items.map((n) => (
            <NodeCard key={n.id} node={n} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({ node: n }: { node: IngestNode }) {
  const h = n.metrics.host;
  const st = STATUS[n.status] ?? STATUS.offline;
  const memUsed = h ? h.mem_total - h.mem_available : 0;
  const memPct = h && h.mem_total ? (memUsed / h.mem_total) * 100 : 0;
  const io = h?.io_pressure;
  const ioTone: Tone = !io
    ? "slate"
    : io.full10 >= 10 || io.full300 >= 5
      ? "red"
      : io.full10 >= 2
        ? "amber"
        : "green";
  return (
    <div className="card p-4" data-testid="server-node">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
          <Server size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-semibold">Servidor de mídia · {n.name}</h2>
            <Badge tone={st.tone} dot>
              {st.label}
            </Badge>
          </div>
          <p className="text-xs text-muted">
            rtmp://{n.publicHost}:{n.rtmpPort} · última resposta {fmtRelative(n.lastSeenAt)}
            {h && ` · ligado há ${uptime(h.uptime_s)}`}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          icon={<Activity size={15} />}
          k="Câmeras"
          v={`${n.camerasOnline} no ar`}
          hint={`${n.camerasRecording} gravando · ${n.camerasEnabled} ativas · capacidade ${n.capacityStreams}`}
        />
        <Tile
          icon={<Cpu size={15} />}
          k="CPU"
          v={h?.cpu_pct !== null && h?.cpu_pct !== undefined ? `${num(h.cpu_pct)}%` : "—"}
          hint={h ? `${h.cpus} núcleos · carga ${num(h.load1, 2)} / ${num(h.load5, 2)}` : undefined}
        />
        <Tile
          icon={<MemoryStick size={15} />}
          k="Memória"
          v={h ? `${num(memPct, 0)}%` : "—"}
          hint={
            h ? `${fmtBytes(memUsed)} de ${fmtBytes(h.mem_total)} (sem contar cache)` : undefined
          }
        />
        <Tile
          icon={<HardDrive size={15} />}
          k="Disco do sistema"
          v={h ? `${num(h.system_disk.pct)}%` : "—"}
          hint={
            h
              ? `livre ${fmtBytes(h.system_disk.free)} de ${fmtBytes(h.system_disk.total)}`
              : undefined
          }
          tone={h && h.system_disk.pct >= 85 ? "red" : undefined}
        />
        <Tile
          icon={<HardDrive size={15} />}
          k="Espera por disco (IO)"
          v={io ? `${num(io.full10)}%` : "—"}
          hint={
            io
              ? `tempo com tudo parado esperando o disco · média 5 min ${num(io.full300)}%`
              : "kernel sem PSI"
          }
          tone={ioTone === "red" ? "red" : ioTone === "amber" ? "amber" : undefined}
        />
        <Tile
          icon={<Activity size={15} />}
          k="Transmissões no servidor"
          v={String(n.metrics.paths_ready ?? "—")}
          hint="caminhos prontos no servidor de mídia"
        />
      </div>

      {h && (
        <div className="mt-4">
          <h3 className="mb-2 text-xs font-medium text-muted">Serviços</h3>
          <ul className="flex flex-wrap gap-2" data-testid="services">
            {Object.entries(h.services).map(([k, v]) => (
              <li
                key={k}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${
                  v === "ok"
                    ? "bg-green-50 text-green-800 ring-green-200"
                    : "bg-red-50 text-red-800 ring-red-200"
                }`}
              >
                {v === "ok" ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {SERVICE_LABEL[k] ?? k}: {v === "ok" ? "ok" : "falha"}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">
            Medido em {fmtDateTime(h.at)} (a cada 30 s).
          </p>
        </div>
      )}
    </div>
  );
}

function Tile({
  icon,
  k,
  v,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  k: string;
  v: string;
  hint?: string;
  tone?: "red" | "amber";
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        tone === "red"
          ? "border-red-200 bg-red-50/50"
          : tone === "amber"
            ? "border-amber-200 bg-amber-50/50"
            : "border-line"
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {k}
      </div>
      <div className="mt-1 text-lg font-semibold text-ink">{v}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
