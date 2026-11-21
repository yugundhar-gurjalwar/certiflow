# DEPLOYMENT.md - taking CertiFlow to production

Target: AWS `ap-south-1` (Mumbai - data stays in India, lowest latency for the users). Nothing here is deployed; it is a plan with the reasoning, the load maths, and the failure behaviour. Where a number is **measured** it says so; everything else is an estimate to be re-checked with the AWS pricing calculator and a load test.

## 1. Load we are designing for

| Input (from the brief) | Derived |
|---|---|
| 100,000 registered users, ~10,000 daily active | ~30 requests/active user/day -> ~300k API requests/day -> **~3.5 req/s average**; assume 10 % of the day's traffic in the busiest hour and a 10x burst -> **~80 req/s peak** (mostly cheap reads) |
| Peak: ~500 batches approved in one hour = ~30,000 PDFs and ~30,000 WhatsApp messages | **~8.3 PDFs/s and ~8.3 messages/s sustained**; but approvals can cluster, so size for a **30,000-job burst** that must drain in minutes |
| Public verification: thousands/day in bursts | Say 5,000/day with bursts of **100 req/s for a few minutes** (a recruiter fair, a viral forged certificate) |
| 8,000 trainees/month | ~270 certificates/day on average - the 30,000/hour peak is an exceptional day (e.g. a statewide result release) |

**Measured on this repository** (`server/scripts/bench.ts`, one worker process with concurrency 10, API + Postgres + Redis + stand-in provider **all sharing one 2-vCPU sandbox**, provider with no failures): 1,000 certificates PDF-rendered, stored and "sent" in **19.3 s -> ~52 certificates/s end to end** (PDFs issued at 53/s). PDF + QR rendering is CPU-bound and dominates; the database work per certificate is ~4 small writes.

## 2. Architecture

```mermaid
flowchart TB
  user((Users)) --> CF[CloudFront + WAF]
  CF -->|static SPA| S3W[(S3: web assets)]
  CF -->|/api/*| ALB[Application Load Balancer<br/>idle timeout 3600s for SSE]
  ALB --> API1[API task]
  ALB --> API2[API task]
  subgraph ECS Fargate - private subnets, 2 AZs
    API1 & API2
    W1[Worker task] & W2[Worker task]
  end
  API1 & API2 --> PX[RDS Proxy]
  W1 & W2 --> PX
  PX --> PG[(RDS PostgreSQL 16<br/>Multi-AZ, PITR)]
  PG -.-> RR[(Read replica<br/>optional: verify fallback, reports)]
  API1 & API2 & W1 & W2 --> RD[(ElastiCache Redis<br/>primary + replica, noeviction)]
  W1 & W2 -->|PDF| S3C[(S3: certificates<br/>private, KMS, versioned)]
  API1 & API2 -->|authorised stream or 60s presigned URL| S3C
  W1 & W2 -->|HTTPS, via NAT| WA[WhatsApp BSP / Cloud API]
  WA -->|signed webhook| ALB
  API1 & API2 & W1 & W2 --> CW[CloudWatch Logs + metrics] --> AL[Alarms -> SNS -> on-call]
  SM[Secrets Manager] -.-> API1 & W1
```

**Event flow** (identical to the Compose stack): approval transaction (state + audit + outbox) -> relay -> BullMQ -> `generate` -> `certificate.issued` -> `send` -> provider -> webhook; Postgres is the source of truth and the sweeper rebuilds any lost work.

## 3. Where each component runs, and why

| Component | Hosting | Why |
|---|---|---|
| Web SPA | S3 + CloudFront (+ WAF) | Static files; global edge cache; ~free at this volume; no servers to patch. nginx in the Compose file only exists to make local one-command start work. |
| API | **ECS Fargate**, >= 2 tasks (0.5 vCPU / 1 GB) in 2 AZs behind an ALB | Stateless -> horizontal scaling and rolling deploys. Fargate avoids managing nodes; Kubernetes would be operational weight with no benefit for 3 services. ALB idle timeout raised for SSE. |
| Worker | **ECS Fargate**, >= 2 tasks (1 vCPU / 2 GB), same image, different command | Scales independently of the API on queue depth. Two tasks minimum so a crash/deploy never stops processing. |
| PostgreSQL | **RDS PostgreSQL 16 Multi-AZ** (`db.t4g.medium` to start, `m6g.large` if CPU > 60 %) + **RDS Proxy** | The system of record: needs transactions, row locks, partial unique indexes and triggers - the correctness rules live here. Multi-AZ = automatic failover; PITR for recovery. RDS Proxy absorbs connection storms from many tasks. |
| Redis | **ElastiCache Redis** (`cache.t4g.small`, primary + replica, Multi-AZ, `noeviction`) | BullMQ queues, verify cache, SSE pub/sub, rate-limit counters. Everything in it is rebuildable from Postgres (D-11), so it is sized small and treated as disposable-but-fast. |
| Certificate files | **S3** private bucket (block public access, SSE-KMS, versioning, lifecycle to Glacier after 12 months) | Cheap, durable, 11 nines. See section 6. |
| WhatsApp | A Business Solution Provider or Meta Cloud API with **approved utility templates** | Real messages need a verified business and an approved template. Throughput: default **80 messages/s per number** (up to 1,000), which is ~10x our peak. |
| Secrets / config | Secrets Manager + SSM Parameter Store -> ECS task env | No secrets in images or the repo. `DEMO_MODE=false`. |
| CI/CD | GitHub Actions: test (Compose `test` profile) -> build images -> push ECR -> ECS blue/green | Migrations run at container start under a Postgres advisory lock, so several tasks starting together is safe; expand/contract style migrations for zero-downtime. |
| IaC | Terraform | Reproducible environments (dev/stage/prod). |

## 4. Scaling

**What scales horizontally (just add tasks):**
- **API** - stateless; sessions are JWTs; SSE connections are spread across tasks and every task subscribes to the same Redis channel. ~2,000 concurrent SSE connections is a small load for a Node task.
- **Workers** - every component is concurrency-safe: the outbox relay uses `FOR UPDATE SKIP LOCKED`, deliveries are claimed with an atomic `UPDATE ... WHERE status IN (...)`, jobs have dedupe ids, escalations are guarded by a UNIQUE index. Scaling policy: target-track on `certiflow_queue_jobs{state="waiting"}` + `certiflow_deliveries{status=~"QUEUED|RETRY"}` (add a task per ~1,500 waiting jobs, max 8).
- **Verification reads** - served from Redis; fall back to Postgres (a primary-key join, ~2 ms); can be pointed at a read replica.

**What limits throughput at peak, in order:**
1. **Worker CPU (PDF + QR rendering).** Measured ~52/s on a shared 2-vCPU box; I plan on **10/s per 1-vCPU task** (5x safety). Peak need is 8.3/s, so **2 tasks already exceed peak**; 4 tasks give 40/s.
2. **The WhatsApp provider.** Technical throughput (80 msg/s default) is fine, but Meta also caps **how many unique users you may message first per rolling 24 hours** by tier (250 -> 2,000 -> 10,000 -> 100,000 -> unlimited, per business portfolio). A 30,000-messages-in-one-hour day needs the **100K tier** (or higher) *before* launch; at 8,000 certificates/month the average day fits a lower tier, but a statewide result release does not. Plan: verify the business, apply early, warm up. If we hit the cap the provider answers 429 / rejects; our retries back off for ~4 h and then dead-letter with a one-click re-queue, so we degrade to "slower", not "lost". (Sources: Meta's WhatsApp Business Platform throughput and messaging-limits documentation.)
3. **Postgres writes** - ~4 small writes per certificate + audit + outbox ~ 40 writes/s at peak: trivial for `db.t4g.medium`. Connection count is bounded by RDS Proxy.
4. **Outbox relay** - drains 200 rows per transaction in a loop; not a bottleneck below thousands/s.

**How a backlog clears:** if all 30,000 approvals land in one minute, 4 workers at 10/s = 40/s drain the generate queue in ~12.5 min, with the autoscaler adding tasks as depth rises (8 tasks = ~6 min). Sending runs in parallel with generation, throttled by the provider; failures retry with exponential backoff + jitter instead of hammering. Users are never blocked: approval returns in milliseconds and the UI shows live progress ("issued 412/600, on WhatsApp 380/600").

## 5. Failure handling

| Failure | What happens | Why nothing is lost / duplicated |
|---|---|---|
| **Worker crashes mid-job** | In-flight BullMQ job is retried by another worker; a delivery stuck in `SENDING` for > 60 s is reset to `RETRY` by the sweeper | Claims are atomic; provider dedupes by idempotency key; PDF write is atomic rename to a deterministic key. Tested. |
| **Redis restarts / loses data** | Queued jobs vanish; cache is cold; SSE reconnects; rate limits reset | Sweeper re-enqueues PENDING certificates and due deliveries within 15 s; job ids dedupe; cancelled certificates still verify as cancelled (DB). Tested by `FLUSHDB` mid-run. AOF persistence is enabled as a bonus, not a dependency. |
| **WhatsApp outage / slow / 429** | Certificates are still issued and downloadable; deliveries go `RETRY` with backoff (~4 h budget), then `DEAD` + alert | Slow provider never blocks users (calls have a 3 s timeout, run in workers). Recovery is automatic; leftovers re-queued from the Operations page. Tested: outage, accept-then-timeout, dead-letter + re-queue. |
| **Slow or failing database** | `statement_timeout` 15 s; API returns 5xx for affected requests, **no partial decisions** (single transaction); workers' jobs fail and retry | Outbox rows only get `published_at` after enqueue; failover (Multi-AZ, ~60-120 s) is survived by pool reconnect + retries. Alert on p95 latency, connections, CPU. |
| **API task dies** | ALB drains it; clients retry; SSE clients reconnect with backoff | Stateless. A decision either committed or did not. |
| **Duplicate request / double click / retry storm** | 409 with a clear code | Unique votes, row lock, idempotent issuance. |
| **S3 unavailable** | `generate` jobs fail and retry (5 attempts) then sweeper re-enqueues; certificates stay `PENDING` | Visible on the Operations page and alarm on "PENDING older than 10 min". |
| **Bad deploy** | ALB health checks (`/ready` checks Postgres + Redis) stop traffic to bad tasks; blue/green rollback | Migrations are additive (expand/contract). |
| **Region/AZ loss** | AZ: automatic (Multi-AZ everywhere). Region: restore from cross-region snapshot + S3 CRR; **RPO <= 5 min (PITR), RTO ~ 1 h** | Documented, not rehearsed. |

## 6. Certificate file storage and access control
- **Where:** private S3 bucket, `BlockPublicAccess` on, SSE-KMS, versioning, deny non-TLS; key = certificate number. Local-disk `Storage` interface in the repo is swapped for an S3 adapter (not written - KNOWN_ISSUES).
- **Who can read:** nobody directly. Every download goes through the API: **staff** pass the same object-level scope check as the batch (other districts get 404); **candidates** use an unguessable 192-bit token that exists only in the message sent to their own phone and unlocks exactly one certificate; **cancelled certificates return 410** to everyone and are never served again (the file is kept for evidence). The API either streams the object or returns a 60-second presigned URL after authorisation.
- **Integrity:** the PDF carries the certificate number and a QR to `/verify/<number>`; the number has an HMAC check code, so a forged number fails without a lookup; the database, not the PDF, is the authority on validity.
- **Retention:** keep >= 7 years (confirm with the mission's records policy); Glacier after 12 months; no deletion path in the application.

## 7. Monitoring and alerting
Already in the code: structured JSON logs (every line carries `requestId`, `batchId`, `certificateId`), `/health` and `/ready`, Prometheus metrics at `/metrics`, per-batch and per-certificate timeline endpoints (the audit trail), and the in-app Operations page.

| Signal | Source | Alert (page unless noted) |
|---|---|---|
| API errors / latency | `http_request_duration_seconds` | 5xx > 1 % for 5 min; p95 > 1 s for 10 min |
| Pipeline stuck | `certiflow_outbox_unpublished` | > 100 for 2 min (relay down) |
| Backlog | `certiflow_queue_jobs{state="waiting"}` | > 5,000 for 10 min (ticket: scale) |
| Certificates not issuing | PENDING older than 10 min | any (S3/worker problem) |
| Delivery trouble | `certiflow_deliveries{status="DEAD"}` / `RETRY` | DEAD > 0 (ticket); RETRY > 20 % of sends for 15 min (page: provider incident) |
| The original complaint | `certiflow_oldest_waiting_batch_seconds` | > 24 h (ticket to state office), > 48 h (page) |
| Escalations | audit action `escalation.raised` | informational digest |
| Infra | RDS CPU/connections/free storage/replica lag; Redis memory + evictions (must be 0); Fargate CPU/memory; ALB 5xx / unhealthy hosts | standard thresholds |
| Synthetic canary | every minute: verify a known-valid certificate (expects VALID) and a known-cancelled one (expects CANCELLED) | any mismatch = page (this is the "never show a cancelled certificate as genuine" guarantee, watched in production) |
| Security | WAF blocked requests, login rate-limit hits, 401/403 spikes | spike -> ticket |

Logs: CloudWatch Logs (14-30 days hot) -> S3; dashboards in Grafana/CloudWatch for the signals above. Tracing a single batch: `GET /api/batches/:id/timeline` for the business story, `requestId` in logs for the technical one.

## 8. Rough monthly cost (USD, `ap-south-1`, on-demand, approximate)

| Item | Sizing | ~USD / month |
|---|---|---|
| API tasks | 2 x Fargate 0.5 vCPU / 1 GB, always on | 45 |
| Worker tasks | 2 x Fargate 1 vCPU / 2 GB always on + ~10 extra task-hours on peak days | 85 |
| RDS PostgreSQL | db.t4g.medium **Multi-AZ**, 100 GB gp3, 7-day PITR | 140 |
| RDS Proxy | 2 vCPU of the DB | 25 |
| ElastiCache Redis | cache.t4g.small, primary + replica | 50 |
| ALB | 1 ALB + LCUs | 30 |
| NAT gateway | 1 (egress to WhatsApp, S3 via VPC endpoint) + data | 45 |
| S3 + CloudFront + WAF | < 5 GB of PDFs/month, light traffic, basic WAF | 20 |
| CloudWatch (logs, metrics, alarms) | ~20 GB logs | 30 |
| Secrets Manager, KMS, Route 53, ECR | | 10 |
| **Infrastructure subtotal** | | **~$480** |
| WhatsApp utility messages | ~8,000/month at a few INR each at most (rate card changes: **verify with the BSP**) | ~$10-30 + BSP fee |

**Trade-offs:** a lean pilot (single-AZ RDS, 1 API + 1 worker task, no RDS Proxy, no replica Redis) is ~**$200/month** but a failure means minutes-to-hours of downtime and manual recovery; for a state programme issuing certificates people rely on for jobs, Multi-AZ is worth the extra ~$280. Fargate costs ~20-30 % more than EC2 for the same CPU but removes node patching. If volume grows 10x the first things to change are: bigger/more workers (cheap), a read replica for verification and reports, and - only if several independent services need the same events - moving the outbox relay target from BullMQ to SNS/SQS or Kafka (the outbox pattern stays unchanged).

## 9. Pre-launch checklist
`DEMO_MODE=false`; real secrets; WhatsApp business verification + template approval + tier upgrade requested; S3 adapter; load test at 30,000 jobs; restore drill from PITR; alarm test (kill a worker, flush Redis, block the provider); WAF rules; seed no demo users; review `KNOWN_ISSUES.md`.
