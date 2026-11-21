# SETUP.md - from a fresh clone to a running system, demo data and passing tests

## Option A - Docker (the intended way; one command)
Prerequisites: Docker Desktop (Windows/macOS) or Docker Engine + Compose v2. Nothing else.

```bash
git clone https://github.com/yugundhar-gurjalwar/certiflow.git
cd certiflow
docker compose up --build
```

First start takes a few minutes (builds 3 images). When the logs settle:

| What | URL |
|---|---|
| **Application** (pick a persona) | <http://localhost:8080> |
| WhatsApp stand-in: candidate "phone" view + failure sliders | <http://localhost:4010> |
| API health / metrics | <http://localhost:4000/ready>, <http://localhost:4000/metrics> |

Demo data is loaded automatically (the one-shot `seed` service; it is idempotent). All demo users share the password `demo1234`:
**Anika** (training centre), **Dev / Meera / Kabir** (district officers, Hyderabad), **Neha** (quality), **Farah** (state office), plus **Rohan** (a centre) and **Sunita** (an officer) in *Warangal* to demonstrate isolation.

Seeded batches: a draft; one in district review with Dev's approval already given; a **large** one waiting for the quality team; one **sent back** to the centre; one **already approved** (its 20 certificates are issued and sent as soon as the worker starts); one in the other district.

### Run the automated tests (in containers)
```bash
docker compose --profile test run --rm test
```
Expected: `Test Files 10 passed (10)`, `Tests 74 passed (74)`. (Uses a separate `certiflow_test` database and Redis db 1; it never touches demo data.)

### Handy commands
```bash
docker compose logs -f api worker          # structured JSON logs
docker compose down                        # stop (keeps data)
docker compose down -v                     # stop and WIPE database, redis, certificates
docker compose run --rm seed               # re-run seed (no-op if data exists)
docker compose exec postgres psql -U certiflow certiflow
```
Port already in use? Change the left-hand side of the `ports:` entries in `docker-compose.yml` (8080, 4000, 4010). Windows: make sure Docker Desktop is running (WSL2 backend).

## Option B - run natively (for development)
Prerequisites: Node 22+, PostgreSQL 16, Redis 7 running locally.

```bash
# 1. databases
createdb certiflow && createdb certiflow_test

# 2. backend (API, worker, tests)
cd server && npm ci
export DATABASE_URL=postgres://postgres@localhost:5432/certiflow REDIS_URL=redis://localhost:6379
npm run db:migrate && npm run db:seed
npm run dev:api        # terminal 1  -> http://localhost:4000
npm run dev:worker     # terminal 2
# 3. WhatsApp stand-in (terminal 3)
cd ../whatsapp-sim && npm ci && WEBHOOK_URL=http://localhost:4000/webhooks/whatsapp WEBHOOK_SECRET=dev-webhook-secret npm run dev
# 4. web (terminal 4)  -> http://localhost:5173
cd ../web && npm ci && npm run dev
# 5. tests (any time)
cd ../server && npm test
```
On Windows use `set VAR=value` (cmd) or `$env:VAR="value"` (PowerShell) instead of `export`.

## Troubleshooting
| Symptom | Fix |
|---|---|
| Login page shows no persona cards | API not ready yet - wait for `api` to be healthy (`docker compose ps`) |
| Certificates stay "pending" | Worker not running: `docker compose logs worker` |
| Messages not arriving at the phone view | The stand-in has failure sliders - set them to 0 and click "Reset provider" |
| `certiflow_test` does not exist | The Postgres volume predates the init script: `docker compose down -v` once, then up again |
| Want to try the escalation quickly | See `docs/DEMO_SCRIPT.md` (one SQL line ages a batch) |
