# Project preview cover and contact actions — October 11, 2026

Feature commit `0de8f2ea` was pushed to `codex/consolidated-firstmeasure-20260923` and deployed to `https://dev.1m8.ai`. Production was not changed.

The project summary now publishes a cover only when the project has a selected `cover_photo`. The browser tries the selected media's thumbnail, then the original if no thumbnail variant exists; it removes the image area only when neither loads. Contact icon actions now open the internal phone workspace or a project Comms text/email draft with the selected contact. A project request helper waits for the Comms tab to mount before opening the draft.

## Verification

- `npm run check` and `npm run build` passed in `public/v1`.
- Browser and contact shortcut checks: 9 passed, including original-image fallback and internal call/text/email dispatch.
- Isolated publication suite: 69 passed, one PostgreSQL-only skip. The project summary publication checks cover selected media and no-cover behavior.
- The public dev site served SHA-256 `035a57ad7586309353085ad08cef42d2b318f16df5483af31e86e267ea2e7047` for `grouped-widgets.js`, `d08491900194bfc440db91f9d3bdf3290b0d9919e1ee5c09ea2c2b6b1b58e958` for `runtime.js`, and `a3bfdd0ddb1c7a8b2bfe835c45013212c996926090ca126fe76e1a651b070714` for the project request app, matching the web/pool releases.
- All three frontend roles returned `ok=true`, `state=ready`, `data_environment=development`, and enforced outbound isolation after activation. The compatibility role retains its existing manifest and project request baseline outside this patch.
- The exact development project in the screenshot is `sample_ea3fe2e8b58fd954dc527c43`. Its saved cover points to `media_4f45c8b5939b3af0`, which has a readable 786,320-byte `original` variant and no `thumb_320` variant. A second project has the same title and address but no cover; checking the selected media identity distinguished them. The browser fixture verified that this missing-thumbnail case displays the original.

## Release state and rollback

The release was staged as an immutable overlay on each role's then-current development release. The project request action was applied as a focused patch to preserve each role's other deployed changes. The final active paths are:

- Web: `/opt/firstmeasure/releases/project-preview-cover-actions-0de8f2ea-fm-dev-web-598520065`
- Pool: `/opt/firstmeasure/releases/project-preview-cover-actions-0de8f2ea-fm-dev-web-603124965`
- Compatibility: `/mnt/firstmeasure_dev_releases/releases/project-preview-cover-actions-0de8f2ea-firstmeasure-development-compatibility`

Each role's baseline and stage path are saved in `/tmp/project-preview-cover-actions-0de8f2ea.release` on that host. Before rollback, confirm that `/opt/firstmeasure/current` still points to this overlay; subsequent development deployments may advance it. Restore that role's recorded baseline only when the guard matches, restart its development service and PHP-FPM, and verify readiness and development isolation. The worker was not changed because these previews run on frontend roles.
