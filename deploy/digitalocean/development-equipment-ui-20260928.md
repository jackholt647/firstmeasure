# Equipment interface fixes — September 28, 2026

Development-only frontend release. Equipment titles wrap while status tags
remain aligned at the top right. Successful unit saves close the popup and
clear its route; rejected saves keep the form open with an error. Timeline,
Service Programs and their due-service panel are temporarily disabled in the
Equipment interface, retaining implementations and stored records. Work Orders
remain available.

Validation: JavaScript syntax and three focused contracts/browser checks pass.
Chromium exercises widths 360, 560, 768 and 1280, successful and rejected saves,
route clearing, disabled Timeline routes, and Maintenance without program API
requests. APIs use synthetic fixtures for this browser verification.

Deploy only public/libraries/apps/equipment/app.js from the committed canonical
source over each verified live web baseline. Guard staging and activation
against intervening releases, retain runtime/configuration and all other assets,
and verify local readiness, development isolation and public asset hashes.
Evidence and final release receipt: output/equipment-ui-20260928/ (ignored).

Rollback: inspect current releases for intervening work before restoring the
per-node prior release recorded in the receipt via the existing atomic symlink
and service restart workflow. Verify readiness and isolation after rollback.
No migrations, topology, provider, worker or production changes.

Completed rollout: `8099f33af373ecf3ac9788079c25bef0f8485a38` is active on
both development web nodes (`do-598520065`, `do-603124965`). Both passed local
readiness, development isolation and Equipment asset hash checks. Six public
readiness requests and the public asset hash passed. The same Chromium flow
also passed against the script fetched from dev.1m8.ai with synthetic API data.

A concurrent window restore release advanced the second node during staging.
The activation guard correctly refused its stale baseline. Its never-activated
staging directory was preserved, then restaged over verified `9d1c687` before
activation. Both nodes inherit that release; no concurrent assets were replaced.
The per-node rollback baseline is `9d1c6877257d5a32c0e64a2d77ff0a78f87fa3ed`.
