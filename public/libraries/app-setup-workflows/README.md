# App setup workflows

`app-setup-workflows.js` is the declarative layer between the app catalog and
the shared `FirstMateSetupWizard` shell. The shell owns modal chrome, the step
rail, routing, responsive behavior, and autosave lifecycle. This package owns
the app inventory, generated fields, validation, setup application, and
completion state.

## Modes

- `required`: launches automatically after the app is enabled and remains
  visibly incomplete in Manage My Apps until finished.
- `optional`: the app opens normally after enablement; setup is available from
  Manage My Apps.
- `none`: the app is immediately useful and has no setup action.
- `external:true`: metadata and a launch adapter only. The external workflow
  remains the sole owner of its fields, UI, state, and submission behavior.

## Current inventory

| Required | Optional | No setup |
| --- | --- | --- |
| Lead Import | Scheduling | Projects |
| Messaging (external 10DLC adapter) | My Contacts | Stats |
| Money (external payments adapter) | CRM | Project Photos |
| Payroll | Documents | Project Docs |
| Crew field app | Pricebook | Canvassing |
| Sales field app | Materials | Channels |
| Feedback | Customer Portal | Referrals |
| Calls provider check | Checklists | FirstMeasure |
| Live Chat legacy settings surface | Training | |
| | Equipment | |
| | Web Editor preference flow | |
| | Project Communications legacy settings surface | |
| | AI Assistant legacy settings surface | |

The three legacy settings surfaces are registered so they can use the same
system, but they do not appear in Manage My Apps until they become discoverable
top-level capability apps.

## Adding or changing a workflow

Declare steps with `step(...)` and fields with `field(...)` in the inventory.
The renderer supports text, email, URL, number, date, time, select, radio,
multi-select, checkbox, textarea, and informational fields. Use
`visibleWhen`, `requiredWhen`, and `validate` for conditional behavior.

Use `capabilityValues(values)` for capability toggles, `apply(values, context)`
for a narrow application adapter, and `handoff` for the routed destination
after completion. Do not add modal markup or direct browser-history calls to a
workflow declaration.

Setup drafts are stored per organization branch in the
`app_setup_workflows` branch module. The record includes values, visited and
active steps, timestamps, and `not_started`, `in_progress`, or `complete`
status. The browser cache is only a recovery fallback.

## Protected external workflows

The 10DLC, Money/payment registration, domain, and website setup workflows are
not implemented or styled here. Messaging and Money use launch/status adapters;
Web Editor's optional flow only records an editor starting preference and opens
the editor. Any change to those external workflows belongs in their separately
managed packages and regression suites.
