# Development Test Company Full Structure reports — September 24, 2026

Test Company (`3dbf7f79528139e27c491363`) could order only roof reports
because its `firstmeasure.exteriors` organization capability was unset. The
capability defaults off and controls residential Full Structure ordering in
the UI and server. Commercial and multifamily have separate default-off
capabilities.

The development organization identity was verified before changing its global
document. A read-only audit found no development organizations with the master
Full Structure flag enabled. The Test Company flag was set to true using the
platform's atomic global-document mutation, preserving its other flags.

The resulting document is revision 115. Effective capability checks on both
serving development web nodes and the development worker return true for
`firstmeasure.exteriors` and false for its commercial and multifamily children.
A repeat audit found Test Company to be the sole development organization with
the master flag enabled. No report was ordered during verification.

No application release or production data was changed. The development
runtime does not currently set `PLATFORM_TEST_ORG_IDS`, so the operator API's
test-organization flag-management allowlist remains unavailable; this data
change did not enable general self-service flag changes.
