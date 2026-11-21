import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, tokenStore, type Me } from "./api";

interface AuthCtx { me: Me | null; loading: boolean; login: (email: string, password: string) => Promise<Me>; logout: () => void }
const Ctx = createContext<AuthCtx>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(!!tokenStore.get());
  const qc = useQueryClient();

  useEffect(() => {
    if (!tokenStore.get()) return;
    api.get<Me>("/auth/me").then(setMe).catch(() => tokenStore.clear()).finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ token: string }>("/auth/login", { email, password });
    tokenStore.set(r.token);
    qc.clear(); // never show the previous persona's cached data
    const m = await api.get<Me>("/auth/me");
    setMe(m);
    return m;
  };
  const logout = () => { tokenStore.clear(); qc.clear(); setMe(null); };
  return <Ctx.Provider value={{ me, loading, login, logout }}>{children}</Ctx.Provider>;
}
