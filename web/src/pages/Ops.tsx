import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type CertRow } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago } from "../lib/format";
import { Badge, Button, Card, Empty, ErrorBanner, ReasonDialog, Spinner } from "../components/ui";
import { openPdf } from "./BatchDetail";

interface Overview {
  thresholds: { level1Minutes: number; level2Minutes: number };
  stuckBatches: { id: string; name: string; status: string; candidateCount: number; centreName: string; districtName: string; escalationLevel: number; waitingSeconds: number }[];
  deliveryProblems: { certificateId: string; number: string; status: string; attempts: number; lastError: string | null }[];
  deliveries: Record<string, number>; certificates: Record<string, number>; batches: Record<string, number>;
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
}

export function Ops() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["ops"], queryFn: () => api.get<Overview>("/ops/overview"), refetchInterval: 10_000 });
  const requeue = useMutation({ mutationFn: (id: string) => api.post(`/certificates/${id}/redeliver`), onSuccess: () => qc.invalidateQueries({ queryKey: ["ops"] }) });
  if (isLoading) return <Spinner />;
  if (!data) return <ErrorBanner error={error} />;
  const sum = (m: Record<string, number>, ...k: string[]) => k.reduce((a, x) => a + (m[x] ?? 0), 0);
  const d = data.deliveries;
  const tiles: [string, number, string][] = [
    ["Batches in review", sum(data.batches, "DISTRICT_REVIEW", "QUALITY_REVIEW", "STATE_REVIEW"), "text-amber-700"],
    ["Stuck past SLA", data.stuckBatches.length, data.stuckBatches.length ? "text-red-700" : "text-green-700"],
    ["Certificates issued", data.certificates.ISSUED ?? 0, "text-green-700"],
    ["Cancelled", data.certificates.CANCELLED ?? 0, "text-slate-700"],
    ["Messages delivered", sum(d, "SENT", "DELIVERED"), "text-teal-700"],
    ["Retrying / waiting", sum(d, "QUEUED", "RETRY", "SENDING"), "text-amber-700"],
    ["Dead / failed", sum(d, "DEAD", "FAILED_PERMANENT"), sum(d, "DEAD", "FAILED_PERMANENT") ? "text-red-700" : "text-slate-700"],
  ];
  return (
    <>
      <div><h1 className="text-xl font-bold">Operations</h1><p className="text-sm text-slate-600">What is stuck, and how healthy is certificate delivery. Updates live.</p></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map(([label, n, color]) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><div className={`text-2xl font-bold ${color}`}>{n}</div><div className="text-xs text-slate-500">{label}</div></div>)}
      </div>
      <Card title={`Stuck batches (waiting longer than ${Math.round(data.thresholds.level1Minutes / 60 * 10) / 10}h)`}>
        {data.stuckBatches.length === 0 ? <Empty>Nothing is stuck.</Empty> : (
          <table className="w-full text-left text-sm"><thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">Batch</th><th>District / centre</th><th>At step</th><th>Waiting</th><th>Escalation</th></tr></thead>
            <tbody>{data.stuckBatches.map((b) => (
              <tr key={b.id} className="border-t border-slate-100"><td className="py-2"><Link className="font-medium text-indigo-700 hover:underline" to={`/batches/${b.id}`}>{b.name}</Link> <span className="text-xs text-slate-500">({b.candidateCount})</span></td>
                <td className="text-slate-600">{b.districtName} / {b.centreName}</td><td><Badge value={b.status} /></td><td className="font-semibold text-red-700">{ago(new Date(Date.now() - b.waitingSeconds * 1000).toISOString())}</td>
                <td>{b.escalationLevel === 0 ? "-" : b.escalationLevel === 1 ? <Badge value="RETRY" label="Level 1: reminded" /> : <Badge value="DEAD" label="Level 2: URGENT" />}</td></tr>))}
            </tbody></table>)}
      </Card>
      <Card title="Delivery problems (dead-lettered or permanently failed)">
        <ErrorBanner error={requeue.error} />
        {data.deliveryProblems.length === 0 ? <Empty>No delivery problems.</Empty> : (
          <table className="w-full text-left text-sm"><thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">Certificate</th><th>Status</th><th>Attempts</th><th>Last error</th><th /></tr></thead>
            <tbody>{data.deliveryProblems.map((p) => (
              <tr key={p.certificateId} className="border-t border-slate-100"><td className="py-2 font-mono text-xs">{p.number}</td><td><Badge value={p.status} /></td><td>{p.attempts}</td><td className="text-slate-600">{p.lastError}</td>
                <td className="text-right"><Button variant="secondary" className="!px-2 !py-1" busy={requeue.isPending} onClick={() => requeue.mutate(p.certificateId)}>Re-queue</Button></td></tr>))}
            </tbody></table>)}
      </Card>
      <Card title="Background queues (Redis / BullMQ)">
        <div className="grid gap-3 sm:grid-cols-3">
          {Object.entries(data.queues).map(([name, c]) => typeof c === "object" && c ? (
            <div key={name} className="rounded-lg bg-slate-50 p-3 text-sm"><div className="font-semibold capitalize">{name}</div>
              <div className="text-slate-600">waiting {c.waiting} - active {c.active} - delayed {c.delayed} - failed {c.failed}</div></div>) : null)}
        </div>
      </Card>
    </>
  );
}

export function Certificates() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState(""); const [cancelId, setCancelId] = useState<string | null>(null);
  const { data = [], isFetching } = useQuery({ queryKey: ["certs", q], queryFn: () => api.get<(CertRow & { batchId: string; batchName: string; cancelReason: string | null })[]>(`/certificates?q=${encodeURIComponent(q)}`), placeholderData: (p) => p });
  return (
    <>
      <div><h1 className="text-xl font-bold">Certificates</h1><p className="text-sm text-slate-600">Search by certificate number or candidate name.</p></div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search..." className="w-full max-w-md rounded-lg border border-slate-300 p-2 text-sm" />
      <Card>
        {data.length === 0 ? <Empty>{isFetching ? "Searching..." : "No certificates found."}</Empty> : (
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-slate-500"><tr><th className="py-2">Number</th><th>Candidate</th><th>Batch</th><th>Status</th><th>WhatsApp</th><th /></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.id} className="border-t border-slate-100"><td className="py-2 font-mono text-xs">{c.number}</td><td>{c.candidateName}</td>
                <td><Link className="text-indigo-700 hover:underline" to={`/batches/${c.batchId}`}>{c.batchName}</Link></td>
                <td><Badge value={c.status} />{c.cancelReason && <div className="text-xs text-slate-500">{c.cancelReason}</div>}</td><td>{c.deliveryStatus ? <Badge value={c.deliveryStatus} /> : "-"}</td>
                <td className="space-x-1 text-right">{c.status === "ISSUED" && <Button variant="ghost" className="!px-2 !py-1" onClick={() => openPdf(c.id)}>PDF</Button>}
                  <a className="text-xs text-slate-500 underline" href={`/verify/${c.number}`} target="_blank">verify</a>
                  {me?.role === "state" && c.status !== "CANCELLED" && <Button variant="ghost" className="!px-2 !py-1 !text-red-700" onClick={() => setCancelId(c.id)}>Cancel</Button>}</td></tr>))}
            </tbody></table></div>)}
      </Card>
      {cancelId && <ReasonDialog danger title="Cancel this certificate" confirmLabel="Cancel certificate" hint="Anyone verifying it will immediately be told it is no longer valid."
        onConfirm={(reason) => api.post(`/certificates/${cancelId}/cancel`, { reason }).then(() => qc.invalidateQueries({ queryKey: ["certs"] }))} onClose={() => setCancelId(null)} />}
    </>
  );
}
