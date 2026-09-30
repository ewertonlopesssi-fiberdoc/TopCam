"use client";

import { Camera, KeyRound, Loader2, Pencil, Plus, UserCheck, UserX } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AccessResultModal, type AccessInfo } from "@/components/password-fields";
import { Badge, Confirm, ErrorBox, useToast } from "@/components/ui";
import {
  PasswordModal,
  PermissionsModal,
  UserForm,
  type Role,
  type TenantOpt,
  type User,
} from "@/components/user-modals";
import { api, qs, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { USER_STATUS, fmtRelative } from "@/lib/format";

/**
 * Usuários de um cliente, abertos logo abaixo dele na tela Clientes, com as mesmas
 * ações da tela Usuários (editar, senha/acesso, câmeras, ativar/desativar) e o
 * cadastro de um usuário já vinculado ao cliente.
 */
export function ClientUsers({
  tenant,
  roles,
  mailEnabled,
  onChanged,
}: {
  tenant: TenantOpt;
  roles: Role[];
  mailEnabled: boolean;
  onChanged: () => void;
}) {
  const auth = useAuth();
  const toast = useToast();
  const [data, setData] = useState<Page<User> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [perms, setPerms] = useState<User | null>(null);
  const [password, setPassword] = useState<{ user: User; email: boolean } | null>(null);
  const [toggling, setToggling] = useState<User | null>(null);
  const [access, setAccess] = useState<AccessInfo | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Page<User>>(`/users${qs({ tenantId: tenant.id, pageSize: 100 })}`));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [tenant.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = () => (void load(), onChanged());
  function showAccess(a: AccessInfo | undefined, fallback: string) {
    changed();
    if (!a) return toast(fallback);
    if (a.password || (a.mail && !a.mail.sent)) return setAccess(a);
    toast(a.mail?.sent ? `${fallback}. Acesso enviado para ${a.email}` : fallback);
  }

  return (
    <div data-testid={`client-users-${tenant.id}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">Usuários de {tenant.name}</h3>
        {data && <span className="text-xs text-muted">({data.total})</span>}
        <div className="ml-auto flex items-center gap-3">
          <Link
            href={`/usuarios?tenantId=${tenant.id}`}
            className="text-xs text-brand-600 hover:underline"
          >
            Abrir em Usuários
          </Link>
          {auth.can("users.write") && (
            <button
              className="btn-secondary h-8 px-3 text-xs"
              onClick={() => (setEditing(null), setFormOpen(true))}
            >
              <Plus size={14} /> Novo usuário neste cliente
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <div className="flex items-center gap-2 py-3 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> Carregando…
        </div>
      ) : data.items.length === 0 ? (
        <p className="py-3 text-sm text-muted">Nenhum usuário neste cliente.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-white">
          {data.items.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{u.name}</div>
                <div className="truncate text-xs text-muted">{u.email}</div>
              </div>
              <span className="w-40 text-xs text-slate-600">{u.roleLabel}</span>
              <span className="w-28">
                <Badge tone={USER_STATUS[u.status]?.tone ?? "slate"}>
                  {USER_STATUS[u.status]?.label ?? u.status}
                </Badge>
              </span>
              <span className="hidden w-28 text-xs text-muted lg:inline">
                {u.lastSeenAt ? fmtRelative(u.lastSeenAt) : "nunca entrou"}
              </span>
              {auth.can("users.write") && (
                <div className="flex gap-1.5">
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
                    <>
                      <button
                        className="icon-btn"
                        title="Alterar senha / enviar acesso"
                        aria-label={`Alterar senha de ${u.name}`}
                        onClick={() => setPassword({ user: u, email: mailEnabled })}
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
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <UserForm
        open={formOpen}
        user={editing}
        roles={roles}
        tenants={[tenant]}
        mailEnabled={mailEnabled}
        defaultTenantId={tenant.id}
        onClose={() => setFormOpen(false)}
        onSaved={(a) => showAccess(a, "Usuário salvo")}
      />
      <PermissionsModal user={perms} onClose={() => setPerms(null)} onSaved={changed} />
      <PasswordModal
        target={password}
        mailEnabled={mailEnabled}
        onClose={() => setPassword(null)}
        onSaved={(a) => showAccess(a, "Senha alterada")}
      />
      <AccessResultModal access={access} onClose={() => setAccess(null)} />
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
              <b>{toggling?.name}</b> volta a ter acesso.
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
            changed();
          } catch (err) {
            toast((err as Error).message, "error");
          }
          setToggling(null);
        }}
      />
    </div>
  );
}
