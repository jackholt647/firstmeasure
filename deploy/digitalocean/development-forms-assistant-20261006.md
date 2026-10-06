# Development rollout: forms assistant, widgets and style (October 6)

Release commit: `a8f3d9077edab8052566f9949b991bc0d8c531c2` on
`codex/consolidated-firstmeasure-20260923`. Development only; production was not
touched and is not authorized by this record.

## What changed

Follow-up to [the October 5 forms rollout](development-forms-20261005.md). See
[the forms architecture](../../docs/architecture/forms.md).

- The Form Builder agent is removed. The shared assistant has `forms_*` tools,
  and the editor's AI tab mounts that assistant in a `form:<id>` conversation
  (`POST /v1/forms/organizations/:orgId/forms/:formId/conversation`).
- Two platform widgets, `forms.preview` and `forms.submissions`
  (`libraries/platform-widgets/forms-widgets.js`), authorized against the new
  `forms.catalog` publication export. The widget runtime accepts
  organization-scope targets.
- Editor tabs are AI, Build, Style, Pricing, Settings, Submissions. A form opens
  on AI. Share is folded into Settings; wording moved into Build.
- Forms follow the company font and logo as well as colors.
- Anonymous activity counts (`POST /v1/forms/public/:key/activity`, new
  `form_activity` collection) and `GET .../forms/:formId/insights`.
- Instant Full Org development sandboxes are seeded once with three published
  forms the first time their form list is read.
- The forms client retries 502/503/504. The reported publish 503 never reached
  an application node; it came from the load balancer while nodes restarted
  during concurrent rollouts. It was not reproduced.

## Rollout

Per-task tooling in the ignored `output/forms-assistant-20261006/` directory.
The commit holds only this task's lines in files other sessions are editing
(`assistant/agent/definition.ts`, the publication bootstrap, coverage and
permission bundles). The payload was three-way merged onto each role's live
files and activated one role at a time: worker, legacy, web, pool.

## Verification

- `verify-deployment.py`: every payload file matches on all four roles (37 on
  web, legacy and pool; 28 on the worker), each reporting release `a8f3d907`,
  ready, development data environment, outbound safety enforced.
- `https://dev.1m8.ai`: health 200 with the release id; `forms-widgets.js`,
  `catalog.json` (containing both form widgets), `forms.js` and the embed 200;
  unknown form key 404; unauthenticated authoring route 401; activity for an
  unknown key 204.
- Before rollout, locally: type check clean, `npm run test:forms` (17),
  `npm run test:forms:browser` (4 Chrome flows), the publication suites and the
  client CSRF and booking suites.

Not verified on development: the real assistant surface inside the editor (the
browser test replaces it with a stand-in), the assistant using the forms tools
with a live model, seeding on an existing Instant Full Org sandbox, and the
company logo on seeded forms.

`platform-widgets-browser.test.mjs` "Scope uses shared widgets…" fails locally
with and without this change.

## Known leftovers

- `public/v1/dist/forms/agent.js` remains on the hosts because the overlay does
  not remove files. Nothing imports it.

## Rollback

Each role keeps its previous release directory. Point `/opt/firstmeasure/current`
back at it and restart the role's service, one role at a time, then confirm
`/v1/health/ready`. `form_activity` records are ignored by the previous release.
