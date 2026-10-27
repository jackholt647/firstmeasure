# Production releases 2b52a332 and 6fefe93c, October 24, 2026

## 2b52a332: session replay page rules

Requested by the session replay session. Jack asked for it in that session: "I wanted to turn off measure/internal, which is where the vast majority of these are coming from" and "maybe only for an hour at a time". I confirmed the request in that session's transcript.

The release is on top of `7a37961d` (production `62119658` plus its records). It adds:

- pages that are never recorded, with uploads from excluded pages refused (403);
- recording a never-recorded page for 15 minutes, 1 hour or 4 hours;
- sessions filtered by page, with next and previous event;
- idle detection that ignores pointer jitter;
- stylesheets kept when a page closes.

The schema change is applied on first use:

- the `session_replay` store goes to version 6;
- a new `session_replay_page_paths` table;
- `session_replay_rules.allow_until`.

Recording mode is unchanged ("everyone" until Jack adds page rules). Replay storage was 2.8 GB of the 124 GB production database, growing about 2 GB a day, mostly from `/measure/internal`.

**Tests:** `tsc` clean; 19 of 19 replay, realtime and access-gates tests pass.

**Rollout:**

- Build `d89ad2b0…`, verified.
- Compatibility logged 0 errors and 0 crashes in the 20 s after activation.
- The worker, the channel (against `c9096dd3…`) and six web nodes all activated.
- Readiness returned it 10 out of 10 times.

## 6fefe93c: bonus offer fix

Built on `2b52a332`, with `b9f89a1d` from `claude/bonus-utm-campaign-20261024`.

**Cause:** `62119658` made the signup widget send the page's campaign value as `acquisition_code`. On the app's Meta pages (`meta-619b`, `meta-619c`) that value was Meta's `utm_campaign` (`52513030142937`). It matched an auto-created campaign from June 29 that has no bonus, so from 02:42 UTC on Oct 24 every Meta visitor was assigned to it instead of Meta 6/19 B.

**Impact:** 28 signups saw no bonus offer, and 16 of them paid. One purchase, $140, would have qualified. The organization ids are in the shared notes file `bonus-offer-meta-utm-20261024.md`. No backfill was done.

**Fix:** the widget sends `acquisition_code` only when the page or link names a campaign code. `utm_campaign` is still recorded.

**Tests:** signup-embed (including the Meta ad case, which fails without the fix), signup-widget-auth and signup-language: 37 of 37 pass. The cache key needs no bump: the widget version is the file's modification time.

**Rollout:**

- Build `f1267322…`, verified.
- Compatibility logged 0 errors and 0 crashes in the 20 s after activation.
- The worker, the channel (against `d89ad2b0…`) and six web nodes all activated.
- Readiness returned it 10 out of 10 times.
- The served `signup-widget.js` contains the fix, and the Meta page loads it with a new `?v=`.

## Rollback

- `6fefe93c` rolls back to `2b52a332` (republish `d89ad2b0…`), which brings the bonus bug back.
- `2b52a332` rolls back to `62119658` (republish `c9096dd3…`).

## Production data change made alongside this release

At Jack's request, the bonus investigation session set the stray campaign `acq_52513030142937` (auto-created June 29, no bonus offers) to inactive at 2026-10-24T20:36:30Z. That was the same moment `6fefe93c` went live.

Meta visitors resolve to Meta 6/19 B even under the old widget. Three bonus purchases followed, the first at 02:51 UTC on Oct 25 (paid $100, received +$50). The session's own record is `7a096e37` on `claude/peaceful-cray-81db93`.
