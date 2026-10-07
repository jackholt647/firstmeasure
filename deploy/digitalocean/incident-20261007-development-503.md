# October 7 development 503: intermittent object-storage readiness timeouts

The public development site returned 503 after the FirstMeasure localization
release had passed its hosted checks. Both web services remained running on
`401a6e30171432ca7fa31cbf5875eef380f29caa`, without automatic service restarts.
Local/public readiness recovered intermittently, then a repeated public sample
captured `artifact_storage:false`, with database, environment and outbound-safety
checks passing. Earlier web readiness responses had repeatedly returned 503 in
about four seconds. A current database snapshot showed one immediate diagnostic
query and 18 idle sessions, with no observed blocking activity; it does not prove
historical database behavior. Underlying Spaces latency/provider cause is not
established. This matches the failure mode in the September 9 incident record.

Development web, pool and compatibility had an effective two-second dependency
timeout and ten-second readiness cache. Applied the documented incident mitigation
sequentially to these three serving nodes:

- `/etc/firstmeasure/development-readiness-latency-20261007.env`:
  `READINESS_DEPENDENCY_TIMEOUT_MS=15000`, `READINESS_CACHE_MS=60000`.
- Last-loaded systemd drop-in for each development service:
  `zzzzz-development-readiness-latency-20261007.conf` loads that EnvironmentFile.
- Verified the allowlisted values in the running process environment after
  restarting each service, with unchanged release identity and development guards.

Storage, database, authentication and outbound-safety checks remain enabled.
This is a timeout/caching mitigation, not a repair of the storage provider or a
guarantee of application I/O latency. The 60-second cache delays the detection of
new failures. Overrides persist across ordinary releases on these hosts; new
replacement hosts need the settings separately because no image/template was
changed. The worker and production were unchanged. No data or currency changes,
credential changes, rollback or application release were performed.

After rollout, all four development roles passed readiness, isolation and current
release-file hash checks. Public login returned HTTP 200; a browser login render
passed without page errors. Public login/readiness samples and per-node evidence
are under `output/firstmeasure-localization-complete-20261006/incident-*`.
There was a brief additional public interruption during sequential service
restarts while the load balancer re-admitted the healthy nodes.

Rollback removes only the two named incident override files on each affected
development host, runs `systemctl daemon-reload`, and restarts one development
service at a time after another public-serving node is confirmed available.
Do not remove unrelated drop-ins or modify production configuration.
