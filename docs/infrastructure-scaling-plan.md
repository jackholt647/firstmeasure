# FirstMate Infrastructure & Scaling Plan

*Prepared July 31, 2026. Pricing verified against provider sources in July 2026 — re-verify at order time; cloud pricing moved a lot in 2026 (Hetzner +2–2.6x US, Wasabi +14%, DO switched to per-second billing).*

---

## 1. What you are actually running (architecture reality check)

FirstMate 2.0 is a **deliberately single-host monolith**, and the code says so explicitly:

- One Node/Fastify process on `:3101` serving all ~37 API modules (`public/v1/src/server.ts:26-30` hard-caps workers at 1).
- nginx in front; PHP is a thin session/rendering/proxy shell (75 active files, no framework, no MySQL — the `pdo_mysql` extension is enabled but unused).
- **Primary OLTP store is a filesystem JSON document store** (`platform/storage.ts`, ~50 collections: projects, customers, payments, proposals, documents, websites…) with a *process-local* compare-and-swap lock. This lock is the reason the process count is pinned to 1.
- **16 multi-tenant SQLite files** (work, stats, channels, communications, agents, payroll, etc.), all keyed by `organization_id` — one file per *module*, not per tenant.
- **In-process SSE hub** — one EventSource per browser tab, fan-out in process memory, no external broker (`platform/realtime.ts`).
- **All media on local disk**, served through Node via whole-file `readFile` into a Buffer. No object storage, no CDN, no streaming, no signed URLs. FirstMeasure projects average **~34 MB / ~460 files each** (GeoTIFF rasters dominate).
- **PDF generation spawns a fresh headless Chromium per request** at six call sites (FirstMeasure, documents, proposals, weather, code-reports) with no pool or concurrency limiter. ~150–300 MB RSS per browser. This is the #1 OOM/CPU risk under load.
- Background work = in-process timers, several of which sweep **O(all organizations)** every 5–15 seconds (`work/scheduler.ts`, `stats/sync.ts`, platform heartbeat). Fine at 3k orgs; breaks by ~50–100k.
- Video editing and call-recording mixing are **client-side** (no ffmpeg, no transcoding) — genuinely good news for server sizing. Voice/video media goes through LiveKit, not your box.
- External services already integrated: OpenAI (5 agents on gpt-5.6-sol high effort), Google Solar/Maps/3D Tiles, Gemini, AWS SESv2 + S3 (inbound mail), Postmark, **Telnyx** (SMS, not Twilio), Stripe, LiveKit, OpenSRS, **Cloudflare (DNS — you already have an account)**, Statsig, NOAA/FEMA/IEM.

**Consequence:** the right plan is *not* "move to Kubernetes." It is: (1) run the monolith on one very strong machine, (2) peel off the things that don't need to be on that machine (media bytes, PDF rendering, backups), and (3) do the specific refactors that unlock horizontal scale only when growth forces them. The architecture is actually well-shaped for an **org-sharded "cell" model** later, because nearly everything is keyed by `organization_id`.

---

## 2. Fix before launch (mostly software, nearly free)

### 2.1 Backups — existential, do this week
There are **no backups of any kind**. Storage is excluded from git and from the deploy snapshot; WAL files are never checkpointed. One disk failure on the droplet loses every tenant's data.

- Nightly `restic` (or borg) of `storage/` to Backblaze B2 (~$6/TB/mo) **and** a second copy to Cloudflare R2 or another region.
- Continuous SQLite replication with **Litestream** to B2/R2 for the 16 SQLite files (near-zero RPO, trivial to run under PM2/systemd).
- Add a scheduled `wal_checkpoint(TRUNCATE)` pass; WALs are already 10x the main DB for channels.sqlite in dev.
- **Do a restore drill.** A backup you haven't restored is a hypothesis.
- Cost: ~$10–50/mo at launch. This is the single highest ROI item in this document.

### 2.2 Media to object storage
Move `storeMediaUpload`/`readMediaFile` (`platform/storage.ts:1355,1733`) and FirstMeasure artifacts to **Cloudflare R2** (or B2), serve via signed URLs / Cloudflare CDN instead of buffering through Node.

- Removes unbounded disk growth from the app box (FirstMeasure alone ≈ 34 MB/project).
- Removes media bytes from your bandwidth bill forever (R2 egress is $0).
- The `@aws-sdk/client-s3` dependency is already in the tree (used for SES inbound) — R2 is S3-compatible, so this is a focused refactor of one module, not a rewrite.
- Add a lifecycle policy: archive or delete DSM/RGB GeoTIFF intermediates after report finalization → cuts ~34 MB/project to ~3–5 MB. **This is the single biggest long-term cost lever in the whole system.**

### 2.3 Chromium pooling / PDF offload
Put a concurrency-limited pool (e.g. max 2–4 browsers, queue behind it) in front of the six `chromium.launch()` sites. Later, move PDF rendering to a separate cheap worker box — it's stateless (render HTML → PDF → store) and is the easiest thing in the codebase to scale horizontally.

### 2.4 Small config fixes
- nginx `client_max_body_size 64m` vs Fastify `bodyLimit` 128 MB — uploads between 64–128 MB die at nginx. Reconcile.
- `worker_connections 1024` with 1 nginx worker caps ~500 concurrent SSE tabs. Raise both (every logged-in tab holds a connection open indefinitely).
- `storage/platform/sessions/` has no TTL sweeper — add one before it becomes millions of files.
- PHP and Node both open `crm/databases/leads.sqlite` in WAL mode from two runtimes (`measure/sales/firstmate-bridge/action.php:92`) — route the PHP side through the Node API.
- The deploy path (HMAC `sync.php` file writes + in-prod IDE) is a security surface and has no rollback. At minimum: IP-allowlist it, and keep a known-good snapshot to roll back to.

---

## 3. Scaling roadmap

### Stage A — Launch, ~3,000 companies (now → ~2 months)
**Topology:** 1 strong app box + 1 small worker/standby box + object storage + Cloudflare.

- **App box:** DigitalOcean dedicated-CPU droplet, 16 vCPU / 64 GB ($504/mo GP, or CPU-Optimized 16/32 at ~$336). You're already on DO: zero migration risk, per-second billing (since Jan 2026), instant resize. Sizing logic: ~15–30k users at 5–10% peak concurrency = 1.5–3k idle SSE connections (trivial for Node); the real constraint is PDF renders + sharp, which a pooled 16-core box handles at thousands of renders/hour.
- **Worker box:** 8 vCPU ($84–168) for PDF rendering, Litestream sidecar, and warm-standby duty (restore target for the backup drill).
- **Storage:** R2 at $15/TB (simplest — Cloudflare account already exists, $0 egress) or B2 at $6/TB + free egress via Cloudflare. Migrate existing media + new writes.
- **In parallel:** open and validate an OVHcloud US account (see §5 — their manual validation takes days; do it before you need it).

### Stage B — ~10,000 companies (months 2–6)
**Topology:** move steady-state compute to bare metal for price/perf; DO stays for burst/failover.

- **2× OVHcloud US Advance-5** (24c/48t Xeon 6527P, 128 GB, NVMe, ~unmetered US bandwidth) at $470 each: one primary, one hot standby/worker. Roughly 3x the compute per dollar vs hyperscalers, in US datacenters (Vint Hill VA / Hillsboro OR).
- **Software work that becomes mandatory here:**
  - Replace O(orgs) timer sweeps with indexed next-fire tables (the code already flags this at `work/scheduler.ts:58`).
  - Sessions out of flat files → SQLite/Redis.
  - Chromium fully off the app box.
  - Start the **document-store migration**: either (a) filesystem JSON → Postgres (jsonb) for the platform collections, or (b) commit to the cell model below and keep the FS store per-cell. Decide by month ~4.

### Stage C — ~100,000 companies (months 6–18)
Single-box vertical scaling runs out here (O(orgs) sweeps, one NVMe's IOPS, blast radius). Two viable paths:

1. **Cell architecture (recommended — least rewrite):** shard by organization. Each *cell* = one big bare-metal box running the entire monolith for a slice of orgs (e.g. 10–20k orgs/cell). A thin routing layer (Cloudflare Worker or nginx map: org → cell) in front. Nearly everything is already org-keyed, so the monolith runs unmodified per cell. Things that must become **central services** first: identity/auth + auth_index (logins span orgs), the internal CRM (`leads.sqlite`, `referrals.sqlite` — FirstMate's own data, not tenant data), the FirstMeasure drafting queue (your internal drafter staff work across all orgs), and cross-org billing. FirstMeasure's flat global project dir must be partitioned by org as part of the R2 move.
2. **Conventional re-platform:** Postgres (managed, HA) + Redis pub/sub for SSE + stateless app fleet behind an LB. More rewrite (the CAS document store and 16 SQLite modules all move), but more standard hiring/ops story.

Either way: media is already in R2, PDFs already on workers, so this stage is about the OLTP layer and the event fan-out only.

### Stage D — 1M companies
Cells scale linearly (~50–100 cells) with a central control plane (identity, billing, routing, fleet ops), or the re-platformed fleet scales conventionally. Storage is petabyte-class *unless* the GeoTIFF lifecycle policy from §2.2 is in place — that policy is worth ~10x on the storage bill.

---

## 4. Cost projections

Assumptions: avg 5 users/company, 5–10% peak concurrency, FirstMeasure ~5–10 reports/company/mo (the dominant storage driver — plug in your real number), GeoTIFF lifecycle policy in place from Stage B (34 MB → ~5 MB retained per report). Excludes OpenAI/LLM API spend (see §6). All monthly, USD.

| | Stage A: 3k cos | Stage B: 10k cos | Stage C: 100k cos | Stage D: 1M cos |
|---|---|---|---|---|
| Compute | $450–700 (DO 16vCPU + worker) | $940–1,400 (2× OVH Advance-5 + DO burst) | $4,000–8,000 (8–16 cells + central svcs) | $40k–80k (~50–100 cells) |
| Object storage | $50–150 (3–10 TB) | $150–450 (15–40 TB) | $1,200–4,500 (150–400 TB; B2 low end, R2 high) | $10k–40k (1.5–4 PB w/ lifecycle) |
| CDN / bandwidth | $0–25 (Cloudflare free/Pro) | $25–200 | $200–1,000 (Cloudflare Business or bunny) | $2k–8k |
| Backups/DR | $20–50 | $50–150 | $500–1,500 | $3k–10k |
| Email (SES @ $0.10/1k) | $10–30 | $30–100 | $500–1,500 | $3k–10k |
| Postgres/Redis (managed) | — | $60–250 | $500–1,500 | $2k–6k |
| Monitoring/misc | $0–50 | $50–200 | $500–1,500 | $3k–8k |
| **Total** | **~$550–1,000** | **~$1,300–2,700** | **~$7,500–19,500** | **~$65k–160k** |
| **Per company** | ~$0.20–0.33 | ~$0.13–0.27 | ~$0.08–0.20 | ~$0.07–0.16 |

Notes:
- Costs scale **sublinearly** with tenants; per-company infra cost roughly halves by 100k. Infra should never be your margin problem — the wildcards are storage retention policy (§2.2) and AI/SMS COGS (§6).
- SMS is a **per-tenant COGS**, not infra: Telnyx ~$0.005–0.01/segment + carrier pass-through, plus A2P 10DLC brand/campaign registration per tenant company (~$50 one-time + ~$2–10/mo per campaign, weeks of lead time). Model it into per-tenant unit economics; the code already has per-org messaging compliance profiles.
- Everything above is postpaid month-to-month — **zero upfront capital required at any stage** except optional OVH prepay discounts.

---

## 5. Providers: picks, payment terms, credit risk

### Recommended stack
| Layer | Pick | Why |
|---|---|---|
| Compute (launch) | **DigitalOcean** dedicated-CPU droplets | Already there; per-second billing; instant resize; monthly postpaid on card |
| Compute (steady state) | **OVHcloud US bare metal** (Advance line) | Best US price/perf after Hetzner's June 2026 US price collapse (2–2.6x hikes, and Hetzner sells **no** US dedicated servers anyway); commitments removed Aug 2025 — month-to-month |
| Object storage | **Cloudflare R2** ($15/TB, $0 egress) or **Backblaze B2** ($6/TB, free egress via Cloudflare) | Zero-egress kills the biggest surprise-bill vector; you already have a Cloudflare account for DNS. B2 = cheapest bytes; R2 = simplest ops. Same media on S3 at scale would cost ~10x+ due to egress |
| CDN | **Cloudflare** (free → Pro $20–25 → Business $200–250) | Already in stack |
| Email | **AWS SES** ($0.10/1k — cheapest at any scale) + Postmark for critical transactional | Both already integrated in `email/` |
| SMS | **Telnyx** (already integrated) | Comparable to Twilio economics; prepaid-style balance = built-in spend cap |
| Postgres (when needed) | DO Managed PG or Crunchy Bridge | $120–260/mo for real capacity; avoid RDS Multi-AZ (~2x for equivalent) until deep in AWS |
| Avoid | Hetzner US (post-hike, cloud-only, KYC rejection risk), AWS/GCP for general compute (1.5–2.5x all-in), Wasabi (90-day min duration + 1 TB min — bad for churny uploads) | |

### Payment terms & credit — the direct answers
- **Nobody credit-checks a card-paying self-serve account.** DO, AWS, Cloudflare, B2, OVH, Telnyx: valid card, monthly postpaid (OVH bills per-period at order). The only true credit review in the industry set is **GCP invoiced billing** (requires ≥1yr registered business, ~$40k/yr spend, credit line review) — and you don't need GCP.
- **No provider demands prepayment** to scale. Optional prepaid commitments (Wasabi reserved, B2 Reserve, OVH 12/24-mo) are discounts, not requirements — skip them until cash flow is boring. AWS's No-Upfront Savings Plans give ~30% off with $0 down if you ever run compute there.
- **Net terms later:** AWS net-30 via a support request once you have payment history (realistic at $5–20k/mo); Twilio-style committed contracts at ~$12k/yr; DO/OVH/Cloudflare via sales. Plan on a business credit card being the payment rail for year one — get one with a real limit now.
- **The actual growth blockers are quotas, not billing:**
  - **DigitalOcean tiers:** new teams start at 3 droplets / shared-CPU only; big jumps are manually reviewed. Your account has history — but pre-request a limit raise before launch week.
  - **SES:** sandbox → production request (~24h) → typically 50k emails/day starting quota → auto-raises with clean sending. Warm up weeks before you need 100k+/day; keep bounces <5%, complaints <0.1%.
  - **OVH US:** new-account order validation is manual (possible card-photo + ID selfie, weekday staff, days-to-a-week). **Open the account and validate it with a small order this month**, long before you depend on it.
  - **A2P 10DLC (Telnyx):** per-tenant brand/campaign registration takes days–weeks. Build the registration pipeline into tenant onboarding.
  - **AWS EC2/quotas** (if used): new accounts start at low vCPU caps; request increases 1–2 weeks ahead.
- **Surprise-bill exposure:** AWS/GCP are uncapped postpaid with complex egress pricing — the reason to keep them confined to SES. R2/B2 zero-egress + Telnyx balance + DO's simple flat pricing make the recommended stack naturally hard to blow up. Set billing alerts everywhere anyway.
- **Free money (apply this month, all compatible with being bootstrapped):** AWS Activate Founders $1k–5k credits (self-funded eligible); Google for Startups bootstrapped tier up to $2k; DigitalOcean Startups program (apply as "Other" affiliation — up to $100k for partner-referred, smaller solo awards).

---

## 6. Watch-outs beyond servers

1. **AI API spend will likely exceed your server bill.** Five agents run gpt-5.6-sol at *high* reasoning effort with 120–150s timeouts. Per-org daily limits exist (chat 500, comms auto-reply 200) — audit them against unit economics before 3k orgs hammer them, and add a global concurrency cap.
2. **The event log grows forever.** `work_events` (+ its 1:1 mirror in `stats_events`) has no retention policy and every module writes to it. Design an archival tier before Stage C.
3. **Channels row amplification:** one chat message writes to ~6–8 tables including duplicated FTS text and per-member read state. Fine for years; know that it's the fastest-growing row count.
4. **Full email bodies (text + HTML) live in `communications.sqlite`.** Fastest byte growth of the SQLite set — plan to move bodies to object storage with the media migration.
5. **`README_NODE.md` claims 8 workers by default; the code resolves 1.** Don't capacity-plan from the README.
6. **Single-region is fine for now** (US-only latency is acceptable from a VA or OR datacenter), but keep backups in a *different* provider+region than compute from day one.

---

## 7. This month's checklist

1. ☐ Backups: restic + Litestream → B2, restore drill (week 1)
2. ☐ Chromium pool/limiter in front of all six PDF call sites
3. ☐ nginx: raise `worker_connections`, reconcile 64m/128MB body limits
4. ☐ Media migration to R2 (start with new writes, backfill old)
5. ☐ GeoTIFF lifecycle policy for FirstMeasure artifacts
6. ☐ DO: pre-request droplet/limit increase
7. ☐ SES: production access + domain warm-up on firstmatemail.com
8. ☐ OVH US: open account, pass validation with a small order
9. ☐ Apply: AWS Activate Founders, Google bootstrapped credits, DO Startups
10. ☐ Business credit card with adequate limit as the payment rail
11. ☐ Session-file TTL sweeper; PHP→Node route for the shared leads.sqlite
12. ☐ Billing alerts on every provider account
