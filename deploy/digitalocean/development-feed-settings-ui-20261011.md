# Development Feed Settings UI — October 11, 2026

Implementation release: `a9ed3f72bedc9101dedbead43e31f4d2a03fd23b`, branch `codex/feed-permissions-autosave-20261010`.

The expanded shared event catalog now has category navigation, search across labels/descriptions, visible descriptions below toggle labels, per-category enabled counts and a total enabled count. Audience selection and bulk actions share a compact toolbar; auto-save status is next to the page heading. Signatures and scheduling are grouped separately rather than highlighted as a combined business-milestone card. Layout follows the existing Settings spacing, fields, cards, shared switches and organization primary color. Mobile uses horizontally scrollable category buttons and stacked controls.

Filtering changes presentation only. Individual toggles update the complete selection set, preserving enabled events hidden by search or a category filter. Keyboard focus is restored after rendering search, audience, category or checkbox changes. Existing default values, audience storage, serialized auto-save, conflict handling and retry remain intact. Bulk actions explicitly say Enable all / Disable all; Use defaults remains available.

Browser checks passed for loading/retry, default-off signature/scheduled-completion choices, rapid edits, switching audiences during an in-flight save, revision conflict preservation, network retry, search/no-results recovery, category filtering, and preserving hidden enabled events. Desktop and mobile screenshots were inspected; the mobile check confirms no document-width overflow. JavaScript syntax and diff checks passed.

The release changes only `settings/feed.js`, the Company settings fallback version, and the two corresponding manifest versions. Each role preserves its current unrelated changes. Activation is sequential; source hashes, local/public readiness and development outbound isolation are verified before completion.

| Role | Release path | Previous path |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/a9ed3f72bedc9101dedbead43e31f4d2a03fd23b` | `/opt/firstmeasure/releases/phone-4e396d15bdd418c1fd2fecfdcc0197482be59545-web` |
| pool | `/opt/firstmeasure/releases/a9ed3f72bedc9101dedbead43e31f4d2a03fd23b` | `/opt/firstmeasure/releases/30e07f0a-policy-redirects` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/a9ed3f72bedc9101dedbead43e31f4d2a03fd23b-feed-settings-ui-r2` | `/mnt/firstmeasure_dev_releases/releases/phone-8a4e2ed40cf27601ed0bf62fa582f01a18f7087c-compat` |

A concurrent rollout advanced the compatibility baseline before activation; the original candidate was not activated. Its UI was rebased onto the newer audited baseline, preserving the current Company script and manifest outside the two owned version changes. Subsequent web/pool rollouts retained the exact UI component hash and updated loader/manifest versions. The later audit found web at `/opt/firstmeasure/releases/phone-8a4e2ed40cf27601ed0bf62fa582f01a18f7087c-web` and pool at `/opt/firstmeasure/releases-gif-drafts-1791774200/d31cfa48b3afa20a2a5165315093abffad506ab3`, both with this UI intact. All three roles passed local readiness and development isolation during the audit. Public requests briefly returned 503 as other serving-node rollouts drained/restarted services; those transient failures are distinct from a settings load failure. The publicly served UI component was also tested in the browser fixture.

For rollback, first inspect current pointers because another deployment can supersede this release. Restore only the affected role's own previous pointer, restart its existing development service and PHP-FPM, and recheck readiness and isolation. Production and worker are unchanged.
