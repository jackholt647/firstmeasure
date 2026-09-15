# Internal full-house measurement integration

Based on `c888adf` (current September 14 bugfix branch), preserving the deployed
`42ab264` QA feedback and streaming-PHP fixes. Exterior changes were ported as
a three-way patch from the isolated prototype baseline `8d09cfb`; the prototype
snapshot was not copied over the production checkout. Runtime overrides, mock
identity, prototype launchers, and generated output are excluded.

## Behavior and access

- Existing roofing projects receive only the shared pane swap and resize controls.
  PHP does not emit exterior scripts or the Resources tab for roofing projects.
- `FIRSTMEASURE_FULL_HOUSE_ENABLED=1` and a comma-separated exact email allowlist
  in `FIRSTMEASURE_FULL_HOUSE_EMAILS` are both required. Defaults are off/empty.
  The identity must also be an active internal user; an Admin role alone grants
  no access. Configure the same values on all development Node roles.
- The private submission page is `/measure/internal/full_house.php`. It creates full-house drafts
  automatically after selecting a Google address suggestion. The selected
  formatted address and coordinates are required by the PHP submission route. There is no customer or
  general technician navigation entry, and no client-controlled role override.
- Submission sets immutable `measurement_scope: full_house` and `internal_only`
  fields. A reserved `fullhouse_` ID namespace preserves the privacy boundary
  even when older metadata is loaded. Normal create/patch/artifact paths cannot
  promote roofing projects into this scope or overwrite the manifest.
- Server queries exclude these IDs before pagination and counting; they have no
  shared queue group. Address matching, QA candidates, batch dashboard lookups,
  and queue events exclude them too. The private page has a separate authorized
  listing. This prevents customer and technician discovery of internal drafts.
- Direct project and resource routes check identity. PHP bridges sign the actual
  session identity with the existing internal service secret; browsers never
  receive that secret. Plain email/actor headers do not authorize access.
- If PHP and the web API use different provider-key files, configure PHP FPM's
  `FIRSTMEASURE_FULL_HOUSE_SIGNING_SECRET` with the web API's effective internal
  signing secret. This override affects only full-house requests. Keep it in a
  protected server configuration; do not alter existing provider credentials.
- Resource uploads use existing project storage with chunk integrity checks and
  ranged downloads. They require a full-house project and allowed identity.
  Private responses use `Cache-Control: private, no-store`.
- Full-house measurements are internal drafts. The normal imagery engine,
  geometry persistence, exterior tools, resources, and local PDF preview work;
  QA submission, billing/refunds, assignment and customer delivery are blocked.
  Background delivery/release handlers independently reject private IDs.

## Validation

Run from the repository root:

```sh
node --test dev/*.test.cjs
```

This includes the prototype's 662 geometry regressions and a real browser test
of shared pane swaps and two-axis resizing. Browser path can be specified with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

From `public/v1`:

```sh
npm run test:smoke
node tests/run-embedded-postgres.mjs tests/full-house-access.test.ts
```

The smoke suite includes real PHP rendering with a mock internal API and tests
for default-off behavior, owner/technician identities, forged headers, explicit
submission, scope immutability, normal roof access, private data save/reload,
resources, searches, counts, queue exclusion and revocation. Linux CI supplies
its test internal service secret and PHP cURL. The existing manager-review VM
test now loads the production quality-label helper that its renderer uses.

## Deployment and rollback

No database schema or dependency change. Deploy the complete Node/PHP/editor
artifact to **all three isolated development roles** before enabling the feature.
Confirm readiness reports `development` and enforced outbound restrictions.
No production activation is authorized by this integration request.

After deployment, enable only the confirmed user's internal account, create an
internal draft, verify walls/resources/save/reload and a normal roofing project,
and let the user test at dev.1m8.ai. Do not create charges or send test messages.

The safe feature rollback is to set `FIRSTMEASURE_FULL_HOUSE_ENABLED=0` and
restart the development Node roles. The privacy filters remain installed.
**Once private projects exist, do not roll back to an older binary that lacks
these filters:** it could expose those projects through old lists/queues. A code
rollback must retain the access/query guards, or first move every private draft
out of the active project store through a separately reviewed data operation.
Do not delete the drafts as an incidental rollback action.
