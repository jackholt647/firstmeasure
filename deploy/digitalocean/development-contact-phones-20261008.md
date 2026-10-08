# My Contacts phone fields — October 8, 2026

Development release `8cd3c9a00a17257ac64394e59a085983d1c3d375` is active at
`https://dev.1m8.ai`. Production was not changed.

My Contacts now calls the existing phone field **Primary Phone** and uses phone
input formatting. The contact modal can add a **Secondary Phone**, choose home,
cell, work or other for either number, and switch which number is primary. The
secondary number and labels are default-on custom fields. The original top-level
`phone` continues to hold the primary number for calling and existing clients.

The commit was pushed to `codex/consolidated-firstmeasure-20260923`. Local
TypeScript check, build, contact browser fixture, contact import and publication
custom-field tests passed. The separately run custom-fields UI contract suite
had one existing project-request assertion failure outside this change.

The main web, pool web and compatibility roles were staged against their verified
`af3b797ac51a7dc132dbb84923f8657c0ebd6334` baselines. Staging replaced only
the owned contact runtime files and bundle tokens, preserving unrelated live
role differences. Each staged JavaScript file passed `node --check`. Activation
was sequential, with an atomic symlink switch, service and PHP restart, and
rollback on failed readiness. All three roles returned the exact release ID,
`data_environment=development`, and enforced outbound isolation after activation.
The public readiness endpoint returned the same values. Publicly served contact
modal and custom-field JavaScript matched the staged SHA-256 hashes.

The development background worker remains on the prior release. It does not
serve the contact modal or contact API; those run on the three activated web
roles. The worker's root deployment credential was unavailable from this
checkout, so no worker files or service were changed.

## Rollback

Each role's new release contains `.contact-phones-manifest.json` with the
previous path and deployed file hashes. If rollback is needed, first verify its
`current` symlink still points to this release. Switch to the manifest's
`previous_path`, restart that role's development service and `php8.3-fpm`, then
check local and public readiness, release identity, and development isolation.
Main and pool releases are under `/opt/firstmeasure/releases/`; compatibility
releases are under `/opt/firstmeasure/releases-root-archive/`. Preserve all
release directories and any later changes.
