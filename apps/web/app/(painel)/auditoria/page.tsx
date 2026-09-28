"use client";

import { ChevronDown, ChevronRight, ClipboardList, Search } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Empty, ErrorBox, Loading, PageHeader, Pagination } from "@/components/ui";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { AUDIT_LABELS, fmtDateTime } from "@/lib/format";

interface Entry {
  id: string;
  createdAt: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  tenantName: string | null;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  ip: string | null;
  data: Record<string, unknown>;
}

export default function AuditoriaPage() {
  const auth = useAuth();
  const [data, setData] = useState<Page<Entry> | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Page<Entry>>(`/audit-logs${qs({ search, page, pageSize: 20 })}`));
    } catch (err) {
      setError(err);
    }
  }, [search, page]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <>
      <PageHeader
        title="Auditoria"
        subtitle="Registro de todas as ações feitas no sistema. Os registros não podem ser alterados nem apagados."
      />
      <ErrorBox error={error} />
      <div className="card">
        <div className="border-b border-line p-4">
          <div className="relative max-w-sm">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <input
              className="input pl-9"
              placeholder="Pesquisar ação, usuário ou cliente…"
              value={search}
              onChange={(e) => (setSearch(e.target.value), setPage(1))}
            />
          </div>
        </div>
        {!data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <Empty icon={<ClipboardList size={40} />} title="Nenhum registro encontrado" />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-line">
                <thead className="bg-slate-50/60">
                  <tr>
                    <th className="th w-8" />
                    <th className="th">Data/Hora</th>
                    <th className="th">Ação</th>
                    <th className="th">Usuário</th>
                    {auth.isPlatform && <th className="th">Cliente</th>}
                    <th className="th hidden md:table-cell">IP</th>
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
                        <td className="td">{fmtDateTime(e.createdAt)}</td>
                        <td className="td">
                          <span
                            className={
                              e.action.includes("failed") || e.action.includes("reuse")
                                ? "text-red-600"
                                : ""
                            }
                          >
                            {AUDIT_LABELS[e.action] ?? e.action}
                          </span>
                        </td>
                        <td className="td">
                          {e.actorName ??
                            (e.actorType === "cli"
                              ? "Linha de comando"
                              : e.actorType === "system"
                                ? "Sistema"
                                : "—")}
                        </td>
                        {auth.isPlatform && <td className="td">{e.tenantName ?? "—"}</td>}
                        <td className="td hidden font-mono text-xs md:table-cell">{e.ip ?? "—"}</td>
                      </tr>
                      {open === e.id && (
                        <tr className="bg-slate-50">
                          <td />
                          <td colSpan={auth.isPlatform ? 5 : 4} className="px-4 py-3">
                            <div className="mb-1 text-xs text-muted">
                              {e.action} · {e.entityType ?? ""} {e.entityId ?? ""}{" "}
                              {e.actorEmail ? `· ${e.actorEmail}` : ""}
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
    </>
  );
}
