# Mobile project header loading parity — October 5, 2026

Runtime source: `35eaada3b47aa7d1a37e7ca6216afbd45e61aac3`.

The opening project header inherited the desktop title size (13px) and a 65% dropdown width limit until the child content installed mobile overrides. Shared, synchronously installed mobile shell styles now give both headers the same 18px title, full available trigger width, absent identity/control separator and hidden empty stage wrapper. Only tab content remains loading.

Validation: JavaScript syntax passed; eight local Chrome browser tests passed. The new regression failed against the before snapshot with 13px instead of 18px. It compares loading and loaded title font, title/trigger widths, header height and separator geometry using the actual shell and project styles. Three report-header tests also passed with source fetched from dev after activation. The synthetic browser harness does not order reports or modify customer records. Evidence: `output/header-title-parity-20261005/`.

One frontend file was overlaid on each role baseline, preserving unrelated changes. Concurrent deployment was caught by baseline guards; compatibility and pool were re-audited and restaged on `76abe6092e508a8bc4ede491bab00b4730da9879`, matching web. All roles ultimately use that previous release. Pool had 2,542,497,792 bytes free, insufficient for the full-copy staging guard. It used the existing immutable hardlink staging method after confirming the same filesystem, retaining the 1 GiB reserve and checking inode capacity. Changed files and release metadata are detached before writes. No historical releases were deleted.

Development activation was authorized in the conversation. All three roles passed running-release, asset-hash, readiness and environment-isolation checks; public readiness and the served asset hash matched. Production and worker were not changed. Rollback uses each manifest role's previous path and development service.
