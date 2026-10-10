# Development Feed permissions and auto-save — October 10, 2026

The browser-facing update is active on `https://dev.1m8.ai`. The background-worker permission rollout remains pending deployment access. Production was not changed.

## Behavior and source

Branch: `codex/feed-permissions-autosave-20261010`. Implementation commits: `f1b937fb0df64047007ed4290e589162210917c9` and `03f60ec21211be586fa4456a52abc6960b16375d`.

Feed Settings uses grouped cards and shared toggle styling. Proposal signed, Contract signed, and Job completed appear together first and are disabled in defaults. Existing explicit audience selections are preserved. Changes auto-save through a serialized, revision-aware queue; failed saves offer Retry and concurrent edits preserve untouched audiences. There is no Save Settings button.

The permission registry exposes Manage Feed, View All Feed Departments, View Feed Activity, and View Feed Posts. The seeded Manager role receives Feed management and all-department visibility. Managers can moderate comments without requiring company-wide settings or comment-creation access. Explicit denials take precedence. Existing company administrators retain inherited management/all-department access unless explicitly denied; Activity and Posts remain enabled unless denied.

Activity permission controls List and thumbnail layouts together. Posts-only users are moved to Posts even when a previous preference points to another view. Existing granular layout denials remain effective. Department access is enforced on the server for catalogs, sources, direct thread access and comment actions. All-department permission permits viewing; creating department posts still requires department membership. Underlying project, document, financial and attachment access continues to apply. Automatic Posts in the All Departments view consider settings for every department visible to the user.

## Verification and app-server rollout

- TypeScript checks passed locally and on each staged application role.
- Feed API tests: 6 passed, including manager moderation, explicit denial, department boundaries and underlying resource access.
- Feed browser test passed: desktop/mobile layouts, Posts-only fallback, comments/reactions and automatic Posts across permitted departments.
- Feed Settings browser test passed: defaults, serialized auto-save, concurrent revisions, network retry and mobile layout.
- Publication regression suite: 69 passed, 1 PostgreSQL-dependent test skipped.
- All 18 deployed source/compiled files matched their release receipts on each app role. Local/public readiness and development outbound isolation passed. Hosted asset versions were verified.

Each app role was overlaid on its then-current release, preserving concurrent changes. Compiled task modules were built separately and copied through atomic replacements, without changing hard-linked baseline files.

| Role | Active release path | Previous path |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/03f60ec21211be586fa4456a52abc6960b16375d` | `/opt/firstmeasure/releases/121e046e6bf8c4de5d0d3a5bbe1a786726bf54a8` |
| pool | `/opt/firstmeasure/releases/03f60ec21211be586fa4456a52abc6960b16375d` | `/opt/firstmeasure/releases/121e046e6bf8c4de5d0d3a5bbe1a786726bf54a8` |
| legacy | `/mnt/firstmeasure_dev_releases/releases-feed-editor-v21/03f60ec21211be586fa4456a52abc6960b16375d` | `/mnt/firstmeasure_dev_releases/releases-feed-editor-v21/121e046e6bf8c4de5d0d3a5bbe1a786726bf54a8` |

Before rollback, verify the current pointer because another deployment may have advanced it. Restore only that role's previous pointer, restart its existing development service and PHP-FPM, and recheck readiness and development isolation.

## Pending background worker

The dev worker at `137.184.44.82` was readable through the configured `ben` account but this account cannot install releases or restart the service without administrative access. Configured deployment keys were not accepted for worker root access. No worker files, service settings or privileges were changed.

At the last inspection its active release was `/opt/firstmeasure/releases/121e046e6bf8c4de5d0d3a5bbe1a786726bf54a8`; the Feed permission helper was absent. Publication actions such as `channels.feed.thread`, `channels.feed.resolve`, `channels.feed.comment`, and `channels.feed.react` can execute through background automation. Their existing worker-side checks remain active, but the new department checks cannot be claimed there until the worker is updated. The older worker permission definitions must also be updated to keep seeded role permissions consistent.

An operator with existing worker deployment access should apply the task's backend changes to the worker's latest audited baseline, add `channels/feed-permissions.ts`, compile the changed modules in isolation, activate the release using the normal worker deployment process, and verify development isolation and a fresh worker heartbeat. Preserve concurrent worker changes and the prior worker release. Do not substitute an app-server release wholesale for the worker release.
