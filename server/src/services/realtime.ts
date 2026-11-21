import { redis } from "../redis.js";

export const EVENTS_CHANNEL = "cf:events";

/** Scope tags let the API decide who may receive an event. Payloads never contain personal data. */
export interface RealtimeEvent {
  type: string;
  batchId?: string;
  certificateId?: string;
  centreId?: string | null;
  districtId?: string | null;
  userId?: string | null; // when set, only this user receives it
  info?: Record<string, unknown>;
}

/** Best-effort fan-out to browsers. Correctness never depends on it: the UI also refetches on focus/interval. */
export async function publish(ev: RealtimeEvent): Promise<void> {
  try {
    await redis.publish(EVENTS_CHANNEL, JSON.stringify(ev));
  } catch {
    /* Redis down: live updates degrade to polling, nothing else is affected */
  }
}
