import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiClient, type User } from "./api";
import { brand } from "./brand";
import { keyStore } from "./store";

interface AuthState {
  /** undefined = ainda conferindo a sessão guardada. */
  user: User | null | undefined;
  api: ApiClient;
  login(email: string, password: string): Promise<User>;
  logout(): Promise<void>;
  setUser(u: User): void;
}

const Ctx = createContext<AuthState | null>(null);
const api = new ApiClient(brand.apiUrl, keyStore);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api.onSessionLost = () => setUser(null);
    api
      .restore()
      .then((u) => setUser(u))
      // Sem internet ao abrir: volta para o login (o token continua guardado).
      .catch(() => setUser(null));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const u = await api.login(email, password);
    setUser(u);
    return u;
  }, []);
  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, api, login, logout, setUser }), [user, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth fora do AuthProvider");
  return v;
}
