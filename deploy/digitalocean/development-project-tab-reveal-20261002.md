# Earlier project tabs and loading chrome parity — October 2, 2026

Final frontend source `02cbae1bf38f0b3534d36c5087edfeeec828f61a` follows [complete opening chrome](development-project-opening-chrome-20261002.md). Five frontend files are scoped to development web, compatibility and pool roles. Worker and production are not part of this release.

## Findings

The loading tab strip measured 31 px client height and 32 px scroll height: its bottom border consumed one pixel of the 32 px row, causing the gray scrollbar in the user's screenshot. Loading tray buttons inherited 12 px, weight 900 styling while completed tray buttons used 13.3333 px normal text styling. The shared shell now sets the row sizing, overflow and tray typography explicitly.

There is no separate tab-header HTTP request. Project tab descriptors come from the app registry, app flags, capability/access snapshot and terminology, with workflow-specific filtering. The iframe's request module initializes through `PlatformCommerce.onReady`; portal startup awaits session, then parallel commerce, app flags, capabilities, terminology and language work before releasing that callback. The parent starts the authoritative project read concurrently. When that read is already resolved, shell creation and record hydration previously completed before the browser's next paint, so headers and Overview appeared together despite concurrent network requests.

## Changes

The parent resolves opening tab descriptors from its existing runtime and access snapshot, with the requested project in the context; it does not mount tab apps or add network requests. Normal new and existing projects get these descriptors immediately. Specialized creation workflows retain their own tab resolution. The child still performs its normal authorization and authoritative record handling.

New tabs slide from behind the first tab for 240 ms with 25 ms stagger (capped at 120 ms). Controls remain available during animation, reduced-motion preference skips motion, known tabs do not replay at iframe handoff, and identical ProjectViewer updates preserve their button nodes and focus. Later newly available tabs use the same entrance.

Existing-project hydration starts its read immediately but gives the shell a paint opportunity before populating content. This does not wait for the animation duration. A bounded fallback allows hidden/minimized documents to finish. No data permissions, write paths, project content ownership or tab app mounting scope changed.

## Validation and release

13 focused opening, window-shell, window-manager and tray tests passed. The opening tests cover a blocked project read with already-visible tab metadata, scroll geometry, reduced motion, retained focus, and an already-resolved record held until the shell paint. All 18 opening tests against the three exact role payloads passed. Staging performs JavaScript syntax checks.

Ignored operational artifacts are in `output/project-tab-reveal-20261002`; exact previous paths and hashes are in the manifest and installed `channels-release.json` receipts. Current roles retain their existing source through three-way merges. Autoscale replacement templates and provider topology are unchanged.

Concurrent development releases triggered baseline guards; fresh snapshots preserve the Measurements backend and assistant sidebar/title fixes. The web role received the final frontend in `02cbae1b`, retained by the subsequent `e662cfd2` assistant release. Remaining activation and verification evidence is recorded under `output/project-tab-reveal-final-20261002` and `output/project-tab-reveal-completion-20261002`. No guard was bypassed.
