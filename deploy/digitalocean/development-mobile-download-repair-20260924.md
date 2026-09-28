# Development Android test download repair — September 24, 2026

The App download page intermittently omitted the Developer testing section for
Test Company (`3dbf7f79528139e27c491363`). Its live app-flags response showed
both `mobile.app_download` and `mobile.developer_downloads` enabled. The page
uses an uncached mobile configuration request, so the intermittent result came
from inconsistent serving web nodes, not browser caching.

The original web node (`do-598520065`) retained its `mobile-testing.conf`
systemd drop-in and private Android APK. Autoscaled web node `do-603124965`
ran the same `d885489a08e42dacedfa9b8fc4e9275db005bc44` release but had
neither the drop-in nor `/opt/firstmeasure/mobile-builds/FirstMeasure-dev-ad4b103.apk`.
The mobile API therefore returned `developer: null` from that node.

Copied the exact drop-in and APK from the original node to the autoscaled node,
verified SHA-256 `49825219fff88f8ef5d9c1d0d01bca6b66b480efa5595c8a3635656677607e74`
for the drop-in and `3521ee03419ecef5a94260bafe25227d3e2d10ee08f0c9c81cb8490156acc0b6`
for the APK, reloaded systemd and restarted only the second development web
service. Its running process now has `FIRSTMEASURE_DATA_ENVIRONMENT=development`,
`MOBILE_DEVELOPER_DOWNLOADS_ENABLED=1` and the expected APK path. Both web
nodes passed role-local readiness on the same release and development data.
Production was not touched.

The current autoscale pool image and bootstrap do not provision this private
test build or its service drop-in. A future replacement or scale-out node may
repeat the omission. Update the development autoscale provisioning workflow
before relying on this distribution path across node replacement; retain the
existing organization and development-environment gates.
