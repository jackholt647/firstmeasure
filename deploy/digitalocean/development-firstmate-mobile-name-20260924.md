# FirstMate mobile display name — September 24, 2026

The Android development and production flavors and the iOS Development and
Production configurations now display **FirstMate** as the installed app name.
Native error dialogs use the same name. The development package and bundle IDs
remain separate from production so test builds can coexist and connect to the
development portal. Android versionCode is 2 and versionName is 1.0.1.

The Android development APK was built locally and its unit tests passed. APK
metadata reports `ai.firstmeasure.mobile.dev`, versionCode 2, versionName
1.0.1, and application label `FirstMate`. Its signing certificate SHA-256
matches the previous downloadable APK, so existing installations can update
without uninstalling. The new APK SHA-256 is
`c9702d37b2cdbaf530e2a30ae91c4197af136f576a1dae579baf45eef579f257`.

The private APK is at
`/opt/firstmeasure/mobile-builds/FirstMate-1.0.1.apk` on both serving
development web nodes. Their `mobile-testing.conf` drop-ins point to it and
advertise version `1.0.1`. Both services were restarted one at a time and
reported ready, using the development data environment. The prior APK and
each drop-in backup remain for rollback. Production was not touched.

The portal download heading, generated localization catalog, and HTTP download
filename were also changed in source. They require a separate development web
code release; concurrent web releases were in progress during this APK update.
The iOS display-name change likewise requires a signed iOS build before it
appears on a device. The development autoscale image still does not provision
the private APK and drop-in, so future replacement nodes need that follow-up.
