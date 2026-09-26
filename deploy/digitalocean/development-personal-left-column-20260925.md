# Personal left-column preferences — development

Source commits `38ae636` and `47c903e` are pushed on
`codex/consolidated-firstmeasure-20260923`. The left-column Apps, To Dos,
Channels, Agents, default tab, compact mode, expansion mode and drag-resize
controls now live in Company Settings > My Settings. They save through the
authenticated user's `/v1/platform/me/preferences` endpoint without operator
authorization. The organization capability catalog no longer publishes these
layout switches. Assistant Settings no longer contains Conversation layout.
Application and domain permissions still gate the underlying content.

Both serving development web nodes advanced from release `060150a24dd4e70d62593a2fbe466a0f191e93e1`
to immutable release `47c903e37a33c5601efb24c9e4bdf04f6c5429b3`. Each
release inherited its exact live predecessor and overlaid 14 reviewed source
and compiled-runtime files. The live predecessor contained concurrent drag
resize and Brand Kit work absent from the canonical source: the deployed
`core.js` retains drag resize and reads its setting from personal preferences;
the deployed `company.js` retains Brand Kit and adds the My Settings controls.
The drag-resize code and markup were reconciled into `47c903e`; the separate
Brand Kit source remains a concurrent integration to preserve during future
deployments. No production role or data was changed.

`npm run check`, the 12 capability tests, the focused sidebar contracts and
the personal translation-preference test passed locally. The full publication
suite has one unrelated existing application-inventory assertion failure;
broader Channels/sidebar source contracts have five failures outside changed
behavior. The development hosts have Node but not npm; both staged releases
passed JavaScript syntax checks and byte comparison of every overlaid file.
Both local `/v1/health/ready` responses reported the new release, development
data and enforced outbound isolation. Twelve public readiness requests were
healthy, and public Core, Settings, Assistant and Channels scripts matched the
staged SHA-256 hashes. Load-balancer sampling selected one node in that short
public check; both nodes were verified directly.

For rollback, first account for any later concurrent release. Restore each
node's `/opt/firstmeasure/current` symlink to the previous release above,
restart `firstmeasure-development-web.service` and `php8.3-fpm.service`, and
verify local readiness and outbound safety. Personal preference fields are
additive; no data rollback is required.
