# Development portal CSRF cookie correction

Source commit `51cb6e09e56920f30c4e3e1811daff9de00c012e` corrects 24 browser
files and the communications developer page. The live development session uses
`fm_platform_session_development`; affected clients instead read the fixed
`fm_platform_session_csrf` cookie. Missing tokens or stale production tokens
therefore failed the server's CSRF check even for administrators.

All affected browser readers now select the configured session's CSRF cookie.
Token readers run for each request, so cookie updates after login or account
switching take effect without retaining the previous token. Standalone clients
retain the default production cookie when no custom name is configured.
Malformed cookie values are ignored by the updated token readers. The server's
CSRF validation and all business permission checks remain unchanged.

## Validation

- 97 browser regression cases pass across 24 clients/audio surfaces, including
  development cookies, stale production cookies, missing/malformed tokens and
  cookie rotation. A source guard prevents fixed production cookie names from
  returning to browser bundles.
- An isolated server integration test passes: a registered administrator with
  the development session can save preferences with the matching token; missing
  and stale tokens receive `403 csrf_required`. The communications test page
  renders the configured cookie name.
- TypeScript check/build and syntax checks for all changed scripts pass.
- Broader setup/Channels/checklist contracts pass 28/31. Three failures concern
  unchanged Channels/FirstMeasure markup expectations (`Starred`, attention
  views and `History`), outside the CSRF change.

## Release preparation

Each role inherits its complete live predecessor. Baseline guards caught a
concurrent fleet and signup-sandbox rollouts before activation. Final candidates
inherit web release `cf0ae5624a3b91bcebe2527be86a79c0ff016ae2` and compatibility
release `330470f3712f69c53c3bb14f36c112232df14d48`, preserving both changes. Earlier,
unactivated candidates remain available as staging evidence. The delta contains
the 25 reviewed source files and the compiled communications developer page.
Each staged file is checksum verified; the changed TypeScript module is also
transpiled on Linux and compared with the packaged runtime.

Evidence and per-role deployment manifests are under `output/csrf-20260928`.
There are no database, provider, permission, infrastructure or production changes.
The worker does not serve these browser assets or the developer page and needs
no activation. Development autoscale replacement-image provisioning remains an
existing limitation; this rollout targets the running hosts.

## Activation and public verification

Release `51cb6e09e56920f30c4e3e1811daff9de00c012e` is active on both development
web nodes (`fm-dev-web-598520065`, `fm-dev-web-603124965`) and the development
compatibility API. Each role passed guarded local readiness with development
outbound isolation enforced, and all 26 overlaid file hashes matched.

Twelve public readiness requests passed and all 24 public browser-file hashes
matched the release. Public load-balancer sampling selected `do-598520065`;
both serving nodes were verified directly. Existing tabs need a portal reload
to load the corrected JavaScript. No production release was activated.

Rollback restores the web nodes to `cf0ae5624a3b91bcebe2527be86a79c0ff016ae2`
and compatibility to `330470f3712f69c53c3bb14f36c112232df14d48`, then restarts
the corresponding development service and PHP-FPM and verifies readiness.
Recheck for newer releases before rollback. There is no data rollback.
