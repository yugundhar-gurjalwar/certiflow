# Demo script (video <= 2 minutes) + live-review cheat sheet

Open three browser windows: **(A)** <http://localhost:8080> (two profiles/incognito windows help), **(B)** the WhatsApp stand-in <http://localhost:4010>, **(C)** a terminal. Start with `docker compose down -v && docker compose up --build` so the seed is fresh.

## 2-minute video - strongest flows, in this order

| Time | Do | Say (one line) |
|---|---|---|
| 0:00-0:10 | Login page -> click **Anika** | "Six personas; every screen and API call is scoped to who you are." |
| 0:10-0:35 | **New batch** -> upload `samples/bad_rows.csv` -> red table | "Six bad rows: exact row and column, and **nothing was saved**." Upload `samples/good_batch_25.csv` -> **Send for approval** |
| 0:35-1:00 | In window 2 log in as **Dev**, approve; **Meera**, approve (do both quickly, or in two tabs at once) | "Two officers are needed. Clicking at the same moment moves the batch exactly once - there's a test that races them 25 times." Show the live update on another persona **without refresh** |
| 1:00-1:25 | **Farah**: approve the batch (or open the seeded large batch: Neha first). Open the stand-in at :4010, set **Accept-then-timeout 30 % + 500 errors 30 %**, approve a 60-row batch (`samples/large_batch_60.csv`), watch the certificates progress bar | "WhatsApp is hostile; every candidate still gets exactly one certificate." Type a phone from the batch into the phone view: one message, a download link |
| 1:25-1:50 | Copy a certificate number -> **Verify** page -> VALID. As **Farah**: Certificates -> **Cancel** with a reason. Refresh Verify | "Cancelled - the very next check says so; the cache can't hide it." |
| 1:50-2:00 | **Operations** page, **Audit trail** panel | "Every decision: who, when, request id. The log is append-only at the database level." |

## Moment-by-moment for the live review (3 pm)

1. **Bad spreadsheet:** Anika -> any draft -> upload `samples/bad_rows.csv`.
2. **Simultaneous approvals:** run the test live: `cd server && npx vitest run test/moment2_concurrency.test.ts`; then show the mutation evidence (docs/evidence/mutation-check.md).
3. **60 certificates / flaky WhatsApp:** stand-in sliders at :4010, approve `samples/large_batch_60.csv` (Dev + Meera -> Neha -> Farah). Or `npx vitest run test/moment3_delivery.test.ts`.
4. **Cancel -> verify:** as above.
5. **Escalation without waiting 24 h:**
   ```bash
   docker compose exec postgres psql -U certiflow certiflow -c "update batches set stage_entered_at = now() - interval '3 days' where name like 'Data Entry - Oct%'"
   ```
   Within 15 s Farah's bell shows an escalation, the Operations page lists it under "Stuck batches", and Meera/Kabir (who have not voted) get a reminder. Dev (who voted) does not.
6. **Send back and resend (D-6):** the seeded "Welding Fundamentals - Sep Batch" is already sent back (Dev had approved it; Kabir sent it back). Log in as **Anika**, open it, upload `samples/good_batch_25.csv` (it replaces the list) and **Resend**. Log in as **Dev**: the batch is now in **round 2** and his earlier approval is shown struck through as void; it needs two fresh approvals.
7. **Break things on purpose:** `docker compose stop worker` -> approve a batch -> certificates stay pending but the UI is instant -> `docker compose start worker` -> everything completes. Or `docker compose exec redis redis-cli flushall` mid-run.

## Questions to expect and where the answer is
See docs/WALKTHROUGH.md ("Likely review questions").
