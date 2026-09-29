"use client";

import { HardDrive, MonitorSmartphone, Siren } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { LineChart } from "@/components/line-chart";
import { Badge, ErrorBox } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { EVENT_LABELS, SEVERITY, fmtBytes, fmtRelative } from "@/lib/format";

/** Parte da Fase 7 do Dashboard: gráficos de 24 h, alertas, eventos, disco e acessos. */

interface Dash {
  cameras: { total: number; online: number; recording: number; offline: number; waiting: number };
  samples: Array<{
    at: string;
    cameras: number;
    online: number;
    recording: number;
    offline: number;
    ingressBps: number | null;
  }>;
  alerts: Array<{ id: string; severity: string; title: string; openedAt: string; status: string }>;
  events: Array<{
    id: string;
    type: string;
    severity: string;
    message: string | null;
    occurredAt: string;
    cameraCode: string | null;
  }>;
  usersOnline: { web: number; app: number };
  tenants?: number;
  storage?: Array<{
    name: string;
    status: string;
    usedPct: number | null;
    freeBytes: number | null;
    writeLatencyMs: number | null;
    recordingBlocked: boolean;
  }>;
}

const mbps = (bps: number) =>
  `${(bps / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} Mb/s`;

export function Monitor() {
  const auth = useAuth();
  const [d, setD] = useState<Dash | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setD(await api.get<Dash>("/dashboard"));
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

  if (!d) return <div className="mt-5">{error ? <ErrorBox error={error} /> : null}</div>;

  const pts = d.samples.map((s) => ({ t: Date.parse(s.at), s }));
  const camMax = Math.max(1, d.cameras.total, ...d.samples.map((s) => s.cameras));
  const ingMax = Math.max(1e6, ...d.samples.map((s) => s.ingressBps ?? 0)) * 1.2;

  return (
    <div className="mt-5 space-y-5" data-testid="dashboard-monitor">
      {d.samples.length > 0 && (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold">Câmeras online — últimas 24 h</h2>
            <LineChart
              label="Câmeras online nas últimas 24 horas"
              points={pts.map((p) => ({ t: p.t, v: p.s.online }))}
              yMax={camMax}
              format={(v) => String(Math.round(v))}
              testId="chart-online"
            />
          </section>
          <section className="card p-4">
            <h2 className="mb-2 text-sm font-semibold">Tráfego de entrada — últimas 24 h</h2>
            <LineChart
              label="Tráfego de entrada das câmeras nas últimas 24 horas"
              points={pts.map((p) => ({ t: p.t, v: p.s.ingressBps }))}
              yMax={ingMax}
              format={mbps}
              testId="chart-ingress"
            />
          </section>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <section className="card p-4" data-testid="dash-alerts">
          <div className="mb-2 flex items-center gap-2">
            <Siren size={16} className="text-red-600" />
            <h2 className="text-sm font-semibold">Alertas ativos</h2>
            <Link href="/eventos" className="ml-auto text-xs text-brand-600 hover:underline">
              Ver todos
            </Link>
          </div>
          {d.alerts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nenhum alerta ativo.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2 py-2 text-sm">
                  <Badge tone={SEVERITY[a.severity]?.tone ?? "slate"} dot>
                    {SEVERITY[a.severity]?.label ?? a.severity}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    {a.title}
                    <span className="block text-xs text-muted">
                      {fmtRelative(a.openedAt)}
                      {a.status === "acknowledged" ? " · reconhecido" : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card p-4" data-testid="dash-events">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Últimos eventos</h2>
            <Link href="/eventos" className="ml-auto text-xs text-brand-600 hover:underline">
              Ver todos
            </Link>
          </div>
          {d.events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nenhum evento.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.events.map((e) => (
                <li key={e.id} className="py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        e.severity === "critical" || e.severity === "error"
                          ? "bg-red-500"
                          : e.severity === "warning"
                            ? "bg-amber-500"
                            : "bg-brand-500"
                      }`}
                    />
                    <span className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</span>
                    {e.cameraCode && <span className="text-xs text-muted">{e.cameraCode}</span>}
                    <span className="ml-auto shrink-0 text-xs text-muted">
                      {fmtRelative(e.occurredAt)}
                    </span>
                  </div>
                  {e.message && <div className="ml-4 truncate text-xs text-muted">{e.message}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-5">
          {d.storage && d.storage.length > 0 && (
            <section className="card p-4" data-testid="dash-storage">
              <div className="mb-2 flex items-center gap-2">
                <HardDrive size={16} className="text-brand-600" />
                <h2 className="text-sm font-semibold">Disco de vídeo</h2>
                <Link
                  href="/armazenamento"
                  className="ml-auto text-xs text-brand-600 hover:underline"
                >
                  Detalhes
                </Link>
              </div>
              {d.storage.map((s) => {
                const p = s.usedPct ?? 0;
                const bar =
                  p >= 95
                    ? "bg-red-600"
                    : p >= 85
                      ? "bg-orange-500"
                      : p >= 70
                        ? "bg-amber-500"
                        : "bg-green-600";
                return (
                  <div key={s.name} className="mb-2 text-sm">
                    <div className="flex justify-between">
                      <span>{s.name}</span>
                      <span className="font-medium">
                        {s.usedPct === null
                          ? "—"
                          : `${p.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full ${bar}`} style={{ width: `${Math.min(100, p)}%` }} />
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {s.freeBytes !== null ? `${fmtBytes(s.freeBytes)} livres` : ""}
                      {s.writeLatencyMs !== null ? ` · escrita ${s.writeLatencyMs} ms` : ""}
                      {s.recordingBlocked && (
                        <span className="text-red-700"> · gravação bloqueada</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
          {auth.can("users.read") && (
            <section className="card p-4" data-testid="dash-users">
              <div className="mb-2 flex items-center gap-2">
                <MonitorSmartphone size={16} className="text-violet-600" />
                <h2 className="text-sm font-semibold">Usuários conectados</h2>
              </div>
              <div className="grid grid-cols-2 gap-3 text-center">
                <div>
                  <div className="text-2xl font-semibold">{d.usersOnline.web}</div>
                  <div className="text-xs text-muted">no painel web</div>
                </div>
                <div>
                  <div className="text-2xl font-semibold">{d.usersOnline.app}</div>
                  <div className="text-xs text-muted">no aplicativo</div>
                </div>
              </div>
              <p className="mt-2 text-xs text-muted">Ativos nos últimos 15 minutos.</p>
            </section>
          )}
        </div>
      </div>
      <p className="text-xs text-muted">
        {d.cameras.recording} câmera(s) gravando agora · {d.cameras.waiting} aguardando transmissão.
        Gráficos com uma amostra a cada 5 minutos.
      </p>
    </div>
  );
}
