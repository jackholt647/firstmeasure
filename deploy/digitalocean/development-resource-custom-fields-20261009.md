# Development: shared resource fields and platform phone assignments â€” October 9, 2026

Implemented and activated on https://dev.1m8.ai. Production was not changed.

## Source and behavior

GitHub branch: `codex/consolidated-firstmeasure-20260923`.
Development release: `68a734d5a50af9d12c31d68a3e35f98d74a10ea3`. Feature commits: `b9637bf`, `28c228e`, `5f919b7`, and `68a734d`; `bca48b6` preserves concurrent remote work.

The declarative owner catalog supports organization, project, contact, organization-member user, branch, department, division (including Region kinds), and workforce team. All reuse typed schemas, media references, field policies and publication contracts. Grouping values are independent sidecars resolved against existing authoritative owners; reads never create records. User settings and both existing user dialogs support user fields.

`platform_phone` is a phone number issued by the platform. It carries an authoritative issuance reference, uses phone presentation, supports one or many values, and cannot be assigned, edited or cleared through ordinary custom-field/storage APIs. The dedicated `platform-phones.<entity>.assignment.set` command requires phone-management and owner permissions, revision checks and idempotency. It resolves issuance IDs server-side and never buys, releases or routes numbers. The `phones` export distinguishes ordinary and platform numbers and checks current availability. Protection persists across retired fields and project scope changes.

Frontend integration: [shared custom-field architecture and handoff](../../docs/architecture/custom-fields.md#resource-scopes-and-platform-phones-frontend-handoff). Grouping editors and the dedicated phone-assignment UI are for the next frontend developer. Existing managed values render as disabled phone controls and are absent from the ordinary field-type picker.

## Rollout and verification

Each role was cloned from its audited live baseline and overlaid with only this task's verified committed changes. Concurrent contact, Channels, runtime and permission work was preserved. Per-role sources and compiled output were verified before activation. Development session-cookie separation and enforced outbound safety were checked on all roles and public readiness.

| Role | Activated path | Previous path for rollback |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/68a734d5a50af9d12c31d68a3e35f98d74a10ea3` | `/opt/firstmeasure/releases/15b0e615d6b6d219f64438cb5966effcbd188c8d` |
| worker | `/opt/firstmeasure/releases/68a734d5a50af9d12c31d68a3e35f98d74a10ea3` | `/opt/firstmeasure/releases/80ffae0533ce180f92b205a3acda2142d951738d` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/68a734d5a50af9d12c31d68a3e35f98d74a10ea3` | `/mnt/firstmeasure_dev_releases/releases/15b0e615d6b6d219f64438cb5966effcbd188c8d` |
| pool | `/opt/firstmeasure/releases/68a734d5a50af9d12c31d68a3e35f98d74a10ea3` | `/opt/firstmeasure/releases/15b0e615d6b6d219f64438cb5966effcbd188c8d` |

Checks: TypeScript compilation on every staged role; publication suite 87 passed and 1 skipped; PostgreSQL scoped/user tests 4 passed; staged Linux publication/scoped/user tests 6 passed; hosted user-field browser tests 3 passed. User API and custom-field browser regressions also passed. Live records and provider phone inventory were not mutated by tests.

Rollback: verify the role and development environment, restore its listed previous symlink, restart that role's existing development service, reload PHP for asset-serving roles, and recheck local/public readiness and outbound isolation. Never substitute another role's baseline or activate these changes in production without separate authorization.

Local automatic approval review rejected cleanup of two synthetic fixture directories. They remain under `public/v1/storage/platform/organizations` and are not part of this release.
