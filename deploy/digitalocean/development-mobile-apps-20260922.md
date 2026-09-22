# Development mobile app release — September 22, 2026

Active development release: `a639aad1132f425ed567aafd03f4d08ffbba5dfe` on web, worker and compatibility. Production was not activated or modified. Source branch: `codex/mobile-platform`.

The release merges the mobile implementation (`ad4b103`) with the independently deployed wall/plane editor (`18a81ab`). A baseline guard stopped an earlier activation when that editor deployment started. The final 32-file public runtime delta was staged on `18a81ab`, preserving and hashing more than 24,000 unchanged runtime files per host, including all four editor files. The earlier staged `ad4b103` directory was never activated and must not be used as a rollback target.

## Shipped behavior

- Shared HTTPS portal in native Android and iOS hosts; native camera/file selection, sharing, PDF/generated-file exports, haptics, permission settings, audio capture and app lifecycle handling.
- Versioned, origin-restricted bridge with main-frame checks. Existing desktop controls retain browser behavior.
- System-browser login handoff with random state, SHA-256 PKCE, a two-minute single-use ticket, live membership revalidation, and normal authenticated app cookies. Both SQLite and PostgreSQL consumption are atomic.
- Settings → App download, default on and independent of expanded apps. Store URLs remain unset until real listings exist.
- `mobile.developer_downloads` defaults off. It is enabled only for local Flow Roofing (Local review), ID `0a8f8865e3c78d2441e08746`, and development Test Company, ID `3dbf7f79528139e27c491363` (the `notifications@1m8.ai` account).
- A settings renderer correction handles categories without terminology keys; old organizations need no data repair to render the new category.

## Runtime configuration

Both PHP-serving development hosts have `mobile-testing.conf` systemd drop-ins under their existing development service directories:

```
MOBILE_DEVELOPER_DOWNLOADS_ENABLED=1
MOBILE_ANDROID_TEST_APK_PATH=/opt/firstmeasure/mobile-builds/FirstMeasure-dev-ad4b103.apk
MOBILE_TEST_BUILD_VERSION=1.0.0-dev.ad4b103
```

These settings cannot serve test builds unless the runtime data environment is development/test **and** the requesting organization has the testing flag. The APK is outside the public root, served only after current session, organization and flag checks. It is 2,805,764 bytes, SHA-256 `3521ee03419ecef5a94260bafe25227d3e2d10ee08f0c9c81cb8490156acc0b6`, signed with the local Android debug key, and connects to dev.1m8.ai using a separate app ID. It is not a Play production release.

## Validation

- [Mobile CI on the exact mobile code](https://github.com/jackholt647/firstmeasure/actions/runs/35685717453): shared checks, Android build/emulator tests and iPhone simulator build/tests all passed. The merge changed only the separately tested editor files.
- Local TypeScript build and seven focused API, bridge, browser, file-selection and localization tests passed. The complete mobile API test also passed against an isolated PostgreSQL instance.
- Four Android instrumentation tests and two Java origin-policy tests passed; development APK and unsigned production AAB built.
- iPhone simulator unit and UI tests passed on GitHub's Mac runner, including launch, rotation and relaunch. Physical iPhone installation still needs Apple signing/TestFlight configuration; real provider login and camera/library behavior require a physical-device acceptance pass.
- 311 editor tests passed after merging the current wall/plane release.
- Signed-in local browser verified Company, logo elements, Users, metric/UK settings, the new download category and an actual APK download.
- Public development HTTP checks verified the release, signed-in portal scripts, the APK checksum, anonymous APK rejection (401), and authorization/form-post exchange back to `/portal/`. Temporary verification sessions were deleted.
- PHP-FPM was restarted on **both** web and compatibility during activation. Existing `$realpath_root` FastCGI configuration remains in place.

The broad FirstMeasure smoke workflow already had five failures before this work (appointments, message-language preferences, two full-house checks and the left-column flag test). The same failures appeared on the first mobile commit. Its old Money layout source-string contract also assumes pre-localization markup. These are not represented as passing; the focused mobile workflow is green.

## Follow-up and rollback

See `native/firstmeasure/README.md` for build commands, emulation, protocol behavior and physical-device acceptance. Public store URLs, Apple team/signing, TestFlight and Play upload signing remain external release setup. No store submission was attempted.

Rollback runtime to verified `18a81abf43bc80ca38ed5f84a2809cfd78fdb3fd`, preserving the editor release. Use the established development activation checks, wait for an idle worker, and restart PHP-FPM on both PHP-serving roles. The mobile environment drop-ins and testing flags can remain inert on that older runtime, or be removed explicitly as part of a full feature rollback. Do not activate the abandoned `ad4b103` staging tree.
