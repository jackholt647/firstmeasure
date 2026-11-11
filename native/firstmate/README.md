# FirstMate platform app

This is the single core FirstMate platform app for Android and iPhone/iPad. It belongs to the shared platform; FirstMeasure (Measurements) is one module inside it. There are no separate customer, management, or Measurements mobile apps. Available modules follow the same organization feature flags and user permissions as desktop. The Android and iOS hosts load the same HTTPS portal, backend, organization permissions, feature flags, language and measurement settings as desktop. No separate screen implementation or report calculation exists in native code.

## Updates and compatibility

The installed Android application IDs and iOS bundle IDs remain
`ai.firstmeasure.mobile` (production) and `ai.firstmeasure.mobile.dev`
(development) so existing installations can receive compatible updates. The
Java namespace, browser-sign-in callback schemes, and version-1 bridge transport
names (`FirstMeasureNative` and `firstmeasure`) are retained for compatibility.
They do not define a separate FirstMeasure app. The local `FirstMeasure_API35`
emulator name is also retained; pass `-Avd` to choose another emulator.

Deploying the portal updates its screens in installed apps on their next load. New hardware integrations require a native release. `PhoneFeatures.ready` negotiates bridge version 1; ordinary browsers never receive native layout attributes or download interception. Keep version 1 methods compatible when extending the bridge; advertise new capabilities and check them before use. Native navigation is restricted to the configured origin; external links use the OS browser and receive no native bridge. Do not enable cleartext, wildcard bridge origins, or arbitrary server URLs in release builds.

Android uses AndroidX WebKit's origin-scoped message listener, main-frame validation, and OS document/camera activities. iOS uses WKWebView with main-frame/security-origin validation, native photo/file selection, and WKDownload. Both persist the existing authenticated WebView session, support native sharing, generated-file exports, settings, and haptic feedback. PDFs must start at the application origin; redirects outside it are rejected to avoid forwarding session cookies. Shared blob exports are limited to 16 MB; server downloads to 150 MB (iOS enforces the declared content length). Files stay in private temporary storage and are pruned after one day on launch.

The app works without a connection once it has been opened online and signed in: the portal keeps its code, the data that was seen and the changes made offline on the device, and the hosts upload queued photos in the background, also after the app is closed (see Offline). It still needs a connection for the first launch and to sign in, and it does not promise offline editing in the measure editor or video calls. Email/password authentication uses the existing portal. The native browser-sign-in button opens the existing login in the OS browser (ASWebAuthenticationSession on iOS); the return uses a two-minute, single-use ticket bound to a SHA-256 PKCE verifier and random state. The backend rechecks identity and membership before issuing app cookies. Google provider acceptance still needs an account-specific device rehearsal. Native audio capture prompts for permission; Android video capture is not advertised. The shared adapter is the extension point for additional phone capabilities. Android push uses Firebase Cloud Messaging (FCM); iPhone push uses Apple Push Notification service (APNs). Firebase is the Android delivery service, not a second app. Existing app installations need an updated native build for push, while portal settings and notification triggers can update independently.

## Offline

The portal's offline engine ([docs/architecture/offline.md](../../docs/architecture/offline.md)) runs in the web view as it does in a browser: a service worker keeps the app's code, the data that was seen and the changes made without a connection. The hosts add three capabilities that only an app can provide. Each is reported in `info.capabilities` and checked by the page before use (`PhoneFeatures.supports(name)`); the bridge version stays 1, and an older app simply does not report them.

| Capability | What the host does | Android 1.0.8 | iOS 1.0.3 |
|---|---|---|---|
| `offlineUploads` | keeps a file in private app storage and uploads it in the background, also after the app is closed | yes | yes, without the `cameraToken` source (iOS has no native camera) |
| `photoLibrarySave` | saves an add-only copy of one photo or video to the camera roll, only when the page asks | yes | yes, `put` source only |
| `offlineShell` | lets the portal's service worker run, and shows a native "no connection yet" screen instead of the browser's error page | yes | yes |

### Bridge contract

Every method uses the version-1 envelope (`{ version: 1, id, method, payload }`, answered with `{ id, result }` or `{ id, error: { code, message } }`), is accepted only from the main frame on the portal origin, and is wrapped by `PhoneFeatures.offlineUploads.*` and `PhoneFeatures.saveToPhotoLibrary` in `public/libraries/phone-features/phone-features.js`. A request is at most 32 KB of JSON text, except `offlineUploads.put` (400 KB). Ids (`id`, `source.put`, the entries of `ids`) match `[A-Za-z0-9._:-]{1,128}`. Times are milliseconds since 1970. The page polls `offlineUploads.status`; the host sends no events.

#### `offlineUploads.put { id, offset, data, done }` answers `{ size, done, accepted }`

Writes a file the page holds into the durable private store, in steps. `data` is base64 of at most 262,144 bytes, `offset` a non-negative integer, `done` a boolean. `size` and `done` in the answer always describe what is stored after the call.

- Empty `data` with `done: false` changes nothing and answers what is stored (`size: 0, done: false` when nothing is). Use it to find out where to continue.
- `data` at `offset` 0 starts the file again and replaces anything stored under the id, a complete file included.
- `data` at any other `offset` is appended only when `offset` equals the stored size and the file is not complete. Otherwise nothing is written and the answer has `accepted: false`: continue from the `size` it gives, or start again at 0.
- `done: true`, with the last data or alone with `offset` equal to the stored size, marks the file complete. Repeating it for a complete file answers `accepted: true`.
- Errors: `chunk_too_large` (more than 262,144 bytes), `file_too_large` (more than 150 MB; what was stored is removed), `empty_file` (completed without a byte), `storage_full` (less than 16 MB would stay free), `invalid_request`, `storage_failed`.
- A handed-over file that is not queued within 7 days of its last write is removed.

`PhoneFeatures.offlineUploads.putBlob(id, blob, { onProgress })` does all of this for a `Blob`, including continuing a transfer that was cut short; it rejects with `invalid_file`, `file_too_large` or `put_out_of_sync` (the host disagreed about the offset twice).

#### `offlineUploads.enqueue { id, source, url, fileField, fileName, contentType, fields, headers, csrfCookie, saveToPhotos, size }` answers `{ id, state, created, requeued, savedToPhotos, photosError }`

Records an upload durably, takes its file and schedules it. The request is always a multipart `POST`.

- `source`: `{ put: <id> }` (a complete handed-over file) or `{ cameraToken: <token> }` (a native camera capture; Android only). The file moves into the job, so the put id or the token no longer exists afterwards.
- `url`: must be on the portal origin with a path under `/v1/`; at most 2,048 characters, no fragment, and no `..`, backslash or encoded `.`, `/` or `\` in the path. `PhoneFeatures` resolves a relative URL and refuses another origin before the host sees it.
- `fileField`: the name of the file part, `[A-Za-z0-9_.-]{1,64}`, default `file`.
- `fileName`: the last 120 characters are kept; quotes, slashes, backslashes and control characters become `_`. Default `upload`; for a capture, its own name.
- `contentType`: a media type; parameters are dropped. Default `application/octet-stream`; for a capture, its own type.
- `fields`: up to 64 text fields. Names match `[A-Za-z0-9_.[\]-]{1,100}`; values are strings (numbers and booleans are written as text, objects and arrays are refused: send JSON as a string). They are sent before the file, sorted by name.
- `headers`: only `Idempotency-Key` (required), `X-FM-Offline-User`, `X-FM-Offline-Org`, `X-FM-Offline-Replay` and `Accept`; values are printable ASCII of at most 256 characters. Any other name is refused with `header_not_allowed`.
- `csrfCookie`: the name of the readable CSRF cookie (`<session cookie name>_csrf`), `[A-Za-z0-9_.-]{1,128}`.
- `saveToPhotos`: `true` also saves a copy to the camera roll first (as `photoLibrarySave` does), only when this call creates the job. The upload is queued whether or not the copy worked: `savedToPhotos` and `photosError` (`null`, or a `photoLibrarySave` error code) say what happened.
- `size` (optional): the file size the page expects, in bytes; a different size is refused with `size_mismatch`.
- **The same `id` again** changes nothing, answers the job's current `state` with `created: false`, and leaves `source` untouched. The one exception: a job that is `failed` or `needs_sign_in` is queued again with this call's `url`, `fields`, `headers` and `csrfCookie` (and `fileName` and `contentType` when given). It keeps its file, so `source` may be left out, and the answer has `requeued: true`.
- Errors: `unknown_source`, `put_incomplete`, `size_mismatch`, `empty_file`, `file_too_large`, `untrusted_url`, `header_not_allowed`, `idempotency_key_required`, `queue_full` (2,000 jobs), `invalid_request`, `storage_failed`. A refused call leaves the source where it was.

#### What the uploader does

For each attempt the host sends one request to `url` with the job's headers plus `Cookie` (the web view's cookies for that URL, read at the time of the attempt), `X-Platform-CSRF` (the value of the cookie named by `csrfCookie`, percent-decoded), `Origin` (the portal origin), `Content-Type: multipart/form-data` and, unless the job gave one, `Accept: application/json`. Cookies and the CSRF token are never stored with the job. It never sends to another origin: the URL is checked when queued and again before every attempt.

| Answer | What happens to the job |
|---|---|
| 2xx | `done`. The status and body are kept until acknowledged; the file is deleted. |
| 401, or 403 with `error: "csrf_required"` | `needs_sign_in`. Every other waiting job becomes `needs_sign_in` too, without being sent. |
| 409 with `error: "offline_identity_mismatch"` | `needs_sign_in`, this job only (someone else is signed in). |
| No cookie named by `csrfCookie` | Every waiting job becomes `needs_sign_in`; nothing is sent. |
| 5xx, 3xx, 408, 425, 429, or 409 with `error: "idempotency_in_progress"` | Stays `queued`. The next attempt comes after 30 s, doubling up to 1 h. The eighth such answer in a row makes it `failed` with `error: "retries_exhausted"`. |
| No answer (no network, timeout) | Stays `queued`. The next attempt comes after 15 s, doubling up to 15 min while the phone says it is connected. Never counted, never `failed`. |
| Any other 4xx | `failed`. The file is kept until `cancel` or a new `enqueue` of the id. |

- A `needs_sign_in` job is queued again when the cookie named by `csrfCookie` exists and its value is no longer the one that was refused. The host checks at app start, after every page load and when the app returns to the front. A new `enqueue` of the id also queues it again.
- A redirect is never the upload's answer. Android does not follow it: the 3xx is recorded as the status. iOS cannot refuse a redirect in a background transfer (Apple: "Tasks in background sessions automatically follow redirects"), so there the host discards an answer that did not come from the URL it sent to and records `error: "redirected"` with `status: null`; the server must never redirect an upload route.
- A job the host cannot send at all is `failed` with `status: null` and `error` `file_missing` or `untrusted_url`.
- Two additions to the outline the coordinator gave, both forced by how the server answers: 409 `idempotency_in_progress`, 408, 425 and 429 are retried (they are the server asking for a later attempt, not refusing the upload), and 409 `offline_identity_mismatch` waits for a sign-in instead of failing (the upload belongs to someone who is not signed in now).

#### `offlineUploads.status { ids? }` answers `[ { id, state, status, body, bodyTruncated, error, attempts, size, createdAt, updatedAt } ]`

- Without `ids`: every job, in the order queued. With `ids` (at most 500): those that exist, in the order asked. An id the host does not know is simply absent: enqueue it again.
- `state`: `queued`, `uploading`, `done`, `failed` or `needs_sign_in`. On iOS `uploading` means the transfer has been handed to the system, which sends it when it can.
- `status`: the last HTTP status, or `null` when the server has not answered. `body`: the last answer's body as a string of at most 256 KB (the page parses it), or `null`; `bodyTruncated` says it was cut. `error`: `null`, `retries_exhausted`, `file_missing`, `untrusted_url` or `redirected`.
- `attempts`: requests started. `size`: the file size in bytes.
- One reply carries at most 1 MB of bodies. A job beyond that has `body: null` and `bodyOmitted: true`: acknowledge the earlier ones or ask for it by id.

#### `offlineUploads.ack { ids }` answers `{ acked: [ids] }`

Forgets `done` jobs whose answer the page has recorded. Ids that are unknown or not `done` are ignored. A `done` job that is never acknowledged is forgotten after 30 days. A job that is not `done` is never removed by the host on its own: an upload that has not arrived is the person's photo.

#### `offlineUploads.cancel { id }` answers `{ cancelled: boolean }`

Removes the job and its file, and a handed-over file of the same id that was never queued. An upload in flight is stopped, but the server may already have received it.

#### `photoLibrarySave { cameraToken }` or `{ put, contentType, fileName }` answers `{ saved: true }`

Saves an add-only copy of one image or video to the camera roll. The source stays where it is, so call it before `enqueue` (which takes the file) or use `saveToPhotos`. Nothing is ever saved to the camera roll unless the page calls this or enqueues with `saveToPhotos: true`.

- `cameraToken`: a native camera capture (Android only), saved with its own name and type. `put`: a complete handed-over file; `contentType` is required and must be `image/*` or `video/*`.
- Errors: `unknown_source`, `unsupported_media`, `photos_permission_denied`, `photos_save_failed`.
- Android saves to `DCIM/FirstMate` through MediaStore. Android 10 and newer need no permission; Android 8 and 9 ask for storage access at the first save. iOS asks once for add-only access and can never read the library.
- `PhoneFeatures` waits up to 120 s for `enqueue` and `photoLibrarySave`, because a permission prompt may be open.

#### `offlineShell`

No methods. It tells the page that the host lets the service worker run and handles a failed first load itself.

- When a main-frame load fails, the host shows a plain native screen ("No connection yet. Connect once to set this device up for offline use." and a Retry button) over the web view, and loads again by itself when a connection returns. Nothing the web view stored (cookies, the service worker, IndexedDB, caches) is touched. The text is in `android/app/src/main/res/values/strings.xml` and `ios/Sources/en.lproj/Localizable.strings`.
- Once the portal's service worker has saved the shell, a launch without a connection is answered by the service worker and this screen does not appear.

#### How a page uses it

1. `await PhoneFeatures.offlineUploads.putBlob(id, blob)` (or take a native camera capture's token).
2. `await PhoneFeatures.offlineUploads.enqueue({ id, source: { put: id }, url, fileField: 'file', fileName, contentType, fields, headers: { 'Idempotency-Key': ..., 'X-FM-Offline-User': ..., 'X-FM-Offline-Org': ..., 'X-FM-Offline-Replay': '1' }, csrfCookie, saveToPhotos })`. The server answers a repeated key with its first answer, so the host's retries are safe.
3. Poll `status(ids)` while jobs wait. `done`: record the answer, then `ack`. `failed`: show it; `enqueue` the id again to retry, or `cancel`. `needs_sign_in`: wait for the person to sign in. Absent: the host has no such job (app data was cleared); hand the file over and enqueue again.

### Where things are kept

| | Android | iOS |
|---|---|---|
| Directory | `filesDir/offline-uploads/` (private, never the cache; the app has `allowBackup="false"`) | `Application Support/OfflineUploads/` (excluded from backup) |
| Jobs | `jobs.json`, replaced in one step on every change | the same |
| Files | `puts/` (handed over), `jobs/` (queued, and each answer until acknowledged) | the same, plus `bodies/` (the multipart body of a transfer in flight) |
| Camera captures | `captures/` and `captures.json` | none |

A native camera capture (Android) is written straight into `captures/` and its token is recorded on disk, so it survives the process being killed before the page reads or queues it. It is removed when the page releases it (`cameraRelease`, which `PhoneFeatures.camera.file` does after reading), when an upload takes it, or after 30 days. Before 1.0.8 captures were in the cache with tokens in memory.

Files are identified by a hash of the id, so two ids never share a file. If the process dies between moving a file into a job and recording the job, the next `enqueue` of that id finds the file and completes the job.

### How the uploads run

**Android.** WorkManager unique work `offline-uploads` with a connected-network constraint and exponential backoff from 30 s (WorkManager caps its own wait at 5 hours). It sends the jobs that are due, oldest first, one at a time, and returns `retry` while any job waits. A new `enqueue`, an app start, a page load or a return to the app starts it at once. WorkManager keeps the work across process death and restarts. The system gives background work about 10 minutes at a time; an upload stopped mid-way is not a failed attempt and starts again from the beginning, so a very large video on a slow connection may need the app open (resumable uploads are not built, see the design).

**iOS.** A background `URLSession` (`<bundle id>.offline-uploads`). A background transfer is sent from a file, so the multipart body is written to `bodies/` first and removed when the transfer ends; because that is a second copy of the file, at most six transfers (200 MB) are handed to the system at a time. The system waits for a connection by itself and relaunches the app in the background to deliver answers (`handleEventsForBackgroundURLSession`), where the next jobs are handed over. If the person force-quits the app from the app switcher, iOS cancels its transfers; they are handed over again at the next launch.

### iOS: App-Bound Domains

`Info.plist` lists `WKAppBoundDomains` (`dev.1m8.ai`, `1m8.ai`, `app.1m8.ai`) and the web view sets `limitsNavigationsToAppBoundDomains`. This is what lets the portal's service worker run in a `WKWebView`. Checked against WebKit's description of the feature (webkit.org/blog/10882/app-bound-domains) and Apple's reference:

- **Bridge.** With the key in `Info.plist`, script injection, cookie access and script message handlers are denied in every web view that does not set `limitsNavigationsToAppBoundDomains`; with it they work on the listed domains. The app has one web view, it sets the flag, and it only loads the portal origin, so `evaluateJavaScript` (replies and push events), the `firstmeasure` message handler and `WKWebsiteDataStore.httpCookieStore` (the uploader's cookies) keep working. A second web view added later must set the flag too, or its bridge silently stops.
- **Navigation.** Only the top-level frame is limited: a navigation to another domain fails with "App-bound domain failure". The host already cancels main-frame navigations off the portal origin and opens them in the OS browser, so nothing changes. Cross-origin iframes such as the payment element still load.
- **Sign-in.** `ASWebAuthenticationSession` runs outside the web view and is not affected; the exchange that follows is a `POST` to the portal origin.
- **Downloads.** `WKDownload` starts on the portal origin and already refuses redirects off it.
- **Limits.** At most 10 domains. WebKit's engineers state a limit of three service workers for an app using App-Bound Domains (bugs.webkit.org 227531); the portal registers one. Whether an entry also covers subdomains is not documented, so each host is listed.
- **Not in Apple's reference.** Apple's page for the property is one line; that service workers need App-Bound Domains comes from WebKit's engineers and Apple's developer forum, so it is on the device checklist below.

When production moves to `app.1m8.ai`, only `PORTAL_ORIGIN` changes: the domain is already listed.

### Not verified without a Mac or a phone

The Android APK builds and its JVM tests pass on a PC. The iOS sources were written without a compiler. On a Mac, expect to fix small compile errors first in: `Sources/OfflineUploadRules.swift`, `Sources/OfflineUploadStore.swift`, `Sources/OfflineUploader.swift`, `Sources/PhotoLibrarySaver.swift`, `Sources/OfflineScreen.swift`, the changes in `Sources/PortalController.swift` and `Sources/AppDelegate.swift`, and `Tests/OfflineUploadTests.swift`. Also check that XcodeGen puts `en.lproj/Localizable.strings` in the app (the text falls back to English without it) and writes `WKAppBoundDomains` as an array.

## Android

Version 1.0.8 (version code 9) adds the offline capabilities described under Offline: background uploads through WorkManager
(`androidx.work:work-runtime`), camera-roll copies through MediaStore, a native screen for a failed first load, and native
camera captures kept in `filesDir` with their tokens on disk. It adds the `ACCESS_NETWORK_STATE` permission and, for
Android 9 and older only, `WRITE_EXTERNAL_STORAGE`. WorkManager itself merges `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED` and
`FOREGROUND_SERVICE` into the manifest (the app starts no foreground service); list them in the Play data-safety review. The logic that needs no device (`OfflineUploadRules`,
`OfflineUploadStore`, `OfflineUploadRunner`, `HttpUploadTransport`, `CaptureStore`, `MultipartBody`) is covered by the JVM
unit tests; `OfflineUploads`, `OfflineUploadWorker`, `PhotoLibrary` and the activity need a device.

Version 1.0.7 includes unfiltered CameraManager enumeration/characteristics and explicit
exclusion reasons in camera diagnostics. Preview stream support is accepted even
without BACKWARD_COMPATIBLE, and a filtered parent no longer hides its children.
This corrects a diagnostic blind spot in 1.0.6; the reported device's ultrawide
remains unverified until its raw inventory is observed.

Version 1.0.6 introduced discovery of Camera2 logical cameras **and physical children** (including
children absent from the top-level camera list). It binds a physical output ID
through Camera2Interop for the whole preview/photo/video session. One zoom control
selects the appropriate route by sensor-relative focal length; no phone-model
list or manual lens picker is used. Video quality prefers a stream size shared
by the discovered cameras so persistent recording can cross lens boundaries.
Preview/JPEG sizes are intersected with the physical sensor's supported sizes.
Opening waits for real capture results; failed lens transitions restore the last
working camera. Development builds expose an explicit camera-diagnostics share
button showing discovered IDs/ranges, stream metadata, and failures, without
photos, account data, or automatic transmission.

The 1.0.5 opaque modal surround/background isolation fix remains in place.
Manufacturer-private lenses outside public camera APIs cannot be advertised.
Automated inventory tests exercise hidden ultrawide/telephoto children; emulator
capture tests do not establish any physical phone's actual 0.5x to 30x support.
Older native hosts and browsers retain their existing capture path.

Camera bridge operations are main-frame/origin restricted and scoped to an opaque
capture-session ID. A stale window cannot close or adjust a newer camera session.
Captured files remain private and transfer in bounded chunks using opaque tokens;
the adapter releases the file after reading it. Backgrounding stops recording;
the CameraX lifecycle releases camera access when the host stops. Both native and
web paths use the existing report upload and authorization flow.

Install JDK 17, Android SDK platform 36, platform-tools, and an API 35 Google APIs x86_64 emulator image. Set `JAVA_HOME` and `ANDROID_HOME`. The checked-in Gradle wrapper downloads Gradle 8.13.

```
cd native/firstmate/android
./gradlew assembleDevelopmentDebug testDevelopmentDebugUnitTest
./gradlew bundleProductionRelease
```

On Windows use `gradlew.bat`. The development APK is `app/build/outputs/apk/development/debug/app-development-debug.apk`; it connects only to `https://dev.1m8.ai` and has a separate application ID, so it can coexist with production. Install explicitly on your emulator: `adb -s emulator-5554 install -r <apk>`. For a visible emulator run `emulator -avd FirstMeasure_API35`. Run `../scripts/test-android.ps1 -Serial emulator-5554` from PowerShell, or set `ANDROID_SERIAL` and run `connectedDevelopmentDebugAndroidTest` on other systems. Never let a test runner pick an attached personal phone implicitly.

`scripts/start-android.ps1` opens the configured emulator window, installs the current development APK and launches FirstMate for interactive testing. It targets only the selected emulator port.

The production AAB is unsigned. Play distribution requires your account, approved package ID, upload signing key and listing. Keep signing material outside Git. Debug builds use the developer machine's debug key; APKs from a different CI/machine key require uninstall/reinstall and lose that app's local session. Use a stable test signing key before distributing continuous upgrades to a wider pilot.

## Push setup

Register both `ai.firstmeasure.mobile.dev` and `ai.firstmeasure.mobile` in Firebase. Put each downloaded Android client file at `android/app/src/development/google-services.json` or `android/app/src/production/google-services.json`. Set `FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON` on the API server for FCM HTTP v1. If development uses a separate project, set `FIREBASE_DEVELOPMENT_PROJECT_ID` and `FIREBASE_DEVELOPMENT_SERVICE_ACCOUNT_JSON`. The service account is a server secret and must never be packaged in the app. Without a client file, local builds work but the push bridge reports unavailable. Android 13 and newer prompts for notification permission when the user enables push. Nine Android channels match the platform categories, including Measurements.

For iPhone, enable Push Notifications for both bundle IDs and use profiles with the `aps-environment` entitlement. Set `APNS_AUTH_KEY_P8`, `APNS_KEY_ID`, and `APNS_TEAM_ID` on the API server. `APNS_BUNDLE_ID` and `APNS_DEVELOPMENT_BUNDLE_ID` default to the canonical bundle IDs. Development tokens use Apple's sandbox endpoint; production tokens use the production endpoint. Test end-to-end delivery on a signed physical device. iOS categories use `FIRSTMATE_<CATEGORY>` identifiers.

## iPhone and iPad

Version 1.0.3 (build 4) adds the offline capabilities described under Offline, including App-Bound Domains and the list of what still needs a first compile on a Mac. It adds `NSPhotoLibraryAddUsageDescription` and `WKAppBoundDomains` to the generated `Info.plist`. iOS has no native camera in this host, so uploads are handed over with `offlineUploads.put`.

On a Mac with Xcode and an installed iPhone simulator: `brew install xcodegen`, then `bash native/firstmate/scripts/test-ios.sh`. Set `IOS_SIMULATOR_ID` to choose an existing simulator. This generates the Xcode project and runs unit/UI tests without signing. Open the generated `ios/FirstMate.xcodeproj` to emulate interactively. The Development configuration connects to dev; Production connects to the production portal.

For a physical iPhone/TestFlight, choose your Apple development team, register the final bundle IDs, archive the correct configuration, and sign/upload through Xcode/App Store Connect. An unsigned IPA is not a direct-install option. `MOBILE_IOS_TESTFLIGHT_URL` controls the private testing link once the build is available. The shared existing icon is included; review final icon/alpha requirements, privacy disclosures, camera/photo permissions and store screenshots before submission.

## App download Settings tab

`mobile.app_download` defaults off for both old and new organizations, independently of expanded apps. Explicitly enable it for an organization to show the category after Billing. Unpublished store URLs render as unavailable, never fake store destinations. Set `MOBILE_ANDROID_STORE_URL` to a Google Play URL and `MOBILE_IOS_STORE_URL` to an App Store URL when listings exist.

Test downloads require **both** `mobile.developer_downloads=true` for the organization (default false) and `MOBILE_DEVELOPER_DOWNLOADS_ENABLED=1` on a `FIRSTMEASURE_DATA_ENVIRONMENT=development|test` server. Set `MOBILE_ANDROID_TEST_APK_PATH` to an absolute, private `.apk` path outside the web root, `MOBILE_TEST_BUILD_VERSION`, and optionally `MOBILE_IOS_TESTFLIGHT_URL`. Every request checks membership and current flags; the APK URL has no public static alias. Production refuses test binaries even if an organization has the testing flag.

## Verification and release gate

Run `public/v1` tests `mobile-api.test.ts`, `phone-features.test.mjs`, `localization-api.test.ts`, `localization-browser.test.mjs`, plus the settings layout contract. The Android JVM tests (`testDevelopmentDebugUnitTest`) cover the offline upload rules, store, runner, transport and capture store; the iOS unit tests (`OfflineUploadTests`) cover the same rules and store. The mobile workflow builds both native projects, runs Android emulator tests and iPhone simulator tests, and uploads artifacts; it never deploys or publishes to stores. Keep CI green and complete physical-device camera/photo/PDF checks before a wider pilot.

Manual acceptance on each phone: existing account login/logout; organization switch; old organization with unset flags; metric/imperial and US/UK language; roof and exterior ordering; multi-photo selection, camera capture and cancellation; rejected upload/retry; delivered PDF open/save/share; generated PDF export; external links; keyboard/rotation/back gestures; losing/restoring connectivity; app background/resume; settings permission denial. Offline, on each phone, signed in on dev: (1) with the connection off, take or choose several photos, close the app completely, turn the connection on and confirm, without opening the app, that they arrive on the server (iOS: allow a few minutes; then repeat after a force-quit from the app switcher and confirm they arrive after the next launch); (2) queue photos, sign out or let the session end, confirm they wait and then upload after the same person signs in, and that they do not upload when someone else signs in; (3) with camera-roll saving off, confirm no photo appears in the phone's gallery; turn it on, take a photo and confirm exactly one copy appears (Android: `DCIM/FirstMate`; Android 8 and 9 and iOS ask for permission the first time: deny it once and confirm the upload still happens); (4) open the app once online, close it, turn the connection off and launch it: the portal opens from the device; on a fresh install without a connection the native "No connection yet" screen shows, Retry works, and the app loads by itself when the connection returns; (5) install the next build over this one with uploads queued: the queue, the saved data and the sign-in survive; (6) kill the app while an upload is running and confirm it finishes later and appears once on the server; (7) iOS only: `navigator.serviceWorker` exists and the portal's worker is active, `PhoneFeatures.info()` still answers, browser sign-in returns into the app, a PDF download opens, the payment element loads, and uploads still carry the session after the app was relaunched in the background; (8) Android only: a native camera capture is still readable after the app is killed before it was queued, and a video too large to send in ten minutes arrives with the app open. Desktop: compare Company logo, Users list, navigation and ordering before/after. No payment or live report orders should be used for testing.

Read root `DEPLOYMENT.md` before activation. Development deployment must preserve the complete source baseline, refresh PHP-FPM on both web and compatibility hosts, and validate authenticated HTML as well as Node readiness. Public app-store submission and production activation are separate releases.
