"use client";

import {
  Camera,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Search,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Confirm,
  CopyButton,
  DataTable,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  useToast,
  type Column,
} from "@/components/ui";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { USER_STATUS, fmtRelative } from "@/lib/format";

interface User {
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

interface Role {
  key: string;
  label: string;
  scope: "platform" | "tenant";
  assignable: boolean;
}

interface TenantOpt {
  id: string;
  name: string;
}

interface PermRow {
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
function UserForm({
  open,
  user,
  roles,
  tenants,
  onClose,
  onSaved,
}: {
  open: boolean;
  user: User | null;
  roles: Role[];
  tenants: TenantOpt[];
  onClose: () => void;
  onSaved: (tempPassword?: { email: string; password: string }) => void;
}) {
  const auth = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [tenantId, setTenantId] = useState("");
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
    setTenantId(user?.tenantId ?? auth.user?.tenant?.id ?? "");
  }, [open, user, auth.user]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (user) {
        await api.patch(`/users/${user.id}`, { name, ...(role !== user.role ? { role } : {}) });
        onSaved();
      } else {
        const r = await api.post<{ temporaryPassword: string }>("/users", {
          name,
          email,
          role,
          tenantId: selected?.scope === "tenant" ? tenantId || null : null,
        });
        onSaved({ email, password: r.temporaryPassword });
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
        {!user && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Uma senha temporária será gerada e mostrada uma única vez. No primeiro acesso, o usuário
            precisa trocá-la.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ permissões por câmera
function PermissionsModal({
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

// ------------------------------------------------------------------ página
export default function UsuariosPage() {
  const auth = useAuth();
  const toast = useToast();
  const canWrite = auth.can("users.write");
  const [data, setData] = useState<Page<User> | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [tenants, setTenants] = useState<TenantOpt[]>([]);
  const [search, setSearch] = useState("");
  const [tenantFilter, setTenantFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<unknown>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [perms, setPerms] = useState<User | null>(null);
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const scope = tenantFilter === "__platform" ? "platform" : undefined;
      setData(
        await api.get<Page<User>>(
          `/users${qs({ search, role: roleFilter, status, page, pageSize: 10, scope, tenantId: tenantFilter.startsWith("__") ? undefined : tenantFilter })}`,
        ),
      );
    } catch (err) {
      setError(err);
    }
  }, [search, roleFilter, status, page, tenantFilter]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    api
      .get<{ roles: Role[] }>("/meta")
      .then((m) => setRoles(m.roles))
      .catch(() => undefined);
    if (auth.isPlatform)
      api
        .get<Page<TenantOpt>>("/tenants?pageSize=100")
        .then((r) => setTenants(r.items))
        .catch(() => undefined);
  }, [auth.isPlatform]);

  const columns: Column<User>[] = [
    {
      key: "name",
      header: "Nome",
      cell: (u) => (
        <div>
          <div className="font-medium">{u.name}</div>
          <div className="text-xs text-muted">{u.email}</div>
        </div>
      ),
      mobileHidden: true,
    },
    ...(auth.isPlatform
      ? [
          {
            key: "tenant",
            header: "Cliente",
            cell: (u: User) => u.tenantName ?? <span className="text-brand-700">Plataforma</span>,
          },
        ]
      : []),
    { key: "role", header: "Papel", cell: (u) => u.roleLabel },
    {
      key: "cams",
      header: "Câmeras",
      cell: (u) =>
        u.role === "operator" || u.role === "viewer"
          ? `${u.cameraPermissionCount} liberada(s)`
          : "Todas",
    },
    {
      key: "status",
      header: "Status",
      cell: (u) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={USER_STATUS[u.status]?.tone ?? "slate"}>
            {USER_STATUS[u.status]?.label ?? u.status}
          </Badge>
          {u.mustChangePassword && u.status === "active" && (
            <Badge tone="amber">1º acesso pendente</Badge>
          )}
        </div>
      ),
    },
    {
      key: "last",
      header: "Último acesso",
      cell: (u) => fmtRelative(u.lastSeenAt ?? u.lastLoginAt),
    },
  ];

  const manageable = (u: User) =>
    canWrite && roles.some((r) => r.key === u.role && r.assignable) && u.id !== auth.user?.id;

  return (
    <>
      <PageHeader
        title="Usuários"
        subtitle={
          auth.isPlatform
            ? "Equipe da plataforma e usuários dos clientes."
            : "Usuários da sua empresa e as câmeras que cada um pode ver."
        }
        actions={
          canWrite && (
            <button
              className="btn-primary"
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              <Plus size={16} /> Novo Usuário
            </button>
          )
        }
      />
      <ErrorBox error={error} />
      <div className="card">
        <div className="flex flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400"
            />
            <input
              className="input pl-9 lg:max-w-sm"
              placeholder="Pesquisar nome ou e-mail…"
              value={search}
              onChange={(e) => (setSearch(e.target.value), setPage(1))}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:flex">
            {auth.isPlatform && (
              <select
                className="input h-9 lg:w-48"
                value={tenantFilter}
                onChange={(e) => (setTenantFilter(e.target.value), setPage(1))}
                aria-label="Cliente"
              >
                <option value="">Todos os clientes</option>
                <option value="__platform">Somente plataforma</option>
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <select
              className="input h-9 lg:w-44"
              value={roleFilter}
              onChange={(e) => (setRoleFilter(e.target.value), setPage(1))}
              aria-label="Papel"
            >
              <option value="">Todos os papéis</option>
              {roles
                .filter((r) => auth.isPlatform || r.scope === "tenant")
                .map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
            </select>
            <select
              className="input h-9 lg:w-36"
              value={status}
              onChange={(e) => (setStatus(e.target.value), setPage(1))}
              aria-label="Status"
            >
              <option value="">Todos</option>
              <option value="active">Ativos</option>
              <option value="disabled">Desativados</option>
            </select>
          </div>
        </div>
        {!data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <Empty icon={<Users size={40} />} title="Nenhum usuário encontrado" />
        ) : (
          <>
            <DataTable
              rows={data.items}
              columns={columns}
              rowKey={(u) => u.id}
              mobileTitle={(u) => (
                <span>
                  {u.name} <span className="block text-xs font-normal text-muted">{u.email}</span>
                </span>
              )}
              actions={(u) =>
                manageable(u) ? (
                  <>
                    <button
                      className="icon-btn"
                      title="Editar"
                      aria-label={`Editar ${u.name}`}
                      onClick={() => (setEditing(u), setFormOpen(true))}
                    >
                      <Pencil size={16} />
                    </button>
                    {(u.role === "operator" || u.role === "viewer") &&
                      auth.can("permissions.write") && (
                        <button
                          className="icon-btn"
                          title="Câmeras permitidas"
                          aria-label={`Câmeras de ${u.name}`}
                          onClick={() => setPerms(u)}
                        >
                          <Camera size={16} />
                        </button>
                      )}
                    <button
                      className="icon-btn"
                      title="Redefinir senha"
                      aria-label={`Redefinir senha de ${u.name}`}
                      onClick={() => setResetting(u)}
                    >
                      <KeyRound size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      title={u.status === "active" ? "Desativar" : "Reativar"}
                      aria-label={`${u.status === "active" ? "Desativar" : "Reativar"} ${u.name}`}
                      onClick={() => setToggling(u)}
                    >
                      {u.status === "active" ? <UserX size={16} /> : <UserCheck size={16} />}
                    </button>
                  </>
                ) : null
              }
            />
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

      <UserForm
        open={formOpen}
        user={editing}
        roles={roles}
        tenants={tenants}
        onClose={() => setFormOpen(false)}
        onSaved={(t) => {
          void load();
          if (t) setTemp(t);
          else toast("Usuário atualizado");
        }}
      />
      <PermissionsModal user={perms} onClose={() => setPerms(null)} onSaved={load} />

      <Modal
        open={!!temp}
        title="Senha temporária"
        onClose={() => setTemp(null)}
        footer={
          <button className="btn-primary" onClick={() => setTemp(null)}>
            Entendi
          </button>
        }
      >
        <p className="text-sm text-slate-700">
          Envie ao usuário <b>{temp?.email}</b> por um canal seguro. Ela{" "}
          <b>não será mostrada de novo</b>. No primeiro acesso, a troca é obrigatória.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code
            className="flex-1 rounded-lg bg-slate-100 px-3 py-2 font-mono text-base tracking-wider"
            data-testid="temp-password"
          >
            {temp?.password}
          </code>
          <CopyButton value={temp?.password ?? ""} />
        </div>
      </Modal>

      <Confirm
        open={!!resetting}
        title="Redefinir senha"
        confirmLabel="Redefinir"
        message={
          <>
            Gerar uma nova senha temporária para <b>{resetting?.name}</b>? As sessões abertas dele
            serão encerradas.
          </>
        }
        onClose={() => setResetting(null)}
        onConfirm={async () => {
          try {
            const r = await api.post<{ temporaryPassword: string }>(
              `/users/${resetting!.id}/reset-password`,
            );
            setTemp({ email: resetting!.email, password: r.temporaryPassword });
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
      <Confirm
        open={!!toggling}
        danger={toggling?.status === "active"}
        title={toggling?.status === "active" ? "Desativar usuário" : "Reativar usuário"}
        confirmLabel={toggling?.status === "active" ? "Desativar" : "Reativar"}
        message={
          toggling?.status === "active" ? (
            <>
              <b>{toggling?.name}</b> perde o acesso imediatamente (painel e app). Nada é apagado.
            </>
          ) : (
            <>
              Reativar o acesso de <b>{toggling?.name}</b>?
            </>
          )
        }
        onClose={() => setToggling(null)}
        onConfirm={async () => {
          try {
            await api.patch(`/users/${toggling!.id}`, {
              status: toggling!.status === "active" ? "disabled" : "active",
            });
            toast(toggling!.status === "active" ? "Usuário desativado" : "Usuário reativado");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </>
  );
}
