# AI usage

## Where AI was used
This project was built in a pair-programming session with **Claude (Claude Code)**, which the problem statement allows ("AI tools are allowed. You must understand and be able to explain every line you submit."). Concretely the assistant:
- proposed the architecture (outbox + BullMQ, row-locked approval transaction, DB-level safety triggers, sweeper for self-healing) and wrote the backend, the WhatsApp stand-in, the React UI, the Dockerfiles/Compose file, the tests and the documentation;
- ran the code, the test suite, a throughput benchmark and a headless-browser walkthrough while building, and fixed what they found.

## How the output was checked (not "it compiled")
| Check | What it showed |
|---|---|
| 74 automated tests against real Postgres/Redis, a real worker and a hostile provider stand-in | Moments 1-6 and never-happen rules 1-5 hold |
| **Mutation check**: removed the `FOR UPDATE` lock | Concurrency tests failed (2 of 6) - tests are not decorative (evidence/mutation-check.md) |
| Attacking the database directly in tests (duplicate inserts, `UPDATE audit_log`, un-cancelling a certificate) | The guards hold even if application code is wrong |
| Headless Chromium walk-through of the UI | Found a real bug (live-update stream blocked by auth) the API tests had missed -> fixed + tested |
| Throughput benchmark (`scripts/bench.ts`) | Measured ~52 certificates/s on a small shared box; used in DEPLOYMENT.md instead of guessing |
| Reading the docs for external claims | WhatsApp limits in DEPLOYMENT.md come from Meta's published documentation (throughput 80 mps default; unique-user messaging tiers), not memory |

Defects the assistant's first drafts contained, found by those checks and fixed: wrong error unwrapping (500 instead of 409), a retry budget of ~4 minutes, the SSE route ordering, noisy sample data (all listed in docs/evidence/mutation-check.md).

## What the AI got wrong or could not verify (read before trusting)
- It could **not** run Docker Compose in its environment (no Docker daemon). Compose files are syntax-validated and every build step was reproduced natively, but the first real `docker compose up` is untested.
- Real-provider behaviour (WhatsApp idempotency, template rules, pricing) is based on documentation and an assumption stated in KNOWN_ISSUES.
- Cost figures in DEPLOYMENT.md are estimates.

## What I (Yug) personally reviewed and changed
>  Gave the AI the problem statement and the constraints (deadline, stack, "explain every line").
> Chose to keep the project's decisions documented (docs/DECISIONS.md) so I could review them.
> Tried to run the Docker stack on my office laptop. Docker Desktop could not start (WSL2 / virtualization disabled), so the Compose stack is unverified by me. I am pushing and verifying in <Codespaces | native setup>.
>  Pushed the repository to GitHub myself.
> ### Reviewed: `server/src/services/approvals.ts` (the approval decision)
I studied this file and wrote up how it works. A decision on a batch runs as one database transaction:

1. Load the batch with a row lock (`SELECT ... FOR UPDATE`), so concurrent decisions on the same batch run one after another.
2. After the lock, re-check that the batch is in a review stage and that my role owns that stage. If not, the request is refused (403, or 409 if my step is already behind the batch).
3. Require a reason for reject or send-back.
4. Insert my vote. A unique index on `(batch, round, stage, officer)` stops the same officer voting twice in the same round. The round is part of the key so the same officer can vote again after a resubmission.
5. Count the votes for the current round and stage inside the same transaction.
6. If the quorum is reached, advance the status exactly once. On the final approval, create one certificate row per candidate in the same transaction.
7. Write the audit row and the outbox event in the same transaction, then commit.

Why each piece is needed: the lock stops two transactions from counting and advancing at the same time; the unique index stops double votes; counting in the same transaction stops a stale count; the outbox row stops "state changed but event lost".

### Reviewed: the six moments (how I plan to verify each)
- **1. Invalid spreadsheet:** the whole file is validated in memory first and every error is reported with row and column; the database is only touched when there are zero errors, so nothing is half-saved.
- **2. Concurrent approvals:** two officers approving at the same time advance the batch once; a third gets a 409.
- **3. 60-candidate batch:** certificate rows are created once, in the approval transaction. WhatsApp retries use an idempotency key, so retries cannot produce a second message for the same certificate.
- **4. Cancel then verify:** the database is the source of truth; cancelling deletes the cache entry and writes a revocation marker, so the next check says cancelled.
- **5. Stuck batch:** after the configured waiting time, the right people are notified exactly once and the state office sees the batch in its stuck list.
- **6. Send back and resend:** a resubmission starts a new review round; earlier approvals stay in history but no longer count (decision D-6 in `docs/DECISIONS.md`).

### Mutation experiment
_Not yet run. Fill in after running it:_ I removed `.for("update")` from `loadBatch` in `server/src/services/batches.ts` and ran `npx vitest run test/moment2_concurrency.test.ts`. Result: `<paste the failing test names>`. I restored the line and the tests passed again (`<paste the pass line>`).

### A decision I would change
_Pick the one you actually believe and delete the others._ I would change that a single officer can send a batch back (D-4). It avoids waiting days for a second officer, but it also lets one person stall a batch. I would keep one-officer send-back but add a rule that the state office is notified immediately when a batch is sent back more than once.
_(Alternatives: re-approval after a tiny typo fix costs every officer a click, so I would carry over approvals from officers whose data did not change; or add an acting-officer flow for a 1-1 split with only two officers.)_

### Not yet verified by me
- The Docker Compose stack: Docker Desktop would not start on my office laptop (virtualization disabled). I am verifying it in `<GitHub Codespaces | other>`.


