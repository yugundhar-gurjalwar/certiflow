# Walkthrough: how to explain every part (for the 3 pm review)

## 1. The 60-second story
A centre uploads a spreadsheet -> it is validated completely or not at all -> two district officers must agree (large batches also go to the quality team) -> the state office gives final approval -> in **one transaction** the system records the decision, creates one certificate row per candidate and writes an outbox event -> a worker renders PDFs and sends WhatsApp messages with retries -> candidates download, employers verify, the state office can cancel -> everything is in an append-only audit trail and everyone sees changes live.

## 2. File map (read in this order)
| File | What it is | Say this |
|---|---|---|
| `server/src/db/schema.ts` + `drizzle/0000_init.sql`, `0001_guards.sql` | Tables, constraints, triggers | "The rules that must never break are in the database: unique candidate/number, one active certificate per person+course, append-only audit, no un-cancelling." |
| `server/src/domain/workflow.ts` | State machine as data + pure functions | "Quorum, which role owns which step, what comes next - testable without a DB." |
| `server/src/domain/csv.ts` | Spreadsheet validation | "Collects every error with row+column; pure; the DB is only touched if zero errors." |
| `server/src/domain/certNumber.ts` | `CF-2026-100245-K7QM` | "Sequence for uniqueness, HMAC check code so numbers can't be guessed and typos never hit the DB." |
| `server/src/services/approvals.ts` | **The most important file** | "One transaction: lock batch -> check step/role -> insert vote -> count -> advance -> audit -> outbox." |
| `server/src/services/batches.ts` | Create/import/submit/correct | "Import is one transaction holding the batch lock; submit starts a new round after a send-back (D-6)." |
| `server/src/services/certificates.ts` | Issue + cancel + download | "Rows created inside approval; PDF in worker; cancel = DB + tombstone + cache delete." |
| `server/src/services/deliveries.ts` + `whatsapp.ts` | Sending | "Atomic claim, idempotency key, classified outcomes, backoff with jitter, dead-letter." |
| `server/src/services/verify.ts` | Public verify | "Check code -> tombstone -> cache -> DB; no-store." |
| `server/src/services/escalation.ts` | Moment 5 | "UNIQUE index makes each escalation level fire once; time is a parameter for tests." |
| `server/src/jobs/{relay,handlers,sweeper,queues}.ts`, `worker.ts` | Event pipeline | "Outbox relay -> BullMQ -> idempotent handlers; the sweeper rebuilds work from Postgres." |
| `server/src/http/app.ts` | Routes, validation, errors, rate limits, webhook | "zod at every edge, role gate + scope in the query, errors never leak internals." |
| `server/src/http/sse.ts` | Live updates | "One-time ticket, per-role filtering, ids only." |
| `whatsapp-sim/src/sim.ts` | Hostile provider | "Idempotency, 500s, 429s, outage, accept-then-timeout, signed webhooks." |
| `web/src/pages/*` | UI | "BatchDetail is role-aware; live hook invalidates queries; no data in events." |
| `server/test/*` | Proof | "Each file is named after a moment or rule." |

## 3. Likely review questions
1. **"Two officers click approve at the same instant - what exactly happens?"** Both transactions reach `SELECT ... FOR UPDATE` on the same batch row; Postgres makes one wait. First inserts vote #1, counts 1 < quorum 2, commits. Second then acquires the lock, inserts vote #2, counts 2, advances status, writes audit + outbox, commits. A third arrival gets the lock, sees the status already moved, returns 409. Removing the lock fails the test.
2. **"Why not a version column / Redis lock?"** Version column needs retries and still races on the count; Redis lock is a second source of truth that can expire mid-transaction.
3. **"What if the process dies after the DB commit but before the queue?"** The outbox row is in the same commit; the relay publishes it later. At-least-once, and handlers are idempotent.
4. **"What if Redis is wiped?"** Queues are a hint. The sweeper (15 s) re-enqueues PENDING certificates and due deliveries from Postgres. Test: `FLUSHDB` + worker killed.
5. **"WhatsApp times out - did it send?"** Unknown, so we retry with the same Idempotency-Key = delivery id; the provider dedupes. Test: accept-then-timeout at 15 %; 60 phones, 60 messages. (Caveat: real providers may not honour idempotency keys - KNOWN_ISSUES #3.)
6. **"How do you stop two certificates for one person?"** Unique candidate_id, unique number, and a partial unique index on (course, phone) where not cancelled. The test inserts around the app and the approval rolls back.
7. **"How can a cancelled certificate never look genuine?"** DB trigger forbids reinstating; verify checks a revocation tombstone before the cache and falls back to the DB; `no-store`; hammer test during cancel; canary in DEPLOYMENT.md.
8. **"Why is the audit log trustworthy?"** Written in the same transaction as the change; trigger blocks UPDATE/DELETE/TRUNCATE; actor comes from the verified token only. Limits: superuser can disable the trigger, no hash chain (KNOWN_ISSUES).
9. **"Why do approvals reset on resend?"** Decision D-6: an approval is about specific data.
10. **"How do you prevent an officer from another district seeing a batch?"** `batchScope` is part of every query; out-of-scope = 404 (no existence leak). Tests use Sunita/Rohan.
11. **"Where could someone act as someone else?"** Actor comes from the JWT subject then a fresh DB lookup; body fields like `officerId` are ignored (test); forged/none/expired tokens -> 401.
12. **"What does the public see on verify?"** Name, course, centre, date. Test asserts the key set and absence of phone/email/score/ids.
13. **"How does escalation avoid firing twice with many instances?"** UNIQUE(batch, round, stage, level) + `ON CONFLICT DO NOTHING`; test runs 5 in parallel.
14. **"Why SSE and not WebSockets?"** One-way, proxies fine, auto-reconnect; the one-time ticket avoids JWTs in URLs.
15. **"Why this queue?"** BullMQ: Redis already needed; delays/concurrency/dedupe; volume ~8 jobs/s. Switch to SQS/Kafka only if several independent consumers need the events.
16. **"What scales and what limits throughput?"** See DEPLOYMENT.md section 4: worker CPU (PDF), then provider tier limits; measured 52/s locally.
17. **"What would you do with another day?"** KNOWN_ISSUES "next steps".
18. **"What did the AI do, what did you do?"** docs/AI_USAGE.md - be specific and honest.
19. **"Show me a bug you found."** The 500-instead-of-409 from wrapped DB errors; the SSE auth ordering; the 4-minute retry budget (evidence/mutation-check.md).
20. **"Is it really one command?"** `docker compose up --build`; say honestly whether you have run it on your machine (KNOWN_ISSUES top).
