"use client";

import { KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorBox, Field } from "@/components/ui";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function TrocarSenhaPage() {
  const { user, loading, setUser, signOut } = useAuth();
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form
        className="card w-full max-w-md p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (next !== confirm) {
            setError(new Error("A confirmação não confere com a nova senha."));
            return;
          }
          setBusy(true);
          try {
            const r = await api.post<{ user: NonNullable<typeof user> }>("/auth/change-password", {
              currentPassword: current,
              newPassword: next,
            });
            setUser(r.user);
            router.replace("/dashboard");
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <KeyRound size={22} />
        </div>
        <h1 className="text-xl font-semibold">Defina sua senha</h1>
        <p className="mt-1 mb-5 text-sm text-muted">
          Por segurança, troque a senha temporária antes de continuar. Use pelo menos 10 caracteres,
          com letras e números.
        </p>
        <ErrorBox error={error} />
        <div className="space-y-3">
          <Field label="Senha atual (temporária)">
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="Nova senha">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="Confirme a nova senha">
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </div>
        <div className="mt-6 flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => void signOut()}>
            Sair
          </button>
          <button className="btn-primary flex-1" disabled={busy}>
            {busy && <Loader2 size={16} className="animate-spin" />} Salvar nova senha
          </button>
        </div>
      </form>
    </div>
  );
}
