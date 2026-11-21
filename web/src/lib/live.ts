import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Live updates without refreshing. The browser trades its login token for a one-time ticket, opens a
 * Server-Sent Events stream, and every event simply invalidates the relevant cached queries so they refetch
 * through the normal authorised API (events never carry data). If the stream drops it reconnects with backoff;
 * queries also refetch on window focus and every 30s, so the UI converges even if events are missed.
 */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let stopped = false;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout>;

    const connect = async () => {
      try {
        const { ticket } = await api.post<{ ticket: string }>("/events/ticket");
        if (stopped) return;
        es = new EventSource(`/api/events?ticket=${ticket}`);
        es.addEventListener("ready", () => { setLive(true); retry = 1000; });
        const refresh = (e: MessageEvent) => {
          let ev: { batchId?: string } = {};
          try { ev = JSON.parse(e.data); } catch { /* ignore */ }
          qc.invalidateQueries({ queryKey: ["batches"] });
          if (ev.batchId) { qc.invalidateQueries({ queryKey: ["batch", ev.batchId] }); }
          qc.invalidateQueries({ queryKey: ["ops"] });
          qc.invalidateQueries({ queryKey: ["notifications"] });
          qc.invalidateQueries({ queryKey: ["certs"] });
        };
        for (const t of ["batch.changed", "batch.submitted", "batch.updated", "certificate.issued", "certificate.cancelled", "delivery.updated", "escalation.raised", "notification"]) es.addEventListener(t, refresh);
        es.onerror = () => {
          setLive(false); es?.close();
          if (!stopped) timer = setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
        };
      } catch {
        setLive(false);
        if (!stopped) timer = setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
      }
    };
    void connect();
    return () => { stopped = true; clearTimeout(timer); es?.close(); setLive(false); };
  }, [enabled, qc]);

  return live;
}
