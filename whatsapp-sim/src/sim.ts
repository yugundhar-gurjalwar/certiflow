import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

/**
 * A deliberately unreliable stand-in for a WhatsApp Business provider. No dependencies (node:http only).
 *
 * Behaviours it models (each one is a real failure mode of real providers):
 *   - slow responses                       (latencyMs)
 *   - 500 errors, nothing recorded         (failureRate)
 *   - 429 rate limiting                    (rateLimitRate)
 *   - ACCEPT-THEN-TIMEOUT: the message is recorded but the response never arrives in time (timeoutRate).
 *     The caller cannot know whether it was sent -> this is what the Idempotency-Key protects against.
 *   - full outage (503)                    (outage)
 *   - permanent rejection for bad numbers  (numbers ending in 0000 -> 400)
 *   - asynchronous delivery receipts via signed webhook, some of which report failure (deliveryFailureRate)
 *   - idempotency: the same Idempotency-Key never produces a second message while the first one is not failed
 */
export interface SimConfig {
  latencyMs: number; failureRate: number; timeoutRate: number; rateLimitRate: number;
  outage: boolean; hangMs: number; deliveryDelayMs: number; deliveryFailureRate: number;
}
export interface SimMessage {
  id: string; to: string; text: string; documentUrl: string; clientRef: string;
  status: "accepted" | "delivered" | "failed"; acceptedAt: string; deliveredAt?: string;
}
export interface SimOptions { webhookUrl?: string; webhookSecret?: string; config?: Partial<SimConfig> }

const DEFAULTS: SimConfig = { latencyMs: 0, failureRate: 0, timeoutRate: 0, rateLimitRate: 0, outage: false, hangMs: 8000, deliveryDelayMs: 300, deliveryFailureRate: 0 };

export function createSim(opts: SimOptions = {}) {
  const cfg: SimConfig = { ...DEFAULTS, ...opts.config };
  const messages = new Map<string, SimMessage>(); // by idempotency key
  const stats = { requests: 0, accepted: 0, duplicatesSuppressed: 0, failures500: 0, rateLimited: 0, timeoutsInjected: 0, rejectedInvalid: 0, outageRejections: 0 };
  const timers = new Set<NodeJS.Timeout>();

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
    let data = ""; req.on("data", (c) => { data += c; if (data.length > 100_000) req.destroy(); }); req.on("end", () => resolve(data)); req.on("error", reject);
  });
  const later = (ms: number, fn: () => void) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  async function sendWebhook(m: SimMessage, status: "delivered" | "failed") {
    if (!opts.webhookUrl || !opts.webhookSecret) return;
    const body = JSON.stringify({ id: m.id, client_ref: m.clientRef, status });
    const sig = createHmac("sha256", opts.webhookSecret).update(body).digest("hex");
    try { await fetch(opts.webhookUrl, { method: "POST", headers: { "content-type": "application/json", "x-signature": sig }, body }); } catch { /* receiver down: real providers retry, we do not */ }
  }

  function scheduleDelivery(key: string) {
    later(cfg.deliveryDelayMs, () => {
      const m = messages.get(key);
      if (!m || m.status !== "accepted") return;
      const failed = Math.random() < cfg.deliveryFailureRate;
      m.status = failed ? "failed" : "delivered";
      m.deliveredAt = new Date().toISOString();
      void sendWebhook(m, failed ? "failed" : "delivered");
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        stats.requests++;
        const key = String(req.headers["idempotency-key"] ?? "");
        let body: { to?: string; text?: string; document_url?: string; client_ref?: string };
        try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid json" }); }
        if (cfg.latencyMs) await new Promise((r) => setTimeout(r, cfg.latencyMs));
        if (cfg.outage) { stats.outageRejections++; return json(res, 503, { error: "provider unavailable" }); }
        if (!key || !body.to || !body.text) return json(res, 400, { error: "missing idempotency-key, to or text" });
        if (!/^\+\d{10,15}$/.test(body.to) || body.to.endsWith("0000")) { stats.rejectedInvalid++; return json(res, 400, { error: "recipient is not a valid WhatsApp number" }); }

        const existing = messages.get(key);
        if (existing && existing.status !== "failed") { stats.duplicatesSuppressed++; return json(res, 200, { id: existing.id, deduplicated: true }); }

        const roll = Math.random();
        if (roll < cfg.timeoutRate) {
          // record it (the provider DID accept it) but make the caller wait past its timeout
          const m = record(body, key); stats.timeoutsInjected++; scheduleDelivery(key);
          later(cfg.hangMs, () => { if (!res.writableEnded) json(res, 202, { id: m.id }); });
          return;
        }
        if (roll < cfg.timeoutRate + cfg.failureRate) { stats.failures500++; return json(res, 500, { error: "internal error" }); }
        if (roll < cfg.timeoutRate + cfg.failureRate + cfg.rateLimitRate) { stats.rateLimited++; res.setHeader("retry-after", "1"); return json(res, 429, { error: "rate limited" }); }

        const m = record(body, key); scheduleDelivery(key);
        return json(res, 202, { id: m.id });
      }

      function record(body: { to?: string; text?: string; document_url?: string; client_ref?: string }, key: string): SimMessage {
        const m: SimMessage = { id: `wamid.${randomUUID()}`, to: body.to!, text: body.text!, documentUrl: body.document_url ?? "", clientRef: body.client_ref ?? key, status: "accepted", acceptedAt: new Date().toISOString() };
        messages.set(key, m); stats.accepted++;
        return m;
      }

      // ---- admin / inspection ----
      if (url.pathname === "/admin/config") {
        if (req.method === "POST") { Object.assign(cfg, JSON.parse((await readBody(req)) || "{}")); }
        return json(res, 200, cfg);
      }
      if (url.pathname === "/admin/stats") {
        const uniqueRecipients = new Set([...messages.values()].map((m) => m.to));
        return json(res, 200, { ...stats, uniqueMessages: messages.size, uniqueRecipients: uniqueRecipients.size });
      }
      if (url.pathname === "/admin/messages") {
        const to = url.searchParams.get("to");
        const list = [...messages.values()].filter((m) => !to || m.to === to).sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
        return json(res, 200, list.slice(-200));
      }
      if (req.method === "POST" && url.pathname === "/admin/reset") {
        messages.clear(); Object.keys(stats).forEach((k) => ((stats as Record<string, number>)[k] = 0)); Object.assign(cfg, DEFAULTS, opts.config);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return void res.end(PAGE); }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });

  return {
    server, cfg, stats, messages,
    listen: (port: number) => new Promise<number>((resolve) => server.listen(port, () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => { timers.forEach(clearTimeout); server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>WhatsApp stand-in</title>
<style>
body{font:14px system-ui;margin:0;background:#e5ddd5;color:#111}header{background:#075e54;color:#fff;padding:12px 16px;font-weight:600}
main{display:grid;grid-template-columns:320px 1fr;gap:16px;padding:16px;max-width:1000px;margin:auto}
.card{background:#fff;border-radius:10px;padding:14px;box-shadow:0 1px 2px #0002}label{display:block;margin:8px 0 2px;font-size:12px;color:#555}
input[type=range]{width:100%}input[type=text]{width:100%;padding:6px;box-sizing:border-box}.bubble{background:#dcf8c6;border-radius:8px;padding:8px 10px;margin:8px 0;max-width:90%;box-shadow:0 1px 1px #0002;word-break:break-word}
.meta{font-size:11px;color:#666;margin-top:4px}a{color:#075e54;font-weight:600}.row{display:flex;justify-content:space-between}code{background:#f1f1f1;padding:1px 4px;border-radius:4px}
button{padding:6px 10px;border:0;border-radius:6px;background:#075e54;color:#fff;cursor:pointer}</style>
<header>WhatsApp provider stand-in (demo) - candidate's phone view + failure controls</header>
<main>
<div class="card"><b>Failure controls</b><div id="ctl"></div>
<div class="row" style="margin-top:10px"><label><input type="checkbox" id="outage"> Full outage (503)</label></div>
<hr><b>Counters</b><pre id="stats" style="font-size:12px;white-space:pre-wrap"></pre><button onclick="reset()">Reset provider</button></div>
<div class="card"><b>Phone inbox</b><label>Candidate phone (E.164, e.g. +919876500001)</label><input type="text" id="phone" placeholder="+91..." oninput="load()">
<div id="msgs" style="margin-top:10px"></div></div></main>
<script>
const sliders=[['failureRate','Random 500 errors'],['timeoutRate','Accept-then-timeout'],['rateLimitRate','429 rate limit'],['deliveryFailureRate','Delivery receipt = failed']];
const ctl=document.getElementById('ctl');
sliders.forEach(([k,l])=>{ctl.insertAdjacentHTML('beforeend','<label>'+l+': <span id="v_'+k+'">0</span>%</label><input type="range" min="0" max="100" value="0" id="'+k+'">');document.getElementById(k).oninput=e=>{document.getElementById('v_'+k).textContent=e.target.value;push()}});
document.getElementById('outage').onchange=push;
async function push(){const b={outage:document.getElementById('outage').checked};sliders.forEach(([k])=>b[k]=document.getElementById(k).value/100);await fetch('/admin/config',{method:'POST',body:JSON.stringify(b)})}
async function reset(){await fetch('/admin/reset',{method:'POST'});location.reload()}
async function load(){const p=document.getElementById('phone').value.trim();const s=await (await fetch('/admin/stats')).json();document.getElementById('stats').textContent=JSON.stringify(s,null,1);
 if(!p){document.getElementById('msgs').innerHTML='<i>Enter a phone number</i>';return}
 const m=await (await fetch('/admin/messages?to='+encodeURIComponent(p))).json();
 document.getElementById('msgs').innerHTML=m.map(x=>'<div class="bubble">'+esc(x.text).replace(/(https?:\\/\\/\\S+)/g,'<a href="$1" target="_blank">$1</a>')+'<div class="meta">'+x.status+' - '+new Date(x.acceptedAt).toLocaleTimeString()+'</div></div>').join('')||'<i>No messages for this number</i>'}
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
setInterval(load,1500);load();
</script>`;
