"use client";

import {
  Camera,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import {
  Badge,
  Confirm,
  CopyButton,
  DataTable,
  Empty,
  ErrorBox,
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

import {
  PasswordModal,
  PermissionsModal,
  UserForm,
  type Access,
  type Role,
  type TenantOpt,
  type User,
} from "@/components/user-modals";

function UsuariosPage() {
  const params = useSearchParams();
  const auth = useAuth();
  const toast = useToast();
  const canWrite = auth.can("users.write");
  const [data, setData] = useState<Page<User> | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [tenants, setTenants] = useState<TenantOpt[]>([]);
  const [search, setSearch] = useState("");
  // Aberto pela tela Clientes ("Abrir em Usuários"): já filtrado pelo cliente.
  const [tenantFilter, setTenantFilter] = useState(params.get("tenantId") ?? "");
  const [roleFilter, setRoleFilter] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState<unknown>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [perms, setPerms] = useState<User | null>(null);
  const [temp, setTemp] = useState<Access | null>(null);
  const [resetting, setResetting] = useState<{ user: User; email: boolean } | null>(null);
  const [mailEnabled, setMailEnabled] = useState(false);
  const canWriteUsers = auth.can("users.write");
  const [toggling, setToggling] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

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
    if (canWriteUsers)
      api
        .get<{ enabled: boolean }>("/users/mail-status")
        .then((r) => setMailEnabled(r.enabled))
        .catch(() => undefined);
  }, [auth.isPlatform, canWriteUsers]);

  /** Senha gerada ou falha no e-mail: mostra o quadro. Senha digitada e e-mail enviado: só um aviso. */
  function showAccess(a: Access | undefined, fallback: string) {
    if (!a) return toast(fallback);
    if (a.password || (a.mail && !a.mail.sent)) return setTemp(a);
    toast(a.mail?.sent ? `${fallback}. Acesso enviado para ${a.email}` : fallback);
  }

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
                    {u.id !== auth.user?.id && (
                      <button
                        className="icon-btn"
                        title="Alterar senha / enviar acesso"
                        aria-label={`Alterar senha de ${u.name}`}
                        onClick={() => setResetting({ user: u, email: mailEnabled })}
                      >
                        <KeyRound size={16} />
                      </button>
                    )}
                    <button
                      className="icon-btn"
                      title={u.status === "active" ? "Desativar" : "Reativar"}
                      aria-label={`${u.status === "active" ? "Desativar" : "Reativar"} ${u.name}`}
                      onClick={() => setToggling(u)}
                    >
                      {u.status === "active" ? <UserX size={16} /> : <UserCheck size={16} />}
                    </button>
                    <button
                      className="icon-btn hover:!text-red-600"
                      title="Excluir"
                      aria-label={`Excluir ${u.name}`}
                      onClick={() => setDeleting(u)}
                    >
                      <Trash2 size={16} />
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
        mailEnabled={mailEnabled}
        onClose={() => setFormOpen(false)}
        onSaved={(a) => {
          void load();
          showAccess(a, "Usuário salvo");
        }}
      />
      <PermissionsModal user={perms} onClose={() => setPerms(null)} onSaved={load} />

      <Modal
        open={!!temp}
        title={temp?.password ? "Senha gerada" : "Acesso"}
        onClose={() => setTemp(null)}
        footer={
          <button className="btn-primary" onClick={() => setTemp(null)}>
            Entendi
          </button>
        }
      >
        {temp?.mail && (
          <p
            role={temp.mail.sent ? "status" : "alert"}
            className={`mb-3 rounded-lg px-3 py-2 text-sm ${temp.mail.sent ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}
          >
            {temp.mail.sent
              ? `Usuário e senha enviados por e-mail para ${temp.email}.`
              : `O e-mail não foi enviado: ${temp.mail.error}`}
          </p>
        )}
        {temp?.password && (
          <>
            <p className="text-sm text-slate-700">
              Senha de <b>{temp.email}</b>. Ela <b>não será mostrada de novo</b>
              {temp.mail?.sent ? "." : ": envie ao usuário por um canal seguro."}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code
                className="flex-1 rounded-lg bg-slate-100 px-3 py-2 font-mono text-base tracking-wider"
                data-testid="temp-password"
              >
                {temp.password}
              </code>
              <CopyButton value={temp.password} />
            </div>
          </>
        )}
        <p className="mt-3 text-xs text-muted">
          {temp?.mustChange
            ? "No primeiro acesso, o usuário precisará trocar a senha."
            : "O usuário não precisará trocar a senha no primeiro acesso."}
        </p>
      </Modal>

      <PasswordModal
        target={resetting}
        mailEnabled={mailEnabled}
        onClose={() => setResetting(null)}
        onSaved={(a) => {
          void load();
          showAccess(a, "Senha alterada");
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
      <Confirm
        open={!!deleting}
        danger
        title="Excluir usuário"
        confirmLabel="Excluir"
        message={
          <>
            Excluir <b>{deleting?.name}</b> ({deleting?.email})? O acesso é cortado na hora e o
            usuário sai das listas. O histórico continua na auditoria.
          </>
        }
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.del(`/users/${deleting!.id}`);
            toast("Usuário excluído");
            await load();
          } catch (err) {
            toast((err as Error).message, "error");
          }
        }}
      />
    </>
  );
}

export default function Page() {
  return (
    <Suspense>
      <UsuariosPage />
    </Suspense>
  );
}
