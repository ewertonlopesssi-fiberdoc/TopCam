"use client";

/**
 * Formulários de usuário compartilhados pelas telas Usuários e Clientes:
 * cadastro/edição, câmeras permitidas e alterar senha / enviar acesso.
 */

import { Camera, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Empty, ErrorBox, Field, Loading, Modal, useToast } from "@/components/ui";
import {
  PasswordFields,
  emptyPassword,
  passwordPayload,
  passwordStateError,
  type PasswordState,
} from "@/components/password-fields";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  status: string;
  tenantId: string | null;
  tenantName: string | null;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
  cameraPermissionCount: number;
}

/** Resultado de uma senha definida (mostrado ao administrador). */
export interface Access {
  email: string;
  /** Só quando o sistema gerou a senha (a digitada o administrador já conhece). */
  password?: string;
  mustChange: boolean;
  mail: { sent: boolean; error: string | null } | null;
}
export interface PasswordResult {
  temporaryPassword?: string;
  mustChangePassword: boolean;
  mail: Access["mail"];
}

export interface Role {
  key: string;
  label: string;
  scope: "platform" | "tenant";
  assignable: boolean;
}

export interface TenantOpt {
  id: string;
  name: string;
}

export interface PermRow {
  cameraId: string;
  code: string;
  name: string;
  locationName: string;
  groupName: string | null;
  recordingEnabled: boolean;
  canLive: boolean;
  canPlayback: boolean;
  canExport: boolean;
}

// ------------------------------------------------------------------ formulário
export function UserForm({
  open,
  user,
  roles,
  tenants,
  mailEnabled,
  defaultTenantId,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: User | null;
  roles: Role[];
  tenants: TenantOpt[];
  mailEnabled: boolean;
  /** Novo usuário já vinculado a este cliente (ex.: aberto pela tela Clientes). */
  defaultTenantId?: string;
  onClose: () => void;
  onSaved: (access?: Access) => void;
}) {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [tenantId, setTenantId] = useState("");
  const [pw, setPw] = useState<PasswordState>(emptyPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const assignable = roles.filter((r) => r.assignable);
  const selected = roles.find((r) => r.key === role);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(user?.name ?? "");
    setEmail(user?.email ?? "");
    setRole(user?.role ?? "viewer");
    setTenantId(user?.tenantId ?? defaultTenantId ?? auth.user?.tenant?.id ?? "");
    setPw(emptyPassword());
  }, [open, user, auth.user, defaultTenantId]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const local = passwordStateError(pw);
      if (local) throw new Error(local);
      if (user) {
        const withPassword = Boolean(pw.password);
        const r = await api.patch<{ mail: Access["mail"] }>(`/users/${user.id}`, {
          name,
          ...(role !== user.role ? { role } : {}),
          ...(withPassword ? passwordPayload(pw) : {}),
        });
        onSaved(
          withPassword
            ? {
                email: user.email,
                mustChange: passwordPayload(pw).mustChangePassword,
                mail: r.mail,
              }
            : undefined,
        );
      } else {
        const r = await api.post<PasswordResult>("/users", {
          name,
          email,
          role,
          tenantId: selected?.scope === "tenant" ? tenantId || null : null,
          ...passwordPayload(pw),
        });
        onSaved({
          email,
          password: r.temporaryPassword,
          mustChange: r.mustChangePassword,
          mail: r.mail,
        });
      }
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const self = user?.id === auth.user?.id;
  return (
    <Modal
      open={open}
      title={user ? "Editar usuário" : "Novo usuário"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-primary"
            onClick={save}
            disabled={busy || name.trim().length < 2 || (!user && !email)}
          >
            {busy && <Loader2 size={16} className="animate-spin" />} Salvar
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="space-y-3">
        <Field label="Nome *">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <Field
          label="E-mail *"
          hint={user ? "O e-mail não pode ser alterado." : "Será usado para entrar no sistema."}
        >
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!!user}
          />
        </Field>
        <Field label="Papel *" hint={self ? "Você não pode alterar o próprio papel." : undefined}>
          <select
            className="input"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={self}
          >
            {(user && !assignable.some((r) => r.key === user.role)
              ? roles.filter((r) => r.key === user.role)
              : []
            ).map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
            {assignable
              .filter((r) => !user || (r.scope === "tenant") === Boolean(user.tenantId))
              .map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
          </select>
        </Field>
        {user && (
          <Field label="Cliente" hint="O cliente não pode ser alterado depois do cadastro.">
            <input
              className="input"
              value={user.tenantName ?? "Plataforma (equipe)"}
              disabled
              readOnly
            />
          </Field>
        )}
        {!user && selected?.scope === "tenant" && auth.isPlatform && (
          <Field label="Cliente *">
            <select
              className="input"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            >
              <option value="">Selecione…</option>
              {tenants.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!self && (
          <PasswordFields
            state={pw}
            onChange={setPw}
            mailEnabled={mailEnabled}
            optionalLabel={user ? "Em branco: mantém a atual" : "Em branco: o sistema gera"}
          />
        )}
        {self && user && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Para trocar a sua senha, use Configurações → Minha conta.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ permissões por câmera
export function PermissionsModal({
  user,
  onClose,
  onSaved,
}: {
  user: User | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<PermRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  useEffect(() => {
    if (!user) return;
    setRows(null);
    setError(null);
    api
      .get<{ items: PermRow[] }>(`/users/${user.id}/camera-permissions`)
      .then((r) => setRows(r.items))
      .catch(setError);
  }, [user]);

  const groups = useMemo(() => {
    const m = new Map<string, PermRow[]>();
    for (const r of rows ?? []) {
      const k = `${r.locationName}${r.groupName ? ` › ${r.groupName}` : ""}`;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()];
  }, [rows]);

  const toggle = (id: string, field: "canLive" | "canPlayback" | "canExport") =>
    setRows((rs) =>
      (rs ?? []).map((r) => {
        if (r.cameraId !== id) return r;
        const next = { ...r, [field]: !r[field] };
        // Gravações/exportação pressupõem acesso à câmera.
        if (field !== "canLive" && next[field]) next.canLive = true;
        if (field === "canLive" && !next.canLive) {
          next.canPlayback = false;
          next.canExport = false;
        }
        return next;
      }),
    );

  const setAll = (value: boolean) =>
    setRows((rs) =>
      (rs ?? []).map((r) => ({
        ...r,
        canLive: value,
        canPlayback: value && r.recordingEnabled,
        canExport: false,
      })),
    );

  return (
    <Modal
      open={!!user}
      wide
      title={`Câmeras de ${user?.name ?? ""}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn-primary"
            disabled={busy || !rows}
            onClick={async () => {
              setBusy(true);
              try {
                await api.put(`/users/${user!.id}/camera-permissions`, {
                  items: (rows ?? []).map(({ cameraId, canLive, canPlayback, canExport }) => ({
                    cameraId,
                    canLive,
                    canPlayback,
                    canExport,
                  })),
                });
                toast("Permissões salvas");
                onSaved();
                onClose();
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 size={16} className="animate-spin" />} Salvar permissões
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      {!rows ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty icon={<Camera size={36} />} title="Este cliente ainda não tem câmeras" />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted">
              {rows.filter((r) => r.canLive).length} de {rows.length} câmeras liberadas
            </span>
            <div className="flex gap-2">
              <button className="btn-secondary h-8 px-3 text-xs" onClick={() => setAll(true)}>
                Liberar todas (ao vivo)
              </button>
              <button className="btn-secondary h-8 px-3 text-xs" onClick={() => setAll(false)}>
                Remover todas
              </button>
            </div>
          </div>
          <div className="space-y-4">
            {groups.map(([g, items]) => (
              <div key={g} className="rounded-xl border border-line">
                <div className="border-b border-line bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-600">
                  {g}
                </div>
                <ul className="divide-y divide-line">
                  {items.map((r) => (
                    <li
                      key={r.cameraId}
                      className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center"
                    >
                      <div className="flex-1 text-sm">
                        <span className="mr-2 font-mono text-xs text-slate-500">{r.code}</span>
                        {r.name}
                      </div>
                      <div className="flex gap-4 text-sm">
                        {(
                          [
                            ["canLive", "Ao vivo"],
                            ["canPlayback", "Gravações"],
                            ["canExport", "Exportar"],
                          ] as const
                        ).map(([f, label]) => (
                          <label key={f} className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-brand-600"
                              checked={r[f]}
                              onChange={() => toggle(r.cameraId, f)}
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ alterar senha / enviar acesso
export function PasswordModal({
  target,
  mailEnabled,
  onClose,
  onSaved,
}: {
  target: { user: User; email: boolean } | null;
  mailEnabled: boolean;
  onClose: () => void;
  onSaved: (a: Access) => void;
}) {
  const [pw, setPw] = useState<PasswordState>(emptyPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!target) return;
    setError(null);
    setPw(emptyPassword(target.email));
  }, [target]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const local = passwordStateError(pw);
      if (local) throw new Error(local);
      const r = await api.post<PasswordResult>(
        `/users/${target!.user.id}/reset-password`,
        passwordPayload(pw),
      );
      onSaved({
        email: target!.user.email,
        password: r.temporaryPassword,
        mustChange: r.mustChangePassword,
        mail: r.mail,
      });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!target}
      title="Alterar senha / enviar acesso"
      onClose={onClose}
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={save} disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />}{" "}
            {pw.sendEmail && mailEnabled ? "Salvar e enviar" : "Salvar senha"}
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <p className="mb-3 text-sm text-slate-700">
        Nova senha para <b>{target?.user.name}</b> ({target?.user.email}). As sessões abertas dele
        serão encerradas.
      </p>
      <PasswordFields
        state={pw}
        onChange={setPw}
        mailEnabled={mailEnabled}
        optionalLabel="Em branco: o sistema gera"
      />
    </Modal>
  );
}
