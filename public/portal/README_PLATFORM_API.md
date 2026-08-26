# Platform Data Model Notes For Future Agents

Do not use `measure/internal` for Platform-owned data. `measure/internal` and `/v1/firstmeasure` are only for measurement/report processing. Platform-owned identity, organization, org users, projects, project contacts, branches, settings, credits, and app workflow state live in `/v1/platform`.

Runtime layers:
- Browser API clients live in `public/libraries/`: `platform-api/platform-api.js` creates `window.PlatformAPI` for `/v1/platform`, and `firstmeasure-api/firstmeasure-api.js` creates `window.FirstMeasureAPI` for `/v1/firstmeasure`. Frontend code in `platform/` should talk to those clients instead of hardcoding API base URLs or building raw API fetches.
- Shared UI affordances live in `public/libraries/platform-ui/platform-ui.js` / `window.PlatformUI`. It is loaded before `public/portal/scripts/core.js`; `window.Portal.ui` delegates to it for toasts, custom black/translucent tooltips, and styled alert/confirm dialogs. Use `data-fm-tooltip="..."` or `PlatformUI.showTooltip(...)` instead of native `title` attributes or one-off tooltip CSS.
- Email API browser calls use `public/libraries/email-api/email-api.js` / `window.EmailAPI`. Backend code lives in `public/v1/email/api.ts`. It is mounted at `/v1/email` and currently owns inbound lead email routing; future outbound email should go there too.
- Public website lead embeds use `public/libraries/lead-embed/firstmate-lead-embed.js`. Admin/settings code manages those forms through `window.EmailAPI`; customer websites load the public embed directly.
- Canvassing API browser calls use `public/libraries/canvassing-api/canvassing-api.js` / `window.CanvassingAPI`. Backend code lives in `public/v1/canvassing/api.ts`. It is mounted at `/v1/canvassing` and stores lightweight canvassing pins separately from Platform projects.
- Scheduling helpers live in `public/libraries/platform-scheduling/platform-scheduling.js` and create `window.PlatformScheduling`. It loads branch scheduling defaults and branch variable mappings through `window.PlatformAPI`, then returns mapped labels plus stable ids.
- Celebration effects live in `public/libraries/platform-celebrations/platform-celebrations.js` and create `window.PlatformCelebrations`. Settings writes branch `project_configuration.celebrations_mode`; trigger-created celebration notifications are consumed by `platform-notifications`.
- Platform API backend code lives in `public/v1/platform/api.ts` and `public/v1/platform/storage.ts`. FirstMeasure API backend code lives in `public/v1/firstmeasure/api.ts` and related `public/v1/firstmeasure/*.ts` modules.
- App rollout flags are implemented in `public/v1/platform/app_flags.ts`, stored under org `global.json` as `data.app_flags`, and read in the browser through `window.PlatformAPI.appFlags`.
- `platform/server.php` is still the PHP transition bridge used by the browser for legacy action names. Login/register now call `/v1/platform/auth/login` or `/v1/platform/auth/register`, forward the V1 `Set-Cookie` header, and also set the old PHP session so existing PHP page guards keep working.
- `platform/platform_api_bridge.php` talks to `/v1/platform`, forwards the Platform session cookie/CSRF header on API calls, and translates old `org_*`, `get_credits`, and credit-reservation actions during the migration away from PHP.
- `public/portal/scripts/project_viewer.js` owns `window.Portal.ProjectStore`. It saves Platform project records to `/v1/platform/organizations/{orgId}/projects` with contact details stored on the project.
- FirstMeasure order submission still goes through the report queue path, but the Platform project/org/user records are Platform API records.
- Project lists are Platform-first. The dashboard should read `/organizations/{orgId}/projects`, then use `measurement_project.id`/`folder` only to hydrate FirstMeasure status, artifacts, thumbnails, and report details. Do not use FirstMeasure `projects/list` as the canonical project list except as a compatibility importer for older measurement-only records.

Storage layout:
```text
v1/storage/platform/
  identities/{identityId}.json
  auth_index/email/{sha256(normalizedEmail)}.json
  organizations/{orgId}/
    manifest.json
    global.json
    users/{userId}.json
    projects/{projectId}.json
    branch/{branchId}.json
    branch_data/{branchId}/{moduleId}.json
    media/{mediaId}/
      metadata.json
      original/original.{ext}
      renditions/{variant}.{ext}
      markup/{layerId}.json
```

Authentication model:
- Global `identities` are login accounts. They contain email, password hash, name/phone, status, and membership pointers.
- Org `users` are memberships/profiles under an organization. They contain `identity_id`, email/name/phone, role, status, permissions, profile fields, and org-specific stats.
- A user can belong to multiple orgs later. V1 login resolves identity by email, verifies the password hash, creates an HttpOnly Platform session cookie, then chooses an org membership. The PHP bridge mirrors the selected membership into PHP session fields only for current page-shell compatibility.

Important seeded records:
- `notifications@1m8.ai` migrated from `measure/internal`.
- Identity: `identity_486adeb6798b37c5`.
- Organization: `06a71ab1357a7a41aa6ee80a`.
- Org user: `02c8e6600b3f84edabba`.

ID convention:
- New Platform-owned generated records use type-prefixed opaque IDs: `org_...`, `identity_...`, `user_...`, `project_...`, `media_...` when generated.
- Semantic singleton IDs are allowed for system records like branch `default` and global `global`.
- External provider IDs are stored under provider-specific fields, not as canonical Platform IDs. For FirstMeasure, use `measurement_project.provider = "firstmeasure"` and `measurement_project.project_id` / `measurement_project.id` for the FirstMeasure child report.
- Legacy migrated IDs without prefixes may still be readable, but new writes should not create `base_...` or bare FirstMeasure project IDs.

Project/contact rule:
- When contact info is entered during project/report order, store normalized contact objects on `project.data.contacts`.
- The Platform project stores address, project type, notes, contacts, workflow state, and `measurement_project` for the FirstMeasure child report.
- Platform projects also store `events: []`. Events have one `start_at`, one `duration_minutes`, and one `event_type_default_id`, but plural `required_role_ids`, `allowed_role_ids`, `assigned_user_ids`, and `assigned_users`. Use `PlatformScheduling.createProjectEvent()` and `PlatformScheduling.saveProjectEvent()` rather than hand-writing event records.
- Platform projects store `stage` / `stage_id`. Default is `new_lead`. Stage labels and stage ordering are branch-level configuration. `newly_sold` is the stable internal id for the displayed `Sold` stage and should always exist.
- Email-imported leads are normal Platform projects with `stage` / `stage_id = new_lead`, `source = email_lead`, `lead_source.kind = email`, and contacts on the project.
- Generic imported leads should use `POST /v1/platform/organizations/{orgId}/leads` or backend helper `createPlatformLead(orgId, input)`. Email import, canvassing promotion, website embed forms, and future third-party imports should all flow through this one creator so projects, contacts, and notifications stay consistent.

Scheduling rule:
- Org users store `roles: []`, with stable internal role ids such as `sales_appointments` and `inside_sales`.
- Branch module `scheduling` stores event defaults. Default `sales_appointment` is 60 minutes, requires `sales_appointments`, allows `sales_appointments`, and can be assigned later.
- Branch module `variable_mappings` stores display labels for roles, event types, and future mapped variables. UI code should display mapped labels returned by `PlatformScheduling`, not raw ids.
- Required roles decide whether a slot is viable. Allowed roles decide which users can be assigned. `PlatformScheduling.availabilityForEventType()` and `availableEventTypeTimeSlots()` own that logic.
- Availability calls may include already assigned users. Assigned users are checked for conflicts and can satisfy any required roles they have; the scheduler then searches only for the remaining required roles. The library reports `hasAvailability`, `assignedStatus`, and `overrideRequired`, but `saveProjectEvent()` is intentionally permissive so front-end workflows can implement controlled overrides.

Stages/triggers rule:
- Branch module `stages` stores possible stage ids and visual ordering. Default display ids are `new_lead`, `appointment_scheduled`, `drafting_proposal`, `proposal_sent`, `newly_sold`, `project_started`, `in_progress`, `completed`, `cancelled`, and `lost`. `contacting` is a legacy/optional stage that should display between `new_lead` and `appointment_scheduled` only when projects actually use it.
- Branch module `variable_mappings` stores `labels.stages` for rendering stage labels.
- Branch module `triggers` stores trigger definitions. Trigger-worthy actions must have API routes and emit server-side events.
- Current API trigger event is `project.event_scheduled`, emitted by `POST /organizations/{orgId}/projects/{projectId}/events`.
- Default trigger: if a scheduled event has `event_type_default_id = sales_appointment` and the project stage is `contacting`, run action `project.stage.set` with `stage = appointment_scheduled`.
- Stage changes emit generated events: `project.stage_changed`, `project.stage.entered.{toStage}`, `project.stage.changed.to.{toStage}`, and `project.stage.changed.{fromStage}.to.{toStage}`. Custom stages should use those deterministic names in branch trigger definitions.
- Supported trigger actions today are `project.stage.set` and `notification.create`. Add new actions in the Platform API trigger runner, not in page scripts.
- Default trigger: entering `newly_sold` creates a `kind: celebration` notification with `celebration.size = large` and `celebration.text`, e.g. the project title/address plus "was just sold." The browser notifications library plays it through `PlatformCelebrations`, shows the toast, completes it, and does not render it in the bell menu.
- Branch module `project_configuration` stores `title_mode` and `celebrations_mode` (`on`, `small_only`, `off`).
- The Platform API heartbeat runs every 10 seconds and emits `project.event.completed` once for scheduled events whose start time plus duration has passed. The current default completed-sales-appointment trigger creates a passive follow-up notification.

Notifications rule:
- Notifications live in the `notifications` collection. They target `target_user_ids`, `target_role_ids`, or both.
- User-specific state lives on the user document at `notification_state.{notificationId}`. This stores `seen_at`, `dismissed_at`, and `completed_at`.
- `manual_dismissible` controls whether the front end offers a Done/Dismiss action.
- `push: true` currently only appends test delivery rows to `push_log`; real push transport can be added later behind the same API.
- Browser code should use `public/libraries/platform-notifications/platform-notifications.js` / `window.PlatformNotifications`, not direct user-state writes.

Branch/global rule:
- Store credits, credit ledger, billing, and truly org-wide policy in `global.json`.
- Store operator-controlled feature rollout flags in `global.json` under `data.app_flags`. These are not customer settings; normal Platform `/global` writes reject `app_flags` and `feature_flags`.
- Store company display settings in `branch/{branchId}.json`: branch name, contact fields, branding/color/logo references, report settings, onboarding state, branch-level preferences.
- Keep branch documents small. Large branch-level systems live as branch modules under `branch_data/{branchId}/`.
- Branch documents expose `data.modules.{moduleId}` references with `{ module_id, document, revision, updated_at, summary }`.
- `public/libraries/apps/settings/company.js` still posts legacy action names to `server.php`; `platform_api_bridge.php` translates those into Platform API writes. Company profile/report defaults write to the current branch, billing writes to `global.json`, and branding changes also sync the branch `presentation_style` module.
- Current branch modules:
- `pricebook`: branch estimating formulas/items. Read/write through `/organizations/{orgId}/branch/{branchId}/modules/pricebook`; Platform UI renders and edits it through `public/libraries/pricebook/firstmate-pricebook.js` so Settings and proposal modals use the same editor and pricing helpers. `public/libraries/pricebook/default-pricebook.json` is only the bootstrap seed when no branch module exists.
  - `presentation_style`: branch proposal/presentation style defaults, brand colors, marketing pages, and proposal page defaults. Read/write through `/organizations/{orgId}/branch/{branchId}/modules/presentation_style`.
  - `lead_import`: branch inbound lead email settings. Read/write through `/v1/email/organizations/{orgId}/branch/{branchId}/lead-import` or `window.EmailAPI`, not raw Platform module calls.
  - `lead_intake`: embeddable website form definitions for appointment forms, contact forms, instant estimate forms, and future custom intake forms. Read/write through `/v1/lead-intake/organizations/{orgId}/branch/{branchId}/settings` or `window.LeadIntakeAPI`, not raw Platform module calls.
  - `canvassing`: branch canvassing statuses, display labels, default status, canvasser role id, enabled flag, and lead target stage. Read/write through `/v1/canvassing/organizations/{orgId}/branch/{branchId}/settings` or `window.CanvassingAPI.settings`, not raw Platform module calls.
- Current default branch is `default`; PHP session key is `platform_branch_id`.

App rollout flag rule:
- Use app flags for controlled rollouts and hidden alpha/beta access. These decide whether a customer sees an app or feature at all.
- Use branch settings for customer-visible configuration after an app flag is enabled.
- Current app flag groups are `platform`, `email`, `canvassing`, and `firstmeasure`.
- Current lead-related flags: `platform.lead_import`, `email.inbound_lead_import`, `platform.website_embed_import`, and `canvassing.app`.
- Current portal shell flags include `platform.top_bar`, `platform.left_column_todo_list`, `platform.cobrand_sidebar_logo`, and `platform.project_stages_view`.
- Current FirstMeasure-compatible flags: `firstmeasure.gutter_reports`, `firstmeasure.instant_reports`, `firstmeasure.bonus_upfront_match`, and `firstmeasure.referral_program_banner`.
- Browser code should call `PlatformAPI.appFlags.load(orgId)` and check `PlatformAPI.appFlags.has(group, flag)`. Do not render customer settings, tabs, or marketing copy for features whose app flags are off.
- APIs must also gate direct calls server-side. Do not rely only on hiding UI.
- Disabled flags are intentionally not exposed as a customer-facing settings list.

Email lead import rule:
- Postmark should deliver unmatched `@1m8.ai` inbound mail to `/v1/email/inbound/postmark`.
- The webhook matches recipients against branch `lead_import.inbound_email`.
- Matching lead mail creates a `new_lead` project with contacts and a passive notification targeted to `lead_import.notification_target_role_ids`.
- OpenAI extraction is server-only. Configure `OPENAI_API_KEY`; default model is `gpt-5-nano`; use `EMAIL_LEAD_AI_DISABLED=1` in tests.

Website embed rule:
- Website forms are configured in Settings -> Forms and Leads and stored at `lead_intake.forms[]`.
- Website form type subtabs appear under Settings -> Forms and Leads when `platform.website_embed_import` and at least one `lead_forms.*` form type flag are enabled.
- Form ids are public because they are used by embeds, but disabled forms and disabled lead intake reject public reads/submits.
- The short embed loads `public/libraries/lead-embed/firstmate-lead-embed.js` with `data-form-id` and optional `data-target`.
- Public endpoint `POST /v1/lead-intake/public/forms/{formId}/submit` creates a Platform lead through `createPlatformLead`.
- Legacy `/v1/email/public/forms/*` routes delegate to Lead Intake for compatibility only.
- Form configuration includes copy, fine print, colors, optional logo URL, font, tracking key, scheduling mode, fields, pages, questions, and estimate settings. Keep this data in `lead_intake`; do not create separate page-script-only configs.

Canvassing rule:
- Canvassing pins are not Platform projects. They live under `v1/storage/canvassing/organizations/{orgId}/branches/{branchId}/pins`.
- The Platform Canvassing tab only appears when app flag `canvassing.app` is enabled.
- Branch `canvassing.enabled = false` hides the Platform Canvassing tab and blocks canvassing users/pins/promote routes for that branch.
- Pin statuses are branch-customizable and rendered through `settings.statuses[].label`; do not hardcode raw labels in UI.
- Promote a pin to a lead with `CanvassingAPI.pins.promote(orgId, branchId, pinId, leadPatch)`. This calls the Canvassing API, which calls the generic Platform lead creator and then writes `platform_project_id` and `status_id = lead_created` back onto the pin.
- The CRM manager tab is `public/libraries/apps/canvassing/app.js`; the standalone canvassing web wrapper is `apps/canvassing/`.
- Shared mobile map/pin/manager UI lives in `libraries/canvassing-app/canvassing-app.js`; future Platform mobile shells should mount that same renderer instead of copying UI.
- `apps/canvassing/` is not PHP-session guarded. It logs in/signs up through `PlatformAPI.auth.*` and uses the V1 Platform session cookie directly.
- Standalone canvassing signup still creates a normal Platform org and branch with the creator as `roles: ["canvasser", "canvassing_manager"]` and admin permissions. The UI can call it standalone, but do not invent a separate standalone identity system.
- Canvassing-only user management uses `CanvassingAPI.users.list/create`. It can add `canvasser` and `canvassing_manager` org users only. If no password is supplied, the backend marks the user invited/pending; invite email delivery is future work.

Media rule:
- Never put image/PDF/video bytes or data URLs in collection JSON.
- Store media bytes under `organizations/{orgId}/media/{mediaId}/`.
- Store only references such as `logo_media_id`, `avatar_media_id`, or project photo media ids in branch/user/project JSON.
- `metadata.json` contains owner `{ type, id, slot }`, content type, original variant, future thumbnail/rendition slots, and markup metadata.
- Read media through `/v1/platform/organizations/{orgId}/media/{mediaId}` for metadata and `/v1/platform/organizations/{orgId}/media/{mediaId}/file?variant=original` for bytes.
- Use the same media shape everywhere: branch logos, user avatars, project photos, videos, PDFs, and future marked-up photos.

When adding new app data:
- Prefer a new field under the relevant org collection document.
- Use `global.json` only for single-instance organization-wide settings/state.
- Use `branch` for branch/location-level records.
- If branch data can get large or is loaded only by a specific subsystem, store it as a branch module in `branch_data/{branchId}/{moduleId}.json` and put only a small reference/summary in `branch/{branchId}.json`.
- Use `media` for all binary/file assets; JSON gets metadata and references only.
- Do not add new Platform data files under `measure/internal`.
