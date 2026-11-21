# Known issues, limitations, and next steps (honest list)

## Verification status of this repository
- **Docker Compose was NOT executed where this was written** (the sandbox had no Docker daemon). What *was* done: `docker compose config` validates; every Dockerfile step was reproduced natively (`npm ci`, `npm run build`, compiled `node dist/api.js|worker.js|seed.js` start and run against Postgres 16 + Redis 7, web production build). Treat the first `docker compose up --build` on a Docker machine as a smoke test; known risk areas: healthcheck commands, the `seed` -> `api` dependency ordering, and the test profile (`certiflow_test` database is created only when the Postgres volume is first created - run `docker compose down -v` once if you started an older volume).
- Tests: 74 passing against real Postgres 16 and Redis 7 (native). They have not been run inside the `test` container profile.
- No browser E2E suite in the repo. The UI was walked through headlessly (Chromium) during development; it found one real bug (see evidence/mutation-check.md) that now has an API-level test, but UI behaviour itself has no automated tests.

## Functional limits
1. **No reassign / force-advance for stuck batches.** The state office is alerted and sees the list, but if two district officers disagree (1-1) or are absent, a person must resolve it outside the system. Next step: delegate/"acting officer" role with a mandatory reason and audit.
2. **Rejected is final.** A centre must create a new batch (its candidates become free again because the cross-batch check only blocks live batches).
3. **State office cannot cancel a whole batch in one click** - only per certificate (the brief says certificate). Bulk cancel is a loop over the same transaction.
4. **Candidate link is a bearer link.** Anyone who gets the WhatsApp link can download that certificate; there is no expiry or OTP. Acceptable for a certificate that is meant to be shown to employers, but a regulator may want OTP-on-open.
5. **Verification shows the holder's name publicly** (decision D-12). A stricter policy could show initials + require the employer to type the name.
6. **Quality team sees all large batches state-wide** (no district partitioning inside the quality team).
7. **Spreadsheet:** first worksheet only; dates/format cells read as text; names with digits or symbols are rejected (deliberately strict; some real names will need the centre to adjust).
8. **No business-hours calendar** for escalation: 24 h is wall-clock.
9. **Cancelling after delivery cannot recall the WhatsApp message** (and does not send a "cancelled" notice); the PDF itself is not revocable once downloaded - verification is the control.

## Technical limits
1. **Audit log is append-only by trigger, not hash-chained.** A database superuser could disable the trigger. Next step: hash chain + periodic anchoring to S3 Object Lock.
2. **Local-disk certificate storage** behind a `Storage` interface; API and worker share a Docker volume. On ECS this must be S3 (DEPLOYMENT.md). The S3 adapter is not written.
3. **Provider idempotency is assumed.** The stand-in honours `Idempotency-Key`; real WhatsApp Cloud API does not document one. In production use the fallback: on an ambiguous failure, look the message up by our client reference (webhook receipts + a list call) before re-sending, or accept rare duplicates and de-duplicate in the BSP layer. `deliveries.provider_message_id` and signed receipts already exist for this.
4. **No send-rate limiter towards the provider** (token bucket). A 429 is handled with backoff, but a smarter pacing at the provider's tier limit would reduce wasted attempts (DEPLOYMENT.md: messaging tiers).
5. **Fixed-window rate limits** (Redis `INCR`), per IP / per user. A sliding window would be smoother. Behind a CDN the real client IP must be forwarded (`trust proxy` is set to 1 hop).
6. **Webhook replay**: signature is verified but no timestamp window; replays are harmless because transitions are monotonic and idempotent.
7. **One Redis**: queue + cache + pub/sub share an instance (fine at this volume; split if it ever matters). Redis must run with `maxmemory-policy noeviction` for BullMQ.
8. **Metrics gauges query Postgres on scrape** (cheap, indexed) - scrape every 30-60 s, not every second.
9. **Load testing** was one 1,000-certificate run on a shared 2-vCPU machine (~52 certificates/s end to end). DEPLOYMENT.md extrapolates; nothing was tested at 30,000/hour or with 10,000 concurrent users.
10. **Passwords/MFA:** demo-grade (no reset flow, no MFA, no lockout beyond rate limiting).
11. **Accessibility/i18n:** semantic HTML and labels, but no audit, English only.

## What I would do next (priority order)
1. Run the Compose stack on a clean machine and fix whatever it shows.
2. S3 storage adapter + presigned downloads; Terraform for the DEPLOYMENT.md layout.
3. Playwright E2E for the six moments through the UI.
4. Provider send-pacing + real BSP adapter behind the existing `sendWhatsApp` interface.
5. Acting-officer / reassign flow; hash-chained audit; OTP for candidate download.
