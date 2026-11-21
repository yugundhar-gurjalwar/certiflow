import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, tokenStore, type AuditEvent, type BatchDetail as Detail, type CertRow, type Meta } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, fmtDate, ROLE_LABEL } from "../lib/format";
import { Badge, Button, Card, Empty, ErrorBanner, ReasonDialog, Spinner, Stepper } from "../components/ui";

const MY_STAGE: Record<string, string> = { district_officer: "DISTRICT_REVIEW", quality: "QUALITY_REVIEW", state: "STATE_REVIEW" };

export async function openPdf(certId: string) {
  const res = await fetch(`/api/certificates/${certId}/pdf`, { headers: { Authorization: `Bearer ${tokenStore.get()}` } });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).error?.message ?? "Could not open the certificate"); return; }
  window.open(URL.createObjectURL(await res.blob()), "_blank");
}

export function BatchDetail() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ["meta"], queryFn: () => api.get<Meta>("/public/meta"), staleTime: Infinity });
  const { data: b, isLoading, error } = useQuery({ queryKey: ["batch", id], queryFn: () => api.get<Detail>(`/batches/${id}`), refetchInterval: 30_000 });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["batch", id] }); qc.invalidateQueries({ queryKey: ["batches"] }); };
  const [dialog, setDialog] = useState<null | "send_back" | "reject">(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = useMutation({ mutationFn: (f: File) => api.upload(`/batches/${id}/import`, f), onSuccess: refresh });
  const submit = useMutation({ mutationFn: () => api.post(`/batches/${id}/submit`), onSuccess: refresh });
  const approve = useMutation({ mutationFn: () => api.post(`/batches/${id}/decision`, { decision: "approve" }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api.del(`/batches/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["batches"] }); nav("/"); } });
  const decide = (decision: "send_back" | "reject") => (reason: string) => api.post(`/batches/${id}/decision`, { decision, reason }).then(refresh);

  if (isLoading) return <Spinner />;
  if (error || !b || !me) return <ErrorBanner error={error ?? new Error("Batch not found")} />;

  const inReview = ["DISTRICT_REVIEW", "QUALITY_REVIEW", "STATE_REVIEW"].includes(b.status);
  const canEdit = me.role === "centre" && ["DRAFT", "CHANGES_REQUESTED"].includes(b.status);
  const myTurn = inReview && MY_STAGE[me.role] === b.status;
  const roundVotes = b.votes.filter((v) => v.round === b.round && v.stage === b.status);
  const iVoted = roundVotes.some((v) => v.officerId === me.id);
  const quorum = b.status === "DISTRICT_REVIEW" ? meta.data?.districtQuorum ?? 2 : 1;
  const approvals = roundVotes.filter((v) => v.decision === "approve").length;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button onClick={() => nav("/")} className="mb-1 text-xs text-slate-500 hover:underline">← All batches</button>
          <h1 className="text-xl font-bold">{b.name} <Badge value={b.status} /></h1>
          <p className="text-sm text-slate-600">{b.centreName} - {b.courseName} - {b.candidateCount} candidates{b.requiresQuality && " - large batch (quality review required)"} - review round {b.round}</p>
        </div>
        {inReview && <div className="rounded-lg bg-slate-100 px-3 py-2 text-sm">Waiting at this step for <b>{ago(b.stageEnteredAt)}</b></div>}
      </div>
      <Card><Stepper status={b.status} requiresQuality={b.requiresQuality} /></Card>

      {b.status === "CHANGES_REQUESTED" && (
        <div className="rounded-xl border border-orange-300 bg-orange-50 p-4 text-sm text-orange-900"><b>Sent back for changes:</b> {b.lastReason}
          {me.role === "centre" && <p className="mt-1">Upload a corrected spreadsheet (it replaces the candidate list), then send it for approval again. Because the data changed, <b>earlier approvals no longer count</b> and review restarts at the district.</p>}
        </div>
      )}
      {b.status === "REJECTED" && <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900"><b>Rejected:</b> {b.lastReason}</div>}

      {canEdit && (
        <Card title="1. Candidates spreadsheet" actions={b.status === "DRAFT" && <Button variant="ghost" onClick={() => confirm("Delete this draft?") && remove.mutate()}>Delete draft</Button>}>
          <p className="mb-3 text-sm text-slate-600">CSV or XLSX with columns <code className="rounded bg-slate-100 px-1">enrolment_no, full_name, phone, email (optional), score</code>. Only candidates who passed (score ≥ {b.passScore}). If any row has a problem, <b>nothing is saved</b> and you get the exact list.</p>
          <input ref={fileRef} type="file" accept=".csv,.xlsx" className="text-sm" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); if (fileRef.current) fileRef.current.value = ""; }} />
          {upload.isPending && <p className="mt-2 text-sm text-slate-500">Validating...</p>}
          {upload.isSuccess && <p className="mt-2 text-sm text-green-700">Imported {(upload.data as { imported: number }).imported} candidates.</p>}
          <div className="mt-3"><ErrorBanner error={upload.error} /></div>
          <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
            <Button onClick={() => submit.mutate()} busy={submit.isPending} disabled={b.candidateCount === 0}>{b.status === "DRAFT" ? "2. Send for approval" : "Resend for approval"}</Button>
            {b.candidateCount === 0 && <span className="text-sm text-slate-500">Upload candidates first.</span>}
          </div>
          <div className="mt-2"><ErrorBanner error={submit.error} /></div>
        </Card>
      )}

      {myTurn && (
        <Card title="Your decision">
          {iVoted ? <p className="text-sm text-slate-700">You have recorded your decision for this round. Waiting for {Math.max(0, quorum - approvals)} more approval(s).</p> : (
            <>
              <p className="mb-3 text-sm text-slate-600">
                {b.status === "DISTRICT_REVIEW" ? `A district decision needs ${quorum} different officers to agree. So far: ${approvals} of ${quorum} approved.` : "Your decision is final for this step."}
                {" "}Sending back needs only one officer and requires a reason.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => approve.mutate()} busy={approve.isPending}>Approve</Button>
                <Button variant="secondary" onClick={() => setDialog("send_back")}>Send back to centre</Button>
                <Button variant="danger" onClick={() => setDialog("reject")}>Reject</Button>
              </div>
            </>
          )}
          <div className="mt-2"><ErrorBanner error={approve.error} /></div>
        </Card>
      )}
      {dialog && <ReasonDialog title={dialog === "send_back" ? "Send back to the centre" : "Reject this batch"} confirmLabel={dialog === "send_back" ? "Send back" : "Reject"} danger={dialog === "reject"}
        hint={dialog === "send_back" ? "The centre will see this reason and can fix and resend." : "Rejection is final. At district level, two officers must reject."} onConfirm={decide(dialog)} onClose={() => setDialog(null)} />}

      {b.status === "APPROVED" && <Certificates batchId={b.id} />}

      <Candidates b={b} canCorrect={me.role === "district_officer" && b.status === "DISTRICT_REVIEW"} onChanged={refresh} />
      {b.votes.length > 0 && (
        <Card title="Decisions on record">
          <ul className="space-y-1 text-sm">
            {b.votes.map((v, i) => (
              <li key={i} className={v.round === b.round ? "" : "text-slate-400 line-through decoration-slate-300"}>
                <b>{v.officerName}</b> {v.decision === "approve" ? "approved" : "rejected"} at {v.stage.replace("_REVIEW", "").toLowerCase()} - round {v.round} - {fmtDate(v.at)}{v.reason ? ` - "${v.reason}"` : ""}
                {v.round !== b.round && <span className="ml-2 text-xs not-italic text-slate-500">(void: batch was changed after this approval)</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Timeline batchId={b.id} />
    </>
  );
}

function Candidates({ b, canCorrect, onChanged }: { b: Detail; canCorrect: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: "", phone: "" });
  const save = useMutation({ mutationFn: (cid: string) => api.patch(`/batches/${b.id}/candidates/${cid}`, { fullName: form.fullName, phone: form.phone }), onSuccess: () => { setEditing(null); onChanged(); } });
  return (
    <Card title={`Candidates (${b.candidates.length})`}>
      {canCorrect && <p className="mb-2 text-xs text-slate-500">You can correct a name or phone number. Any correction voids approvals already given, because reviewers approved different data.</p>}
      <ErrorBanner error={save.error} />
      {b.candidates.length === 0 ? <Empty>No candidates uploaded yet.</Empty> : (
        <div className="max-h-96 overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-white text-xs uppercase text-slate-500"><tr><th className="py-2">Enrolment</th><th>Name</th><th>Phone</th><th>Score</th>{canCorrect && <th />}</tr></thead>
            <tbody>{b.candidates.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="py-1.5 font-mono text-xs">{c.enrolmentNo}</td>
                <td>{editing === c.id ? <input className="rounded border p-1 text-sm" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /> : c.fullName}</td>
                <td className="font-mono text-xs">{editing === c.id ? <input className="rounded border p-1 text-sm" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /> : c.phone}</td>
                <td>{c.score}</td>
                {canCorrect && <td className="text-right">{editing === c.id ? <><Button className="!px-2 !py-1" onClick={() => save.mutate(c.id)} busy={save.isPending}>Save</Button> <Button variant="ghost" className="!px-2 !py-1" onClick={() => setEditing(null)}>Cancel</Button></> : <Button variant="ghost" className="!px-2 !py-1" onClick={() => { setEditing(c.id); setForm({ fullName: c.fullName, phone: c.phone }); }}>Correct</Button>}</td>}
              </tr>))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Certificates({ batchId }: { batchId: string }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["batch", batchId, "certs"], queryFn: () => api.get<CertRow[]>(`/batches/${batchId}/certificates`), refetchInterval: 5_000 });
  const [cancelId, setCancelId] = useState<string | null>(null);
  const done = data.filter((c) => c.deliveryStatus === "SENT" || c.deliveryStatus === "DELIVERED").length;
  const issued = data.filter((c) => c.status === "ISSUED").length;
  return (
    <Card title="Certificates">
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <span>Issued: <b>{issued}</b>/{data.length}</span><span>On candidate's WhatsApp: <b>{done}</b>/{data.length}</span>
        <div className="h-2 w-48 self-center overflow-hidden rounded-full bg-slate-200"><div className="h-full bg-green-500 transition-all" style={{ width: `${data.length ? (done / data.length) * 100 : 0}%` }} /></div>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-white text-xs uppercase text-slate-500"><tr><th className="py-2">Number</th><th>Candidate</th><th>Certificate</th><th>WhatsApp</th><th>Tries</th><th /></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.id} className="border-t border-slate-100">
              <td className="py-1.5 font-mono text-xs">{c.number}</td><td>{c.candidateName}</td><td><Badge value={c.status} /></td>
              <td>{c.deliveryStatus ? <span title={c.lastError ?? ""}><Badge value={c.deliveryStatus} /></span> : "-"}</td><td>{c.deliveryAttempts ?? "-"}</td>
              <td className="space-x-1 text-right">
                {c.status === "ISSUED" && <Button variant="ghost" className="!px-2 !py-1" onClick={() => openPdf(c.id)}>PDF</Button>}
                {me?.role === "state" && c.status !== "CANCELLED" && <Button variant="ghost" className="!px-2 !py-1 !text-red-700" onClick={() => setCancelId(c.id)}>Cancel</Button>}
              </td>
            </tr>))}
          </tbody>
        </table>
      </div>
      {cancelId && <ReasonDialog danger title="Cancel this certificate" confirmLabel="Cancel certificate" hint="Anyone verifying it will immediately be told it is no longer valid. This cannot be undone."
        onConfirm={(reason) => api.post(`/certificates/${cancelId}/cancel`, { reason }).then(() => qc.invalidateQueries({ queryKey: ["batch", batchId] }))} onClose={() => setCancelId(null)} />}
    </Card>
  );
}

function Timeline({ batchId }: { batchId: string }) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({ queryKey: ["batch", batchId, "timeline"], queryFn: () => api.get<{ events: AuditEvent[]; outboxUnpublished: number }>(`/batches/${batchId}/timeline`), enabled: open });
  return (
    <Card title="Audit trail - everything that happened to this batch" actions={<Button variant="secondary" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</Button>}>
      {!open ? <p className="text-sm text-slate-500">Every decision is recorded with who made it and when. Records cannot be edited or deleted.</p> : !data ? <Spinner /> : (
        <ol className="max-h-96 space-y-2 overflow-auto text-sm">
          {data.events.map((e) => (
            <li key={e.id} className="border-l-2 border-indigo-200 pl-3">
              <span className="font-mono text-xs text-slate-500">{fmtDate(e.at)}</span> <b>{e.action}</b> by {e.actorName} <span className="text-xs text-slate-500">({ROLE_LABEL[e.actorRole] ?? e.actorRole})</span>
              {Object.keys(e.details).length > 0 && <div className="break-all font-mono text-xs text-slate-500">{JSON.stringify(e.details)}</div>}
              {e.requestId && <div className="font-mono text-[10px] text-slate-400">request {e.requestId}</div>}
            </li>))}
        </ol>
      )}
    </Card>
  );
}
