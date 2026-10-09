# Development SMS campaign default: Low Volume Mixed - October 9, 2026

New, unsubmitted 10DLC campaigns now default to Telnyx's `LOW_VOLUME`
use case (displayed as Low Volume Mixed) instead of `AGENTS_FRANCHISES`.
The setup API, company settings wizard, provider submission payload, and
outbound purpose checks use the same default. Existing provider-submitted
campaigns retain their selected use case. Sole proprietors still use
`SOLE_PROPRIETOR`.

The source change is commit `bdadfe8c5c6c1c25afd6a21d0aaa206e28ae0773`,
pushed to `codex/pioneer-puffin-feed-photos`. Local TypeScript check, build,
communications frontend suite, and the three focused 10DLC tests passed.
The full local messaging suite reached the changed tests but stalled in an
unrelated SQLite job-worker loop with a missing `firstmeasure_jobs` table;
it was stopped. The three focused tests also passed on all staged roles.

Development initially ran `b600cdc30c813db3234dcf34fa4acb1047101dba`.
Web and pool were staged with the changed source and compiled messaging
artifacts, verified by SHA-256, then a concurrent development release
`c967b5cb0e1ffc7cc71e8602e24eed260c38974a` took over both roles while
retaining those exact changed artifacts. Compatibility's concurrent release
still had the old messaging files. A hardlinked stage derived from its
active `c967b5cb0e1ffc7cc71e8602e24eed260c38974a` release was overlaid
with only the changed artifacts, tested, checksum-verified, and activated at
`/opt/firstmeasure/releases-root-archive-sms-low-volume/c967b5cb0e1ffc7cc71e8602e24eed260c38974a`.
This preserved the other concurrent release's files. Compatibility rollback
is the previous symlink target
`/opt/firstmeasure/releases-root-archive/c967b5cb0e1ffc7cc71e8602e24eed260c38974a`;
restart `firstmeasure-development-legacy` and `php8.3-fpm` after restoring it.

All three active roles now have identical SHA-256 hashes for the changed
messaging API, compliance rules, and company settings UI. All three report
development readiness and enforced outbound safety. The public readiness
endpoint reports release `c967b5cb0e1ffc7cc71e8602e24eed260c38974a`;
the public `/v1/messaging/sms/10dlc/options` endpoint reports
`defaults.campaign.usecase=LOW_VOLUME`, and the served settings script
contains the `LOW_VOLUME` default without the old `AGENTS_FRANCHISES`
default. No carrier campaign was submitted and no text was sent.

The separate development worker was not changed. Live SMS delivery must
remain disabled until the worker and carrier-registration prerequisites
are handled independently.
