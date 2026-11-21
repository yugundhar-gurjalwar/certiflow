# Decisions log

Each decision: what was unclear -> what I chose -> why -> what I rejected -> where it is enforced/tested.

## D-1 Quorum for district decisions
- **Unclear:** "a district decision needs MORE THAN ONE officer to agree".
- **Chose:** `DISTRICT_QUORUM = 2` *distinct* officers (env, minimum 2). Approve **and** reject need the quorum. Quality and state decide alone (one person each).
- **Why:** Smallest number that satisfies "more than one"; the demo has three district officers (Dev, Meera, Kabir) so a third can break ties.
- **Enforced:** `domain/workflow.ts#quorumFor/outcomeOf`; UNIQUE(batch, round, stage, officer) stops one person counting twice. Tests: `unit`, `moment2`.

## D-2 What is a large batch
- **Chose:** `LARGE_BATCH_THRESHOLD = 50` candidates (env). Computed at upload and at submission; large batches go DISTRICT -> QUALITY -> STATE, small ones DISTRICT -> STATE.
- **Why:** The brief only says "big". 50 keeps the demo data small enough to show both paths. It is a business rule that belongs in config, not code.

## D-3 Concurrency control for approvals (moment 2)
- **Chose:** one transaction per decision: `SELECT ... FOR UPDATE` on the batch row -> re-check step and role **after** the lock -> insert vote (unique index) -> count -> advance -> audit -> outbox. Commit.
- **Why:** The lock makes every decision on a batch strictly sequential, so "count votes, then advance" cannot interleave. The first of two simultaneous approvals sees 1 vote and waits; the second sees 2 and advances; a third finds the batch already moved and gets 409 `ALREADY_ADVANCED`.
- **Rejected:** optimistic `version` column (needs retry loops and still needs a lock to be safe when counting); Redis distributed lock (second source of truth that can expire mid-transaction); serializable isolation (retries everywhere).
- **Proof:** 25-iteration race test; **deleting the lock makes it fail** (docs/evidence/mutation-check.md).

## D-4 Mixed votes, reject, send back
- Send back: **one** officer, reason required, immediate. It is reversible and cautious, and waiting for a second officer would recreate the "sits for days" problem.
- Reject: terminal, so it needs the same quorum as approve. 1 approve + 1 reject = pending; the third officer decides. If the district only has two officers and they disagree, the batch stalls and **escalation (D-13)** makes the state office aware. (Known limit: no reassignment tool - KNOWN_ISSUES.)

## D-5 State office powers
- Decides only at STATE_REVIEW. Cannot approve at district/quality ("acting at a step that isn't yours" is a never-happen). Can cancel any certificate, re-queue dead deliveries, and sees stuck work. Enforced by `STAGE_ROLE` after the row lock, so even a forged request cannot skip a step.

## D-6 Approvals after send-back and resend (moment 6) - the deliberate decision
- **Chose:** a resubmission starts a **new review round** (`batches.round + 1`) at the **district** stage. Votes are tagged with their round; only the current round counts. Old votes stay visible (struck through in the UI) and in the audit log, with the count of voided approvals recorded on the `batch.resubmitted` event.
- **Why:** An approval attests to a specific list of people. After the centre re-uploads, the list can be entirely different. Carrying approvals over would let a batch collect "approved" stamps and then be swapped for something nobody reviewed.
- **Also (D-6b):** if an officer **corrects a typo** during review, the round is bumped too, so votes already cast stop counting - reviewers approved different data.
- **Rejected alternatives:** (a) keep approvals if the diff is small - needs a definition of "small" and invites gaming; (b) keep approvals of officers whose rows did not change - correct in theory, complex to explain and audit. Cost of the chosen rule: officers re-approve. Acceptable: re-approval is one click.
- **Proof:** `moment6_sendback`.

## D-7 Spreadsheet import (moment 1)
- All-or-nothing: the **whole** file is validated in memory (every error collected, capped at 500), the database is touched only when there are zero errors, and then everything is written in **one transaction** that also holds the batch row lock. Import **replaces** the draft's list (the spreadsheet is the source of truth; the fix loop is "edit file, upload again").
- Rules: required columns, unknown/duplicate columns, 3-30 char enrolment no., names limited to letters/space/`.'-` (which also kills spreadsheet formula injection), Indian mobile normalised to +91, optional email, score 0-100 and **>= course pass mark** (only passed candidates), duplicates within the file, and phone already in another live batch for the same course. Max 2000 rows / 2 MB. CSV and XLSX.

## D-8 "A candidate must never get two certificates / two certificates sharing a number"
Three independent layers, all in the database:
1. `certificates.candidate_id UNIQUE` - one per candidate row.
2. `certificates.number UNIQUE`, numbers drawn from a **sequence** (never computed from a count) + an HMAC check code.
3. Partial unique index on `(course_code, phone) WHERE status <> 'CANCELLED'` - one **active** certificate per person per course across batches. Import checks it politely; the index catches races and bypasses (a test inserts rows directly and the approval is rolled back with 409 `DUPLICATE_CERTIFICATE`).
Certificate creation uses `ON CONFLICT DO NOTHING`, so replays are no-ops.

## D-9 What happens synchronously vs. asynchronously
- Synchronous (in the approval transaction): deciding, creating certificate **rows** (PENDING) and numbers. Fast (one insert per candidate), and it means the decision and the right to a certificate are atomic.
- Asynchronous: PDF rendering, storage, WhatsApp. Slow or flaky work never blocks a user.

## D-10 Delivery semantics ("exactly one certificate on their phone")
- One `deliveries` row per certificate (UNIQUE). A send is claimed with an atomic `UPDATE ... WHERE status IN (QUEUED, RETRY)`, so two workers cannot send the same one.
- **Timeouts are ambiguous** (provider may have accepted). So every request carries `Idempotency-Key = delivery id`; the provider dedupes. Retrying is therefore safe by construction. (A real provider's idempotency behaviour must be confirmed - see KNOWN_ISSUES; fallback is "lookup by client reference before retry".)
- Outcomes: 2xx -> SENT; 5xx/429/timeout/network -> RETRY (exponential backoff, +-50 % jitter, cap 15 min); 4xx -> FAILED_PERMANENT; budget exhausted -> DEAD.
- **Budget:** 25 attempts, base 5 s doubling to 15 min: 5+10+20+40+80+160+320+640 s, then 17 x 15 min ~= **4.6 h** (jitter makes it 3.5-4.6 h). The first draft had 8 attempts at 2 s base = ~4 minutes, which a test showed would dead-letter everything in a normal outage.
- A cancelled certificate is **never sent**: the cancel marks queued deliveries SKIPPED and the sender re-checks the certificate status after claiming.
- A webhook "delivered" is monotonic (SENT -> DELIVERED); "failed" re-opens the delivery for another attempt.

## D-11 Redis is a hint, Postgres is the truth
Queued jobs, cache, pub/sub and rate-limit counters may all be lost. The sweeper (every 15 s, on every worker) re-enqueues: PENDING certificates, due RETRY/QUEUED deliveries, stale SENDING claims (>60 s), and runs escalation. Job ids (`gen_<cert>`, `send_<delivery>`, `ob_<outbox>`) dedupe, handlers are idempotent. Tested by wiping Redis and killing the worker mid-run.

## D-12 Public verification
- Reveals: valid/cancelled/not found, holder name, course, centre, issue date. A public verifier needs the name to be useful (it is printed on the certificate too); everything else is withheld.
- Check code first (typos/scans never reach the DB), then tombstone, then cache (60 s), then DB. `Cache-Control: no-store`. Per-IP rate limit.
- Cancel: DB update + audit + outbox in one transaction; **then** delete the cache entry and write a 30-day revocation tombstone; the relay repeats this idempotently if the process dies in between. A verify racing a cancel re-checks the tombstone after writing the cache. If Redis is lost entirely the DB answers (still CANCELLED).
- Not-found and "bad check code" return the **same** answer so scanning leaks nothing.

## D-13 Escalation (moment 5)
- Clock = `stage_entered_at` (reset on every stage change and send-back). Level 1 at 24 h: reminder to the officers **who have not yet voted** (or the quality/state team) + heads-up to the state office. Level 2 at 48 h: URGENT to the state office. `UNIQUE(batch, round, stage, level)` makes each level fire exactly once no matter how many schedulers run (tested with 5 racing). The state office additionally has a live "stuck" list and a metric `certiflow_oldest_waiting_batch_seconds` for alerting.
- `runEscalations(now)` takes the time as a parameter so tests travel in time instead of sleeping.

## D-14 Live updates
SSE with a **one-time 30-second ticket** (EventSource cannot send headers; putting the JWT in a URL leaks it into logs). Events are filtered per role/scope on the server and carry ids only. Clients reconnect with backoff and also refetch on focus and every 30 s, so a missed event only delays a refresh.

## D-15 Authentication and authorisation
- Login with email + password (scrypt). JWT (HS256, 8 h) with only the user id; the user row is re-read every request. `DEMO_MODE=true` exposes a persona picker for reviewers; **set false in production** (the endpoint then returns 404).
- Two layers: route-level role gate, and **object-level scope** in the query itself (`batchScope`), so there is no code path that forgets to check.
- Candidates have no account; their WhatsApp link holds an unguessable 192-bit token for exactly one certificate.

## D-16 Audit
Every state change writes an audit row **inside the same transaction** (actor id/name/role, action, details incl. before/after, request id, time). A DB trigger rejects UPDATE/DELETE/TRUNCATE. System actions are attributed to `system:worker` / `system:scheduler`. Failed attempts leave no "success" record (tested). Not hash-chained (next step).

## D-17 Things deliberately left out
No Zustand/React-Hook-Form/shadcn/Kafka/RabbitMQ/GraphQL/Kubernetes: each would be a tool added to tick a box. The one extra service (`whatsapp-sim`) exists because the brief demands a provider stand-in.
