"use client";

import { Loader2, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Confirm, ErrorBox, Field, Modal, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtRelative } from "@/lib/format";

interface Network {
  id: string;
  cidr: string;
  description: string;
  updatedAt: string;
}
interface FirewallInfo {
  networks: Network[];
  publicPorts: { port: string; use: string }[];
  status: {
    state: "not_installed" | "stale" | "error" | "pending" | "applied";
    appliedAt: string | null;
    checkedAt: string | null;
    error: string | null;
  };
}

const STATE: Record<
  FirewallInfo["status"]["state"],
  { label: string; tone: "green" | "amber" | "red" | "slate" }
> = {
  applied: { label: "Aplicado no servidor", tone: "green" },
  pending: { label: "Aguardando aplicação (até 1 min)", tone: "amber" },
  error: { label: "Não aplicado", tone: "red" },
  stale: { label: "Serviço do servidor parado", tone: "red" },
  not_installed: { label: "Serviço do servidor não instalado", tone: "slate" },
};

/**
 * Configurações → Firewall (Super Admin). O painel mantém a lista de redes que podem
 * acessar o SSH; o serviço do host aplica a cada minuto e devolve o status.
 */
export function FirewallCard() {
  const toast = useToast();
  const [info, setInfo] = useState<FirewallInfo | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Network | "new" | null>(null);
  const [form, setForm] = useState({ cidr: "", description: "" });
  const [formError, setFormError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Network | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await api.get<FirewallInfo>("/firewall"));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  function open(n: Network | "new") {
    setFormError(null);
    setEditing(n);
    setForm(
      n === "new" ? { cidr: "", description: "" } : { cidr: n.cidr, description: n.description },
    );
  }

  async function save() {
    setBusy(true);
    setFormError(null);
    try {
      if (editing === "new") await api.post("/firewall/ssh-networks", form);
      else if (editing) await api.patch(`/firewall/ssh-networks/${editing.id}`, form);
      toast("Rede salva. O servidor aplica em até 1 minuto.");
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  const st = info?.status;
  const only = (info?.networks.length ?? 0) <= 1;
  return (
    <section className="card" data-testid="firewall-card">
      <div className="flex flex-wrap items-start gap-3 border-b border-line p-5 pb-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-semibold">
            <ShieldCheck size={18} /> Firewall do servidor
          </h2>
          <p className="text-sm text-muted">
            Redes que podem acessar o servidor por SSH. O resto da internet só alcança as portas
            públicas do TopCam.
          </p>
        </div>
        <button className="btn-secondary h-9 px-3 text-sm" onClick={() => open("new")}>
          <Plus size={15} /> Adicionar rede
        </button>
      </div>
      <ErrorBox error={error} />
      {!info ? (
        <div className="flex items-center gap-2 p-5 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> Carregando…
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-5 pt-4 text-sm">
            <Badge tone={STATE[st!.state].tone} dot>
              {STATE[st!.state].label}
            </Badge>
            {st!.appliedAt && (
              <span className="text-xs text-muted">
                última aplicação {fmtRelative(st!.appliedAt)}
              </span>
            )}
          </div>
          {st!.state === "error" && st!.error && (
            <p className="mx-5 mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">
              {st!.error}. As regras anteriores continuam valendo.
            </p>
          )}
          {st!.state === "not_installed" && (
            <p className="mx-5 mt-2 text-xs text-muted">
              A lista fica guardada, mas só passa a valer depois de instalar o serviço no servidor (
              <code>scripts/host/topcam-host install</code>). Enquanto isso, nada é bloqueado.
            </p>
          )}
          {st!.state === "stale" && (
            <p className="mx-5 mt-2 text-xs text-muted">
              O servidor não confere a lista há alguns minutos; as últimas regras aplicadas
              continuam valendo. No servidor: <code>topcam-host status</code>.
            </p>
          )}
          <div className="overflow-x-auto p-5 pt-3">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="th">Rede (IP/máscara)</th>
                  <th className="th">Descrição</th>
                  <th className="th text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {info.networks.length === 0 && (
                  <tr>
                    <td className="td text-muted" colSpan={3}>
                      Nenhuma rede cadastrada.
                    </td>
                  </tr>
                )}
                {info.networks.map((n) => (
                  <tr key={n.id}>
                    <td className="td font-mono text-xs">{n.cidr}</td>
                    <td className="td">{n.description || <span className="text-muted">—</span>}</td>
                    <td className="td text-right">
                      <div className="inline-flex gap-1.5">
                        <button
                          className="icon-btn"
                          title="Editar"
                          aria-label={`Editar rede ${n.cidr}`}
                          onClick={() => open(n)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-btn"
                          title={only ? "A última rede não pode ser removida" : "Remover"}
                          aria-label={`Remover rede ${n.cidr}`}
                          disabled={only}
                          onClick={() => setRemoving(n)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details className="mt-4 text-sm">
              <summary className="cursor-pointer text-muted">
                Portas públicas (abertas para qualquer origem)
              </summary>
              <ul className="mt-2 space-y-1">
                {info.publicPorts.map((p) => (
                  <li key={p.port} className="flex gap-3">
                    <code className="w-28 shrink-0 font-mono text-xs">{p.port}</code>
                    <span className="text-xs text-slate-600">{p.use}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        </>
      )}

      <Modal
        open={!!editing}
        title={editing === "new" ? "Adicionar rede ao SSH" : "Editar rede"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={save} disabled={busy || !form.cidr.trim()}>
              {busy && <Loader2 size={16} className="animate-spin" />} Salvar
            </button>
          </>
        }
      >
        <ErrorBox error={formError} />
        <div className="space-y-3">
          <Field
            label="IP/máscara"
            hint="Ex.: 172.31.0.0/16 (uma faixa) ou 45.237.164.6 (um único IP). Mínimo /8."
          >
            <input
              className="input font-mono"
              value={form.cidr}
              onChange={(e) => setForm((f) => ({ ...f, cidr: e.target.value }))}
              placeholder="172.31.0.0/16"
              autoFocus
            />
          </Field>
          <Field label="Descrição">
            <input
              className="input"
              value={form.description}
              maxLength={120}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Rede interna, escritório, CGNAT…"
            />
          </Field>
          {editing !== "new" && (
            <p className="text-xs text-amber-700">
              Ao trocar a faixa, confira se a sua conexão continua dentro de alguma rede da lista
              antes de fechar a sessão SSH atual.
            </p>
          )}
        </div>
      </Modal>
      <Confirm
        open={!!removing}
        danger
        title="Remover rede do SSH"
        confirmLabel="Remover"
        message={
          <>
            A rede <b className="font-mono">{removing?.cidr}</b> perde o acesso SSH em até 1 minuto.
            Sessões já abertas continuam; novas conexões dela são recusadas.
          </>
        }
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          try {
            await api.del(`/firewall/ssh-networks/${removing!.id}`);
            toast("Rede removida");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </section>
  );
}
