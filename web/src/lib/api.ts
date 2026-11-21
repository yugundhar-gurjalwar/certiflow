const TOKEN_KEY = "certiflow.token";
export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = tokenStore.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith("/auth/login")) { tokenStore.clear(); window.location.href = "/login"; }
    throw new ApiError(res.status, body?.error?.code ?? "ERROR", body?.error?.message ?? `Request failed (${res.status})`, body?.error?.details);
  }
  return body as T;
}

export const api = {
  get: <T,>(p: string) => request<T>(p),
  post: <T,>(p: string, data?: unknown) => request<T>(p, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) }),
  patch: <T,>(p: string, data: unknown) => request<T>(p, { method: "PATCH", body: JSON.stringify(data) }),
  del: <T,>(p: string) => request<T>(p, { method: "DELETE" }),
  upload: <T,>(p: string, file: File) => { const f = new FormData(); f.append("file", file); return request<T>(p, { method: "POST", body: f }); },
};

export type Role = "centre" | "district_officer" | "quality" | "state";
export interface Me { id: string; name: string; role: Role; centreId: string | null; districtId: string | null }
export interface Meta { districtQuorum: number; largeBatchThreshold: number; escalationLevel1Minutes: number; escalationLevel2Minutes: number; demoMode: boolean }

export interface BatchSummary {
  id: string; name: string; courseCode: string; courseName: string; centreName: string; status: string; round: number;
  candidateCount: number; requiresQuality: boolean; stageEnteredAt: string; lastReason: string | null;
  approveVotes: number; rejectVotes: number; iVoted: boolean;
}
export interface Candidate { id: string; enrolmentNo: string; fullName: string; phone: string; email: string | null; score: number }
export interface Vote { stage: string; round: number; decision: string; reason: string | null; at: string; officerName: string; officerId: string }
export interface BatchDetail extends Omit<BatchSummary, "approveVotes" | "rejectVotes" | "iVoted"> {
  candidates: Candidate[]; votes: Vote[]; passScore: number; certificates: Record<string, number>; deliveries: Record<string, number>;
}
export interface CertRow { id: string; number: string; status: string; issuedAt: string | null; candidateName: string; deliveryStatus: string | null; deliveryAttempts: number | null; lastError?: string | null }
export interface AuditEvent { id: number; at: string; actorName: string; actorRole: string; action: string; details: Record<string, any>; requestId: string | null }
export interface RowError { row: number; column: string | null; code: string; message: string }
