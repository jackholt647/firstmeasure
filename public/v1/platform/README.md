# Platform API Backend

Backend implementation for the Platform API lives here:

- Routes: `public/v1/platform/api.ts`
- Storage helpers: `public/v1/platform/storage.ts`
- App flag helpers: `public/v1/platform/app_flags.ts`
- Runtime storage root: `public/v1/storage/platform/`

Frontend browser client lives at:

- `public/libraries/platform-api/platform-api.js`
- Client docs: `public/libraries/platform-api/README.md`
- Scheduling client: `public/libraries/platform-scheduling/platform-scheduling.js`
- Scheduling docs: `public/libraries/platform-scheduling/README.md`
- Notifications client: `public/libraries/platform-notifications/platform-notifications.js`
- Notifications docs: `public/libraries/platform-notifications/README.md`
- Action items client: `public/libraries/platform-action-items/platform-action-items.js`
- Action items docs: `public/libraries/platform-action-items/README.md`
- Celebrations client: `public/libraries/platform-celebrations/platform-celebrations.js`
- Celebrations docs: `public/libraries/platform-celebrations/README.md`
- Email API client: `public/libraries/email-api/email-api.js`
- Email API backend/docs: `public/v1/email/api.ts` and `public/v1/email/README.md`
- Public website lead embed: `public/libraries/lead-embed/firstmate-lead-embed.js`

All frontend Platform-owned data access should go through `window.PlatformAPI`. FirstMeasure measurement/report calls are separate and use `window.FirstMeasureAPI` from `public/libraries/firstmeasure-api/firstmeasure-api.js`.

Platform owns organizations, identities, org users, projects, project contacts, branches, branch modules, global settings, media metadata, media references, and future media markup references. It does not own FirstMeasure report processing or measurement artifacts. The Email API may create Platform records, but the stored project contact and notification data still belongs to Platform org storage.

## First-Party Auth

Auth implementation is centralized in `public/v1/platform/auth.ts`.

- `POST /auth/login`: verifies the identity password, creates a server-side session record, and sets `fm_platform_session` as an HttpOnly cookie.
- `POST /auth/register`: creates the identity/org/user and, when a raw password is supplied, also creates the session cookie.
- `GET /auth/session`: returns the current identity, org user, org, permissions, branch, and CSRF token.
- `POST /auth/logout`: revokes the server-side session and clears cookies.

The browser client in `public/libraries/platform-api/platform-api.js` always sends `credentials: include`. Mutating requests must include `X-Platform-CSRF`; the browser client copies this from the readable CSRF cookie. The actual session cookie stays HttpOnly and is never available to JavaScript.

Protected organization routes call `requirePlatformAuth()` with the requested org id. This is the central place to add future third-party token/OAuth handling later: keep route handlers using the same auth context rather than reading cookies directly.

## Local Codex Dev Account

Use this development-only account when a Codex agent needs to log into the Platform UI for browser automation, screenshots, or end-to-end smoke testing. It is intentionally simple and must not be copied to production storage.

- URL: `http://127.0.0.1:8012/platform/login.php`
- Email: `codex-dev@firstmate.local`
- Password: `codexdev`
- Organization id: `codex-dev`
- Organization name: `Codex Dev Roofing`
- Branch id: `default`

The account should authenticate against `POST /v1/platform/auth/login`, then `GET /v1/platform/auth/session` should return organization `codex-dev`, user role `super_admin`, `membership.branch_id = "default"`, permissions `{ "*": true }`, and a CSRF token. The default branch document is seeded with `canvassing.enabled = true` and development branding colors.

If the local storage copy is missing, recreate it through the API while the V1 node service is running:

```bash
curl -X POST http://127.0.0.1:3111/v1/platform/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "codex-dev@firstmate.local",
    "password": "codexdev",
    "name": "Codex Dev",
    "company": "Codex Dev Roofing",
    "organization_id": "codex-dev",
    "organization": {
      "status": "active",
      "metadata": {
        "purpose": "Local Codex/browser testing only",
        "source": "codex_dev_seed"
      }
    },
    "membership": {
      "role": "super_admin",
      "roles": ["sales_appointments", "inside_sales", "canvasser", "canvassing_manager"],
      "permissions": { "*": true }
    },
    "global": {
      "credits_balance": 10000,
      "credits_ledger": [],
      "branding": {
        "colors": {
          "primary": "#F0D030",
          "secondary": "#000000",
          "accent": "#1A73E8"
        }
      },
      "app_flags": {
        "platform": {
          "lead_import": true,
          "website_embed_import": true,
          "settings_forms": true
        },
        "email": {
          "inbound_lead_import": true
        },
        "canvassing": {
          "app": true
        },
        "firstmeasure": {
          "bonus_upfront_match": true,
          "gutter_reports": true,
          "instant_reports": true,
          "referral_program_banner": true
        }
      }
    }
  }'
```

After registering, log in once and create the default branch with the returned session cookie and CSRF token:

```bash
curl -X PUT http://127.0.0.1:3111/v1/platform/organizations/codex-dev/branch/default \
  -H "Content-Type: application/json" \
  -H "X-Platform-CSRF: <csrf token>" \
  -b "<cookie jar with fm_platform_session>" \
  -d '{
    "data": {
      "id": "default",
      "name": "Default Branch",
      "status": "active",
      "branding": {
        "colors": {
          "primary": "#F0D030",
          "secondary": "#000000",
          "accent": "#1A73E8"
        }
      },
      "contact": {},
      "report_settings": {},
      "canvassing": {
        "enabled": true
      }
    },
    "metadata": {
      "purpose": "Local Codex/browser testing branch for Codex agents",
      "source": "codex_dev_seed"
    }
  }'
```

## Legacy Cutover Commands

The legacy users/organizations migration is a clone-and-rebuild path. It does not move or mutate `public/measure/internal/storage`; fresh modes delete only the selected Platform target.

Development rehearsal:

```bash
npm run platform:cutover:simulate
```

This rebuilds `public/v1/storage/platform-migration-dev`, validates the migrated file graph, boots the Node API against that disposable target, and runs runtime smoke checks.

Production cutover:

```bash
npm run platform:cutover:production
```

The production command defaults to:

- source: `public/measure/internal/storage`
- target: `public/v1/storage/platform`
- backup root: `public/v1/storage/platform-cutover-backups`

It requires `--confirm-production` through the package script, performs preflight checks, backs up any existing target to a timestamped directory, fresh-rebuilds the target from legacy storage, and validates the result. Runtime smoke is intentionally not run against production storage because it creates synthetic test accounts; use the development rehearsal immediately before production deployment for API smoke.

Useful explicit forms:

```bash
node --experimental-sqlite --import tsx src/scripts/platform_production_cutover.ts --confirm-production --json
node --experimental-sqlite --import tsx src/scripts/platform_production_cutover.ts --source ../measure/internal/storage --target ./storage/platform --backup-root ./storage/platform-cutover-backups --confirm-production
```

Expected production-night sequence:

1. Stop write traffic to the portal.
2. Confirm the Node service env uses `PLATFORM_STORAGE_ROOT=./storage/platform`.
3. Run `npm run platform:cutover:simulate`.
4. Run `npm run platform:cutover:production`.
5. Start or restart the Node service.
6. Log in through the portal and verify `/v1/platform/ping`, `/v1/platform/auth/session`, portal credits, company settings, and a non-destructive project browse.
7. Keep the timestamped backup until the next successful business day.

## Schema-Light Core Documents

The core primitives are intentionally fungible during development:

- `projects`
- `users`
- `branch`
- `action_items`

Each record has a stable envelope plus open-ended `data` and `metadata` objects:

```json
{
  "id": "project_...",
  "organization_id": "org_...",
  "collection": "projects",
  "data": {
    "address": "...",
    "end_date": "2026-06-01",
    "any_new_variable": true
  },
  "metadata": {},
  "revision": 1
}
```

The backend does not validate or strip unknown keys from `data`. Add new fields through the browser client rather than adding a route:

```js
await PlatformAPI.documents.setField(orgId, 'projects', projectId, 'end_date', '2026-06-01');
await PlatformAPI.projects.setField(orgId, projectId, 'proposal.status', 'draft');
```

Top-level `PATCH` is shallow. The browser library supports dot paths by reading the current document and saving the updated full `data` object. Later, when product behavior stabilizes, stricter schemas can be layered onto specific fields without changing the storage envelope.

## App Rollout Flags

Org-controlled feature rollout flags live under `global.json` at `data.app_flags`, but they are operator-controlled, not customer settings. Mutually exclusive split-test assignments live beside them at `data.app_variants`. Platform `/global` writes reject `app_flags`, `feature_flags`, `app_variants`, and `feature_variants` mutations so normal users cannot toggle alpha/beta capabilities from the app.

Helper code is in `public/v1/platform/app_flags.ts`.

Current groups:

```json
{
  "platform": {
    "lead_import": true,
    "website_embed_import": true,
    "cobrand_sidebar_logo": false
  },
  "email": {
    "inbound_lead_import": true
  },
  "canvassing": {
    "app": true
  },
  "firstmeasure": {
    "bonus_upfront_match": true,
    "gutter_reports": true,
    "instant_reports": true,
    "referral_program_banner": false
  }
}
```

The UI calls `GET /v1/platform/organizations/:orgId/app-flags`, which returns only enabled capability names grouped by API. It does not return a customer-visible flag editor or disabled feature list. Browser code should use `PlatformAPI.appFlags.load()` and `PlatformAPI.appFlags.has(group, flag)`.

Split-tested variants are returned from the same endpoint as `effective_variants`. Browser code should use `PlatformAPI.appFlags.variant(family)`. Current family: `firstmeasure.referral_offer`, with variants `gift_card_50` and `credits_50`; both require `firstmeasure.referral_program_banner`.

Feature settings can still have customer-facing branch toggles once the app flag is enabled. Example: `canvassing.app = true` makes the Canvassing setting visible; branch `canvassing.enabled = false` lets that customer hide the Canvassing tab for their branch.

## Scheduling Data

Scheduling is stored with schema-light fields and branch modules:

- `users/{userId}.json` stores `data.roles`, an array of stable role ids. The first owner/super-admin user is seeded with all standard roles. Older owner/admin users without `roles` are treated as having all standard roles by the scheduling library.
- `projects/{projectId}.json` stores `data.events`, an array, and `data.stage` / `data.stage_id`. New manually created projects usually start with `events: []` and stage `appointment_scheduled`; inbound email leads can still start at `new_lead`.
- `branch_data/{branchId}/scheduling.json` stores event type defaults and branch availability defaults.
- `branch_data/{branchId}/variable_mappings.json` stores branch terminology mappings for roles, event types, and future variable labels.
- `branch_data/{branchId}/stages.json` stores possible project stages and their display ordering.
- `branch_data/{branchId}/triggers.json` stores branch trigger pair definitions.
- `branch_data/{branchId}/project_configuration.json` stores project UI rules such as title mode and celebration mode.
- `branch_data/{branchId}/lead_import.json` stores branch inbound email lead settings. Access this through `/v1/email/organizations/:orgId/branch/:branchId/lead-import`.
- `branch_data/{branchId}/lead_intake.json` stores embeddable website forms. Access this through `/v1/lead-intake/organizations/:orgId/branch/:branchId/settings`.
- `notifications/{notificationId}.json` stores passive/push notification records.
- `users/{userId}.json` stores per-user notification state under `data.notification_state`.
- `action_items/{actionItemId}.json` stores org-scoped to-do/action item records.
- `users/{userId}.json` stores per-user action item UI state under `data.action_item_state`.

Event records use singular scheduling facts and plural staffing facts:

```json
{
  "id": "event_...",
  "event_type_default_id": "sales_appointment",
  "start_at": "2026-05-04T16:00:00.000Z",
  "duration_minutes": 60,
  "required_role_ids": ["sales_appointments"],
  "allowed_role_ids": ["sales_appointments"],
  "role_ids": ["sales_appointments"],
  "assigned_user_ids": ["user_..."],
  "assigned_users": [{ "id": "user_...", "name": "Jane", "role_ids": ["sales_appointments"] }],
  "status": "scheduled"
}
```

Use `PlatformScheduling.loadBranchConfig()` and `availabilityForEventType()` from `public/libraries/platform-scheduling/platform-scheduling.js`. Do not duplicate terminology mapping or required/allowed role logic in page scripts.

Availability may be evaluated with preassigned users. Assigned users are checked for conflicts and can satisfy required roles they have; remaining required roles are staffed from the available user pool. Saving an event is not availability-enforced by the API.

## Stages And Triggers API

Stages are branch-configured variables. Default stage ids are:

- `appointment_scheduled`
- `newly_sold` (locked/default; always exists because sold workflow behavior depends on it)
- `project_started`
- `in_progress`
- `completed`

Legacy/default-compatible ids such as `new_lead`, `contacting`, and `lost` may still exist in the stage dictionary for older projects and integrations, but they are not part of the default display order.

`stages.json` defines the allowed/known stage ids and visual order. `variable_mappings.json` contains `labels.stages` so UIs render company terminology without changing internal ids. The order is only for display; it is not workflow logic.

Triggers are centralized in the Platform API. Trigger-worthy actions need an API route so outcomes run no matter whether the action came from the Platform UI, a customer form, or a future integration. Do not rely on browser-only code for trigger outcomes.

Current trigger routes:

- `GET /organizations/:orgId/branch/:branchId/triggers`: returns trigger config plus stages/mappings.
- `PUT /organizations/:orgId/branch/:branchId/triggers`: replaces branch trigger definitions.
- `POST /organizations/:orgId/branch/:branchId/triggers/emit`: manually emits a named trigger event.
- `POST /organizations/:orgId/projects/:projectId/events`: schedules/saves a project event and emits `project.event_scheduled`.

Trigger config shape:

```json
{
  "triggers": [
    {
      "id": "sales_appointment_scheduled_advances_contacting",
      "enabled": true,
      "event": "project.event_scheduled",
      "action": "project.stage.set",
      "conditions": {
        "event_type_default_id": "sales_appointment",
        "project_stage": "contacting"
      },
      "params": {
        "stage": "appointment_scheduled"
      }
    }
  ]
}
```

Supported action today: `project.stage.set`. The default trigger advances a project from `contacting` to `appointment_scheduled` whenever a `sales_appointment` event is scheduled through the API.

Stage changes emit generated trigger event names. When a project moves from `appointment_scheduled` to a custom stage like `job_sold`, the API emits:

- `project.stage_changed`
- `project.stage.entered.job_sold`
- `project.stage.changed.to.job_sold`
- `project.stage.changed.appointment_scheduled.to.job_sold`

Custom branch stages can therefore have trigger definitions without hardcoding each stage in API code.

Default newly sold trigger:

- Entering `newly_sold` creates a lightweight `kind: "celebration"` notification with `celebration.size = "large"` and `celebration.text`.
- `public/libraries/platform-notifications/platform-notifications.js` consumes celebration notifications, calls `PlatformCelebrations`, shows the celebration toast, marks them completed, and hides them from the bell list. New visible non-celebration notifications play `PlatformCelebrations.indicator()`.
- Branch `project_configuration.celebrations_mode` controls the client effect: `on`, `small_only`, or `off`.

The Platform API also runs a lightweight 10-second heartbeat in-process. Current heartbeat behavior checks project events whose `start_at + duration_minutes` is in the past and emits `project.event.completed` once per event. The default trigger for completed `sales_appointment` events creates a passive follow-up notification.

Supported trigger actions today:

- `project.stage.set`
- `notification.create`
- `action_item.create`
- `action_item.complete`

`notification.create` accepts normal notification fields plus template strings like `{{project.address}}` and `*_from` pointers such as `target_user_ids_from: "event.assigned_user_ids"`.

Default newly sold action item:

- Entering `newly_sold` creates a `kind: "schedule_sold_project"` action item assigned to the `sales_appointments` role.
- The item stores `frontend_action.kind = "open_project_scheduling"` so browser libraries can decide how to open the scheduling surface.
- The item automatically completes when `project.event_scheduled` fires for a `sales_appointment` on the same project.

## Notifications API

Notification records are centralized Platform documents. They target users and/or roles, but each user tracks their own state separately:

```json
{
  "id": "notification_...",
  "title": "Appointment completed",
  "body": "How did the appointment go?",
  "target_user_ids": ["user_..."],
  "target_role_ids": ["sales_appointments"],
  "manual_dismissible": true,
  "push": false,
  "passive": true,
  "expires_at": ""
}
```

Routes:

- `GET /organizations/:orgId/notifications`: notifications visible to the logged-in user.
- `POST /organizations/:orgId/notifications`: create a notification. If `push: true`, delivery is logged to `push_log` for now.
- `GET /organizations/:orgId/notifications/:notificationId`: read one notification.
- `PATCH /organizations/:orgId/notifications/:notificationId/user-state`: mark `seen`, `dismissed`, or `completed` for the logged-in user.

Per-user state is stored as `user.notification_state.{notificationId}` with `seen_at`, `dismissed_at`, and `completed_at`. Do not mutate notification records to dismiss them for one user.

## Action Items API

Action items are org-scoped workflow records. They are not owned by a user unless claimed. Lookup for the logged-in user is computed from assignment:

- blank assignment means any user in the organization can fulfill the item
- `assigned_user_ids` targets specific org users
- `assigned_role_ids` targets users with matching role ids

Routes:

- `GET /organizations/:orgId/action-items`: list visible items for the current user; supports `project_id`, `contact`, `kind`, `status`, `include_completed`, and due date filters.
- `POST /organizations/:orgId/action-items`: create an action item.
- `GET /organizations/:orgId/action-items/:actionItemId`: read one visible item.
- `PATCH /organizations/:orgId/action-items/:actionItemId`: update an item.
- `POST /organizations/:orgId/action-items/:actionItemId/claim`
- `POST /organizations/:orgId/action-items/:actionItemId/complete`
- `POST /organizations/:orgId/action-items/:actionItemId/cancel`
- `PATCH /organizations/:orgId/action-items/:actionItemId/user-state`: mark `seen`, `hidden`, `dismissed`, `pinned`, or `snoozed_until` for the logged-in user.

Frontend behavior is keyed by `kind` or `frontend_action.kind`; the backend stores those keys and payloads but does not run frontend code.

## Email Lead Import

Inbound lead routing lives in the Email API, not the Platform API:

- `GET /v1/email/organizations/:orgId/branch/:branchId/lead-import`: returns or creates the branch inbound lead email.
- `PATCH /v1/email/organizations/:orgId/branch/:branchId/lead-import`: updates settings or regenerates the email with `{ "regenerate": true }`.
- `POST /v1/email/inbound/postmark`: public Postmark webhook for unmatched `@1m8.ai` inbound mail.

When the webhook matches a recipient to `lead_import.inbound_email`, it extracts provider lead data and then calls the generic Platform lead creator. OpenAI extraction is server-only: configure `OPENAI_API_KEY`, optionally override `OPENAI_LEAD_MODEL`, and use `EMAIL_LEAD_AI_DISABLED=1` for deterministic tests.

Embeddable website forms live in the Lead Intake API:

- Branch settings store `lead_intake.forms[]`.
- Authenticated management should use `LeadIntakeAPI.settings` or `LeadIntakeAPI.forms`.
- Public websites should use `public/libraries/lead-embed/firstmate-lead-embed.js`.
- Public endpoints are `GET /v1/lead-intake/public/forms/:formId` and `POST /v1/lead-intake/public/forms/:formId/submit`.
- Legacy `/v1/email/public/forms/*` endpoints delegate to Lead Intake for compatibility only.
- Website submissions call the same generic Platform lead creator with source-specific `source_kind`, optional contact details, optional requested event, and passive notification.

## Generic Lead Creation

Shared lead route: `POST /v1/platform/organizations/:orgId/leads`.

This is the canonical path for email imports, canvassing promotion, future embedded website forms, and future third-party imports. It creates:

- a Platform project at `stage = new_lead` by default, with contacts stored on `project.data.contacts`
- a passive notification

Input is intentionally schema-light during development:

```json
{
  "branch_id": "default",
  "source_kind": "canvassing",
  "address": "22 Canvas Court",
  "summary": "Created from a canvassing pin.",
  "contacts": [{ "name": "Casey Canvas", "phone": "555-300-4000" }],
  "lead_source": { "kind": "canvassing", "pin_id": "pin_..." },
  "raw": {}
}
```

Backend helpers should call exported `createPlatformLead(orgId, input)` from `platform/api.ts` instead of duplicating project contact and notification creation.

## Canvassing Integration

Canvassing is its own API, not part of the Platform API:

- Backend: `public/v1/canvassing/api.ts`
- Browser library: `public/libraries/canvassing-api/canvassing-api.js`
- Platform manager tab: `public/platform/scripts/canvassing.js`
- Reusable mobile UI library: `public/libraries/canvassing-app/canvassing-app.js`
- Standalone mobile app wrapper: `public/apps/canvassing/`

Canvassing pins are lightweight records stored under `storage/canvassing`, not Platform projects. Branch-level canvassing settings/statuses/labels live as the Platform branch module `branch_data/{branchId}/canvassing.json`. A pin becomes a Platform lead only through `POST /v1/canvassing/organizations/:orgId/branch/:branchId/pins/:pinId/promote`, which calls the generic Platform lead creator and writes `platform_project_id` back onto the pin.

## Media Protocol

Media upload route: `POST /v1/platform/organizations/:orgId/media`.

Use `multipart/form-data` with a `file` field. Supported metadata fields:

- `owner_type`, `owner_id`, `slot`: associates the media with a project, branch, user, proposal, etc.
- `collection`/`scope`: optional logical bucket such as `projects`, `branch`, or `users`.
- `replace_slot=true`: deterministic ID for slot-style uploads like branch logos or avatars.
- `thumbnails`: optional JSON or `false`. Defaults generate `thumb_160`, `thumb_320`, `thumb_640` for raster images whose max dimension is at least `1024px`.
- `compression`: optional JSON or `false`. Defaults create a derived `display_2400` WebP when the original is larger than `2400px`. Original files are preserved unchanged.
- `markup`: optional JSON with `layers`; each layer is written to `media/{mediaId}/markup/{layerId}.json`.
- `metadata`: optional JSON stored on `metadata.json`.

For document-owned file fields, prefer the browser helper:

```js
await PlatformAPI.documents.uploadFieldFile(orgId, 'projects', projectId, 'supplier_materials_pdf', file, {
  mode: 'single',
  compression: false,
  thumbnails: false
});
```

That uploads the binary under `media/{mediaId}` and saves a normalized `media_reference` object onto the requested document field. Repeatable file fields can use `mode: 'append'`.

Storage shape:

- `media/{mediaId}/original/original.ext`: untouched source upload.
- `media/{mediaId}/renditions/*`: generated thumbnails/display variants.
- `media/{mediaId}/markup/*.json`: markup layers.
- `media/{mediaId}/metadata.json`: variant paths, owner reference, processing settings, markup references.

Read routes:

- `GET /organizations/:orgId/media`
- `GET /organizations/:orgId/media/:mediaId`
- `GET /organizations/:orgId/media/:mediaId/file?variant=original|thumb_320|display_2400`
- `GET /organizations/:orgId/media/:mediaId/markup/:layerId`
- `PUT /organizations/:orgId/media/:mediaId/markup/:layerId`
