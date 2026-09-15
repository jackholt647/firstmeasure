# Internal exteriors integration — development only

Source branch: `codex/internal-exteriors`, based on `c888adf` from the current
`codex/september-14-bugfixes` branch. Integration is in the existing FirstMeasure
GitHub repository. The separate prototype and sibling working checkout were
preserved. Continue exterior development on the integration branch.

## Candidate

Runtime commit `c5834ea9b878e3d6be678c81214b8433957075bd` includes the PHP-specific
signing override required by development's separate provider-key files. The
override affects full-house traffic only; existing provider credentials remain
unchanged. PHP FPM stores the override in a root-readable configuration file.

Linux artifact: `/home/dev/exteriors-c5834ea.tar.gz` and `.tar.json` on the dev
worker. Size 249,859,527 bytes, SHA256
`a4b1936b462a8d90f5c83d9e12e23c5a102e2f3803f7833f2de016ad6d209e85`.
Build checkout: `/home/dev/code/internal-exteriors-build-20260915`.

Development hosts: web `143.198.68.11`, worker `137.184.44.82`, compatibility/PHP
`137.184.229.145`. No production host, release pointer, or signed production
channel was activated. Artifact metadata follows the existing packaging format;
it does not authorize production deployment.

All three roles activated and verified this exact release with the allowlist
preserved. The first integrated release matched 1,265 unrelated source files
against the deployed baseline on each host; the signing follow-up matched 1,329
unchanged source files. The worker had no active jobs before each restart.

## Access

The authenticated development browser identified the user's account as
`jack@1m8.ai`. Development's three Node roles require the exact allowlist value
`FIRSTMEASURE_FULL_HOUSE_EMAILS=jack@1m8.ai` and the explicit enable flag.
Other environments retain the default off behavior. No general navigation entry
was added. Open `https://dev.1m8.ai/measure/internal/full_house.php` to submit an
address with the required full-house checkbox.

The synthetic live draft `fullhouse_246e192b64b4198227dbf3e9ffc58216` is labeled
`EXTERIORS DEV SMOKE 20260915 - internal draft`. It was created without imagery
processing and contains no customer geometry. Its private metadata and resource
roundtrips passed; unauthenticated/service-secret-only and unlisted signed
identities were denied; QA and delivery calls were blocked.
It now includes a generated checkerboard map and reference PNG for browser tests.

## Validation

- 662 exterior geometry regressions passed.
- Real browser pane test passed on Windows and Linux, including node-preserving
  view swapping and two-axis resizing without accidental swaps.
- Linux smoke: 180 passed, 11 skipped, zero failed; four deployment tests passed.
- Full-house isolation/persistence/revocation test passed with SQLite and an
  isolated embedded PostgreSQL database.
- Real PHP tests verify roof markup excludes exterior modules, permitted private
  markup includes them, and unlisted/default-off sessions receive 404.
- Signing follow-up: local and Linux PHP tests passed, all 84 PHP files linted,
  TypeScript build passed. The test uses different general and full-house keys
  and verifies the actual HMAC sent by PHP.
- Signed-in development browser verified normal roofing editor controls and
  working view swaps, with no wall controls or Resources tab.
- Public readiness recovered after the expected single-web-node restart/reentry
  interval. Fresh requests verified the development environment and enforced
  outbound safety. The served pane script matched committed source after
  normalizing line endings.
- The signed-in private submission page displays the synthetic draft and leaves
  the full-house checkbox unchecked for new submissions. Its editor loaded the
  synthetic map, wall controls, Resources tab, and private reference image.
- Public unauthenticated access to the private project/list returned 404 with
  `private, no-store`; the normal project listing returned 200 with no private IDs.

Full imagery acquisition and the user's acceptance of measurements/PDFs remain
part of their hands-on testing. The synthetic draft does not establish either.

## Rollback and promotion

Private drafts now exist. Disable `FIRSTMEASURE_FULL_HOUSE_ENABLED` to hide the
feature; retain its privacy filters. Do not revert to the pre-integration
`42ab264` binary while private drafts remain in the active store. The `ea55a99`
integration release retains the guards but lacks the PHP signing override.

Keep production deployment held until the user approves it. Before promotion,
refresh production inventory/baseline and verify all rollout roles and any web
replacement-node source include the guards. See `INTERNAL_EXTERIORS.md`.
