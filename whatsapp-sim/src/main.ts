import { createSim } from "./sim.js";

const port = Number(process.env.PORT ?? 4010);
const sim = createSim({
  webhookUrl: process.env.WEBHOOK_URL, // e.g. http://api:4000/webhooks/whatsapp
  webhookSecret: process.env.WEBHOOK_SECRET,
  config: {
    failureRate: Number(process.env.FAILURE_RATE ?? 0),
    timeoutRate: Number(process.env.TIMEOUT_RATE ?? 0),
    latencyMs: Number(process.env.LATENCY_MS ?? 0),
  },
});
sim.listen(port).then((p) => console.log(`whatsapp stand-in listening on :${p}`));
process.on("SIGTERM", () => void sim.close().then(() => process.exit(0)));
