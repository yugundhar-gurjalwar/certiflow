import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Card } from "../components/ui";

interface Result { valid: boolean; status: "VALID" | "CANCELLED" | "NOT_FOUND"; number?: string; holderName?: string; course?: string; centre?: string; issuedOn?: string; message?: string }

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl space-y-5 px-4 py-10">
      <Link to="/" className="flex items-center justify-center gap-2 font-bold text-indigo-700"><span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-white">C</span>CertiFlow</Link>
      {children}
    </div>
  );
}

export function Verify() {
  const { number } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(number ?? "");
  const { data, isFetching } = useQuery({ queryKey: ["verify", number], queryFn: () => api.get<Result>(`/public/verify/${encodeURIComponent(number!)}`), enabled: !!number, staleTime: 0, gcTime: 0 });
  const tone = !data ? "" : data.status === "VALID" ? "border-green-300 bg-green-50" : data.status === "CANCELLED" ? "border-red-300 bg-red-50" : "border-slate-300 bg-slate-100";
  return (
    <PublicShell>
      <div className="text-center"><h1 className="text-2xl font-bold">Verify a certificate</h1><p className="text-slate-600">Enter the number printed on the certificate, or scan its QR code. No login needed.</p></div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (input.trim()) nav(`/verify/${encodeURIComponent(input.trim())}`); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="CF-2026-100001-ABCD" className="flex-1 rounded-lg border border-slate-300 p-2.5 font-mono text-sm uppercase" aria-label="Certificate number" />
        <Button type="submit" busy={isFetching}>Verify</Button>
      </form>
      {data && (
        <div className={`rounded-xl border-2 p-5 ${tone}`} role="status">
          {data.status === "VALID" && (<>
            <div className="text-lg font-bold text-green-800">✓ Genuine certificate</div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Holder</dt><dd className="font-semibold">{data.holderName}</dd>
              <dt className="text-slate-500">Course</dt><dd>{data.course}</dd>
              <dt className="text-slate-500">Training centre</dt><dd>{data.centre}</dd>
              <dt className="text-slate-500">Issued on</dt><dd>{data.issuedOn}</dd>
              <dt className="text-slate-500">Number</dt><dd className="font-mono">{data.number}</dd>
            </dl></>)}
          {data.status === "CANCELLED" && <><div className="text-lg font-bold text-red-800">✗ Certificate cancelled</div><p className="mt-1 text-sm text-red-900">{data.message} Do not accept it.</p><p className="mt-1 font-mono text-xs">{data.number}</p></>}
          {data.status === "NOT_FOUND" && <><div className="text-lg font-bold text-slate-800">No such certificate</div><p className="mt-1 text-sm text-slate-700">{data.message} Check the number for typing mistakes. If it came from the candidate, treat it as unverified.</p></>}
        </div>
      )}
    </PublicShell>
  );
}

export function CandidateDownload() {
  const { token = "" } = useParams();
  const [state, setState] = useState<"idle" | "busy" | "gone" | "missing">("idle");
  const download = async () => {
    setState("busy");
    const res = await fetch(`/api/public/certificates/${encodeURIComponent(token)}/download`);
    if (res.status === 410) return setState("gone");
    if (!res.ok) return setState("missing");
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a"); a.href = url; a.download = "certificate.pdf"; a.click();
    setState("idle");
  };
  return (
    <PublicShell>
      <Card title="Your certificate">
        <p className="text-sm text-slate-600">Download your Pragati Skills Mission certificate as a PDF. Keep this link private - anyone with it can download your certificate.</p>
        <div className="mt-4"><Button onClick={download} busy={state === "busy"}>Download PDF</Button></div>
        {state === "gone" && <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">This certificate has been cancelled and is no longer valid.</p>}
        {state === "missing" && <p className="mt-3 rounded-lg bg-slate-100 p-3 text-sm text-slate-700">This link is not valid or the certificate is still being prepared. Try again in a minute.</p>}
      </Card>
    </PublicShell>
  );
}
