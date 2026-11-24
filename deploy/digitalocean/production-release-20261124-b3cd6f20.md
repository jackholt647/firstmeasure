# Production release b3cd6f20 (FM-631) is live again: FM-633's a16b0a05 rolled back, November 24, 2026

Production runs `b3cd6f2077b94ffa47da859e2a5dfa5ca612f0ec` on all 8 hosts (compatibility, worker, 6 web nodes).
This record also stands for b3cd6f20's own release, which was not recorded on `production-live` when it went out.

## b3cd6f20: FM-631, November 23

- `b3cd6f20` FM-631: campaign landing lookup stops sorting every view of the campaign (`stickyBonusSetForVisitor`
  in `public/v1/internal/crm/referrals.ts`, plus its regression subtest). Same change as canonical `199a7628`,
  verified on dev in `platform-20261123185707-8adaae2f`. Direct child of `production-live` `6806baae` (record of 375d1ee6).
- Released from fm-agents-1 by FM-631's production run on the full path: worker and web 19:0x–19:29 UTC, compatibility
  through the gate at 20:15 UTC. Rollback target was `375d1ee69d079e0af649d6b746e585d1c9550632` (FM-629).

## a16b0a05: FM-633, released in part and rolled back

- `a16b0a05` (branch `claude/fm-633-fix-prod`, child of b3cd6f20): the public FirstMeasure API reads the key without
  `Bearer` and from `X-API-Key`, and a 401 says why (`public-firstmeasure/keys.ts`, `commerce/profile.ts`, the API docs
  page, a test). Same change as canonical `f89da725` + `d7f804f7`, dev release `platform-20261124011705-ea2bf2a9`.
- November 24, full path: worker activated 01:36 UTC, web channel published, the 6 web nodes 01:37–01:52 UTC.
  Paused before compatibility at Jack's request (compatibility never left b3cd6f20). Ben asked to roll back at 04:10.
- Rollback to the recorded target b3cd6f20 (scripts `fm-633-prodrun-scripts/rollback` on fm-agents-1):
  worker activated 04:12 UTC (no running jobs); web channel re-published from compatibility with b3cd6f20's archive
  (sha256 `bd9bff7220b666254ac76c6c1ec77ad9770d470017a9ee24bdd813267a86b576`, expected previous `4800ae89…`, a16b0a05's),
  so new pool nodes boot on b3cd6f20; web nodes one at a time from 04:13 UTC, each drained from the load balancer,
  activated and checked (file asserts for every release through FM-631) before the next.
- No data, environment, flag, NGINX or config-library change. a16b0a05 stays installed (not current) on the worker,
  the web nodes and compatibility.

## Checks after the rollback

See FM-633 in the tracker for the run's output: `readlink -f /opt/firstmeasure/current` = b3cd6f20 on all 8 hosts,
`/v1/health/ready` 10/10 on b3cd6f20, and the public API without a key answers 401 `missing_api_key` with
`"details":null` again (the pre-FM-633 reply).
