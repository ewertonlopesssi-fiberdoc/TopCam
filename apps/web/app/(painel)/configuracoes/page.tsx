"use client";

import { Loader2, Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ErrorBox, Field, Modal, PageHeader, useToast } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { fmtBytes } from "@/lib/format";

interface Plan {
  code: string;
  name: string;
  maxCameras: number;
  maxStorageBytes: number;
  maxRetentionHours: number;
  tenantCount: number;
  maxCamerasInUse: number;
}

const GB = 1024 ** 3;

/** Limites dos planos (decisão D9): valores padrão editáveis pelo Super Admin. */
function PlansCard({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [form, setForm] = useState({
    name: "",
    maxCameras: "",
    maxStorageGb: "",
    maxRetentionHours: "",
  });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      setPlans((await api.get<{ items: Plan[] }>("/plans")).items);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  function open(p: Plan) {
    setFormError(null);
    setEditing(p);
    setForm({
      name: p.name,
      maxCameras: String(p.maxCameras),
      maxStorageGb: String(Math.round(p.maxStorageBytes / GB)),
      maxRetentionHours: String(p.maxRetentionHours),
    });
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setFormError(null);
    try {
      await api.patch(`/plans/${editing.code}`, {
        name: form.name,
        maxCameras: Number(form.maxCameras),
        maxStorageGb: Number(form.maxStorageGb),
        maxRetentionHours: Number(form.maxRetentionHours),
      });
      toast("Plano atualizado");
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <section className="card">
      <div className="border-b border-line p-5 pb-4">
        <h2 className="font-semibold">Planos</h2>
        <p className="text-sm text-muted">
          Limites aplicados ao cadastrar câmeras de cada cliente.
        </p>
      </div>
      <ErrorBox error={error} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="th">Plano</th>
              <th className="th">Câmeras</th>
              <th className="th hidden sm:table-cell">Armazenamento</th>
              <th className="th hidden md:table-cell">Retenção máx.</th>
              <th className="th hidden md:table-cell">Clientes</th>
              {canEdit && <th className="th text-right">Ações</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {plans?.map((p) => (
              <tr key={p.code}>
                <td className="td font-medium">{p.name}</td>
                <td className="td">{p.maxCameras}</td>
                <td className="td hidden sm:table-cell">{fmtBytes(p.maxStorageBytes)}</td>
                <td className="td hidden md:table-cell">{p.maxRetentionHours} h</td>
                <td className="td hidden md:table-cell">{p.tenantCount}</td>
                {canEdit && (
                  <td className="td text-right">
                    <button
                      className="icon-btn"
                      aria-label={`Editar plano ${p.name}`}
                      onClick={() => open(p)}
                    >
                      <Pencil size={15} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal
        open={!!editing}
        title={`Editar plano ${editing?.name ?? ""}`}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn-secondary" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={save} disabled={busy}>
              {busy && <Loader2 size={16} className="animate-spin" />} Salvar
            </button>
          </>
        }
      >
        <ErrorBox error={formError} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Nome">
              <input className="input" value={form.name} onChange={set("name")} />
            </Field>
          </div>
          <Field label="Máximo de câmeras">
            <input
              className="input"
              type="number"
              min={1}
              value={form.maxCameras}
              onChange={set("maxCameras")}
            />
          </Field>
          <Field label="Armazenamento (GB)">
            <input
              className="input"
              type="number"
              min={1}
              value={form.maxStorageGb}
              onChange={set("maxStorageGb")}
            />
          </Field>
          <Field label="Retenção máxima (horas)">
            <input
              className="input"
              type="number"
              min={1}
              value={form.maxRetentionHours}
              onChange={set("maxRetentionHours")}
            />
          </Field>
        </div>
        {editing && editing.maxCamerasInUse > 0 && (
          <p className="mt-3 text-xs text-muted">
            O maior cliente deste plano usa {editing.maxCamerasInUse} câmera(s); o limite não pode
            ficar abaixo disso.
          </p>
        )}
      </Modal>
    </section>
  );
}

interface Settings {
  platformName: string;
  supportEmail: string;
  recordingGloballyEnabled: boolean;
  publicHost: string;
  rtmpServer: string;
  sessionMinutes: number;
  refreshHours: number;
  cookieSecure: boolean;
}

function PasswordCard() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="card p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (next !== confirm)
          return setError(new Error("A confirmação não confere com a nova senha."));
        setBusy(true);
        try {
          await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
          setCurrent("");
          setNext("");
          setConfirm("");
          toast("Senha alterada. As outras sessões foram encerradas.");
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="mb-1 font-semibold">Trocar senha</h2>
      <p className="mb-4 text-sm text-muted">Pelo menos 10 caracteres, com letras e números.</p>
      <ErrorBox error={error} />
      <div className="space-y-3">
        <Field label="Senha atual">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </Field>
        <Field label="Nova senha">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
        </Field>
        <Field label="Confirme a nova senha">
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>
      </div>
      <button className="btn-primary mt-4" disabled={busy}>
        {busy && <Loader2 size={16} className="animate-spin" />} Salvar senha
      </button>
    </form>
  );
}

export default function ConfiguracoesPage() {
  const auth = useAuth();
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  const [support, setSupport] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!auth.can("settings.read")) return;
    api
      .get<Settings>("/settings")
      .then((r) => {
        setS(r);
        setName(r.platformName);
        setSupport(r.supportEmail);
      })
      .catch(setError);
  }, [auth]);

  const u = auth.user!;
  return (
    <>
      <PageHeader
        title="Configurações"
        subtitle="Sua conta e, para a equipe da plataforma, os parâmetros gerais."
      />
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <section className="card p-5">
            <h2 className="mb-4 font-semibold">Minha conta</h2>
            <dl className="space-y-2 text-sm">
              {[
                ["Nome", u.name],
                ["E-mail", u.email],
                ["Papel", u.roleLabel],
                ["Cliente", u.tenant?.name ?? "Plataforma"],
              ].map(([k, v]) => (
                <div key={k} className="grid grid-cols-3 gap-2">
                  <dt className="text-muted">{k}</dt>
                  <dd className="col-span-2">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
          <PasswordCard />
        </div>

        {auth.can("settings.read") && (
          <div className="space-y-5">
            <ErrorBox error={error} />
            <section className="card p-5">
              <h2 className="mb-4 font-semibold">Plataforma</h2>
              <div className="space-y-3">
                <Field label="Nome da plataforma">
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={!auth.can("settings.write")}
                  />
                </Field>
                <Field label="E-mail de suporte">
                  <input
                    className="input"
                    type="email"
                    value={support}
                    onChange={(e) => setSupport(e.target.value)}
                    disabled={!auth.can("settings.write")}
                  />
                </Field>
              </div>
              {auth.can("settings.write") && (
                <button
                  className="btn-primary mt-4"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.put("/settings", { platformName: name, supportEmail: support });
                      toast("Configurações salvas");
                    } catch (err) {
                      setError(err);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy && <Loader2 size={16} className="animate-spin" />} Salvar
                </button>
              )}
            </section>
            {s && (
              <section className="card p-5">
                <h2 className="mb-4 font-semibold">Informações do servidor</h2>
                <dl className="space-y-2 text-sm">
                  {[
                    ["Endereço público", s.publicHost],
                    [
                      "Servidor RTMP das câmeras",
                      <code key="r" className="font-mono text-xs">
                        {s.rtmpServer}
                      </code>,
                    ],
                    [
                      "Gravação",
                      s.recordingGloballyEnabled ? "Ligada" : "Desligada (ativada na Fase 4)",
                    ],
                    [
                      "Sessão",
                      `token de ${s.sessionMinutes} min, renovação por até ${Math.round(s.refreshHours / 24)} dias`,
                    ],
                    [
                      "Cookie só por HTTPS",
                      s.cookieSecure ? "Sim" : "Não (laboratório em HTTP — ligar na Fase 8)",
                    ],
                  ].map(([k, v]) => (
                    <div key={String(k)} className="grid grid-cols-5 gap-2">
                      <dt className="col-span-2 text-muted">{k}</dt>
                      <dd className="col-span-3 break-words">{v}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>
        )}
      </div>
      {auth.isPlatform && (
        <div className="mt-5">
          <PlansCard canEdit={auth.can("settings.write")} />
        </div>
      )}
    </>
  );
}
