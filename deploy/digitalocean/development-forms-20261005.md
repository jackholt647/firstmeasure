# Development rollout: block-based forms (October 5)

Release commit: `0562254e1086b7aeab71226aba99763e2b39146a` on
`codex/consolidated-firstmeasure-20260923`. Development only; production was not
touched and is not authorized by this record.

## What changed

Website forms were rebuilt as steps of blocks published as workflow document
modules. See [the forms architecture](../../docs/architecture/forms.md).

- New API at `/v1/forms`; the `/v1/lead-intake` API and the legacy
  `/v1/email/public/forms/*` routes are removed.
- New browser files: `libraries/forms-embed/`, `libraries/forms-api/`,
  `libraries/apps/settings/forms.js`. Settings → Forms and Leads now hosts the
  forms library and editor.
- New organization collections `forms` and `form_submissions`. No migration:
  forms stored in `lead_intake.json` branch modules are not carried over.

## Rollout

Per-task tooling in the ignored `output/forms-rework-20261005/` directory
(`setup.py`, `commit.py`, `prepare.py`, `build-payload.py`, `rollout.py`,
`deploy.py`). The payload was three-way merged onto each role's live files and
activated one role at a time: worker, legacy, web, pool. Host-side staging ran
the TypeScript check on every role.

Other sessions were deploying to development during this rollout. Two
activations were refused by the "active release changed" guard and were
re-audited, rebuilt and repeated. Because later releases from those sessions
were layered on afterwards, the web, legacy and pool roles now report a later
release id; that is expected.

## Verification

- After the last activation, every role was re-inventoried against the release
  commit. All 34 runtime files matched on web, legacy and pool except
  `public/portal/index.php`, which carries this change merged with a later
  release from another session. The worker matched on every `public/v1` file it
  receives.
- `https://dev.1m8.ai`: `/v1/forms/` 200, the three browser files and
  `forms-embed/form.html` 200, an unknown form key 404, an unauthenticated
  authoring route 401, `/v1/lead-intake/` 404. Health reported
  `data_environment: development` with outbound safety enforced.
- Before rollout: `npm run test:forms` (14 tests) and
  `npm run test:forms:browser` (4 Chrome flows) passed locally, with the
  websites, documents, module-store, booking and client CSRF suites.

Not verified on development: the editor inside the signed-in portal, a real
submission, live satellite measurement, and the Form Builder agent with a live
model. Those are the first things to exercise.

## Known leftovers

- The deleted `lead-intake` and `lead-embed` files remain on the hosts because
  the overlay does not remove files. Nothing loads them.
- Organizations need `platform.website_embed_import` and at least one
  `lead_forms.*` flag to see the Forms pane.

## Rollback

Each role keeps its previous release directory. Point `/opt/firstmeasure/current`
back at it and restart the role's service, one role at a time, then confirm
`/v1/health/ready`. Forms and submissions created meanwhile stay in storage and
are ignored by the previous release.
