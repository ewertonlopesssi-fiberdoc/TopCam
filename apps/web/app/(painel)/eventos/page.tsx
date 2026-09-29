"use client";

import { Check, CheckCheck, ChevronDown, ChevronRight, Search, Siren } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Badge,
  Confirm,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  Pagination,
  useToast,
} from "@/components/ui";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  ALERT_RULES,
  ALERT_STATUS,
  EVENT_LABELS,
  SEVERITY,
  fmtDateTime,
  fmtRelative,
  zonedToMs,
} from "@/lib/format";

interface Alert {
  id: string;
  rule: string;
  severity: string;
  title: string;
  details: Record<string, unknown>;
  status: string;
  openedAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  notifiedAt: string | null;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  tenantName: string | null;
  cameraCode: string | null;
  cameraName: string | null;
}
interface Ev {
  id: string;
  type: string;
  severity: string;
  message: string | null;
  data: Record<string, unknown>;
  occurredAt: string;
  tenantName: string | null;
  cameraCode: string | null;
  cameraName: string | null;
}
type Tenant = { id: string; name: string };

export default function EventosPage() {
  const auth = useAuth();
  const [tab, setTab] = useState<"alerts" | "events">("alerts");
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState("");

  useEffect(() => {
    if (!auth.isPlatform) return;
    api
      .get<Page<Tenant>>("/tenants?pageSize=100")
      .then((r) => setTenants(r.items))
      .catch(() => {});
  }, [auth.isPlatform]);

  return (
    <>
      <PageHeader
        title="Eventos e Alertas"
        subtitle="Quedas, recusas de chave, falhas de gravação e de disco. Alertas ficam abertos até o problema acabar."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="tablist" className="inline-flex rounded-lg border border-line bg-white p-1">
          {(
            [
              ["alerts", "Alertas"],
              ["events", "Eventos"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              className={`rounded-md px-4 py-1.5 text-sm font-medium ${tab === k ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}
              onClick={() => setTab(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {auth.isPlatform && (
          <select
            className="input ml-auto h-9 w-56"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            aria-label="Cliente"
          >
            <option value="">Todos os clientes</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {tab === "alerts" ? <AlertsTab tenantId={tenantId} /> : <EventsTab tenantId={tenantId} />}
    </>
  );
}

function where(x: {
  tenantName: string | null;
  cameraCode: string | null;
  cameraName: string | null;
}) {
  const cam = x.cameraCode ? `${x.cameraCode}${x.cameraName ? ` · ${x.cameraName}` : ""}` : null;
  return [cam, x.tenantName].filter(Boolean).join(" — ") || "Sistema";
}

// ------------------------------------------------------------------ alertas
function AlertsTab({ tenantId }: { tenantId: string }) {
  const auth = useAuth();
  const toast = useToast();
  const canWrite = auth.can("alerts.write");
  const [status, setStatus] = useState("active");
  const [severity, setSeverity] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Alert> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [resolving, setResolving] = useState<Alert | null>(null);

  const load = useCallback(async () => {
    try {
      setData(
        await api.get<Page<Alert>>(
          `/alerts${qs({ status, severity: severity || undefined, tenantId: tenantId || undefined, page, pageSize: 20 })}`,
        ),
      );
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [status, severity, tenantId, page]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function ack(a: Alert) {
    try {
      await api.post(`/alerts/${a.id}/ack`);
      toast("Alerta reconhecido");
      await load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="card" data-testid="alerts">
      <div className="flex flex-wrap gap-2 border-b border-line p-4">
        <select
          className="input h-9 w-48"
          value={status}
          onChange={(e) => (setStatus(e.target.value), setPage(1))}
          aria-label="Situação"
        >
          <option value="active">Ativos (abertos e reconhecidos)</option>
          <option value="open">Abertos</option>
          <option value="acknowledged">Reconhecidos</option>
          <option value="resolved">Resolvidos</option>
          <option value="all">Todos</option>
        </select>
        <select
          className="input h-9 w-40"
          value={severity}
          onChange={(e) => (setSeverity(e.target.value), setPage(1))}
          aria-label="Gravidade"
        >
          <option value="">Todas as gravidades</option>
          <option value="critical">Crítico</option>
          <option value="error">Erro</option>
          <option value="warning">Atenção</option>
          <option value="info">Informação</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty
          icon={<Siren size={40} />}
          title={status === "active" ? "Nenhum alerta ativo" : "Nenhum alerta encontrado"}
        />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {data.items.map((a) => (
              <Fragment key={a.id}>
                <li className="flex flex-wrap items-start gap-3 px-4 py-3">
                  <button
                    className="mt-0.5 text-slate-400"
                    onClick={() => setOpen(open === a.id ? null : a.id)}
                    aria-label="Detalhes"
                  >
                    {open === a.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={SEVERITY[a.severity]?.tone ?? "slate"} dot>
                        {SEVERITY[a.severity]?.label ?? a.severity}
                      </Badge>
                      <span className="font-medium">{a.title}</span>
                      <Badge tone={ALERT_STATUS[a.status]?.tone ?? "slate"}>
                        {ALERT_STATUS[a.status]?.label ?? a.status}
                      </Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {ALERT_RULES[a.rule] ?? a.rule} · {where(a)} · aberto{" "}
                      {fmtRelative(a.openedAt)} ({fmtDateTime(a.openedAt)})
                      {a.resolvedAt && ` · resolvido ${fmtDateTime(a.resolvedAt)}`}
                    </div>
                  </div>
                  {canWrite && a.status !== "resolved" && (
                    <div className="flex gap-2">
                      {a.status === "open" && (
                        <button
                          className="btn-secondary h-8 px-3 text-xs"
                          onClick={() => void ack(a)}
                        >
                          <Check size={14} /> Reconhecer
                        </button>
                      )}
                      <button
                        className="btn-secondary h-8 px-3 text-xs"
                        onClick={() => setResolving(a)}
                      >
                        <CheckCheck size={14} /> Resolver
                      </button>
                    </div>
                  )}
                </li>
                {open === a.id && (
                  <li className="bg-slate-50 px-4 py-3 text-xs">
                    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                      <div>
                        <dt className="inline text-muted">Última atualização: </dt>
                        <dd className="inline">{fmtDateTime(a.updatedAt)}</dd>
                      </div>
                      <div>
                        <dt className="inline text-muted">Aviso por e-mail: </dt>
                        <dd className="inline">
                          {a.notifiedAt ? fmtDateTime(a.notifiedAt) : "não enviado"}
                        </dd>
                      </div>
                      {a.acknowledgedAt && (
                        <div>
                          <dt className="inline text-muted">Reconhecido: </dt>
                          <dd className="inline">
                            {fmtDateTime(a.acknowledgedAt)}
                            {a.acknowledgedBy ? ` por ${a.acknowledgedBy}` : ""}
                          </dd>
                        </div>
                      )}
                      {a.resolvedAt && (
                        <div>
                          <dt className="inline text-muted">Resolvido: </dt>
                          <dd className="inline">
                            {fmtDateTime(a.resolvedAt)}
                            {a.resolvedBy ? ` por ${a.resolvedBy}` : " automaticamente"}
                          </dd>
                        </div>
                      )}
                    </dl>
                    {Object.keys(a.details ?? {}).length > 0 && (
                      <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3">
                        {JSON.stringify(a.details, null, 2)}
                      </pre>
                    )}
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            pageSize={data.pageSize}
            onPage={setPage}
          />
        </>
      )}
      <Confirm
        open={!!resolving}
        title="Resolver alerta"
        message={
          <>
            Marcar <strong>{resolving?.title}</strong> como resolvido? Se o problema continuar, o
            sistema abre um novo alerta no próximo ciclo.
          </>
        }
        confirmLabel="Resolver"
        onClose={() => setResolving(null)}
        onConfirm={async () => {
          try {
            await api.post(`/alerts/${resolving!.id}/resolve`);
            toast("Alerta resolvido");
          } catch (err) {
            setError(err);
          }
          setResolving(null);
          await load();
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ eventos
function EventsTab({ tenantId }: { tenantId: string }) {
  const auth = useAuth();
  const [type, setType] = useState("");
  const [severity, setSeverity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<Ev> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(
        await api.get<Page<Ev>>(
          `/events${qs({
            type: type || undefined,
            severity: severity || undefined,
            tenantId: tenantId || undefined,
            from: from ? new Date(zonedToMs(`${from}T00:00`)).toISOString() : undefined,
            to: to ? new Date(zonedToMs(`${to}T00:00`) + 86400_000).toISOString() : undefined,
            q: q || undefined,
            page,
            pageSize: 25,
          })}`,
        ),
      );
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [type, severity, tenantId, from, to, q, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const reset =
    <T,>(fn: (v: T) => void) =>
    (v: T) => (fn(v), setPage(1));

  return (
    <div className="card" data-testid="events">
      <div className="flex flex-wrap gap-2 border-b border-line p-4">
        <div className="relative w-full max-w-xs">
          <Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input h-9 pl-9"
            placeholder="Pesquisar mensagem ou câmera…"
            value={q}
            onChange={(e) => reset(setQ)(e.target.value)}
          />
        </div>
        <select
          className="input h-9 w-52"
          value={type}
          onChange={(e) => reset(setType)(e.target.value)}
          aria-label="Tipo"
        >
          <option value="">Todos os tipos</option>
          {Object.entries(EVENT_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          className="input h-9 w-40"
          value={severity}
          onChange={(e) => reset(setSeverity)(e.target.value)}
          aria-label="Gravidade"
        >
          <option value="">Todas as gravidades</option>
          <option value="critical">Crítico</option>
          <option value="error">Erro</option>
          <option value="warning">Atenção</option>
          <option value="info">Informação</option>
        </select>
        <input
          type="date"
          className="input h-9 w-40"
          value={from}
          onChange={(e) => reset(setFrom)(e.target.value)}
          aria-label="De"
        />
        <input
          type="date"
          className="input h-9 w-40"
          value={to}
          onChange={(e) => reset(setTo)(e.target.value)}
          aria-label="Até"
        />
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty icon={<Siren size={40} />} title="Nenhum evento encontrado" />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-line">
              <thead className="bg-slate-50/60">
                <tr>
                  <th className="th w-8" />
                  <th className="th">Data/Hora</th>
                  <th className="th">Gravidade</th>
                  <th className="th">Evento</th>
                  <th className="th">Câmera</th>
                  {auth.isPlatform && <th className="th hidden md:table-cell">Cliente</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.items.map((e) => (
                  <Fragment key={e.id}>
                    <tr
                      className="cursor-pointer hover:bg-slate-50/60"
                      onClick={() => setOpen(open === e.id ? null : e.id)}
                    >
                      <td className="td text-slate-400">
                        {open === e.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </td>
                      <td className="td whitespace-nowrap">{fmtDateTime(e.occurredAt)}</td>
                      <td className="td">
                        <Badge tone={SEVERITY[e.severity]?.tone ?? "slate"} dot>
                          {SEVERITY[e.severity]?.label ?? e.severity}
                        </Badge>
                      </td>
                      <td className="td">
                        <div className="font-medium">{EVENT_LABELS[e.type] ?? e.type}</div>
                        {e.message && <div className="text-xs text-muted">{e.message}</div>}
                      </td>
                      <td className="td">{e.cameraCode ?? "—"}</td>
                      {auth.isPlatform && (
                        <td className="td hidden md:table-cell">{e.tenantName ?? "—"}</td>
                      )}
                    </tr>
                    {open === e.id && (
                      <tr className="bg-slate-50">
                        <td />
                        <td colSpan={auth.isPlatform ? 5 : 4} className="px-4 py-3">
                          <div className="mb-1 text-xs text-muted">
                            {e.type}
                            {e.cameraName ? ` · ${e.cameraName}` : ""}
                          </div>
                          <pre className="overflow-x-auto rounded-lg bg-white p-3 text-xs">
                            {JSON.stringify(e.data, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            pageSize={data.pageSize}
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
