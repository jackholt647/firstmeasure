# Settings layout contract

Settings is one page shell with three layers:

1. The active broad category supplies the wrapping title above the left category rail; Settings does not render category subtitles.
2. Broad categories are listed in the left sidebar (a horizontal rail on narrow screens).
3. A category's smaller views are hoisted into the dedicated top-right bubble-tab row, outside the white content surface. When no subtabs exist, that surface takes the row's space.

Do not add category markup, headings, click handlers, or permission checks directly to the shell. Add one entry to `settingsSections` in `public/libraries/apps/settings/company.js`. Every entry must provide a stable route `id`, `allowed`, `icon`, `title`, `subtitle`, `tabId`, and `paneId`; `subtitle` remains metadata but is not rendered in the compact shell. Use `term` when the title is terminology-aware. `My Settings` remains the first and default category.

For views inside a category, use `FirstMateSettingsPages.subTabs()` and `FirstMateSettingsPages.bindSubTabs()` from `public/libraries/settings-pages/firstmate-settings-pages.js`. The category owns its state and route updates; the helper owns tab semantics and bubble chrome. Existing settings modules retain their selectors for compatibility, but their tab systems are normalized by the shared shell styles.

## Migration inventory

All currently reachable broad categories use the shared title/subtitle, sidebar entry, content pane, active state, and route behavior:

- [x] My Settings
- [x] Company
- [x] Money — Accounts, Payments, Disputes
- [x] Calls — call queues, assignments, follow-up cadence, and outcomes
- [x] Contacts — Import contacts, Import history
- [x] Feedback — Set up, Responses
- [x] Equipment
- [x] Live Chat — Widget, Availability, Routing, Team, AI Agent
- [x] Communications — General, Message templates
- [x] AI Agents
- [x] Channels
- [x] Users — People, Roles & access
- [x] Payroll
- [x] Reports
- [x] Documents
- [x] Configuration — Custom Fields, Terminology, Projects, Celebrations, Insights, Apps
- [x] Scheduling
- [x] Crews and Subcontractors — Resource groups, Organization connections
- [x] Project Scopes — data-driven scope groups (Sales and Production by default), starred new-project fallback, conditional lead-field routing, a two-step catalog-to-scope creation workflow that can reuse already-installed templates, and per-scope Details, Boards & Automations, and Commissions views
- [x] Storage
- [x] SMS
- [x] Domains & Hosting
- [x] Features & Apps — Features & Apps, Manage My Apps, App Locations, Presets, Permission Sets
- [x] Pricebook — Pricebook, Generate from proposals
- [x] Proposals
- [x] Forms and Leads — website form kinds and Lead Import
- [x] Billing

The layout contract test is `public/v1/tests/settings-layout-contract.test.mjs`. Update the inventory and contract deliberately when a category or nested view is added.
