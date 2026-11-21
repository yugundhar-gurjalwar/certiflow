import { config } from "../config.js";

/**
 * Client for the WhatsApp provider (in this repo: the stand-in service in /whatsapp-sim).
 * It classifies every outcome so the caller can decide what to do:
 *   accepted   -> provider took the message (2xx)
 *   permanent  -> will never work (bad number, template rejected): do not retry
 *   transient  -> try again later (5xx, 429, network error, TIMEOUT)
 * A timeout is AMBIGUOUS: the provider may have accepted the message. That is why every call carries an
 * Idempotency-Key (= delivery id); retrying with the same key cannot produce a second message.
 */
export type SendResult =
  | { kind: "accepted"; providerMessageId: string }
  | { kind: "permanent"; error: string }
  | { kind: "transient"; error: string; ambiguous: boolean };

export interface OutgoingMessage { to: string; text: string; documentUrl: string; clientRef: string }

export async function sendWhatsApp(msg: OutgoingMessage): Promise<SendResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.WHATSAPP_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.WHATSAPP_URL}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": msg.clientRef },
      body: JSON.stringify({ to: msg.to, type: "document", text: msg.text, document_url: msg.documentUrl, client_ref: msg.clientRef }),
      signal: ctrl.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.json().catch(() => ({}))) as { id?: string };
      return body.id ? { kind: "accepted", providerMessageId: body.id } : { kind: "transient", error: "2xx without message id", ambiguous: true };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = `HTTP ${res.status}${body.error ? `: ${body.error}` : ""}`;
    if (res.status === 429 || res.status >= 500) return { kind: "transient", error: err, ambiguous: false };
    return { kind: "permanent", error: err };
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    return { kind: "transient", error: aborted ? `timeout after ${config.WHATSAPP_TIMEOUT_MS}ms` : `network error: ${(e as Error).message}`, ambiguous: true };
  } finally {
    clearTimeout(timer);
  }
}
