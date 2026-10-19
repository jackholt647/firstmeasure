# Permissions and shared agent access

This is the implementation guide for the platform access model. Read it before
adding an application, publishing data or actions, changing a role, or giving an
agent a tool. The publication contracts are in
[publication-architecture.md](publication-architecture.md).

## The three layers

1. **Operations:** backend owned data exports in
   `public/v1/platform/publication/providers.ts` and versioned actions in
   `public/v1/platform/publication/actions.ts`. Each has a target scope, schema,
   the app it belongs to, feature requirements, resource authorization and
   effect. Existing routes remain responsible for their own authorization.
2. **Business permissions:** `platform/capability_defs.ts` registers stable,
   named permissions. `platform/publication/permission-bundles.ts` maps each
   built-in publication operation to one permission. Some subject owned
   operations have an explicit empty permission and require membership or
   record authorization. The mapping is backend code; it is not a tenant
   supplied policy. Read and write operations should use different permissions.
3. **Roles:** `workforce/access.ts` stores organization roles that grant sets of
   named permissions. Users receive one or more roles and may have explicit
   per-user overrides. The Settings **Roles & access** and permission views
   manage this layer. Which apps a person has, and on which devices, is
   [App experience](app-experience.md), not a permission; a role grant does
   not turn on an app or feature the organization has off.

For a human request, effective authority is the intersection of active
membership, the app (when the route belongs to one) and feature, effective named permission, target
organization, and resource ownership rules. An explicit user denial overrides a
role's wildcard grant. `platform/auth.ts` builds the same authorization context
for API requests and background work; `backgroundAuthContext` reloads current
membership and permissions instead of trusting a saved snapshot.

For an agent request, the effective authority is that same current human
authority intersected with any agent specific restrictions. The model sees
only permitted catalog entries; discovery does not reveal permission internals.
Every read or action is checked again on the server, so a role, membership or
feature revocation takes effect on the next tool call. The catalog is a way to
find operations, never a grant of authority.

## FirstMeasure production compatibility

The seven production permissions are `order_reports`, `view_reports`,
`manage_billing`, `manage_company_settings`, `manage_report_settings`,
`manage_company_users`, and `manage_company_user_permissions`. Keep these keys
and the legacy Users tab contract stable. Existing organizations without
`platform.expanded_access` continue to use their original permission level
and per-user flags, including the legacy owner and administrator behavior.

When expanded access is enabled, `resolveAccessProfile` infers a seeded role
for users who have no explicit `access_role_ids` and applies their legacy
`org_permissions.items` as overrides. A saved `access_role_ids` array,
including an empty array, is authoritative. Do not silently convert legacy
role labels into modern grants after that field is present. A rollout must
compare each user's seven effective flags before and after enabling expanded
access; a code deployment alone does not flip that organization feature.

All other app permissions are development contracts and can be revised. Do
not reuse a FirstMeasure key for an unrelated new operation merely to make a
role pass. Keep cross-app grants explicit and business meaningful.

## How permissions are presented

Every permission key has one node in the capability registry with a title, a
one-line description and a subcategory (`permission_group`) inside one of the
categories in `public/v1/platform/permission_categories.ts`. The People
Permissions panel reads that tree from `permission_catalog` on the workforce
access catalog. Grouping is labels only and never changes a key or its meaning.
See [CAPABILITIES.md](../../public/v1/platform/CAPABILITIES.md#permission-categories).
`permission_keys` on the same response is deprecated and kept until nothing
reads it.

## Branch scope

With the `platform.multiple_branches` feature and more than one branch, People
data (users, the assignee directory, groups, outside companies, departments)
and their writes are limited on the server to the caller's own branches.
`view_region_branches` / `manage_region_branches` widen that to the branches of
their regions, `view_all_branches` / `manage_all_branches` to every branch; only
the seeded administrator roles have them. Branch scope only removes records:
the record's ordinary permission is still required. See
[branches](branches.md#access-the-branch-scope-rule).

## Organization boundary

A platform route never answers beyond the caller's organizations. There is no
platform operator in a customer session: every organization on the platform,
and creating an identity on its own, are internal-staff work under
`/v1/internal`. `GET /v1/platform/organizations` lists only the caller's own
memberships, and an identity is made only by the routes that add a person to an
organization (`POST /v1/platform/identities` was removed: it took memberships
and a password hash from the body).

The organization's global document holds billing, payment-method and credits
records. Reading it raw (`/organizations/:orgId/global`) needs
`manage_billing`; patching its `branding` needs `manage_company_settings` (the
brand kit) and every other key `manage_billing`. Everyone else sees only its
branding, in `/me` and `portal-state`. Credits are split: the balance
(`/credits`, and `credits.balance` in `portal-state`) needs
`order_reports|manage_billing`; the entries (`/credits/ledger`, and
`credits.ledger_count` and `billing` in `portal-state`) need `manage_billing`.
Without expanded access an owner or administrator holds all of these, as
before. Covered by `tests/platform-organization-boundary.test.ts`.

## Shared agent runtime

`agents/runtime.ts` runs the common conversation loop for all registered
agents. Human initiated turns receive the same six platform tools:
`platform_search`, `platform_describe`, `platform_read`, `platform_list`,
`platform_invoke`, and `platform_resolve_binding`. Their implementation is in
`agents/platform_tools.ts`. Search and describe keep the prompt small while
allowing cross-app discovery. The tool schema, action input and output schemas,
effects, and supported target scopes come from the publication registry.
`platform_invoke` uses the run's tool-call identity as its action receipt key.
Frozen bindings retain provenance and reauthorize on replay.

An app specific agent provides its identity, local prompt, local editing tools
and settings; it does not get a separate copy of the publication catalog.
Local editor tools may still use specialized domain services, but must declare
their permission, app and resource gates. The runtime refreshes the human
context before those tools as well. Agent settings may further narrow access;
they cannot enlarge the human's rights.

Automatic chat or communications turns without a human principal do not get
the general platform tools. Their existing narrow system tools use explicit
operation grants. Give autonomous work a deliberate service identity and
policy before extending its access. Never substitute a tenant supplied user ID
or a saved permission snapshot for that authority.

## Publishing a new app operation

1. Publish a typed provider or versioned domain action during shared bootstrap.
   Reuse the domain service and its record authorization. Declare the correct
   `executionKinds` if agents or other consumers should use the operation.
2. Add or reuse a stable permission node in `platform/capability_defs.ts` (or
   the owning app's capability registry) and place the operation in exactly
   one bundle in `platform/publication/permission-bundles.ts`. An empty bundle
   entry requires a subject or membership check in the domain service.
3. Add the appropriate permission to seeded roles or expose it for custom
   roles. App and feature gates still apply. Keep legacy HTTP routes and their
   permission checks aligned with the published operation.
4. Update `platform/publication/coverage.ts` and the publication guides. Add
   behavior tests for role grant and denial, cross-tenant and record access,
   schemas and effects. `tests/publication-permissions.test.ts` fails when a
   built-in API operation has no bundle.
5. Run `npm run test:publication` and `npm run check` in `public/v1`.

Publication covers the typed operations listed in the provider and action
registries. Registration does not itself migrate every older HTTP endpoint;
keep an endpoint's existing authorization until that route is reconciled with
its domain service and publication contract.

## Notification configuration permissions

`manage_own_notifications` controls personal registrations, preferences and quiet
hours. It defaults to allowed for existing members. `manage_notification_defaults`
controls organization defaults and administrative locks; existing company-settings
administrators inherit it when no explicit notification decision is present.
Both are visible as separate permissions in the capability/role catalog.

Explicit denials of either new permission on a role or user win over wildcard,
administrator and migration grants. These checks do not change notification reads,
delivery eligibility, or any of FirstMeasure's seven production permission flags.
`platform/notifications/permissions.ts` provides synchronous `notificationPermissions`
and `assertPersonalNotificationEdit` helpers for mutation endpoints.


## Notification editing permissions

Notifications separately declare `manage_own_notifications` and
`manage_notification_defaults` under the Notifications capability. Migration grants
personal editing to existing users and maps organization management from existing
company-settings authority. Explicit user or role denies override those fallbacks,
including legacy administrator and wildcard access. This narrow handling does not
change FirstMeasure's seven production permissions. Personal editing does not grant
organization policy access; organization access does not remove an explicit denial
of personal editing. Live notification protection is applied independently at delivery.
See [notification ownership and protection](notifications.md#personal-ownership-organization-defaults-and-protection).
