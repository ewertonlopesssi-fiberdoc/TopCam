"use client";

import { Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ErrorBox } from "@/components/ui";
import { useAuth } from "@/lib/auth";

function LoginForm() {
  const { signIn, user, loading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const next = () => {
    const n = new URLSearchParams(window.location.search).get("next");
    return n && n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard";
  };

  useEffect(() => {
    if (!loading && user) router.replace(user.mustChangePassword ? "/trocar-senha" : next());
  }, [loading, user, router]);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const u = await signIn(email, password);
          router.replace(u.mustChangePassword ? "/trocar-senha" : next());
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorBox error={error} />
      <label className="block">
        <span className="label">E-mail</span>
        <input
          className="input h-11"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="block">
        <span className="label">Senha</span>
        <div className="relative">
          <input
            className="input h-11 pr-11"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            className="absolute top-1/2 right-2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-slate-600"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? "Ocultar senha" : "Mostrar senha"}
          >
            {show ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </div>
      </label>
      <button className="btn-primary h-11 w-full" disabled={busy}>
        {busy && <Loader2 size={16} className="animate-spin" />} Entrar
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen">
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-navy-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700">
            <ShieldCheck size={24} />
          </div>
          <div>
            <div className="text-lg font-bold tracking-wide">TOPCAM</div>
            <div className="text-xs text-slate-400">Monitoramento de Câmeras</div>
          </div>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl leading-tight font-semibold">
            Suas câmeras, seus clientes, um só painel.
          </h1>
          <p className="mt-3 text-slate-300">
            Ao vivo, gravações e alertas com acesso separado por cliente e por câmera.
          </p>
        </div>
        <div className="text-xs text-slate-500">© TopCam</div>
        <div className="pointer-events-none absolute -right-24 -bottom-24 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl" />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
              <ShieldCheck size={22} />
            </div>
            <div className="text-lg font-bold tracking-wide text-navy-900">TOPCAM</div>
          </div>
          <h2 className="text-2xl font-semibold">Entrar</h2>
          <p className="mt-1 mb-6 text-sm text-muted">
            Use o e-mail e a senha fornecidos pelo administrador.
          </p>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
