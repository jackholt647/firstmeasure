# Complete opening chrome — October 2, 2026

Initial source release: `b483e972e52d95dc7e6c48d53c59c72582ce8ab5`. Final follow-up release: `590ff6709cf947cf76cd55f5fc77c74775cc624b`, which preserves title-menu keyboard semantics during the handoff. This follows the [initial loading optimization](development-project-opening-20261002.md).

The initial project window now uses the shared two-row entity header: the title/address and folder/menu treatment, the full placement/minimize/close controls, Overview, and the Notes/Activity/Agent tray positions. Project-specific tabs still depend on the isolated document's availability decisions. Tray buttons remain disabled until the project shell is ready; rendering these affordances does not grant access to their data.

The outer window manager attaches immediately. Its new `rebindChrome` operation moves the existing controls and header listeners into the ready child without recreating the window or discarding placement, geometry, or minimized restore state. A dock/minimize choice made during loading survives child initialization. The portal loads the shared shell through a content-versioned static script so the loading and final header use the same layout styles.

“Opening project” covers the iframe portal document's scripts, session/capability/commerce startup and shell construction. The project read starts concurrently in the parent. This release improves the usable shell during startup; it does not claim to remove the remaining startup second or establish a measured latency breakdown.

Validation: 11 focused opening/window-manager/window-shell/project-tray tests passed, including docking then minimizing before child attachment and restoring to the same dock afterward. Two asset-cache tests passed. All 12 opening tests against the actual three role payloads passed. Deployment staging runs JavaScript syntax and PHP lint checks.

Deployment artifacts and receipts: `output/project-opening-chrome-20261002`. Six runtime files target development web, legacy and pool roles only, preserving each role's current source through reviewed three-way merges. The window-manager merge retained the existing role-specific mobile baseline and added only the chrome handoff. Previous role release was `0f0774d4241a51dd22b2b7ff36cfa69ce5cf09b3`; installed `channels-release.json` receipts retain exact rollback paths. Worker, production, provider topology and autoscale replacement templates are outside this rollout.

Public browser verification showed Overview, Notes/Activity/Agent and all placement controls while “Opening project” was still visible, followed by the completed form with the same two-row chrome. The test form was closed without saving. Public hashes matched all five JavaScript assets in the initial rollout. The final keyboard follow-up passed the same 12 role-payload tests, now also asserting title role and tab order. Its ignored artifacts are `output/project-opening-chrome-focus-20261002`.

Final verification: all three roles passed release/hash/readiness/isolation checks at `590ff6709cf947cf76cd55f5fc77c74775cc624b`, and all five public JavaScript hashes matched. Live DOM measurements were 69 px for both the initial and completed headers; the completed title retained `role="button"` and `tabindex="0"`. The verification form was closed without saving.
