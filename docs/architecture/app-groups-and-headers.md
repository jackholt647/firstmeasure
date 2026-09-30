# App groups and shared headers

`public/libraries/app-runtime/app-chrome.js` is the shared presentation library,
loaded before app bundles by the app manifest. `AppChrome.header` declares an
icon, title, optional subtitle, actions, tabs, and optional separate row. Existing
apps participate with `data-app-header` on their header, preserving their controls
and event handlers. `data-app-tab-row` declares a separate content-navigation row.
Doc Studio uses this for its dynamic folders; these folders are not applications.

Communications, Financials and Payroll declare groups with
`AppChrome.registerGroup`. Each declaration has a stable group ID, parent runtime
app ID, title, default member, and member definitions with stable IDs, titles,
optional icons and availability checks. The group's mount adapter mounts the
same member renderer in a standalone runtime instance. Children register in the
existing embeddable runtime, with their own portal route, and inherit the parent
access requirements. Both child and parent access are checked; placement never
grants domain access. Payouts additionally retains its merchant-processing gate.

Organization layouts are stored in `global.data.app_groups`. Each member can be
`group`, `standalone`, `both`, or `hidden`. Existing organizations default to all
members grouped. A group has an explicit default member; if it is unavailable to
a user, the first accessible grouped member is used. No accessible member means
no member content. A standalone-only layout uses an empty default and removes
the parent from the sidebar. Child IDs remain stable when placement changes.

The authenticated `GET /v1/platform/organizations/:orgId/app-groups` reads layout
without mutation. The per-group PUT requires CSRF and `manage_company_settings`,
validates placement/default consistency, and atomically preserves other groups.
Layouts are organization presentation preferences, not application entitlements
or publication operations. These child surfaces keep their existing domain
owners/providers; they introduce no new data or business-action packages.

Communications settings have a separate declared tab collection (Phone setup and
App layout); settings do not need one-to-one correspondence with member apps.
Financials exposes app layout through its header settings control. Payroll puts
app layout inside its Settings tab (standalone Payroll apps also provide a layout
control). Payroll configuration is a normal Payroll tab. New Call belongs to calling
views; Off-cycle run belongs to Upcoming payroll. Routine refresh controls are
removed from these group headers and Communications toolbars. Existing event
refreshes remain, with visible-view polling for financial/payroll data and call
lists/history/follow-ups. Settings forms are excluded from polling.

The Inbox currently owns a shared conversation/draft session. Its group and
standalone placements reattach that same DOM/session when activated, preserving
drafts and avoiding duplicate pollers. Other member views use independent mounted
renderer state. Scheduling remains one app with internal views. No project-window
content ownership or shared-sidebar contract changes are introduced.

Verification: `node --test tests/app-groups-browser.test.mjs` exercises actual
Communications, Financials and Payroll renderers with fixture APIs, responsive
headers, defaults, placement, access denial and settings. Run
`node --experimental-sqlite --import tsx --test --test-force-exit tests/app-groups-api.test.ts`
for persistent layouts, tenant isolation and input validation, and `npm run check`
from `public/v1`. These checks do not validate live telephony or payroll processing.
