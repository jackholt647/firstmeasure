# Contact editor autosave and layout - September 29, 2026

Final feature commit: `c5d51c9298f4aedde93d489de74acf0b3a843ff9`, including editor implementation `dc36bf431e7e91ead393b7e61903d7bb784d9a2e`.

The contact editor keeps one window title, removes the duplicate left title/type selector and large right heading, and begins the right pane with a compact tab strip. The built-in Org tag selects organization classification; removing it restores Human, which remains the default. The profile photo uses a square upload target, click-to-edit crop/replace dialog and small remove control. Its duplicate custom-field dropdown is hidden in this editor.

Edits autosave through a debounced, serialized writer. A save response preserves later input; failures remain visible and the next edit retries. Closing flushes pending valid changes. Required field and name validation still apply. Relationship fields use type-filtered searchable choices and selected reference chips. Draft contacts can immediately upload and view photos/media before a name is entered; entering a valid name autosaves the anchor using the same stable draft media identity.

Validation: actual editor/gallery/settings browser code with isolated fixtures, profile upload/crop, Org add/remove, relationship search, draft-media upload followed by autosave, delayed writes preserving newer input, error/retry and mobile layout; seven shared custom-field browser/contract tests; syntax checks. Desktop/mobile screenshots inspected.

Rollout overlays the two owned frontend scripts and exact bundle tokens on audited role-specific live baselines. Compatibility keeps its existing modal behavior with the same UI changes and a single window header; its variant passes the same browser flow. Manifest differences and unrelated deployed work are retained. Development source/runtime/hash guards and automatic rollback protect activation. No production changes.

Rollback: inspect for later deployments, restore each development role to its baseline release pointer, restart its corresponding development service and PHP-FPM, and verify development environment, outbound safety and readiness.

Initial staging candidates are retained. Intervening rollouts required refreshed baselines; the first activation served the revised editor on web before another release took over. Its task-owned web files were preserved, while pool/compatibility still retained their prior contact versions. The final candidate accepts only those known task-owned source versions, overlays the complete editor update on each role, and preserves all other deployed files. Public load-balancer 503 responses during restart are retried; they do not bypass direct node readiness or development isolation checks.

The final follow-up keeps the Call button enabled state synchronized after autosaved phone edits and prevents a previous contact's upload callback from changing a subsequently opened contact. The browser flow verifies the Call action after delayed/error/retry writes.

Final deployment predecessors and runtime IDs:

| Role | Prior release | Activated release |
| --- | --- | --- |
| web | `e50bb4f9bd8f57eab4948addc9e2a67179d098a5` | `c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-1` |
| pool | `fd4e70334953b66ea1362925b10f516b552b51c8` | `c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-1` |
| legacy | `7ee54c8b9a34670fb64507513884f7299efd0a88` | `c5d51c9298f4aedde93d489de74acf0b3a843ff9-contact-editor-4` |

Hosted editor tests passed again for autosave, delayed updates, save error/retry, live Call availability, typed relationship search, Org add/remove, profile upload/crop, optional imports and immediate draft media. Desktop/mobile hosted-code screenshots were inspected. Two public script hashes, owned manifest bundle tokens and six public development readiness responses passed. Fixtures avoid customer contact mutations and real calls.

Final direct verification passed on all three roles with development isolation and outbound safety enforced. At verification the pool ran compatible release `7ee54c8b9a34670fb64507513884f7299efd0a88`, preserving the exact tested editor/picker files and owned bundle tokens; web and compatibility retained the activated IDs above. No later compatible release was rolled back.
