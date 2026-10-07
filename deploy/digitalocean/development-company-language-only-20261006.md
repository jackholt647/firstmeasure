# Company language without personal interface settings — October 6, 2026

Runtime release: `8c06e90029c6d502c31cab5c3cfa446186bd35d6`.

Company/report localization no longer enables the My Settings tab. Personal
interface language follows the existing opt-in `platform.my_settings` flag,
which defaults off. Enabling other personal controls (such as left-column
appearance) does not expose interface language. Company information language
and measurements still follow `firstmeasure.report_localization` and remain
on for FirstMeasure signups. Saved preferences and language resolution are
preserved; this adjustment controls settings visibility.

Candidate browser checks passed fresh FirstMeasure settings at 1440 and 390px:
company language and measurements visible, default My Settings hidden, and
interface language absent. Enabling appearance controls displayed those controls
without exposing interface language. Company selectors remained available.
Disposable fixtures were deleted. JavaScript syntax checking passed.

Only Company settings and its asset version are deployed, as audited per-role
immutable overlays to web, compatibility and pool. The worker and production
are excluded. Unrelated live assets and differences remain intact.
Artifacts and receipts are in `output/company-language-only-20261006/`.

Prior serving release: `dd27dc17e08db99f57ac7450773a66601328eb99`, under
`/opt/firstmeasure/releases/` on web/pool and
`/opt/firstmeasure/releases-root-archive/` on compatibility. Rollback restores
the recorded prior path, restarts the role service and reloads PHP-FPM;
check intervening releases first.

Activation and final verification passed on all three serving roles. Owned
asset hashes matched; readiness and development outbound isolation passed.
The fresh hosted organization passed the company/personal settings visibility
checks at desktop and mobile widths and was deleted.
