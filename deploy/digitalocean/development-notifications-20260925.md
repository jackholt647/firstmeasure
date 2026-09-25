# Platform notifications and FirstMate app — development, September 25, 2026

The user authorized deployment to `dev.1m8.ai` and enabling Notifications for
Test Company (`notifications@1m8.ai`, organization `3dbf7f79528139e27c491363`).
Production was not changed.

## Activated releases

| Role | Release | Previous release |
| --- | --- | --- |
| Primary web | `e3ad1645bcd756cba9a5af818ff95d1c13fbdbb4` | `58113d59587a5a86ca3aab8177be62c9c6b86a42` |
| Pool web | `4108941a40aae3953efa38b9f3c45b401500ceb2` | `58113d59587a5a86ca3aab8177be62c9c6b86a42` |
| Worker | `d79912a656c0efd435f01ea25fa8564bee0676d7` | `b94be726b407047814b819de0cf935d49fce4e5b` |
| Compatibility | `97b7e018e573f907e2e7406939bfc2623eb80f3a` | `21fe1b937eaab6aba91eec3108dd8673f5ebb29d` |

Task source commit `fb01e6d` is on the canonical branch. Per-role source commits
are pushed under `codex/notifications-{web,pool,worker,legacy}-20260925`.
The release applies only the notification/mobile delta over each verified live
baseline. It preserves concurrent billing, Brand Kit, assistant, sidebar and
mobile spacing work. Release guards stopped stale candidates before activation.
Evidence and checksummed per-role manifests are in ignored
`output/notifications-dev-20260925/`; deployed records are
`notifications-release.json` within each immutable release.

## Behavior and company configuration

- Notifications is a default-on platform feature, available without expanded
  platform access. Settings displays only relevant enabled application sections.
- Measurements includes delivered, corrected, canceled, rejected and progress
  preferences, independently selectable for in-app and phone push delivery.
- Report transitions publish recipient-targeted notifications; notification
  reads enforce recipient access. Shared notification creation handles push,
  user preferences, native devices and stable Android/iOS categories.
- Test Company's `apps.notifications` was explicitly set to true through atomic
  global-document mutation, revision 120. Its prior value was unset. Expanded
  access remains false and Measurements remains enabled; other flags were retained.
- The only native app is `native/firstmate`, the global FirstMate Android/iOS
  platform host. Retired customer/management prototypes and wrappers were removed.
  Installed identifiers remain compatible with existing builds.

## Android download and remaining push setup

Both serving web nodes publish private Android build **1.0.3** through the existing
authenticated App download flow. The new APK's SHA-256 is
`0c0951284ea9568d7b0c1c4623d49e0657e11ddf0260643294274d42d3009ce5`.
Its signing certificate matches the prior 1.0.2 download, supporting in-place
updates. Each web service has a `zz-notifications-mobile.conf` drop-in pointing to
the immutable FirstMate APK under `/opt/firstmeasure/mobile-builds/`. Preserve it
along with the existing development-download gates.

Firebase and APNs server credentials are absent on development. The Android
client configuration is also not provisioned. Portal notifications and preference
controls are deployed; real phone push delivery is not yet operational. iOS source
is published, but a signed iPhone build and physical-device verification still
require Apple tooling/account setup. No phone installation or store submission
was performed.

## Verification and rollback

- Linux type check/build and all four role-specific backend builds passed.
- 27 targeted capability, mobile, notification, recipient and report workflow
  tests passed. Android build/unit checks passed before packaging.
- Every role passed readiness, development isolation, source/runtime hashes and
  compiled notification smoke checks after activation.
- Twelve public readiness requests reached both web nodes successfully.
- Authenticated Test Company browser checks on both web releases show the
  Notifications tab, five Measurements rows, no expanded-only sections, and no
  page errors. Desktop/mobile screenshots were inspected.
- Public authenticated APK download matches the published hash and version.
  Temporary verification sessions were revoked. No real report, message or
  payment was created for testing.

Rollback restores each role's previous `current` symlink and restarts its
development service, plus PHP-FPM for PHP-serving roles. For web rollback, remove
the new notification mobile drop-in to restore the previous private APK settings,
reload systemd, and verify readiness/downloads. Old releases and APKs were retained.
The company flag is independent of code rollback. No database migration occurred.

The existing development autoscale-image limitation remains: running nodes were
verified; replacement-node image/bootstrap provisioning was not changed. Future
releases must preserve these notification modules and private mobile settings.
