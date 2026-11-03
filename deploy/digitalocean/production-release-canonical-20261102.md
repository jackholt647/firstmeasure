# Production release from canonical: live since November 3, 2026, 02:53 UTC

This is the first production release cut from canonical since production moved to `production-live` on October 26. Jack said go on November 2 (evening, PST); it is live on all 8 hosts. Outcome below, under "Released".

**To update the candidate, change this table and re-run "Build the candidate".**

| | Commit | Note |
| --- | --- | --- |
| Canonical (platform) | `CANON_SHA` (`e05b5f5b` on Nov 2 00:30 UTC, with the feature flag console API and keys; take the tip at go time) | `devpush/codex/consolidated-firstmeasure-20260923` |
| Lane (editor) | `LANE_SHA` = **`a64f67a7`** (Nov 2 20:35 UTC: student progress per curriculum and FM-320). **Not the lane tip:** editor modeling work from `4691f0fe` onward (line centers in plane mode, ground arc selection, repeat extrusion of curved faces, extruding floating lines and curves) stays on dev until Jack releases it as a batch. A tracker FirstMeasure bug fix that lands on the lane after `a64f67a7` must be cherry-picked onto the candidate, not taken with the tip. | `devpush/lane/measure-internal` |
| Candidate | `CANDIDATE_SHA` | The commit from "Build the candidate" |
| Production today | `51c70f907423ed8245495838a9939908f7038700` | Compat and worker checked Nov 3 01:15 UTC; production-live `c03bca5d`. Two tracker hotfixes after this record was written, both already in lane `a64f67a7`: FM-309 `f9c88a71` (users export country, lane `72f3a91a`, same file hashes) and FM-320 `51c70f90` (lane `a64f67a7`, every added line present) |
| Rollback | `51c70f90…`, channel archive `eb8a98be95df042cd874ba1c8e00be7eb4c100db07ee6e689fe06ab932d84b60` | Kept on every role (record: `production-hotfix-20261102-51c70f90.md` on production-live) |

## Build the candidate

**Canonical alone must not be released.** Its `public/measure/internal` stopped at October 27: the editor lives on the lane. A canonical tree would drop the Exteriors engine, `wall_stickers.js`, and FM-305, 310, 311, 312, 313, 318 and 319. Dev runs exactly this pairing: canonical's platform with the lane's editor.

```bash
git fetch devpush
git switch -c release/prod-canonical-20261102 CANON_SHA
git rm -r -q public/measure/internal dev
git checkout LANE_SHA -- public/measure/internal dev
git commit -m "Production candidate: canonical CANON_SHA with editor from lane LANE_SHA"
git push origin release/prod-canonical-20261102
```

Then build on the dev worker as for every release since October 22 (npm ci, check, build, prune, `release-artifact.py`), and verify the archive sha256. The tracker's latest helpers are in `/srv/agents/work/fm-319-prodrun-scripts` on fm-agents-1. They have hard-coded shas to replace.

## Audit: every production change since October 22

**Method.** Host files were hashed against git. Every non-merge commit reachable from `226e87fd` since October 21 was checked line by line (lines it added, lines it removed) against canonical, or the lane for editor paths. Each difference was then read by hand. A rewritten fix shows as a difference, and was checked by behavior.

**No hand-patched code.** On all 8 hosts the release tree matches its commit file for file, apart from the rebuilt `package-lock.json`, `.release-artifact.json` and `release.env`. Hashed on November 1 at about 23:44 UTC, while FM-319 was rolling out: 6 hosts were on `226e87fd`, 2 on `bcf1e43d`, and each matched its own commit. All 8 were on `226e87fd` when rechecked.

| Fix | What | Production commit | Canonical + lane |
| --- | --- | --- | --- |
| **1M8-254** | Portal summary and CSV show each report's own measurements | `f67c79a2`, `3d1fdb12` | **Was missing; ported** `177e5696` |
| **1M8-249** | Impersonate from the organization window; portal stays on the sign-in email | `ef39262b` | **Was missing; ported** `b425d580`, lane `64c53a83` |
| FM-319 | Practice shows the source's reference imagery | `a79f2ea5`, `226e87fd` | Present (equivalent commits) |
| FM-318 | Training saves; training files in any course | `bcdd8205`, `bcf1e43d` | Present (`a12dd9b6`, lane) |
| FM-316 | Colour picker above the signup wizard | `20fd2f8a` | Present (`d2edc4c0`) |
| FM-315 | Training source missing one view can start | `fe9640e6` | Present (`26a065e6`) |
| FM-313 | PDF step survives unreadable project files | `70c22b02` | Present (lane) |
| FM-312 | Roof edit can't leave wall mode black | `e2a69846` | Present (lane) |
| FM-311 | Wall Notes blank on the customer PDF | `bbf23641` | Present (lane) |
| FM-310 | Glass doors and garage doors | `ce0e815f` | Present (lane) |
| FM-305 / 1M8-256 | Summary card labels | `c8acd3c4` | Present (lane) |
| FM-304 / 1M8-255 | Pitch in degrees | `bf0e8339`, `ab90dc2c` | Present (`0f8830dd`; lane PDF equivalent) |
| FM-302 / 1M8-250 | Onboarding names only the missing field | `d587264a`, `784b7bd0` | Present |
| FM-300 / 1M8-246 | Company name banner, Settings rename | `9af332be` | Present |
| — | Exteriors engine from the lane | `091e5c36` | Present (lane) |
| 1M8-248 | Impersonate by user record | `b49136e1` | Present |
| 1M8-246 | Onboarding asks for the company name | `fc31553b` | Present |
| 1M8-245 | Adding a person never replaces a member | `71654b2e` | **Superseded** by FM-303, see Decisions |
| 1M8-244 | User email kept equal to sign-in email | `05a3ef93` | Present |
| 1M8-243 | Help & support launcher | `7d5ca591` | Present |
| — | Signup-funnel events | `eac399d9` | Present |
| — | Bonus offer with Meta utm_campaign | `6fefe93c` | Present |
| — | Replay page rules | `2b52a332` | Present |
| 1M8-240 | Phone codes, signup language, embed form | `6e8093f7`, `bf8a99a8`, `62119658` | Present |
| — | Session replay | `2703bab3` | Present |
| — | Full Exterior sample report | `67cb3617` | Present |
| 1M8-242 | Imported accounts' logos | `6948c461` | Present |
| 1M8-241 | VAT labels | `51e9d84f`, `aa66cd9b`, `8ee3c3b1` | Present |
| — | European login billboard | `9c022473` | Present |
| 1M8-238 | Customer user order counts | `242fba6c` | Present |
| 1M8-235/236 | People protection, Settings launcher | `9daef908` | **Superseded** in part by FM-303, see Decisions |
| 1M8-234 | Draft cleanup | `1de5ee2b` | Present |
| 1M8-233 | Quad views retired | `f4b74de0` | Present |
| 1M8-232, 205 | Report tabs follow the open report | `d12a4c71` | **Superseded** on purpose by `6069c8db` (Summary first) |
| 1M8-230, 231 | Portal list, saves without expanded access | `c9479381`, `9398c0ad` | Present |
| — | Oct 22 release, hotfix c, hotfix d | `f7fd3fc8`, `ce7a2ed4`, `9ada3dc1` | Present |

Language: of 17,913 production catalog keys, 2 are gone, both Wall ID explanatory lines canonical removed on purpose (`1584597b`).

### Host and data changes that a code release does not touch

None need porting, and all must survive. Verified present on November 1 unless noted.

| Change | Where | Action |
| --- | --- | --- |
| `FIRSTMEASURE_FULL_HOUSE_ENABLED`, `_EMAILS` | `/etc/firstmeasure/production-cutover.env`, compat (also the bootstrap overlay) and all 6 web nodes | Keep |
| Background loops off (`WORK_SCHEDULER_DISABLED`, `STATS_SCHEDULER_DISABLED`, `CUSTOMER_CALL_WORKER_DISABLED`) | compat `firstmeasure-legacy.service.d/zz-platform-background-off-20261021.conf` | Keep. Canonical runs these loops if the file goes |
| Tutorial folder ACLs (Oct 23) | compat `tutorials/users`, outside the release | Keep |
| Training sources and curriculum | Spaces and compat, outside the release | Keep |
| Data: Proven Roofing, What The Hail Roofing owners; stray campaign off; country backfill | Database | Stays |

## What changes between production and the candidate

733 commits, about 1,280 files. Full list: `release-delta-inventory.md` in the session notes.

**Every customer, no switch:**
- Request security: anonymous calls to `/v1/firstmeasure`, `/v1/internal`, `/v1/communications` are refused; `portal-action` is checked per action; cross-site cookie writes are refused; customer logins no longer open `/measure/internal`.
- Project details tray: contact, address, measurements and order move from Overview to a left tray.
- Reports tab order Summary, Model, Standard, Customer, XML. (The Reports tab tour is off; see Decisions.)
- Orders placed once; a Stripe-paid order is placed on return even if the browser lost state.
- Checklists print and signature where the tab shows, plus a setup modal for `manage_projects`.
- Phone layouts.

**Gated off by default** (reach only organizations that switch them on): Documents history, Operations and materials, Money ledger, customer portal payments, scheduling, assistant, CRM additions, Holiday Lights, Full Exterior ordering.

**Added on Nov 2 after this record was written** (all live on dev; canonical taken at its tip, the lane at `a64f67a7`):
- **Release blocker fixed:** customers without expanded access open their orders from any browser (`e311bddb`). Before it, canonical showed "This project could not be found" from a second device; production does not.
- **Measurements widget** never shows a bare "No measurements." (`f512f924`): order status, the report's model, or a way to get measurements.
- **Project details column** starts open on desktop for every project, including after ordering.
- **Full Exterior:** "Under 6 hours" / "Under 3 hours" labels; after-the-fact expedite for the fee difference ($5 / $10 per structure); one report-kind tag on My Projects; what was ordered on the order card; new sample PDF (`portal/samples/full_house_sample.pdf`) and Settings preview sample.
- **Technician points for a Full Exterior:** walls weigh 1.1x a roof of the same complexity (was 2x), for jobs scored after release. This changes pay (Jack, Nov 1).
- **Editor (lane):** `/measure/internal/.user.ini` raises PHP's upload limits to 64M (saves of full houses failed with "Upload failed" 400 at the stock 2M); the PDF step shows gutter stories only as a reminder; Sources & Notes holds only what the tech adds; training reads Apple imagery stored as JPEG; Student Progress counts and names only the open curriculum.
- **Exteriors intro popup:** an `introduce` flag state and its guide (`guided_experience/exteriors.introduction`, exported into the snapshot alone). Ben's page `https://1m8.ai/billboards/exteriors_popup/` went live Nov 3 00:49 UTC; its Get Started button (`exteriors-popup-get-started`) opens the Full Exterior order. Inert on production until staff Introduce an organization in the console. To try it without using it up: `FirstMateGuides.preview('exteriors.introduction')` in the portal console, in an org with Exteriors on.

**No capability default flips.** Production's runtime defaults (186 keys) against the snapshot (205): none changed. New keys that default on sit under switches that are off for FirstMeasure organizations; this was checked from the definitions, not walked in a browser.

## Configuration

| Item | State on production | Action |
| --- | --- | --- |
| Internal secret | Same value on compat, worker and the 2 web nodes sampled, and in the provider file; `www-data` can read it | None. Do not rotate until the rollback window closes |
| `FIRSTMEASURE_API_BASE` on compat | Unset; `FIRSTMEASURE_NODE_BASE_URL` is a `fastcgi_param` map | Add `fastcgi_param FIRSTMEASURE_API_BASE https://app.1m8.ai/v1/firstmeasure;` to the live compat config before activating |
| `FIRSTMEASURE_APPLE_KEY_INGEST_TOKEN` | Unset | Harvester writes get 401 without it. No Apple key traffic in today's logs on compat and one web node; see Risks |
| `CORS_ALLOWED_ORIGINS`, `PUBLIC_BASE_URL` | Unset | Check `src/config/env.ts` defaults against `app.1m8.ai` and the signup embed origins; set if needed |
| `PUBLIC_FIRSTMEASURE_API_KEY_SECRET` | Set | Leave |
| `NODE_ENV`, data environment | `production` on all roles sampled | Guards for the simulator, dev console and sandbox rely on this |
| Provider file, Postmark, Stripe, Chromium | See DEPLOYMENT.md | Lock file is identical, so same Chromium. ffmpeg and `ca-certificates` are on compat |

### Config library gate

**Satisfied, nothing to export.** Read on production through the running code: `capability_presets`, `capability_signup_preset` and `app_flag_defaults` are all empty, and there are no JSON copies on compat or the worker. Production has only ever used built-in defaults. The snapshot's signup preset matches production's hard-coded list.

The snapshot differs from the dev store in three entries, and **should not be re-exported** for this release. The export script also rewrites 231 files, and the store is the older side for one entry:
- `capability_defaults`: the store lacks `checklists.crew_send`, which the snapshot has.
- `terminology_namespace/money`: "Take a Payment" in the store, "Take a Collected Payment" in the snapshot.
- `sandbox_configuration/swf_mvp_platform`: sandbox only.

After release, operator saves of presets and flag defaults are refused on production (`config_library_read_only`). The staff console's flag-default save falls back to a JSON file and reports success, but Node ignores it. **Don't use it on production** until fixed.

## Schema and data

**Nothing destructive.** No `.sql` changes, and no `DROP`, `TRUNCATE` or startup `DELETE`. There is no migration step: `openSqlStore` creates tables on first use, whatever `POSTGRES_AUTO_MIGRATE` says. `firstmeasure_app` has `CREATE` on the schema (checked).

| Store | On production now | After release |
| --- | --- | --- |
| `document-checkpoints` | No row, table absent | v2: `document_revisions`, `document_revision_heads` on first document use |
| `guided-experiences` | Absent | v2 on first guide read |
| `config-library` | Absent | Not opened on production |

Data rewritten by normal use: untouched document template copies are republished from the snapshot, and scope templates are stamped. Edited copies are left alone. This only touches organizations using Documents.

Connections: `max_connections` is 800, with 145 active at the last check; pool 4. Budget is fine.

## Steps

1. **Freeze.** Set the tracker's FirstMeasure bug-fix workspace to Pause. Otherwise a tracker hotfix cut from `production-live` would overwrite this release with old code.
2. Build the candidate, then the archive. Check disk: compat has 11 GB free, and the archive is about 390 MB.
3. Copy the archive to compat and the worker, and verify sha256. Install on all roles without activating. Publish to the signed channel only after compat and the worker are healthy.
4. Save `nginx -T` on compat. Add `FIRSTMEASURE_API_BASE` (table above), `nginx -t`.
5. **Compat first,** in a quiet window, reloading nginx with it: `activate-release.sh CANDIDATE_SHA firstmeasure-legacy.service`. See Risk 1.
6. Worker, after no running jobs. Then publish the channel.
7. Web nodes, one at a time, using the drain from `web_activate.py` (about 95 s each, about 10 minutes). Check `FIRSTMEASURE_FULL_HOUSE_*`, pool and worker counts in each process.
8. Verify: readiness returns the candidate 40 of 40; staff sign-in reaches the console without signing in again; a customer login opening `/measure/internal/` goes to staff sign-in; open and save the editor, including a Full Exterior project; render a roof PDF and a Full Exterior PDF; a customer's Roof Report Summary and CSV show that report's measurements (1M8-254); impersonate a user whose emails differ (1M8-249); save a full house in the editor without "Upload failed" (`.user.ini`); a FirstMeasure-only customer opens an order from a fresh browser; place no real orders. The Stripe negative-signature probe returns 400. Watch 5xx and worker exits for 30 minutes.
9. Merge the candidate into `production-live` and push, so the tracker's hotfixes start from it. Record the outcome here. **Unpause the tracker only after this.**
10. Later, separately: nginx hardening per `security-php-nginx-20261024.md` (host filtering, blocked paths). Give the bootstrap endpoint its own `server_name` first or new web nodes won't boot, and update the image template. It is not part of this release because the rollout helpers assert one `server {` block. Remove `sites-enabled/firstmeasure-development` from compat, which still needs Jack.

## Released (November 3, 2026)

**Candidate `ac09d330d94e850a2fc782a0f069c4aa6a4c12e6`**: canonical `4cbae6a0` with `public/measure/internal` and `dev` from lane `a64f67a7` (identical to the lane there). Branch `release/prod-canonical-20261102` on GitHub. Archive sha256 `b7a3775568868702eb84318ccf69bcae0214e980db26850af163c829668b9258`, 371,105,283 bytes, built on the dev worker (`build.sh`: npm ci, check, build, prune; 278 s), verified there and again on compatibility and the worker after copying.

| Time (UTC) | Step |
| --- | --- |
| 02:23:23 | Tracker FirstMeasure bug-fix router stopped (`systemctl --user stop tracker-router@bugs` on fm-agents-1); it was idle, last release FM-320 at 21:08 |
| 02:35–02:37 | Archive on compatibility and the worker, sha256 matched, installed without activating. `nginx -T` saved to `/root/nginx-T-before-ac09d330.txt`, site config to `/root/firstmeasure.nginx.before-ac09d330`; `fastcgi_param FIRSTMEASURE_API_BASE https://app.1m8.ai/v1/firstmeasure;` added, `nginx -t` ok |
| 02:37:56–02:38:09 | **Compatibility** activated (`firstmeasure-legacy` and PHP-FPM restarted), nginx reloaded. Ready on `ac09d330`. Background loops still off, full house on |
| 02:38:29 | **Worker** activated after no running jobs: 8 slots, production, email on, heartbeat off |
| ~02:39 | **Signed channel** published against `eb8a98be…`; a web node's download now returns `ac09d330`/`b7a37755…` |
| 02:40:07–02:53:45 | **Six web nodes**, one at a time, drained from the load balancer (~95 s each), each back behind the LB on the new release before the next. Every node: ready, served assets match, pool 4, 8 workers, `FIRSTMEASURE_FULL_HOUSE_ENABLED=1` with the email list set, signup sandbox 404 |

**Publish trap:** `publish-web-release.sh` run through `/opt/firstmeasure/current/...` exits 0 and does nothing, because `release-channel.mjs` compares its symlinked path with `import.meta.url` and skips `main()`. Run it from `/opt/firstmeasure/releases/<sha>/deploy/digitalocean/`. Confirm with a web node's channel download.

**Checks after activation:**
- Readiness `ac09d330` 40 of 40 across all six instances right after the rollout, and 10 of 10 at 03:10 and 03:24.
- Anonymous: `/measure/internal/` redirects to `backend_login.php`; `POST /v1/internal/legacy-action` and `GET /v1/firstmeasure/projects` return 401. The Stripe bad-signature probe on `server.php` returns 400.
- Served files equal the candidate's on 6 of 6 requests each: the guided-experience runtime and announcement, the measurements card, the projects viewer, the editor's `report.js` and `wall_mode.js`, `tutorials.js` and `portal/samples/full_house_sample.pdf`.
- Staff console opens on an existing staff session; Student Progress shows Full House Drawing with per-curriculum counts. The customer portal loads the new code for a report-only login, with no popup and no tour.
- `firstmeasure.exteriors` on for 0 of 13,146 organizations under the new code.
- **Not checked** (no production customer login with projects): a customer opening an order from a fresh browser, Roof Report Summary and CSV (1M8-254), impersonation (1M8-249), an editor save of a full house. Nothing was saved or ordered.

**30 minutes after (to 03:24):**
- Web nodes: 5xx 0.10–0.14% after against 0.17–0.34% in the half hour before; no worker exits, no restarts.
- Compatibility: nginx 5xx 0.50% (93 of 18,420) against 1.18% before; 91 are the existing `top_view_reroll_proxy.php`. The only release-time errors were 14 `editor.php` 503s from 02:38:05 to 02:38:07 while Node started. Node logged six isolated 500s on routes that already failed before (`legacy-action`, `/v1/internal/users`, `qa/me/status`).
- Worker: 343 jobs completed since activation, none failed, no restarts.

**production-live** fast-forwarded to `b0a441a3`: parents `ac09d330` and `c03bca5d`; the tree is the candidate plus production-live's two hotfix records (FM-309, FM-320). Tracker hotfixes now start from this release. **Rollback target:** `51c70f90` (see Rollback), kept on every role.

**Disk:** compatibility is at 95% (5.8 GB free) after this release. It holds 92 releases (58 GB) and 20 GB of old staging in `/var/tmp`; prune before the next release, keeping the current release and two rollback targets.

## Rollback

Every role keeps `51c70f90`: republish `eb8a98be…` to the channel, then `activate-release.sh 51c70f90… <service>`, web nodes first this time. Confirm the rollback release is still on every role before step 5.

- **One trap:** production has no `document_checkpoints` table. After the candidate writes version 2 for that store, old code skips creating the table and document history fails. On rollback run `DELETE FROM platform_sql_schemas WHERE store_id='document-checkpoints'` so old code recreates what it needs. New revision tables stay and are ignored.
- **Not reversed:** emails, charges, republished template copies.
- Rollback reopens anonymous access. Don't rotate secrets before the window closes.

## Risks

1. **Staff work breaks for about 10 minutes during the rollout.** Old PHP is unsigned to new Node (401); new PHP sends no identity to old Node. Compat first is the least bad order: compat's PHP and Node switch together, and the old web nodes it then calls have no route gates. Editor saves and QA should stop for the window; customers are not affected this way. Sending compat's PHP to its own Node for the window would shorten this, but compat's `127.0.0.1:3101` answered 403 to an anonymous test, so it is **unproven and not in the steps**.
2. **An unidentified client is reading data without a session.** `Python-urllib/3.12` calls `POST /v1/internal/legacy-action` with no session; 175–236 hits per web node in the current log, responses over 100 KB. It gets 401 after release. Real IP isn't logged. If it's something of Jack's, it needs an API key or staff session first.
3. **Apple key harvester.** Writes need the new token. The audit saw frequent writes in October; today's logs on compat and one web node show none, so it may have stopped. Jack knows; the editor's Apple imagery depends on the key.
4. **Dev has never run in snapshot mode with production-shaped data.** Dev reads the store. The small drift above is the only known difference, but the first real run is on production. Watch the first web node before continuing.
5. **Partly exercised:** on dev with FirstMeasure-only signup organizations (production-shaped), orders open from a fresh browser, the details tray opens, and the measurements widget shows order status, the model or a way to order at 1440 and 390 wide. Not walked: a cache-only project on a report-only organization end to end.
6. **Compat disk** at 92% (11 GB free), and `64.23.240.81` at 89%.
7. **Minor:** `DEPLOYMENT.md` lines 40 and 127 hold leftover conflict markers.

## Decisions (Jack, Nov 2 evening)

- **FM-303: ship as built.** Any other active super admin may lower, suspend or archive the owner (Cat 6 Roofing's case); no "Make owner" transfer for now.
- **Reports tab tour: off.** Removed from the library on dev with its replay question and exported into the snapshot (`ded758f8`), so no customer gets it. Checked on dev: the Reports tab offers no tour and no "Show me the tutorial again".
- **The unidentified `Python-urllib` client (Risk 2): refuse it.** It gets 401 after release.
- **Apple key harvester (Risk 3): no token for now.** Add `FIRSTMEASURE_APPLE_KEY_INGEST_TOKEN` if the editor's Apple imagery stops refreshing.
- **Exteriors stays off by default.** Production on Nov 3 02:20 UTC: 0 of 13,139 organizations have `firstmeasure.exteriors` on (resolved by the running code); the snapshot's `capability_defaults/platform` has it `false` and the signup preset does not name it. It reaches an organization only when staff turn it on or Introduce it in the console.
- **Platform stays off for production organizations.** This release deploys the code only: background loops stay off and capability defaults are unchanged. Turning the platform on for anyone is a separate step.
