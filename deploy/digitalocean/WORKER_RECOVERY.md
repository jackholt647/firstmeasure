# Background worker recovery

## September 6 development repair

The isolated development worker (`137.184.44.82`) had been left **disabled and
inactive**, not crash-looping. Web and compatibility services were still running.
Before starting it, the development database marker and outbound protections
were checked: Stripe test credentials, internal-only rewritten mail, blocked SMS,
and development artifact writes. Its durable job queue was empty.

Worker-only release: `1b09f15-worker-recovery-20260906`, based on the existing
`1b09f15` deployment. The three original queue/runtime source hashes matched the
local source. A narrow overlay preserves other deployed fixes, dependencies and
all application data. No production services, DNS, or production data change.
The original release and the previous systemd unit remain available for rollback.

## Recovery contract

| Condition | Behavior |
| --- | --- |
| Crash / OOM | systemd restarts after five seconds; dependency preflight runs before readiness |
| Frozen Node event loop | external systemd watchdog kills and restarts after up to two minutes without a keepalive |
| Database heartbeat stops | watchdog keepalives stop after 90 seconds of stale heartbeat; dependency failures prevent a false ready signal |
| Long but healthy job | renew its five-minute database lease every ten seconds |
| Lease renewal fails temporarily | retry, but exit before the last confirmed lease can expire (30-second safety margin) |
| Ownership is lost | stop the process; never overwrite another attempt's completion/failure |
| Handler promise hangs | restart after maximum runtime (default 30 minutes) |
| Process dies with a job in progress | another attempt can claim it after lease expiry, if retry budget remains |
| Final attempt dies | reaper marks the expired job failed, rather than leaving it running forever |
| Normal restart | stop claiming, drain active jobs for up to 45 seconds; hard stop deadline 60 seconds |

Worker identity includes hostname, PID and a random boot token. Queue settlement
and renewal require the matching owner **and attempt number** and a live lease.
This is compatible with existing tables; no database migration is required.
`FIRSTMEASURE_JOB_MAX_RUNTIME_MS` can tune the job deadline (1 minute–6 hours).
Do not raise it merely to conceal a hung operation.

The development worker runs two concurrent job slots on its four-vCPU Droplet.
It is separate from HTTP process counts and does not change production capacity.
The service is enabled at boot. `Restart=always` does not undo an intentional
`systemctl stop`; an operator must explicitly start a deliberately paused service.

## Verification

Deployed checks completed successfully on September 6, 2026 at 17:15:52 UTC:

- Forced SIGKILL: automatically running again in 7.1 seconds.
- SIGSTOP freeze: external watchdog killed/restarted the process in 126.5 seconds.
- Interrupted synthetic job: reclaimed after the unchanged five-minute lease,
  completed on attempt 2 (`worker-recovery-1788714625712-crash`).
- Graceful restart: active ten-second job completed on attempt 1.
- Fresh worker heartbeat and enabled-at-boot service verified after restart.
- TypeScript check, SQLite smoke, recovery suites on SQLite/PostgreSQL, environment
  safety, background-role and HTTP-health tests passed. Broader PostgreSQL
  integration passed with 10,500 fixture projects and concurrency 64.

One initial test-harness run stopped because it treated systemd's normal
`activating` transition as a command failure. The worker itself restarted
successfully; the harness was corrected and the complete test rerun passed.
Three harmless synthetic job records (including that initial run) are retained.

From `public/v1`:

```sh
node --experimental-sqlite --import tsx --test --test-force-exit tests/job-recovery.test.ts
node tests/run-embedded-postgres.mjs tests/job-recovery.test.ts
node --experimental-sqlite --import tsx --test --test-force-exit tests/firstmeasure-sqlite-smoke.test.ts tests/firstmeasure-background-runtime.test.ts tests/environment-safety.test.ts tests/runtime-health.test.ts
npm run check
```

`inspect-development-worker.mjs` reads safe aggregate queue/heartbeat/config
information using the worker EnvironmentFiles and application working directory.
It must not print environment files or connection strings.

`test-development-worker-recovery.mjs` is an **active failure-injection test**,
not a monitoring script. It is restricted to the exact isolated dev worker and a
database marked development. It creates harmless synthetic CPU jobs, kills and
freezes the worker, waits for automatic restarts and expired-lease recovery, then
checks graceful draining. It refuses to interrupt an active non-test durable job.
Run it only in a controlled dev test window. It leaves its completed synthetic
job records as audit evidence. Do not run this against production.

## Operational checks

On the development worker:

```sh
systemctl is-enabled firstmeasure-development-worker
systemctl show firstmeasure-development-worker \
  -p ActiveState -p SubState -p MainPID -p NRestarts -p Result -p WatchdogTimestamp
journalctl -u firstmeasure-development-worker --since '-30 minutes' --no-pager
```

Check a **fresh database heartbeat**, not just systemd's `active` state. Also watch
failed jobs, stale running jobs and the age of queued work. Repeated restarts or
exhausted retries require diagnosis; restarting cannot repair an invalid payload,
revoked credentials, an external provider outage or insufficient capacity.

## Production promotion and limitations

Promote the tested source plus `firstmeasure-worker.service` in a normal immutable
release. The Type=notify/watchdog unit and new worker entrypoint belong together:
install the unit, run `systemctl daemon-reload`, then activate the corresponding
release. Preserve both the prior unit and release for rollback. This repair does
not deploy to either production environment. Include the new `job_lease.ts` and
`worker_supervision.ts` modules; copying only the old five-file set is insufficient.

Process/lease recovery is **at-least-once**, not a guarantee of exactly-once
external effects. For example, a provider can accept an email just before a crash
prevents recording that success; a retry may resend it. Existing sent markers
avoid ordinary repeat sends but cannot eliminate that narrow failure window.
Payment/email end-to-end tests and representative load tests remain necessary
before the real-data/DNS cutover. Synthetic crash tests do not establish maximum
production throughput or validate every report-rendering payload.
