# Development Feed permissions and auto-save — October 10, 2026

The Feed update was activated on `https://dev.1m8.ai`. The report-worker deployment is not a prerequisite for this Feed change; the earlier claim was corrected after inspecting its actual service entrypoint on October 11. Production was not changed.

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

## Correction: report worker is not a Feed deployment dependency

The initial report incorrectly treated the dev worker at `137.184.44.82` as the Platform automation runtime. The October 11 service inspection showed that `firstmeasure-development-worker` executes `dist/src/firstmeasure_worker.js`, which registers the FirstMeasure API and starts the durable report-job runtime. It does not start `src/platform_worker.ts` or the integration automation scheduler. No worker files, service settings or privileges were changed.

Feed publication actions can be called by Platform automations, but their registered execution kinds do not establish that the separate report-worker service runs those automations. The integration API registers its scheduler in the application runtime when platform background execution is enabled; the dedicated Platform worker is a separate entrypoint. The Feed backend changes belong in the runtime actually executing those actions, not automatically in every service described as a worker.

The earlier request for root/deployment access to the report worker is withdrawn for this Feed task. General backend release synchronization can be handled through normal deployment maintenance; it must not be represented as an unmet Feed requirement.

## October 11: portal component loading repair

The screenshot's exact message, `Feed settings failed to load.`, originated from the Company settings guard when `FirstMateFeedSettings` was absent. The component was registered in the app manifest, but the primary portal template loaded Company settings directly without the Feed component. The original standalone component test explicitly injected the component and missed this integration path.

Commit/release `940d95c71c3dc04ad133f4809772a0f5312b9bf6` adds Feed settings to the portal script list before Company settings. The tab renderer also loads the component on demand for shells that lack it, shares the in-flight request, and offers Retry after a download failure. The manifest advances only the Company bundle to `20261011-feed-loader-v3`.

Browser tests passed for the actual tab renderer starting with an absent component, a failed first download, a successful Retry and repeated tab opening without duplicate loads. The existing auto-save/defaults/conflict tests passed locally and with the publicly served Feed component. JavaScript and PHP syntax checks passed. Each serving role preserved its latest unrelated changes and verified the three changed files against its receipt.

Web and pool activated `/opt/firstmeasure/releases/940d95c71c3dc04ad133f4809772a0f5312b9bf6`; legacy activated `/mnt/firstmeasure_dev_releases/releases/940d95c71c3dc04ad133f4809772a0f5312b9bf6`. Their respective previous paths ended in `07b7a6c748a678941cc1b7e8bfdf9e4f0e3216fc` under the same parent. Local and public readiness passed with development isolation. The public site briefly returned 503 while services restarted and the load balancer readmitted them; it recovered before final verification. Worker and production were unchanged.
