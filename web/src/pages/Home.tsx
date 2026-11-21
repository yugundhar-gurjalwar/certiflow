import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type BatchSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, ROLE_LABEL } from "../lib/format";
import { Badge, Button, Card, Empty, ErrorBanner, Spinner } from "../components/ui";

const MY_STAGE: Record<string, string> = { district_officer: "DISTRICT_REVIEW", quality: "QUALITY_REVIEW", state: "STATE_REVIEW" };

export function Home() {
  const { me } = useAuth();
  const { data, isLoading, error } = useQuery({ queryKey: ["batches"], queryFn: () => api.get<BatchSummary[]>("/batches"), refetchInterval: 30_000 });
  if (!me) return null;
  if (isLoading) return <Spinner />;
  const batches = data ?? [];

  if (me.role === "centre") return <CentreHome batches={batches} error={error} />;
  const mine = batches.filter((b) => b.status === MY_STAGE[me.role] && !b.iVoted);
  const rest = batches.filter((b) => !mine.includes(b));
  return (
    <>
      <div><h1 className="text-xl font-bold">Hello {me.name}</h1><p className="text-sm text-slate-600">{ROLE_LABEL[me.role]} - oldest waiting items first</p></div>
      <ErrorBanner error={error} />
      <Card title={`Needs your decision (${mine.length})`}>
        {mine.length === 0 ? <Empty>Nothing is waiting for you. 🎉</Empty> : <BatchTable rows={mine} showWaiting highlight />}
      </Card>
      <Card title="All other batches in your scope">
        {rest.length === 0 ? <Empty>No other batches.</Empty> : <BatchTable rows={rest} showWaiting />}
      </Card>
    </>
  );
}

function BatchTable({ rows, showWaiting, highlight }: { rows: BatchSummary[]; showWaiting?: boolean; highlight?: boolean }) {
  const { me } = useAuth();
  const quorum = me?.role === "district_officer" ? 2 : 1;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-slate-500"><tr><th className="py-2 pr-3">Batch</th><th className="pr-3">Centre</th><th className="pr-3">Candidates</th><th className="pr-3">Status</th>{showWaiting && <th className="pr-3">Waiting</th>}<th className="pr-3">Votes</th><th /></tr></thead>
        <tbody>
          {rows.map((b) => {
            const inReview = ["DISTRICT_REVIEW", "QUALITY_REVIEW", "STATE_REVIEW"].includes(b.status);
            const waitingSeconds = (Date.now() - new Date(b.stageEnteredAt).getTime()) / 1000;
            return (
              <tr key={b.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="py-2.5 pr-3"><Link className="font-medium text-indigo-700 hover:underline" to={`/batches/${b.id}`}>{b.name}</Link><div className="text-xs text-slate-500">{b.courseName}{b.round > 1 ? ` - round ${b.round}` : ""}</div></td>
                <td className="pr-3 text-slate-600">{b.centreName}</td>
                <td className="pr-3">{b.candidateCount}{b.requiresQuality && <span title="Large batch: quality review required" className="ml-1 text-xs text-purple-700">(large)</span>}</td>
                <td className="pr-3"><Badge value={b.status} /></td>
                {showWaiting && <td className={`pr-3 ${inReview && waitingSeconds > 86400 ? "font-semibold text-red-700" : "text-slate-600"}`}>{inReview ? ago(b.stageEnteredAt) : "-"}</td>}
                <td className="pr-3 text-slate-600">{inReview ? `${b.approveVotes}/${quorum} approve${b.rejectVotes ? `, ${b.rejectVotes} reject` : ""}${b.iVoted ? " (you voted)" : ""}` : "-"}</td>
                <td className="text-right"><Link to={`/batches/${b.id}`}><Button variant={highlight ? "primary" : "secondary"} className="!px-3 !py-1">{highlight ? "Review" : "Open"}</Button></Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CentreHome({ batches, error }: { batches: BatchSummary[]; error: unknown }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const courses = useQuery({ queryKey: ["courses"], queryFn: () => api.get<{ code: string; name: string; passScore: number }[]>("/courses") });
  const [name, setName] = useState(""); const [course, setCourse] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>("/batches", { name, courseCode: course || courses.data![0]!.code }),
    onSuccess: (b) => { qc.invalidateQueries({ queryKey: ["batches"] }); nav(`/batches/${b.id}`); },
  });
  const attention = batches.filter((b) => b.status === "CHANGES_REQUESTED");
  return (
    <>
      <div><h1 className="text-xl font-bold">Your batches</h1><p className="text-sm text-slate-600">Create a batch, upload your spreadsheet, send it for approval and track it here.</p></div>
      <ErrorBanner error={error} />
      {attention.length > 0 && (
        <div className="rounded-xl border border-orange-300 bg-orange-50 p-4 text-sm text-orange-900">
          <b>{attention.length} batch{attention.length > 1 ? "es were" : " was"} sent back and need{attention.length > 1 ? "" : "s"} your attention:</b>
          <ul className="mt-1 list-disc pl-5">{attention.map((b) => <li key={b.id}><Link className="underline" to={`/batches/${b.id}`}>{b.name}</Link> - {b.lastReason}</li>)}</ul>
        </div>
      )}
      <Card title="New batch">
        <form className="grid gap-3 sm:grid-cols-[2fr_1.5fr_auto]" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <input className="rounded-lg border border-slate-300 p-2 text-sm" placeholder="Batch name, e.g. Welding - Dec 2026" value={name} onChange={(e) => setName(e.target.value)} minLength={3} required />
          <select className="rounded-lg border border-slate-300 p-2 text-sm" value={course} onChange={(e) => setCourse(e.target.value)}>
            {courses.data?.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code}, pass mark {c.passScore})</option>)}
          </select>
          <Button type="submit" busy={create.isPending} disabled={!courses.data}>Create batch</Button>
        </form>
        <div className="mt-2"><ErrorBanner error={create.error} /></div>
      </Card>
      <Card title={`All batches (${batches.length})`}>{batches.length === 0 ? <Empty>No batches yet.</Empty> : <BatchTable rows={batches} />}</Card>
    </>
  );
}
