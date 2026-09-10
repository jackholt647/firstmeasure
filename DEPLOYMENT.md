# FirstMeasure: local development and production deployment

Operational handoff for Codex and maintainers. Baseline: September 8, 2026, after production cutover, provider repairs, and successful final database validation. Verify current inventory and configuration before acting. This guide is not an instruction to deploy automatically.

September 10: [production promotion record](deploy/digitalocean/production-promotion-20260910.md)
records production release `e35b8847eb42d390ba01d734f4b32bb5abe5611c`, signed
replacement image `244899309`, new web inventory, reboot/signature rehearsal and
runtime verification. The old six web hosts have been replaced. Current autoscale
range is 6–7 while retaining ten database connections of planning headroom;
the earlier 6–8 limit and launch IPs below are historical. Consult the promotion
record before changing capacity or rolling back.

September 9 live-incident follow-up: [503 and staff-page recovery](deploy/digitalocean/incident-20260909-503.md)
records the editor session-lock repair, PHP capacity adjustment, and production
readiness environment-file override. Preserve these during subsequent releases.

September 9 follow-up: see [bug-fix releases and verification](deploy/digitalocean/releases-20260909.md), including the unresolved autoscale replacement-code risk. The launch release below is historical, not the current active code.

September 9 capacity/release follow-up: [replacement release delivery](deploy/digitalocean/REPLACEMENT_RELEASES.md)
records the live database audit and the prepared signed private release channel.
The new production web activation guard requires the published channel to match
the staged artifact. This is prepared code, not an activated bootstrap: do not
declare 1M8-173 resolved or use old activation-script copies to bypass the guard.
One-time signing-key/image provisioning and real new-node rehearsal were
completed in the September 10 promotion record.

## Start here

- Develop locally, test in isolated development, then promote the exact tested release to production when authorized.
- Routine releases change code. They do not repeat the customer-data migration, archive integrity scan, or DNS cutover.
- Production is **https://app.1m8.ai**: `/portal/` for customers and `/measure/internal/` for technicians.
- The former `prerelease.1m8.ai` candidate became production. It is **not a sandbox**; its data is now live production data. Its former HTTPS certificate was replaced on port 443 by the app certificate. Use the production hostname.
- `dev.1m8.ai` is the separate development environment. Verify its current inventory, data isolation, and outbound restrictions before testing.
- The SSH alias `dev-sync-droplet` is a separate development/jump host, not the production cluster or the entire development environment.
- Migration is complete: all 11 frozen SQLite databases passed full integrity checks with zero errors. Production has new writes. Never rerun imports or reconcile live records against frozen source counts during a code deployment.

## First task before another release: consolidate the baseline

CI, release installation, activation, and verification scripts exist. A fully verified single-command fleet deployment pipeline does **not** yet exist.

The initial live release is `/opt/firstmeasure/releases/preprod-r1-20260907`; `/opt/firstmeasure/current` selects it. Migration-night repairs were applied directly to deployed code and host configuration. The existing main workspace contains substantial uncommitted work, including changes absent from newer worktrees.

Before the next release, compare deployed source with the existing workspace, preserve the fixes listed below, and produce a reviewed commit and complete release bundle. Do not deploy an older clean checkout merely because it builds. Do not reset, clean, or overwrite unrelated workspace changes. This documentation does not mean baseline reconciliation has already been completed.

Existing workspace: `C:\Users\jackh\Code\2026\FirstMeasure`.
Documentation task worktree: `C:\Users\jackh\.codex\worktrees\f78b\FirstMeasure`.

## The workflow

1. **Inspect and branch.** Read applicable instructions, inspect Git status, preserve unrelated changes, and identify the affected roles. Use a `codex/` branch unless the user specifies otherwise.
2. **Develop locally.** Use `./start-local.ps1` and `./stop-local.ps1`. Default web address: `http://127.0.0.1:8021`; API: `http://127.0.0.1:3111/v1`. Machine-specific paths are in ignored `local-stack.config.json`. See [README.md](README.md) and `deploy/local-cluster/compose.yml`.
3. **Test the change.** Run appropriate tests and exercise the affected workflow. `.github/workflows/ci.yml` runs smoke and PostgreSQL integration suites. Read current `public/v1/package.json` for commands. A health endpoint does not prove checkout, email, or PDF correctness.
4. **Test in development.** Deploy the exact version to isolated development with development data and provider settings. Keep its databases, storage, credentials, and sessions separate from production. Do not use the former prerelease environment as development.
5. **Prepare the release.** Record commit/release ID, changed roles, dependencies, database/configuration changes, validation, and rollback steps. Confirm the bundle includes PHP/editor assets as well as Node code. Keep secrets and runtime data out of source bundles.
6. **Activate within the user's authorization.** If production deployment is not authorized, finish preparation and present the concrete tested release first. Do not ask again when the session already authorizes it. Coordinate roles, database compatibility, and the autoscale template.
7. **Verify and record.** Verify release identity, actual process configuration, affected workflows, errors, and jobs. Record the outcome and limitations. Do not send test messages or create charges without authorization.

Typical instruction: “Fix this locally and deploy to development for testing; hold production.” After testing: “Deploy that tested release to production and verify it.” Codex handles the individual hosts.

## Architecture and inventory

Historical inventory below must be reverified. Web IPs change when the pool replaces nodes.

| Component | Launch baseline | Responsibility |
| --- | --- | --- |
| Web pool | Six 8-vCPU / 16-GB nodes; minimum 6, maximum 8 | Customer web/API traffic; 8 Node HTTP workers per node |
| Background worker | `146.190.169.59`, 16 vCPU / 32 GB | 8 job slots; PDFs, delivery, background jobs |
| Compatibility | `144.126.222.110`, private `10.124.0.9` | Internal/PHP editor, remaining stateful legacy services, sole platform heartbeat owner |
| Managed PostgreSQL | Database `firstmeasure`, production environment | Shared application data, queues and leases |
| Spaces | Production bucket/prefix from runtime configuration | Shared project artifacts |
| Load balancer | `24.144.68.104`, IPv6 `2604:a880:4:1d0:0:3:62d7:1000` | Public HTTPS and ready-node routing |
| Old frozen source | `64.23.235.5` | Preserved migration source, not active production |

Pool ID: `e1445028-df68-42ed-af43-6c24b16cddf0`.
Load balancer ID: `bb1ffcae-8b3d-448e-b5c0-e98e6b1da41b`.
Image at cutover: `244502867`, plus production bootstrap and browser/code repairs. The image alone is not the complete final configuration.

| Web droplet ID | Public IPv4 at cutover |
| --- | --- |
| 598678504 | 159.223.207.210 |
| 598678505 | 147.182.196.155 |
| 598678506 | 209.38.141.35 |
| 598678507 | 165.232.144.109 |
| 598678508 | 24.199.113.228 |
| 598678509 | 134.199.216.71 |

Services are `firstmeasure-web`, `firstmeasure-worker`, and `firstmeasure-legacy`. Compatibility is not named `firstmeasure-legacy-node`.

Web autoscaling does not increase worker, database, or compatibility capacity. PostgreSQL's launch connection limit was 100, with a planned usable budget of 87. Web pools were capped at 1 connection per Node process; worker/compatibility pools at 4. Recalculate demand before adding processes or overlapping fleets. The successful 6-to-8-to-6 scaling test covered synthetic read/PDF traffic, not every concurrent editing/ordering scenario.

## Access and configuration

Use the existing local SSH configuration. Never print, copy, upload, or transmit private SSH keys.

```powershell
ssh -n -T -J dev-sync-droplet -o BatchMode=yes -o UpdateHostKeys=no -o ConnectTimeout=15 -i C:/Users/jackh/.ssh/id_ed25519_firstmeasure_cluster_v2 root@144.126.222.110 'systemctl is-active firstmeasure-legacy'
```

Omit `-n` when piping a script to stdin. Use literal PowerShell here-strings or properly quoted scripts; never interpolate secrets into command text. The jump host normally uses account `dev` and project directory `/home/dev/code`. A request to sync files does not imply deletion or mirroring.

Verify new web IPs against DigitalOcean inventory before accepting new host keys. Do not disable host-key verification. The old source was administered through DigitalOcean's root browser console; do not assume cluster SSH access to it.

Runtime files live under `/etc/firstmeasure`. Inspect `systemctl show SERVICE -p EnvironmentFiles -p DropInPaths` for precedence, then verify the actual process. Do not dump full environments, provider JSON, credential-bearing NGINX configurations, or customer sessions.

- Shared overlay: `/etc/firstmeasure/production-cutover.env`.
- Provider file: `/etc/firstmeasure/provider-keys.json`; verify effective `PROVIDER_KEYS_PATH` and service-user permissions.
- Historical filenames `preproduction-runtime.env`, `preproduction-worker.env`, and `preproduction-compatibility.env` now configure production roles. Their names do not establish environment safety.
- Web bootstrap fetches the shared overlay privately from `http://10.124.0.9/__firstmeasure_bootstrap_20260908/production.env`, using Host `firstmeasure-production-bootstrap.internal`, VPC restrictions, and existing `x-firstmeasure-legacy-proxy` authentication. Never expose this endpoint publicly or print its response. Worker HTTP access was blocked; do not widen access merely to copy configuration.
- Keep credential locations and validation outcomes in documentation, never values.

## Release installation and rollout

Read [deploy/digitalocean/README.md](deploy/digitalocean/README.md) and the actual scripts. The following are building blocks, not a complete fleet deployment:

```bash
sudo bash deploy/digitalocean/install-release.sh COMMIT_SHA /path/to/release-source
sudo bash /opt/firstmeasure/releases/COMMIT_SHA/deploy/digitalocean/activate-release.sh COMMIT_SHA firstmeasure-web.service
```

These arguments are placeholders. Installation refuses a dirty Git checkout and requires its HEAD to match the release ID. Non-Git source bundles exclude credentials, dependencies, builds, and runtime storage. Installation runs dependency installation, type checking, build, and dependency pruning into a new directory without activation.

Activation switches `current`, restarts the selected service, and checks readiness. Failure triggers an attempt to restore the previous symlink and restart it. Verify recovery actually succeeds: this is not a database or fleet-wide transaction. Worker readiness uses its ready log message. Web/compatibility verification must use the actual listener; the default loopback port 3101 check may not suit every compatibility configuration.

Stage web releases first. Drain/withdraw one node, activate it, verify readiness and application behavior, confirm load-balancer reentry, then continue. Keep sufficient healthy capacity. Do not restart all six together. Worker changes must allow jobs to finish or safely relinquish leases. Compatibility changes can briefly interrupt internal/PHP features while web nodes remain available.

**Update the autoscale image/template/bootstrap to the intended release as well.** Otherwise new nodes can reintroduce old code. Pool configuration changes can replace the fleet and overlap old/new nodes; inspect the behavior and connection budget first. When changing template/image behavior, verify a newly provisioned node, not only a patched existing host.

Run database migrations once through a controlled process. Use additive/backward-compatible changes while old/new code coexist. Normal `POSTGRES_AUTO_MIGRATE` should remain false; web images must not contain database administrator credentials. Destructive schema changes need a separate data recovery plan.

## Production fixes future releases must preserve

### Browser and PDF runtime

Chromium is needed on web, worker, and compatibility hosts: instant PDFs can render inline on web nodes. Use `deploy/digitalocean/install-pdf-browser.sh` with the deployed Playwright dependency's browser revision, OS dependencies, and fonts. Verify under the real service account, supplementary groups, and service restrictions.

At launch, the browser was `chromium_headless_shell-1217` under `/opt/firstmeasure/browsers`, with `/usr/bin/chromium` pointing at its executable. Derive future revisions from the dependency lock rather than hardcoding this forever.

Preserve the `instant_pdf.ts` browser-context fix: the logo calculation inside `page.evaluate` uses `payload.layout.logoHeight`, not Node-only `REPORT_LOGO_HEIGHT_PX`. Preserve the deployed job lease/renewal/completion logic when reconciling source; older worktrees had older interfaces.

Worker `FIRSTMEASURE_PDF_RUNTIME_BASE_URL` is `https://app.1m8.ai/v1/firstmeasure/pdf-runtime`. This is an asset base, not an index/health endpoint. Validate it through native main/summary rendering.

### Worker and scheduled processing

Production worker: `FIRSTMEASURE_JOB_WORKERS=8`, empty `FIRSTMEASURE_JOB_TYPES` (all registered types), `EMAIL_OUTBOUND_DISABLED=0`, `PLATFORM_HEARTBEAT_DISABLED=1`.

Historical `zz-pdf-preview.conf` still loads `/etc/firstmeasure/pdf-preview.env` LAST. It now contains those production values and the app PDF URL. Preserve or deliberately consolidate it. Editing an earlier file alone may not affect the running setting. Do not restore the old PDF-only one-slot hold.

Exactly one heartbeat owner: compatibility `firstmeasure-legacy`. Its `zz-production-heartbeat.conf` loads `/etc/firstmeasure/production-heartbeat.env` with disabled flag `0`. Shared web bootstrap retains disabled flag `1` so scheduled work does not multiply with web nodes.

### Postmark credential and delivery status

The copied credential initially existed only in migration data, not the runtime lookup path. This caused a real failed send despite the migration email hold being removed.

Production now has `POSTMARK_SERVER_TOKEN` in the shared overlay and a fallback file at `/opt/firstmeasure/current/public/v1/storage/secrets/pm_server_token.txt`, readable by the service account. When changing `current`, preserve effective credential access through the external environment or securely provision the fallback. Never rely on a file that exists only inside the old release, or include secrets in source/public artifacts.

Live Postmark authentication and a real requested resend succeeded. Normal business release windows still apply. A completed `report.delivery` job may mean it scheduled a held report, not that it sent an email. Inspect `delivery.email_state.report_email.sent_ok`, provider result/message ID, and `report_sent_at`. Do not retry an accepted send without authorization.

### Stripe and PHP HTTPS forwarding

All eight production roles were verified with live mode and credentials matching the frozen source. Stripe read-only authentication and both configured prices returned live/active results. No real payment was created during this audit.

The live webhook includes `https://app.1m8.ai/measure/internal/server.php`, forwarding to Node's `/v1/platform/stripe-webhook-proxy`.

Compatibility NGINX must preserve HTTPS for PHP behind the load balancer. The deployed fix maps `$http_x_forwarded_proto` to `$fm_forwarded_https` (`https` to `on`, default `$https`) and sets `fastcgi_param HTTPS $fm_forwarded_https` after the FastCGI parameters include. Without it, the bridge called HTTP, received a redirect, and failed. The public negative-signature probe now returns HTTP 400 `Invalid signature`, proving routing/signature rejection, not a full payment test.

Preserve the compatibility PHP app API map: `$fm_preview_php_platform_base` maps `app.1m8.ai` to `https://app.1m8.ai/v1/platform`. Web proxies preserve original `X-Forwarded-Proto`. Do not replace deployed configuration with old loopback-only templates.

### Other provider/configuration checks

Google/Gemini and internal API keys resolved under the actual service user on all eight hosts; Telnyx, Meta, and Statsig credential variables were present. Presence does not prove every external operation works. Test the provider affected by a change using an appropriate non-destructive check.

Repository NGINX/systemd examples may predate these repairs. Reconcile hostname maps, TLS forwarding, secret permissions, browser provisioning, private routing, and configuration precedence before replacing live configuration.

## Verification, rollback, and DNS

Verify the intended release, process configuration, ready-node count, and affected workflow. For broad releases include authenticated customer/staff access, authorized representative save/submit behavior, native PDFs, queues, providers, and public Stripe routing. A login page returning 200 does not prove authenticated login; credential presence does not prove a transaction.

Keep the previous code release. Code rollback requires database compatibility and does not reverse migrations, email, charges, or edits. The frozen old server is not a lossless rollback target after new production writes. Preserve/reconcile those writes before any return to it; never automatically restart its writers or rerun imports.

Routine code releases leave DNS alone. The app subdomain is delegated to DigitalOcean; the parent `1m8.ai` remains at GoDaddy. App A/AAAA point to the load balancer, TTL 600. Managed certificate `app-1m8-ai-production-20260908` serves HTTPS443. An app certificate also remained on staging port 444; that is not the normal user endpoint.

## Recovery and evidence

Private chronological handoff: `C:\Users\jackh\.codex\recovery\firstmeasure-20260907\CURRENT-STATE.md`. Read newest entries first. Older migration documents contain superseded candidate/hold/pending-scan states. The recovery directory includes bootstrap and targeted repair/audit scripts; review before running, because some are one-time mutations.

Compatibility evidence under `/var/lib/firstmeasure-migration/final-20260908/`:

- `validation-readiness-current.json`: completed cutover and validation.
- `sqlite-validation-status`: `SQLITE_VALIDATED`; `sqlite-validation-private.json`: all 11 passed. Avoid printing private paths/customer records.
- `post-cutover-provider-audit.json`: live provider audit, also on other hosts.
- `lawndale-email-repair-validation.json`: accepted requested resend; do not replay.
- Private configuration archives and before-change backups: inspect selectively, never dump.

Worker `/var/cache/firstmeasure/production-pdf-runtime-validation.json` records native main/summary rendering through the production domain without application writes.

The `watch-firstmeasure-pre-sync` automation was paused after scan success. That completed watcher is not an ongoing production incident monitor. If monitoring is requested, define its checks, schedule, and notifications explicitly.

For subsequent deployments, update this guide or a linked release record with release/template IDs, configuration changes, verification, and outstanding work. Do not record secrets or customer data.
