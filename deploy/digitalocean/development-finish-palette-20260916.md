# Development finish color palette

Status: activated and verified on all three development roles.

## Source

- Runtime: `1c3fc2fe458b7b0daee8d288a902353a670a2d13`.
- Previous development runtime: `fc6c83129db9ef87205c537de1834f6aa8dadfa7`.
- Branch: `codex/exterior-trim-controls`. Preserve this branch when integrating concurrent work in the original checkout.
- Only `wall_features.js` and `wall_mode.js` change in public sources. The existing trim/chimney release is retained; compiled runtime, dependencies, access settings and production are unchanged.

## Behavior

- Finish color is an open palette of unnamed swatches: Common, In this project (most-used first), and Recent.
- Project colors use current effective face finishes and default colors, normalized and deduplicated. Sticker display/type colors are omitted.
- Last 12 chosen colors are remembered per project in browser local storage, including custom default colors. Saved face colors remain discoverable from project geometry independently of browser history.
- Swatches apply only color, preserving material type. Custom color input and reset to inherited finish remain available.
- Geometry inventory is read at panel opening, re-entry and explicit color changes, never during per-frame UI refresh.

## Validation

- 46 focused local tests passed in the isolated release checkout, including browser tests for custom reuse, refresh persistence, project isolation and unchanged material type.
- 48 focused tests passed against the shared local checkout, which includes separate concurrent changes.
- 44 wall controller tests passed on Linux.
- Browser-checked the local editor in a separate tab: project colors include its custom siding and trim colors; swatches have no visible names. No geometry changes were saved.

## Artifact

- `/home/dev/exteriors-1c3fc2f.tar.gz`, 249923578 bytes.
- SHA-256 `4a1f448bc7913c0926abc5b8c025093a72794a829bc8afcde90afffe20f671d9`.
- Staging checks all 1335 other public source files against the previous release.
- Development-only environment, outbound isolation and existing experimental allowlist are verified before activation.

## Live verification

- Worker, web and compatibility services are running this release with the existing experimental allowlist and outbound isolation intact.
- Public readiness returned healthy, development, release `1c3fc2fe458b7b0daee8d288a902353a670a2d13`. A brief post-restart 503 cleared before final verification.
- Both editor modules served by dev.1m8.ai match the tested release bytes, normalized for line endings.
- Production was not changed.
