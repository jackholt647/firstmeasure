# Mobile report contact consistency — October 5, 2026

Runtime source: `8677524cfde4f5a8fb89518e5a36efb36d528574`.

Primary contact inputs now use the same 32px height, typography and full available card width in the Overview form and project identity dropdown. Removed the order-details-only contact sizing that also affected the dropdown. The dropdown is available from the initial New Report header onward. Empty restored report contacts receive one editable placeholder, preventing the contact form from disappearing after refresh. Unchanged title markup is retained so a contact blur/change cannot swallow a click on the header dropdown.

Validation: JavaScript syntax checks and all nine report-entry/window-shell tests passed. Chrome mobile checks at 414×836 cover initial New Report, location, empty-contact reload, details, details dropdown and restored details; all have matching 32px inputs with zero card side padding. Form/dropdown edits synchronize in both directions and survive refresh. No report was submitted.

Deployment evidence and role-specific source overlays: `output/mobile-order-contacts-20261005/`. Previous release on all three development roles: `0bd7bad0707b17b8a3a355c412c9ca9d900e7a6a`. Rollback uses each manifest's previous release path and development service. Two frontend files are overlaid onto the existing immutable role baselines, preserving unrelated live and workspace changes.

Development activation was authorized in the ongoing conversation. All three roles passed running-release, asset hash, readiness and isolation verification. Public readiness and both asset hashes match the release. The complete mobile browser flow also passed against the hosted assets without interception. The temporary test organization and workflow were removed. Production and worker are unchanged.
