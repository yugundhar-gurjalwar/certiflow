import { useState, type ReactNode } from "react";
import { ApiError, type RowError } from "../lib/api";
import { STAGE_LABEL } from "../lib/format";

const BADGE: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700", DISTRICT_REVIEW: "bg-amber-100 text-amber-800", QUALITY_REVIEW: "bg-purple-100 text-purple-800",
  STATE_REVIEW: "bg-blue-100 text-blue-800", CHANGES_REQUESTED: "bg-orange-100 text-orange-800", REJECTED: "bg-red-100 text-red-800", APPROVED: "bg-green-100 text-green-800",
  ISSUED: "bg-green-100 text-green-800", PENDING: "bg-slate-100 text-slate-700", CANCELLED: "bg-red-100 text-red-800",
  QUEUED: "bg-slate-100 text-slate-700", SENDING: "bg-blue-100 text-blue-800", RETRY: "bg-amber-100 text-amber-800", SENT: "bg-teal-100 text-teal-800",
  DELIVERED: "bg-green-100 text-green-800", FAILED_PERMANENT: "bg-red-100 text-red-800", DEAD: "bg-red-100 text-red-800", SKIPPED: "bg-slate-200 text-slate-600",
};
export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[value] ?? "bg-slate-100 text-slate-700"}`}>{label ?? STAGE_LABEL[value] ?? value.replace("_", " ").toLowerCase()}</span>;
}

export const Card = ({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
    {(title || actions) && <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3"><h2 className="font-semibold">{title}</h2><div className="flex gap-2">{actions}</div></header>}
    <div className="p-4">{children}</div>
  </section>
);

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean };
export function Button({ variant = "primary", busy, className = "", children, disabled, ...rest }: BtnProps) {
  const styles = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-700", secondary: "bg-white text-slate-700 border border-slate-300 hover:bg-slate-50",
    danger: "bg-red-600 text-white hover:bg-red-700", ghost: "text-slate-600 hover:bg-slate-100",
  }[variant];
  return <button {...rest} disabled={disabled || busy} className={`rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}>{busy ? "Working..." : children}</button>;
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  const rows: RowError[] | undefined = e.details?.errors;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p className="font-medium">{e.message ?? "Something went wrong"}</p>
      {rows && (
        <div className="mt-2 max-h-72 overflow-auto rounded border border-red-200 bg-white">
          <table className="w-full text-left text-xs text-slate-800">
            <thead className="sticky top-0 bg-red-100"><tr><th className="px-2 py-1">Row</th><th className="px-2 py-1">Column</th><th className="px-2 py-1">Problem</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-red-100"><td className="px-2 py-1 font-mono">{r.row}</td><td className="px-2 py-1 font-mono">{r.column ?? "-"}</td><td className="px-2 py-1">{r.message}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-900/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-3 text-lg font-semibold">{title}</h3>{children}
      </div>
    </div>
  );
}

/** Asks for a reason (required) before a consequential action. */
export function ReasonDialog({ title, confirmLabel, danger, onConfirm, onClose, hint }: { title: string; confirmLabel: string; danger?: boolean; hint?: string; onConfirm: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={title} onClose={onClose}>
      {hint && <p className="mb-2 text-sm text-slate-600">{hint}</p>}
      <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Reason (at least 5 characters)" className="w-full rounded-lg border border-slate-300 p-2 text-sm" />
      <div className="mt-2"><ErrorBanner error={err} /></div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} busy={busy} disabled={reason.trim().length < 5}
          onClick={async () => { setBusy(true); setErr(null); try { await onConfirm(reason.trim()); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); } }}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-8 text-center text-sm text-slate-500">{children}</p>;
export const Spinner = () => <p className="py-8 text-center text-sm text-slate-500">Loading...</p>;

/** Horizontal progress of a batch through the approval stages. */
export function Stepper({ status, requiresQuality }: { status: string; requiresQuality: boolean }) {
  const steps = [["DRAFT", "Draft"], ["DISTRICT_REVIEW", "District"], ...(requiresQuality ? [["QUALITY_REVIEW", "Quality"]] : []), ["STATE_REVIEW", "State"], ["APPROVED", "Certificates"]] as [string, string][];
  const order = steps.map((s) => s[0]);
  const idx = status === "CHANGES_REQUESTED" ? 0 : status === "REJECTED" ? -1 : order.indexOf(status);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {steps.map(([key, label], i) => {
        const done = idx > i || status === "APPROVED"; const current = idx === i && status !== "APPROVED";
        return (
          <li key={key} className="flex items-center gap-2">
            <span className={`grid h-6 w-6 place-items-center rounded-full font-semibold ${done ? "bg-green-600 text-white" : current ? "bg-indigo-600 text-white" : "bg-slate-200 text-slate-500"}`}>{done ? "✓" : i + 1}</span>
            <span className={current ? "font-semibold" : "text-slate-500"}>{label}</span>
            {i < steps.length - 1 && <span className="h-px w-6 bg-slate-300" />}
          </li>
        );
      })}
      {status === "CHANGES_REQUESTED" && <li className="ml-2"><Badge value="CHANGES_REQUESTED" /></li>}
      {status === "REJECTED" && <li className="ml-2"><Badge value="REJECTED" /></li>}
    </ol>
  );
}
