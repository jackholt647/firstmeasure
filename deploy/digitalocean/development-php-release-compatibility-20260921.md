# Development PHP release compatibility — September 21, 2026

Resolved on September 22 UTC. Application runtime remains
`9ee0e68ba5c8671468d121629ac97be00e7336c6`; this is a deployment configuration
correction, not an organization-data migration.

## Cause and observed impact

The web host's PHP-FPM had not restarted since September 18. Releases switched
the `current` symlink and refreshed Node; the ad-hoc development activation
helper refreshed PHP only on compatibility. NGINX supplied PHP with
`$document_root$fastcgi_script_name`, retaining the symlink in the filename.
PHP realpath/opcode caching continued serving an older portal document with
newer JavaScript. The authenticated page lacked the current account-switcher
markup and supporting scripts. Settings initialization and the Users app were
incomplete; logo/settings values could remain blank or broken.

This was reproduced by inspecting the actual authenticated development DOM
against the deployed portal source. It was not caused by the age of the
organization or an incorrectly configured company flag. The user confirmed
that the company logo, Settings/account controls and Users tab all worked after
the repair and refresh of the same notifications@1m8.ai session.

## Permanent correction

- Development web (143.198.68.11) and compatibility (137.184.229.145) NGINX now
  pass `$realpath_root$fastcgi_script_name` to PHP, giving every immutable release
  a distinct PHP entry filename. Both configurations passed `nginx -t` before
  reload; PHP-FPM was restarted to remove stale cached paths immediately.
- All four checked-in PHP-serving NGINX templates use resolved release paths.
- The checked-in release activator now refreshes PHP on both web and legacy
  activation and rollback. Worker-only releases do not restart PHP.
- Future development helpers must also refresh PHP on both PHP-serving roles;
  checking only Node readiness does not validate the rendered portal shell.

No organization documents, flags, memberships, branding or permissions were
edited. No production service or live production configuration changed. Future
production deployment should include the reviewed template/activator fixes.

## Verification

Three deployment contract tests passed. A separate Linux integration test ran
isolated NGINX/PHP-FPM processes on loopback with fictional release directories,
opcode timestamp checks disabled and a long realpath cache. The old configuration
reproduced the bug (upgrade still returned the old PHP include); the fixed
configuration returned old -> new -> old across upgrade and rollback without
restarting FPM. Test processes and fixtures were cleaned up.

The test is `deploy/digitalocean/tests/php-release-switch.py`; run as root on a
Linux test host with NGINX and PHP-FPM 8.3 installed. It does not use application
data, credentials, running services or public ports.

Public readiness after the correction remained healthy development with
outbound isolation enforced. Browser verification showed the current Settings
and account controls; the user's original session confirmed all three reported
issues resolved. This is targeted upgrade compatibility verification, not a
claim that every historical organization variation has been exhaustively tested.

The previous NGINX config is backed up on each dev PHP host at
`/etc/nginx/sites-available/firstmeasure-development.before-portal-compatibility-20260921`.
Restoring it requires `nginx -t`, reload and PHP-FPM refresh, and reintroduces the
symlink-cache risk. Application code rollback remains independent and must
refresh both PHP-serving roles.
