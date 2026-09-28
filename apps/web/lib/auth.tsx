"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  type Me,
  login as apiLogin,
  logout as apiLogout,
  refresh,
  setSessionLostHandler,
} from "./api";

interface AuthState {
  user: Me | null;
  loading: boolean;
  can: (permission: string) => boolean;
  isPlatform: boolean;
  signIn: (email: string, password: string) => Promise<Me>;
  signOut: () => Promise<void>;
  setUser: (u: Me) => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null);
      router.replace("/login");
    });
    refresh()
      .then((u) => setUser(u))
      .finally(() => setLoading(false));
  }, [router]);

  const signIn = useCallback(async (email: string, password: string) => {
    const u = await apiLogin(email, password);
    setUser(u);
    return u;
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    router.replace("/login");
  }, [router]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      can: (p) => Boolean(user?.permissions.includes(p)),
      isPlatform: user?.role === "platform_admin" || user?.role === "platform_operator",
      signIn,
      signOut,
      setUser,
    }),
    [user, loading, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth fora do AuthProvider");
  return v;
}

/** Protege as páginas do painel: sem sessão → /login; senha pendente → /trocar-senha. */
export function useRequireAuth() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (auth.loading) return;
    if (!auth.user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    else if (auth.user.mustChangePassword && pathname !== "/trocar-senha")
      router.replace("/trocar-senha");
  }, [auth.loading, auth.user, pathname, router]);
  return auth;
}
