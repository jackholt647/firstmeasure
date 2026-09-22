# FirstMeasure mobile hosts

This is the canonical shared-platform mobile app. `management-mobile` and `customer-mobile` are older Capacitor prototypes; they are not the release projects. The Android and iOS hosts load the same HTTPS portal, backend, organization permissions, feature flags, language and measurement settings as desktop. No separate screen implementation or report calculation exists in native code.

## Updates and compatibility

Deploying the portal updates its screens in installed apps on their next load. New hardware integrations require a native release. `PhoneFeatures.ready` negotiates bridge version 1; ordinary browsers never receive native layout attributes or download interception. Keep version 1 methods compatible when extending the bridge; advertise new capabilities and check them before use. Native navigation is restricted to the configured origin; external links use the OS browser and receive no native bridge. Do not enable cleartext, wildcard bridge origins, or arbitrary server URLs in release builds.

Android uses AndroidX WebKit's origin-scoped message listener, main-frame validation, and OS document/camera activities. iOS uses WKWebView with main-frame/security-origin validation, native photo/file selection, and WKDownload. Both persist the existing authenticated WebView session, support native sharing, generated-file exports, settings, and haptic feedback. PDFs must start at the application origin; redirects outside it are rejected to avoid forwarding session cookies. Shared blob exports are limited to 16 MB; server downloads to 150 MB (iOS enforces the declared content length). Files stay in private temporary storage and are pruned after one day on launch.

This is an online app. It does not promise offline report editing, queued background uploads, push notifications or video calls. Email/password authentication uses the existing portal. The native browser-sign-in button opens the existing login in the OS browser (ASWebAuthenticationSession on iOS); the return uses a two-minute, single-use ticket bound to a SHA-256 PKCE verifier and random state. The backend rechecks identity and membership before issuing app cookies. Google provider acceptance still needs an account-specific device rehearsal. Native audio capture prompts for permission; Android video capture is not advertised. The shared adapter is the extension point for additional phone capabilities.

## Android

Install JDK 17, Android SDK platform 36, platform-tools, and an API 35 Google APIs x86_64 emulator image. Set `JAVA_HOME` and `ANDROID_HOME`. The checked-in Gradle wrapper downloads Gradle 8.13.

```
cd native/firstmeasure/android
./gradlew assembleDevelopmentDebug testDevelopmentDebugUnitTest
./gradlew bundleProductionRelease
```

On Windows use `gradlew.bat`. The development APK is `app/build/outputs/apk/development/debug/app-development-debug.apk`; it connects only to `https://dev.1m8.ai` and has a separate application ID, so it can coexist with production. Install explicitly on your emulator: `adb -s emulator-5554 install -r <apk>`. For a visible emulator run `emulator -avd FirstMeasure_API35`. Run `../scripts/test-android.ps1 -Serial emulator-5554` from PowerShell, or set `ANDROID_SERIAL` and run `connectedDevelopmentDebugAndroidTest` on other systems. Never let a test runner pick an attached personal phone implicitly.

`scripts/start-android.ps1` opens the configured emulator window, installs the current development APK and launches FirstMeasure for interactive testing. It targets only the selected emulator port.

The production AAB is unsigned. Play distribution requires your account, approved package ID, upload signing key and listing. Keep signing material outside Git. Debug builds use the developer machine's debug key; APKs from a different CI/machine key require uninstall/reinstall and lose that app's local session. Use a stable test signing key before distributing continuous upgrades to a wider pilot.

## iPhone and iPad

On a Mac with Xcode and an installed iPhone simulator: `brew install xcodegen`, then `bash native/firstmeasure/scripts/test-ios.sh`. Set `IOS_SIMULATOR_ID` to choose an existing simulator. This generates the Xcode project and runs unit/UI tests without signing. Open the generated `ios/FirstMeasure.xcodeproj` to emulate interactively. The Development configuration connects to dev; Production connects to the production portal.

For a physical iPhone/TestFlight, choose your Apple development team, register the final bundle IDs, archive the correct configuration, and sign/upload through Xcode/App Store Connect. An unsigned IPA is not a direct-install option. `MOBILE_IOS_TESTFLIGHT_URL` controls the private testing link once the build is available. The shared existing icon is included; review final icon/alpha requirements, privacy disclosures, camera/photo permissions and store screenshots before submission.

## App download Settings tab

`mobile.app_download` defaults on for both old and new organizations, independently of expanded apps. It adds one category after Billing. Unpublished store URLs render as unavailable, never fake store destinations. Set `MOBILE_ANDROID_STORE_URL` to a Google Play URL and `MOBILE_IOS_STORE_URL` to an App Store URL when listings exist.

Test downloads require **both** `mobile.developer_downloads=true` for the organization (default false) and `MOBILE_DEVELOPER_DOWNLOADS_ENABLED=1` on a `FIRSTMEASURE_DATA_ENVIRONMENT=development|test` server. Set `MOBILE_ANDROID_TEST_APK_PATH` to an absolute, private `.apk` path outside the web root, `MOBILE_TEST_BUILD_VERSION`, and optionally `MOBILE_IOS_TESTFLIGHT_URL`. Every request checks membership and current flags; the APK URL has no public static alias. Production refuses test binaries even if an organization has the testing flag.

## Verification and release gate

Run `public/v1` tests `mobile-api.test.ts`, `phone-features.test.mjs`, `localization-api.test.ts`, `localization-browser.test.mjs`, plus the settings layout contract. The mobile workflow builds both native projects, runs Android emulator tests and iPhone simulator tests, and uploads artifacts; it never deploys or publishes to stores. Keep CI green and complete physical-device camera/photo/PDF checks before a wider pilot.

Manual acceptance on each phone: existing account login/logout; organization switch; old organization with unset flags; metric/imperial and US/UK language; roof and exterior ordering; multi-photo selection, camera capture and cancellation; rejected upload/retry; delivered PDF open/save/share; generated PDF export; external links; keyboard/rotation/back gestures; losing/restoring connectivity; app background/resume; settings permission denial. Desktop: compare Company logo, Users list, navigation and ordering before/after. No payment or live report orders should be used for testing.

Read root `DEPLOYMENT.md` before activation. Development deployment must preserve the complete source baseline, refresh PHP-FPM on both web and compatibility hosts, and validate authenticated HTML as well as Node readiness. Public app-store submission and production activation are separate releases.
