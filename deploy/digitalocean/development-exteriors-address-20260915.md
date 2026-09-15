# Full-house address selection — development follow-up

The dedicated full-house page now uses Google address suggestions and creates
full-house measurements automatically. The redundant scope checkbox is removed.
Selecting a suggestion supplies its formatted address and latitude/longitude;
editing the text clears that selection and disables submission until a new
suggestion is selected. Google load/authentication failures also disable creation.

PHP validates the address and coordinate ranges, fixes the submission scope to
`full_house`, and forwards those coordinates to the existing imagery pipeline.
For new projects, that pipeline uses supplied coordinates before text geocoding.
The existing owner allowlist, default-off feature gate, private project filters,
and separate PHP signing configuration remain unchanged.

## Validation

- Two browser-logic tests cover Google selection, exact submitted coordinates,
  changed text, missing geometry, API failure, and duplicate-submit protection.
- Real PHP tests reject missing/invalid coordinates before calling upstream,
  verify the exact address/coordinates forwarded, and ensure client parameters
  cannot change scope or skip imagery processing.
- Existing PHP access/signing tests and customer export tests passed alongside
  the new tests on Windows and Linux.
- TypeScript checks/build and all 84 PHP syntax checks passed.

## Deployment

Runtime: `6eed8c8a0b0f2d02673176a0dda205d2bfc6a685`, preserving customer
export release `4e7390e1daabdaca361294ce35809fac91590a3b`.
Linux artifact `/home/dev/exteriors-6eed8c8.tar.gz`, size 249,867,150 bytes,
SHA256 `6b23d56fbfb6f6e6e4803c656eee0dfcce579ad1b501bd95959e846de6149b28`.

All three development roles activated this runtime. Each staged release verified
1,333 unchanged public source files against the export baseline. Live processes
reported the expected release, development data environment, enforced outbound
safety, and the existing exact owner allowlist. The worker had no active jobs
before restart. No feature configuration, production host, or production release
pointer changed. Existing provider keys were reused without rotation.

Public readiness recovered and reported this release, development data, and
enforced outbound safety. The signed-in browser verified a real Google dropdown,
selected a public property address, received its normalized formatted address,
and enabled Create measurement. Editing the text disabled creation again. The
user's previously typed address was restored without submitting a measurement.
The checkbox is absent. Automated tests verify coordinates through the PHP
submission boundary; no real Solar imagery job was created for this UI check.

Production remains held. The merged export verification record is
`development-export188-20260915.md`.

## Development PHP browser-key configuration

Live verification found that Nginx passed PHP an existing Node provider-key file
that `www-data` could not read. PHP's default release-relative file also does not
exist. This prevented Google browser scripts from loading.

On the development compatibility host only, a dedicated file
`/etc/php/8.3/fpm/firstmeasure-browser-provider-keys.json` now contains the four
existing Google browser key fields (general, internal, customer, territory),
owned by `root:www-data` with mode `0640`. No server, Solar, application signing,
or other backend credential was copied, and the Node key file's permissions were
preserved.

The development Nginx site's `PROVIDER_KEYS_PATH` FastCGI parameter points at
this browser-only file. Its original configuration is backed up alongside the
resolved site file as `firstmeasure-development.before-browser-20260915`.
PHP's `[www]` environment uses the same path via
`/etc/php/8.3/fpm/pool.d/zz-firstmeasure-browser.conf` (root-only mode `0600`).
Nginx and PHP configuration validation passed before graceful reloads.
The existing `zz-firstmeasure-exteriors.conf` signing override was preserved.

Keep these settings when rolling development releases. They are development
configuration, not authorization to modify production.

This follow-up supersedes the checkbox instructions in the original
`development-exteriors-20260915.md` deployment record.
