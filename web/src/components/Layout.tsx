import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, ROLE_LABEL } from "../lib/format";
import { useLiveUpdates } from "../lib/live";

interface Notice { id: string; batchId: string | null; kind: string; message: string; readAt: string | null; createdAt: string }

export function Layout() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const live = useLiveUpdates(!!me);
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: notes = [] } = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<Notice[]>("/notifications"), enabled: !!me, refetchInterval: 30_000 });
  const unread = notes.filter((n) => !n.readAt).length;
  const readAll = useMutation({ mutationFn: () => api.post("/notifications/read-all"), onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }) });

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-bold text-indigo-700"><span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-white">C</span>CertiFlow</Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link to="/" className="text-slate-600 hover:text-slate-900">Batches</Link>
            {(me?.role === "state" || me?.role === "quality") && <Link to="/ops" className="text-slate-600 hover:text-slate-900">Operations</Link>}
            <Link to="/certificates" className="text-slate-600 hover:text-slate-900">Certificates</Link>
            <Link to="/verify" className="text-slate-600 hover:text-slate-900">Verify</Link>
            <span title={live ? "Live updates connected" : "Reconnecting - the page will still refresh itself every 30s"} className={`flex items-center gap-1 text-xs ${live ? "text-green-700" : "text-amber-700"}`}>
              <span className={`h-2 w-2 rounded-full ${live ? "bg-green-500" : "bg-amber-500"}`} />{live ? "Live" : "Offline"}
            </span>
            <div className="relative">
              <button aria-label="Notifications" onClick={() => { setOpen(!open); if (!open && unread) readAll.mutate(); }} className="relative rounded-lg p-2 hover:bg-slate-100">
                🔔{unread > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{unread}</span>}
              </button>
              {open && (
                <div className="absolute right-0 mt-2 max-h-96 w-80 overflow-auto rounded-xl border border-slate-200 bg-white shadow-xl">
                  {notes.length === 0 && <p className="p-4 text-sm text-slate-500">No notifications</p>}
                  {notes.map((n) => (
                    <button key={n.id} onClick={() => { setOpen(false); if (n.batchId) nav(`/batches/${n.batchId}`); }} className="block w-full border-b border-slate-100 p-3 text-left text-sm hover:bg-slate-50">
                      <span className={n.kind.startsWith("escalation") ? "font-semibold text-red-700" : ""}>{n.message}</span>
                      <span className="mt-0.5 block text-xs text-slate-400">{ago(n.createdAt)} ago</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {me && (
              <div className="flex items-center gap-2 border-l border-slate-200 pl-3">
                <div className="text-right leading-tight"><div className="font-medium">{me.name}</div><div className="text-xs text-slate-500">{ROLE_LABEL[me.role]}</div></div>
                <button onClick={() => { logout(); nav("/login"); }} className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">Switch user</button>
              </div>
            )}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6"><Outlet /></main>
    </div>
  );
}
