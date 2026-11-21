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
> Read `server/src/services/approvals.ts` line by line and can explain why the lock, the unique index and the same-transaction count are all needed.
> Ran the six moments by hand in the UI.

