"use client";

import { BarChart3, Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty, ErrorBox, Field, Loading, PageHeader } from "@/components/ui";
import { api, fetchBlob, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { dayOf, fmtBytes, fmtDuration, zonedToMs } from "@/lib/format";

interface Row {
  cameraId: string;
  code: string;
  name: string;
  tenantName: string;
  recordingEnabled: boolean;
  observedS: number;
  onlineS: number;
  recordingS: number;
  offlineEvents: number;
  gaps: number;
  gapSeconds: number;
  recordedBytes: number;
  availabilityPct: number | null;
  recordingPct: number | null;
}
type Tenant = { id: string; name: string };

const DAY = 86400_000;
const PRESETS: Array<[string, number]> = [
  ["Hoje", 0],
  ["Últimos 7 dias", 6],
  ["Últimos 30 dias", 29],
];

function pctTone(v: number | null) {
  if (v === null) return "text-muted";
  if (v >= 99) return "text-green-700";
  if (v >= 95) return "text-amber-700";
  return "text-red-700";
}
const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("pt-BR")}%`);

export default function RelatoriosPage() {
  const auth = useAuth();
  const today = dayOf(Date.now());
  const [from, setFrom] = useState(dayOf(Date.now() - 6 * DAY));
  const [to, setTo] = useState(today);
  const [tenantId, setTenantId] = useState("");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!auth.isPlatform) return;
    api
      .get<Page<Tenant>>("/tenants?pageSize=100")
      .then((r) => setTenants(r.items))
      .catch(() => {});
  }, [auth.isPlatform]);

  // Dias inteiros no fuso de São Paulo; "até" inclui o dia (limitado a agora).
  const params = useMemo(() => {
    const f = zonedToMs(`${from}T00:00`);
    const t = Math.min(zonedToMs(`${to}T00:00`) + DAY, Date.now());
    return {
      from: new Date(f).toISOString(),
      to: new Date(t).toISOString(),
      tenantId: tenantId || undefined,
    };
  }, [from, to, tenantId]);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const r = await api.get<{ items: Row[] }>(`/reports/availability${qs(params)}`);
      setRows(r.items);
      setError(null);
    } catch (err) {
      setError(err);
      setRows([]);
    }
  }, [params]);
  useEffect(() => {
    void load();
  }, [load]);

  async function csv() {
    setDownloading(true);
    try {
      const blob = await fetchBlob(`/reports/availability${qs({ ...params, format: "csv" })}`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `disponibilidade_${from}_${to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError(err);
    } finally {
      setDownloading(false);
    }
  }

  const total = useMemo(() => {
    if (!rows?.length) return null;
    const obs = rows.reduce((a, r) => a + r.observedS, 0);
    const on = rows.reduce((a, r) => a + r.onlineS, 0);
    return {
      availability: obs ? Math.round((on / obs) * 1000) / 10 : null,
      drops: rows.reduce((a, r) => a + r.offlineEvents, 0),
      gaps: rows.reduce((a, r) => a + r.gaps, 0),
      bytes: rows.reduce((a, r) => a + r.recordedBytes, 0),
    };
  }, [rows]);

  return (
    <>
      <PageHeader
        title="Relatórios"
        subtitle="Disponibilidade e gravação por câmera no período. Medido pelo servidor a cada 10 s."
      />
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="De" className="w-40">
          <input
            type="date"
            className="input"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="Até" className="w-40">
          <input
            type="date"
            className="input"
            value={to}
            min={from}
            max={today}
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        <div className="flex gap-1 pb-0.5">
          {PRESETS.map(([label, back]) => (
            <button
              key={label}
              className="btn-secondary h-9 px-3 text-xs"
              onClick={() => (setFrom(dayOf(Date.now() - back * DAY)), setTo(today))}
            >
              {label}
            </button>
          ))}
        </div>
        {auth.isPlatform && (
          <Field label="Cliente" className="w-56">
            <select
              className="input"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            >
              <option value="">Todos os clientes</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <button
          className="btn-primary ml-auto"
          disabled={downloading || !rows?.length}
          onClick={() => void csv()}
        >
          {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}{" "}
          Baixar CSV
        </button>
      </div>
      <ErrorBox error={error} />

      {total && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            ["Disponibilidade média", pct(total.availability)],
            ["Quedas", String(total.drops)],
            ["Lacunas na gravação", String(total.gaps)],
            ["Gravado no período", fmtBytes(total.bytes)],
          ].map(([l, v]) => (
            <div key={l} className="card p-4">
              <div className="text-xs font-medium text-muted">{l}</div>
              <div className="text-xl font-semibold">{v}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card" data-testid="availability">
        {!rows ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty icon={<BarChart3 size={40} />} title="Nenhuma câmera no período" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-line">
              <thead className="bg-slate-50/60">
                <tr>
                  {auth.isPlatform && <th className="th">Cliente</th>}
                  <th className="th">Câmera</th>
                  <th className="th text-right">Disponibilidade</th>
                  <th className="th text-right">No ar</th>
                  <th className="th text-right">Gravação</th>
                  <th className="th text-right">Quedas</th>
                  <th className="th text-right">Lacunas</th>
                  <th className="th text-right">Gravado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.cameraId}>
                    {auth.isPlatform && <td className="td">{r.tenantName}</td>}
                    <td className="td">
                      <div className="font-medium">{r.code}</div>
                      <div className="text-xs text-muted">{r.name}</div>
                    </td>
                    <td className={`td text-right font-semibold ${pctTone(r.availabilityPct)}`}>
                      {pct(r.availabilityPct)}
                    </td>
                    <td className="td text-right text-sm">
                      {r.observedS ? fmtDuration(r.onlineS) : "—"}
                      {r.observedS > 0 && (
                        <div className="text-xs text-muted">de {fmtDuration(r.observedS)}</div>
                      )}
                    </td>
                    <td className={`td text-right ${pctTone(r.recordingPct)}`}>
                      {r.recordingEnabled ? (
                        pct(r.recordingPct)
                      ) : (
                        <span className="text-muted">não grava</span>
                      )}
                    </td>
                    <td className="td text-right">{r.offlineEvents}</td>
                    <td className="td text-right">
                      {r.gaps}
                      {r.gapSeconds > 0 && (
                        <div className="text-xs text-muted">{fmtDuration(r.gapSeconds)}</div>
                      )}
                    </td>
                    <td className="td text-right">
                      {r.recordedBytes ? fmtBytes(r.recordedBytes) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        Disponibilidade = tempo com a câmera no ar ÷ tempo observado pelo servidor. O histórico
        começa na instalação da Fase 7; períodos anteriores aparecem sem dados.
      </p>
    </>
  );
}
