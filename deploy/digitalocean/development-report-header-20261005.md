# FirstMeasure compact report header — October 5, 2026

Runtime source: `b608906b0b02fa9cdbfccd4319900bfbf4d733b4`.

Ordered projects with only Reports and Map (optionally Photos) use one equal-width icon row for Customer, Standard, Summary, Map and optional Photos. The row uses the project header's compact 32px underline styling, meaningful labels/tooltips and the map-location icon. Map and Photos continue using their existing project panels and ownership. Model/XML do not add header entries in this compact presentation; XML remains accessible in Summary. Additional project tabs or optional report tools (Instant, Weather, Support) retain nested report navigation.

Report buttons now derive active state after resolving the selected view, and set matching aria-selected values. The shared row updates on project-tab changes so only the currently displayed report, Map or Photos is highlighted. Existing report route handlers remain in use.

Validation: syntax checks; ten targeted tests covering report entry, window shell, mobile ordering and four/five-tab navigation; a Chrome harness with full project and window-shell styles at 414px and 1100px, including icon-font visual review. The navigation harness checks every selected tab, equal widths, 32px height and fallback to nested navigation. Evidence: `output/report-header-20261005/`.

The release overlays two frontend files on each existing immutable development baseline, preserving unrelated live and workspace changes. Prior release on all roles: `f590528965536bf351231c866dca59ce83a867cf`. Rollback uses each manifest's previous path and development service. Production and worker are unchanged.

Development activation was authorized in the ongoing conversation. All three roles passed running-release, asset hash, readiness and development-isolation checks. Public readiness and changed asset hashes match the release. Both browser navigation harnesses passed again using the published dev sources, including completed-report Model/XML eligibility and optional-tool fallback. No reports were ordered or customer records modified for these checks.
