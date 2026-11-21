import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Role } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABEL } from "../lib/format";
import { Button, Card, ErrorBanner } from "../components/ui";

const BLURB: Record<Role, string> = {
  centre: "Creates batches, uploads the spreadsheet, sends for approval, fixes and resends.",
  district_officer: "Reviews batches for their district. Two officers must agree.",
  quality: "Extra scrutiny for large batches.",
  state: "Final approval, stuck items, cancelling certificates.",
};

export function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const demo = useQuery({ queryKey: ["demo-users"], queryFn: () => api.get<{ password: string; users: { name: string; email: string; role: Role }[] }>("/auth/demo-users"), retry: false });

  const go = async (e: string, p: string) => { setBusy(e); setErr(null); try { await login(e, p); nav("/"); } catch (x) { setErr(x); } finally { setBusy(null); } };

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-10">
      <div className="text-center"><div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-xl bg-indigo-600 text-xl font-bold text-white">C</div>
        <h1 className="text-2xl font-bold">CertiFlow</h1><p className="text-slate-600">Pragati Skills Mission - certificate issuance platform</p></div>
      <ErrorBanner error={err} />
      {demo.data && (
        <Card title="Demo personas - pick someone to act as">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {demo.data.users.map((u) => (
              <button key={u.email} disabled={!!busy} onClick={() => go(u.email, demo.data!.password)} className="rounded-xl border border-slate-200 p-3 text-left transition hover:border-indigo-400 hover:bg-indigo-50 disabled:opacity-60">
                <div className="font-semibold">{u.name}</div><div className="text-xs font-medium text-indigo-700">{ROLE_LABEL[u.role]}</div>
                <div className="mt-1 text-xs text-slate-500">{BLURB[u.role]}</div>
              </button>
            ))}
          </div>
        </Card>
      )}
      <Card title="Sign in">
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void go(email, password); }}>
          <input className="rounded-lg border border-slate-300 p-2 text-sm" placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input className="rounded-lg border border-slate-300 p-2 text-sm" placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Button type="submit" busy={busy === email}>Sign in</Button>
        </form>
      </Card>
      <p className="text-center text-sm text-slate-500">Employer or candidate? <a className="text-indigo-700 underline" href="/verify">Verify a certificate</a> - no login needed.</p>
    </div>
  );
}
