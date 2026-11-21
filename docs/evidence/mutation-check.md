# Mutation check: do the concurrency tests actually catch the bug they claim to?

Procedure: temporarily remove the row lock in `loadBatch` (`.for("update")`) and run `test/moment2_concurrency.test.ts`.

```
sed -i 's/const \[b\] = lock ? await q.for("update") : await q;/const [b] = await q;/' src/services/batches.ts
npx vitest run test/moment2_concurrency.test.ts
```

Result **without** the lock:

```
 x two officers approving simultaneously advance the batch exactly once (repeated 25x)
 x three officers racing: two win, the late one gets a clean 409 and nothing is double-counted
 Tests  2 failed | 4 passed (6)
```

Result **with** the lock restored: `Tests 6 passed (6)`.

Other defects found by running things rather than reading code (all fixed, each with a regression test):

| Found by | Defect | Fix |
|---|---|---|
| `never_happen` test | Duplicate-certificate guard answered **500** instead of a clean 409: drizzle wraps driver errors, the code looked for the pg code on the wrong object | `db/errors.ts#pgError` unwraps `.cause` (also used in officer corrections) |
| `moment3` outage test | Default retry budget of 8 attempts at 2 s base = **~4 minutes**, so a 10-minute WhatsApp outage would dead-letter everything | 25 attempts, 5 s base, 15-min cap = ~4 h; arithmetic in DECISIONS D-10 |
| Real browser run (Playwright) | Live-update stream **always 401**: `/api/events` was registered after the bearer-token router, whose `authenticate` runs for every `/api/*` path | Route registered before the router; `realtime.test.ts` added |
| Real browser run | Sample "bad" spreadsheet had accidental duplicate rows, so the error list was noisier than intended | Samples regenerated with exactly six distinct, labelled defects |
