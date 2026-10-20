# Production release 31f87be5: staging — October 20, 2026

Jack authorized steps 1–3 of the production push: pre-flight, staging and the
platform index. **Nothing was activated.** Every role still runs its previous
release:

| Role | Release still live |
| --- | --- |
| Web (six nodes) | `15ed3851` |
| Compatibility | `3d424a69` |
| Worker | `3d424a69` |

## Release

- **Commit.** Canonical `31f87be5f482dd581233e515a95ac76fdd659ee2`. It contains everything on dev, plus:
  - [the release gates](development-release-gates-20261020.md);
  - [the original roof report layout](development-pdf-original-layout-20261020.md).
- **Build.** Built on the dev worker in `/var/tmp/fm-prod-release-20261020/` with `npm ci`, check, build and prune, as the service user, and packaged with `release-artifact.py`.
- **Archive.** `9f0305b0bfa8e28996a9a6f23ca54753a000f1c3d841bc6d05ffbf7c06505e92`, 358,627,456 bytes, 27,726 files. `release-artifact.py verify` passed.

## Pre-flight (read-only)

- **Load balancer.** It reaches six web nodes, all on `15ed3851`: do-599442759, -763, -764, -766, -768 and -769. The seventh IP in older records is gone.
- **Services.** All eight roles are active on production data.
- **Disk.** Free space is 50–170 GB.
- **Database.** 147 connections, of roughly 800.
- **Worker queue.** 1 job running and 323 queued.
- **No changes needed** for:
  - **PDF browser.** Playwright is unchanged (1.59.1, `chromium_headless_shell-1217`).
  - **Email.** Postmark is read from each role's environment.
  - **Release folders.** No runtime data is kept inside one.
  - **Core schema.** The FirstMeasure schema version is unchanged (5).

## Staged

- **Compatibility and worker.** The archive is installed in
  `/opt/firstmeasure/releases/31f87be5…` with the archive's own installer, as
  previous production roles were. The `current` link is unchanged. Copies are in
  `/var/tmp/firstmeasure-release-31f87be5/` on both hosts.
- **Web nodes.** The installer `/usr/local/lib/firstmeasure-release/release-artifact.py`
  on all six was replaced:
  - New sha256 `ab7a8885…`; its unit tests pass on production Linux.
  - Previous copy kept beside it as `release-artifact.py.before-31f87be5`
    (sha256 `73177938…`).
  - The new installer accepts everything the old one did, and also:
    - `src/storage/artifact_catalog` and `src/storage/storage_metrics`;
    - a folder named `private` inside a node_modules package (`@bufbuild/protobuf`).
- **Autoscale image.** It still has the old installer. A newly booted web node
  would refuse this release and stay out of rotation until the image is updated.
  This needs a separate decision.

## Database

`prepare-platform-indexes` ran from the new release with the compatibility
service's production environment and took 2 seconds:

- It created the valid partial index `platform_expanded_orgs_idx`.
- Platform storage setup added one table, `platform_control_documents`. All
  other platform DDL is identical to what production already runs.
- No organization has `platform.expanded_access`.

Public readiness answered 24/24 on `15ed3851`. The portal and internal pages respond.

## Remaining (needs authorization)

Activate in this order:

1. Compatibility.
2. Worker, once no job is running.
3. Publish the signed web channel from the compatibility controller.
4. The six web nodes, one at a time with the NGINX drain.

Then verify. Rollback is the previous `current` link on each role, plus
republishing `15ed3851` to the channel.
