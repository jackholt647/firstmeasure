# Session replay, who is recorded — development, October 23, 2026

Release `5675967d1d623fa4eaba564e4dba98140e8a6636` (parent `fa35507c`).
[Architecture](../../docs/architecture/session-replay.md#who-is-recorded).

**Why.** Jack wants only internal platform administrators to view replays and decide who is recorded, with full
control: everyone on or off, or specific people and organizations (for example a customer having problems), working
across 10,000 production organizations without loading them all.

**What changed.**
- **The mode.** One mode for the whole platform: off for everyone (a kill switch), only those listed (the default),
  or everyone except those set not to record.
- **Rules.** A rule names a person (their sign-in identity, in every organization they belong to) or an organization,
  says record or don't, and can end at a time. A person's rule wins over their organization's; an expired rule counts
  as absent. Every change is logged with who, when, what it replaced and why.
- **The old switch is gone.** `platform.session_replay` is no longer an organization capability, so presets, signup
  and Developer Settings cannot switch recording on. Stored values of it are ignored, because unknown capability keys
  are dropped on read and write.
- **Admin routes**, all for platform administrators only, under `/v1/platform/session-replay/admin/targeting`:
  list, mode, rules (up to 500 at once, people by email), remove, search, explain and log. Customer organization
  owners and admins get 403.
- **Search.** `searchIdentities` and `searchOrganizations` were added to `platform/storage.ts` (`ILIKE` with a
  `LIMIT` on Postgres). The table scan is in the optimization backlog.
- **The viewer.** The organization switch is replaced by **Recording**, a summary in the sidebar, and **Manage who is
  recorded**, a dialog with the mode, search, rules by state, and the change log.
- **Store.** The `session_replay` store moves to schema version 4, with `session_replay_rules`,
  `session_replay_config` and `session_replay_rule_log`.

**State on dev after the rollout.**
- The mode is "only those listed", with no rules, so nothing records. That matches before: every organization was
  already off.
- Earlier organization switches were not carried over, since all were off.

**Checked on dev** (`output/session-replay-targeting-20261023/check.mjs` on the web host, Postgres):
- The tables exist and the mode reads "listed".
- Organization and people searches each returned a page of 20 in about 80 ms.
- A query made of LIKE wildcards matched nobody (the wildcards are escaped).
- An unlisted person resolves to "not recorded, not listed" in 2 ms.
- The served `viewer.html` loads `session-replay-recording.js?v=20261023-1` (200).
- The targeting route answers 401 without a session.

**Tests.**
- `tests/session-replay.test.ts` adds:
  - the capability is gone and no preset carries it;
  - modes, person and organization rules and their precedence, and expiry;
  - all-or-nothing batches, and unknown people and organizations refused;
  - search and explain, rules a page at a time with counts, and the log;
  - every targeting route refused to a customer organization admin.
- `tests/session-replay-e2e-browser.test.mjs` sets an organization rule through the new dialog and records.
- The archive, agent access and insights tests pass.
- `tests/access-gates.snapshot.json` was regenerated in a clean checkout of the release. It also picked up documents
  routes that other sessions had committed without updating it.
- `tests/capabilities.test.ts` fails on `platform.collaboration missing catalog_stub`, and fails the same way at the
  parent commit, so it is not this change.

**Rollout.**
- The pool role (10.124.16.3) did not answer ("No route to host"). The static compression session had found that
  node gone from dev, so web is the only node behind the load balancer. The release went to worker, legacy and web.
- Those three had settled on web and legacy `da55b272`, worker `29562fd1` (two audits 60 s apart).
- The four shared platform files were merged onto each host's live copy without conflicts.
- `tests/session-replay.test.ts` was not shipped, because the hosts carry an older copy; it stays compatible.
- Stage and activate ran as separate commands for each role.
- All three report `5675967d`, and every shipped file equals its payload (`verify-live.py`).
- `firstmeasure-development-platform-worker` was restarted onto the release.
- Scripts: `output/session-replay-targeting-20261023/`.
