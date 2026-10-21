# Production portal slowness (1M8-225) — October 21, 2026

## Symptom

After [release 31f87be5](production-release-20261020.md), the internal and
customer portals were slow. QA project loads took about 20 s, and logins needed
repeated clicks on "authenticate".

## Cause 1: platform background loops on the compatibility host (fixed 20:43 UTC)

The compatibility host `144.126.222.110` (2 CPUs, PHP-FPM `pm.max_children` 20)
owns the heartbeat. Since the push it also ran the platform's work scheduler,
stats sync and customer-call worker. The platform is off for every production
organization.

- An uncaught "timeout exceeded when trying to connect" from those loops killed
  HTTP workers 144 times an hour.
- PHP-FPM reached `max_children` 177 times on October 21, against about once a
  day before the push.

**Change.** Drop-in
`/etc/systemd/system/firstmeasure-legacy.service.d/zz-platform-background-off-20261021.conf`:

```
[Service]
Environment=WORK_SCHEDULER_DISABLED=1
Environment=STATS_SCHEDULER_DISABLED=1
Environment=CUSTOMER_CALL_WORKER_DISABLED=1
```

Applied with `systemctl daemon-reload` and a restart of `firstmeasure-legacy` at
20:43:04Z.

**Result.** 0 worker exits since. Login pages answer in 0.15–0.4 s.

**Undo.** Delete the file, run `systemctl daemon-reload`, then restart
`firstmeasure-legacy`. Re-enable these loops only together with the platform,
and only after the scheduler catches its own errors.

## Cause 2: `readGlobal` took a row lock (fix `c144dd1b`, not yet in production)

`platform/storage_postgres.ts` `readGlobal` ran `SELECT … FOR UPDATE` on the
organization's `global` document inside a transaction. Almost every request
reads it, so readers queued behind each other on every web node. The
compatibility host's `POSTGRES_POOL_MAX=4` pool timed out after 15 s and
returned 500s:

- `legacy-action`, `internal/me` and `internal/users`;
- 235 such responses in the first 3 minutes after the restart.

The database itself had room: 204 of 800 connections were in use.
`pg_stat_activity` showed `Lock` waits and `idle in transaction` sessions on
that row from every node.

**Fix.** Reads are plain selects. Only seeding a missing document uses a
transaction, with `INSERT … ON CONFLICT DO NOTHING` followed by a read of the
winning row. `saveGlobal` and `mutateGlobal` still lock, as writes should.

Branch: `codex/hotfix-global-read-lock-20261021`, on top of `31141b11`.
