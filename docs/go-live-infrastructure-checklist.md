# Go-Live Infrastructure Checklist

*A guiding framework, not a granular runbook. Each section = one area that must be stood up before serving large volumes. Source of truth for required credentials/services: `public/v1/src/config/env.ts` and `.env.example`.*

## 1. Object storage (media)
- [ ] Cloudflare R2: create account bucket(s), generate S3-compatible keys ($15/TB, $0 egress)
- [ ] Point the media module at R2 (S3 SDK already in the tree) + serve via signed URLs / Cloudflare instead of buffering through Node — fixes video playback memory risk at the same time
- [ ] Backfill the existing 3TB volume into R2, then drop the $300/mo DO volume
- [ ] Lifecycle policy: archive/delete FirstMeasure GeoTIFF intermediates after report finalization (34MB → ~5MB per project)

## 2. Backups & disaster recovery
- [ ] Nightly restic backup of all `storage/` to Backblaze B2 (separate provider from primary storage on purpose)
- [ ] Litestream continuous replication for the 16 SQLite databases
- [ ] Scheduled WAL checkpointing (nothing checkpoints today; WALs grow unbounded)
- [ ] One full restore drill onto a scratch droplet before launch — non-negotiable

## 3. Email (Cloudflare Email Service)
- [x] Enable Email Sending and configure DKIM/SPF/DMARC on firstmatemail.com
- [x] Deploy the inbound Worker with R2, Queue, and dead-letter queue bindings
- [ ] Deploy the V1 Cloudflare email integration and matching shared secrets, then enable the Email Routing catch-all
- [ ] Add an R2 lifecycle policy and verify one real lead import end to end
- [ ] Bounce/complaint webhooks feeding suppression + per-tenant sending limits (one bad tenant list must not poison platform reputation)
- [ ] Postmark live token for OTP/critical transactional only

## 4. SMS (Telnyx)
- [ ] Telnyx account funded, live API key, webhook endpoint reachable
- [ ] A2P 10DLC: platform brand registered + per-tenant campaign registration built into tenant onboarding (days–weeks lead time; real per-tenant cost)
- [ ] Confirm per-org daily limits and the $100/day spend cap match launch expectations

## 5. Calls / video (LiveKit — not set up yet, needs building)
- [ ] LiveKit Cloud account (or self-hosted SFU): set `LIVEKIT_URL` / API key / secret, `CALLS_PROVIDER=livekit`
- [ ] Verify huddles + calls end-to-end through LiveKit in prod — the fallback provider is P2P with no TURN and will fail for field crews on LTE
- [ ] Understand LiveKit per-participant-minute billing as a COGS line; recording uploads flow through the media path (→ R2)

## 6. Customer websites & domains
- [ ] Cloudflare API tokens live; sites.firstmatehosting.com CNAME target configured
- [ ] OpenSRS account funded for tenant domain registration
- [ ] TLS issuance for tenant custom domains (Cloudflare for SaaS custom hostnames or certbot automation) — verify, this is easy to miss
- [ ] nginx `/sites/` routing confirmed on prod

## 7. Payments
- [ ] Stripe live keys + both webhook endpoints (portal subscriptions, FirstMeasure per-report billing) registered against prod URLs
- [ ] Webhook signature verification confirmed in live mode

## 8. AI & external APIs (quota + billing, not just keys)
- [ ] OpenAI: production key, usage-tier/rate limits raised for 5 agents + transcription at 3k-company volume, monthly budget alert
- [ ] Google: Maps/Solar/3D Tiles billing + quota headroom (Solar API is per-request — this scales with report volume), Gemini key
- [ ] Audit per-org AI daily caps (chat 500, comms auto-reply 200) against unit economics
- [ ] Statsig + Meta CAPI keys if those features ship at launch

## 9. Server & app configuration
- [ ] Flip delivery-mode kill switches to live: `EMAIL_DELIVERY_MODE`, `COMMUNICATIONS_DELIVERY_MODE`, `DOMAINS_DELIVERY_MODE`, `DOMAIN_INFRASTRUCTURE_MODE` (all default to capture/test — silent no-op if forgotten)
- [ ] Full prod `.env` audit against `env.ts` — every key above present
- [ ] Chromium concurrency pool in front of all 6 PDF call sites; Chrome/Chromium binary installed on host
- [ ] nginx: raise `worker_connections` (SSE holds one per tab; template caps ~500), reconcile 64MB/128MB body-size mismatch
- [ ] Session-file TTL sweeper; route PHP's direct leads.sqlite access through the Node API

## 10. Security hardening
- [ ] Lock down sync.php / ide.php / api.php (IP allowlist at minimum — they are remote file-write + in-prod IDE surfaces)
- [ ] Cloudflare proxy in front of app.1m8.ai (DDoS, rate limiting, WAF)
- [ ] Firewall: only 80/443 public; Node :3101 loopback-only confirmed
- [ ] Secrets rotation + stored outside the web root; fresh `auth_users.json` credentials

## 11. Observability & alerting
- [ ] Uptime monitoring + alerting (external probe on app + API health)
- [ ] Disk, memory, CPU alerts on the droplet (memory especially — Chromium + media buffers)
- [ ] Error tracking/log rotation for Node + PHP (current log is a single unrotated file)
- [ ] Billing alerts on every provider account (DO, AWS, Cloudflare, B2, Telnyx, OpenAI, Google)

## 12. Accounts, quotas & money
- [ ] DigitalOcean: pre-request droplet/limit increase for launch headroom
- [ ] OVHcloud US: open + validate account now with a small order (steady-state compute later)
- [ ] Apply: AWS Activate Founders, Google bootstrapped credits, DO Startups
- [ ] Business credit card with adequate limit as the payment rail

## 13. Deploy, rollback & launch readiness
- [ ] Rollback path: known-good code snapshot + documented restore procedure (current deploy has none)
- [ ] Staging/smoke environment that exercises the full env (even a $50 droplet)
- [ ] Load test the ugly paths: PDF render burst, concurrent video playback, few-thousand SSE connections
- [ ] One-page incident runbook: restart procedure, restore procedure, provider status pages, who to call
