# Native collaboration views — September 30, 2026

Development-only UI correction for cross-organization collaboration. Source release: `bf582ca080208f828cb4f11615b8696e39b8e80e` (implementation `e6e5827a`; follow-up preserves canonical LF source files).

## Behavior

- Removed the standalone shared-resource sections above Projects, Contacts and Channels. These were the only three callers of the former shared-list renderer.
- Projects uses Manage view for All / Owned by us / Shared with us / Shared by us and organization filters. Received projects use normal rows and tiles, qualified identities, a small owner label and scoped opening. They do not become cards in the receiving organization's workflow stages. Received-only selection switches to List. Mixed lists remain flat; Owned by us retains existing board/stage grouping. Stage view continues to show local workflow projects.
- Contacts uses its existing list and tile layouts, with sort and sharing filters grouped under Manage view. External contacts remain distinct even when IDs or email addresses match local records. Unknown project counts are not presented as zero.
- Channels includes received channels in the existing rail. Browse channels combines discovery, search and sharing filters; these filters also apply to the rail. Received conversations open within the conversation pane; the integrated sidebar uses the existing dialog shell. Sending and read-only behavior follow current grants. Revocation clears content. Local channel management does not receive foreign identities.
- Shared project/contact details continue to use the permission-scoped Partners reader. Their owner-only legacy editors are intentionally not reused.

## Validation

- Four focused browser/data tests passed, including the existing collaboration browser suite and the new `collaboration-native-ui.test.mjs`.
- Exercised real development portal chrome with controlled API fixtures and exact release assets: Projects list/tiles, incoming/owned filters, 60-record pagination, Contacts list/tiles/mobile, Channels rail/conversation, message posting and revocation. No JavaScript errors.
- Inspected desktop and mobile screenshots; corrected menu alignment, contact owner labels, view switching and pagination.
- Staged JavaScript/PHP syntax checks and seven-file content hashes passed for web, compatibility and web pool. Backend fingerprint remained `ea6ec36f327444590add564ac441ddc102be913826fa349a3b585e2495d0cd5f`.

## Release preservation and rollback

The release overlays only the seven frontend files recorded in `output/collaboration-native-ui-20260930/files.json`. Each role's immutable baseline is preserved. The already-deployed Contacts search removal is retained; its separate staged source changes were not incorporated into the feature commit. Unrelated local edits remain untouched. No schema, configuration, worker, production or infrastructure changes.

Previous development web, compatibility and pool release: `8cea7bf32665660d67b7f531cc404be8eadb4789`. Rollback uses the recorded per-role `previous_path` in the release manifest, restores `/opt/firstmeasure/current`, restarts that role's development service, reloads PHP and verifies development readiness and outbound isolation. Do not substitute a production path.

Activation completed and verified on web, compatibility and web pool. Public development readiness reports this release with outbound safety enforced. The deployed-asset browser suite passed without JavaScript errors. A real two-organization sandbox project grant appeared in the normal project list/tile, opened its scoped detail without the private cost field, and disappeared after revocation; a subsequent resource request returned 403. Test grants were revoked. The existing Contacts view/style/mobile smoke test also passed.
