export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "-");
export function ago(s: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}
export const STAGE_LABEL: Record<string, string> = {
  DRAFT: "Draft", DISTRICT_REVIEW: "District review", QUALITY_REVIEW: "Quality review", STATE_REVIEW: "State review",
  CHANGES_REQUESTED: "Changes requested", REJECTED: "Rejected", APPROVED: "Approved",
};
export const ROLE_LABEL: Record<string, string> = { centre: "Training centre", district_officer: "District officer", quality: "Quality team", state: "State office", system: "System" };
