# Production release 67cb3617: Full Exterior sample report, October 23, 2026

Requested by the Platform Exteriors Front End session. Jack approved it in that session: "so that both dev and prod have a sample report" and "Just push it with the rest of it". I confirmed the quotes in that session's transcript.

The release is production `2703bab3` plus one static file, `public/portal/samples/full_house_sample.pdf`: 2,749,957 bytes, sha256 `d7ac55d3…`, the 4725 W Mercer Way pilot report. The Full Exterior "What's included" pop-up links it, and it returned 404 on production before this release. The report settings commits (`0fccea08`, `d5730630`, `c57e72a1`) are deliberately left out until Jack reviews them.

## Build

Archive `a80cf249…`. The PDF inside the archive hashes `d7ac55d3…`, so it shipped byte for byte.

## Rollout

All roles were activated so every role shows the same release ID:

- compatibility, with 0 errors and 0 crashes in the next 20 s;
- the worker;
- the signed channel, published against `e20d4718…` (`2703bab3`);
- the six web nodes.

Public readiness returned `67cb3617` 10 out of 10 times.

## Verification

Four requests to `https://app.1m8.ai/portal/samples/full_house_sample.pdf` each returned 200 `application/pdf` with sha256 `d7ac55d3…`.

## Rollback

Every role keeps `2703bab3`. Republish it (`e20d4718…`) to the channel before rolling back a web node.
