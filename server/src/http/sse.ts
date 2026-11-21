import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { db, schema } from "../db/client.js";
import type { Actor, Role } from "../auth/actor.js";
import { redis } from "../redis.js";
import { AppError } from "./errors.js";
import { EVENTS_CHANNEL, type RealtimeEvent } from "../services/realtime.js";

interface Client { actor: Actor; res: Response }
const clients = new Set<Client>();

/** Who may receive an event. Events carry ids only (never personal data); the client refetches through normal authorised APIs. */
export function canReceive(actor: Actor, ev: RealtimeEvent): boolean {
  if (ev.userId) return ev.userId === actor.id;
  switch (actor.role) {
    case "centre": return !!ev.centreId && ev.centreId === actor.centreId;
    case "district_officer": return !!ev.districtId && ev.districtId === actor.districtId;
    case "quality":
    case "state": return true;
    default: return false;
  }
}

let sub: Redis | undefined;
export function startSseHub() {
  sub = new Redis(config.REDIS_URL);
  sub.on("error", () => {});
  void sub.subscribe(EVENTS_CHANNEL);
  sub.on("message", (_ch, msg) => {
    let ev: RealtimeEvent;
    try { ev = JSON.parse(msg) as RealtimeEvent; } catch { return; }
    const payload = `event: ${ev.type}\ndata: ${JSON.stringify({ type: ev.type, batchId: ev.batchId, certificateId: ev.certificateId, info: ev.info })}\n\n`;
    for (const c of clients) if (canReceive(c.actor, ev)) c.res.write(payload);
  });
  const hb = setInterval(() => { for (const c of clients) c.res.write(": hb\n\n"); }, 15_000);
  hb.unref();
  return () => { clearInterval(hb); sub?.disconnect(); for (const c of clients) c.res.end(); clients.clear(); };
}

/** EventSource cannot send an Authorization header, so the browser first trades its token for a 30-second one-time ticket. */
export async function issueTicket(actor: Actor): Promise<string> {
  const ticket = randomBytes(24).toString("base64url");
  await redis.set(`cf:sse:${ticket}`, actor.id, "EX", 30);
  return ticket;
}

export async function openStream(req: Request, res: Response) {
  const ticket = String(req.query.ticket ?? "");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(ticket)) throw new AppError(401, "UNAUTHENTICATED", "Invalid ticket");
  const userId = await redis.getdel(`cf:sse:${ticket}`); // one-time
  if (!userId) throw new AppError(401, "UNAUTHENTICATED", "Ticket expired");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!u || !u.active) throw new AppError(401, "UNAUTHENTICATED", "Account not available");
  const actor: Actor = { id: u.id, name: u.name, role: u.role as Role, centreId: u.centreId, districtId: u.districtId };
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write("retry: 2000\n\nevent: ready\ndata: {}\n\n");
  const client = { actor, res };
  clients.add(client);
  req.on("close", () => clients.delete(client));
}
