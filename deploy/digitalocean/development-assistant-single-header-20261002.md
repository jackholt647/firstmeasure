# Single project assistant toolbar — October 2, 2026

Source/release: `38936a7a01b40f29094602e02a3e4e1229e4015a`.
Target: `https://dev.1m8.ai`, development web and pool only.
Baseline on both roles: `2ddd423f0d1c12962d5a7c12aa399d143e6841a7`.

The Agent tray hides its outer title/close header. Its existing shared assistant
toolbar now owns the close button beside conversations and visuals. The button
ends capture and invokes the project tray close callback, preserving the mounted
conversation and draft. Other trays retain their title/close headers; a failed
assistant mount restores the outer header so the error panel can still close.

The overlay contains only `platform-assistant/platform-assistant.js` and
`project-trays/project-trays.js`. Both browser suites passed, including close,
reopen, draft retention and switching to another tray. Both staged JavaScript
files passed syntax checks. No backend code, permissions or project data changed.

Both roles activated and verified the expected release. Public readiness and both asset hashes matched. The browser tray test passed using the two deployed assets, including one visible toolbar, close/reopen and preserved drafts. The initial stage attempt stopped at a
transient readiness 503 before mutation; the next health read was healthy and
staging completed normally.

Rollback: restore the previous role release above, restart
`firstmeasure-development-web.service`, reload `php8.3-fpm.service`, and verify
readiness with development isolation and outbound safety. Recheck later releases
before rolling back. Production, worker and compatibility roles are outside scope.

Ignored verification receipts and payloads: `output/assistant-single-header-20261002/`.
