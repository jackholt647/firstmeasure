# Complete Android camera inventory — October 6, 2026

Native source `7f36597e621689d83ba7fbf93f6f0ee386d1c6a5`; FirstMate development 1.0.7/code 8.
APK SHA-256: `02337edfdff7c4ef430d5682bfc834ce4dbae5344401b316d5c9e41ae6ec9ad8`.
Signing certificate unchanged: `57f8c5714560accd5ef6048dc45678b5194feb033dc11307231072bde5a4eb6a`.

The customer's 1.0.6 diagnostics contained only rear route 0, 1–10x, focal length 5.56, crop 4096x3072, no physical capture metadata and no discovery failures. This confirms that ultrawide was not discovered as an eligible route, but does **not** prove Android exposes no other camera: the previous diagnostics omitted raw IDs and silently excluded capability/facing mismatches.

This revision accepts advertised PRIVATE/YUV preview streams without requiring BACKWARD_COMPATIBLE. It traverses physical children even when the parent's preview capability filter excludes that parent. It records every enumerated CameraManager ID, successfully read characteristics, physical child IDs, capabilities, stream counts, focal/sensor geometry, zoom range and hardware level. CameraX IDs and explicit filter exclusions appear separately from discovery errors and final routes. No model-specific mapping, guessed IDs, package impersonation, permission bypass or invented 0.5x option is added.

This is a targeted filter correction plus diagnostic completion, **not a verified resolution of this physical device's missing ultrawide**. A new on-device inventory is necessary to distinguish application filtering from an OS inventory that omits the lens. Other camera applications also depend on what the public APIs expose; see [Open Camera's own help](https://opencamera.org.uk/help.html) and [Samsung's camera-ID guidance](https://support-cn.samsung.com.cn/App/DeveloperChina/Notice/Detail?NoticeId=109). Neither establishes the behavior of this unobserved device.

Validation: development APK build; 10 Java unit tests; two real emulator capture/bridge tests including raw inventory presence, JPEG/MP4, zoom, opaque modal and stale session protection. Signature checked; emulator 1.0.6 → 1.0.7 update succeeds without uninstalling. No web assets or iOS code changed.

Deployment uses the immutable APK and `zzzzzzz-camera-inventory.conf` path/version override on the three development download-serving roles. Existing live server releases are retained; only each service restart loads the new download configuration. Readiness, development isolation, current release identity and APK hash are checked. Evidence: `output/camera-inventory-20261006/`. No production, worker, topology or data change.

Rollback downloads by removing/superseding only this release's APK override after checking for later changes, then restart and verify the affected service. Android installed-version rollback requires a signed forward build; changing the server download does not downgrade installed apps.

Rollout verified on all three roles: each serves the exact 1.0.7 APK hash and passed readiness/isolation checks. Their existing server release `edffff4d15d6847a90700b66ea7d6f7ddc64f97e` was retained. Public readiness and enforced development outbound safety also passed. Device ultrawide acceptance remains pending the corrected diagnostic output.
