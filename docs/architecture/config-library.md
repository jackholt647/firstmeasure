# The platform config library

Status: built 2026-10-27 (the `config` lane of [dev lanes](dev-lanes.md)).
Development (dev.1m8.ai) edits it live; production reads the checked-in
snapshot and refuses every write.

## What it is

Every **default** the platform ships — document, workflow and presentation
templates, form templates, the scope library, guided setups and tutorials,
tab and app marketing media, rule and terminology defaults, price book
setups, measurement and work dictionaries, flag defaults and capability
presets, sandbox configurations — is **data** in one platform-level library.
Code declares what a kind of default looks like and reads entries; it never
holds the defaults themselves.

**Defaults are edited as data on dev, not in code.** To change a template, a
tutorial's copy, a flag default or a preset, write the library entry on dev
(the dev console's library editor, or the API with an access key). It is read
by every dev web and worker process within about a second: no commit, merge
or rollout. Do not add a default to a `.ts`/`.js` file; do not edit the
snapshot by hand.

- A **kind** is one sort of default (`document_template`, `guided_experience`,
  `app_flag_defaults`). It is declared once in `config-library/kinds/<kind>.ts`
  by the domain that reads it and registered in `config-library/kinds/index.ts`:
  its structure (a zod schema), its checks against what the running code
  registers, whether it is append-only, and how an organization's copy is
  reported and reset.
- An **entry** is one default of a kind, with an id unique inside the kind,
  a `revision` that rises by one with every save, and the sha256 of its data.

## Reading (code)

`config-library/library.ts`:

- `libraryEntries(kind)`, `libraryEntry(kind, id)`, `libraryData(kind, id)`
  are synchronous and return **frozen** values; `libraryCopy(kind, id)` returns
  a changeable clone. Clone before changing anything.
- `libraryVersion()` rises with every change seen by the process; use it as a
  cache key for anything derived from entries. `onLibraryChange(listener)` is
  called on every change.
- `libraryStamp(entry)` is what an organization's copy records about where it
  came from (`kind`, `id`, `revision`, `sha256`).

Where entries come from:

| Environment | Source | Writes |
|---|---|---|
| development data environment (dev.1m8.ai, a local stack) | the library store (Postgres on dev, SQLite locally) | yes |
| everywhere else (production, tests that do not opt in) | the checked-in snapshot `public/v1/config-library/snapshot/` | refused |

`CONFIG_LIBRARY_SOURCE=store|snapshot` forces one (never `store` in
production). In development each process seeds the store from the snapshot
(only entries the store never had: the store wins, deletes included), loads
it, and polls one sequence number each second (`refreshLibrary`), so an edit
reaches every process on its next load. Server boot (`src/app.ts`) and the
platform worker start the sync.

Pages read kinds declared `browser: true` (labels, marketing copy) from
`GET /v1/config-library/read/<kind>`, public and cached for 2 s on dev.

## Organizations' copies

Organizations still get **copies** of defaults, as before: a default reaches
an organization only while its copy is untouched; once the organization edits
its copy, library changes no longer reach it until it is reset. Each copy
records the `libraryStamp` it was made from; untouched means the copy still
matches that stamp. A kind with copies declares `orgCopies.status` (`missing`,
`library`, `behind`, `changed`) and `orgCopies.reset`, which puts the
organization's copy back to the current entry. Logic that adapts a default to
an organization (branding into a theme, price book rates into an estimate)
stays code and runs when the copy is made.

## Writing

`config-library/writes.ts`. Every save is a new revision with author
(`person` email, `agent` key, or `snapshot`), time and an optional note;
nothing in history is edited or removed. A save:

1. parses the entry with the kind's schema (what is stored is the parsed value);
2. runs the kind's `validate` against the running code's registries
   (`config-library/registries.ts`: providers and exports, actions, widgets,
   measurement keys and schemas, work items, capabilities, the one condition
   contract, other library entries);
3. for an **append-only** kind (the measurement and work dictionaries) refuses
   deletes and any change `compatible` rejects (meaning, unit, key);
4. requires every `asset:<sha256>` the entry names to exist;
5. takes `expected_revision` to refuse a lost update (409).

**Saves are as fast as possible: even seconds matter.** No tests of any kind
run on a save, and save-time checks are only those that cost milliseconds:
the shape, the append-only dictionary rule, and references to what the
running code registers (in-memory lookups; the registries load once per
process, at boot on dev). Nothing that takes longer (rendering a template,
running a module, cross-checking organizations) runs on save; a kind that
wants such a check declares `deepCheck`, run only on request
(`POST /deep-check {kind, id?}`). A save is one short transaction (about
2 ms locally).

Saving identical content records nothing. **Revert** saves an earlier
revision's data again as a new revision, checked again against the running
code. Deleting is a revision too, and can be reverted.

**Assets** (images a default uses) are content-addressed: upload, then name
`asset:<sha256>` in the entry; pages load `/v1/config-library/assets/<sha256>`
(public, immutable). PNG, JPEG, WebP, GIF and AVIF only (no SVG), 5 MB each.

## API

Mounted at `/v1/config-library`. Everything except `GET /assets/<sha256>` and
`GET /read/<kind>` answers 404 outside the development data environment,
whoever asks. Callers: a signed-in platform administrator or the development
tools audience (a sandbox test organization's settings managers), with CSRF on
writes; or a coding agent (Codex, Claude) with `Authorization: Bearer fmck_...`,
an access key a platform administrator created (`POST /keys`). A key reaches
library entries and assets only.

| Route | |
|---|---|
| `GET /kinds` | every kind with its JSON Schema, count, append-only and copies flags |
| `GET /entries?kind=&q=` | entry summaries |
| `GET /entries/:kind/:id` | one entry with data |
| `PUT /entries/:kind/:id` `{data, expected_revision?, note?}` | save |
| `DELETE /entries/:kind/:id?expected_revision=` | delete (not append-only kinds) |
| `GET /entries/:kind/:id/revisions[/:n]` | history, newest first |
| `POST /entries/:kind/:id/revert` `{revision}` | back to a revision |
| `POST /check` `{kind, id, data}` | the save-time checks, without saving |
| `POST /deep-check` `{kind, id?}` | a kind's slow on-demand checks (never run on save) |
| `GET /changes?kind=&limit=` | recent revisions across the library |
| `GET /assets`, `POST /assets` `{file_name, data_base64}` | assets |
| `GET /export` | the whole store (for the snapshot script) |
| `GET/POST /keys`, `DELETE /keys/:id` | access keys (signed-in administrator) |
| `GET /organizations/:orgId/copies?kind=` | how the organization's copies stand |
| `POST /organizations/:orgId/copies/:kind/:id/reset` | reset a copy to the library |
| `GET /organizations/:orgId/state` | a test organization's flags (flat), settings, scope flags, its start and every changed path |
| `PATCH /organizations/:orgId/state` `{path, value}` | flip one `flags.<key>`, `settings.<key>` or `scope_flags.<id>` |
| `POST /organizations/:orgId/state/restore` `{paths?}` | put the listed paths, or everything, back to the start |
| `POST /organizations/:orgId/state/capture` | record the current state as the start |

Realtime (the one platform event stream): `org_state.changed` `{changed_count}`
to the organization after a state change, and `config_library.changed`
`{kind, id, revision}` to the editor's organization after a library edit
(a library edit is platform-wide; other open trays read `GET /changes`).

For a coding agent on dev:

```bash
curl -s -H "Authorization: Bearer $FM_CONFIG_LIBRARY_KEY" https://dev.1m8.ai/v1/config-library/entries/document_template/tpl_invoice
curl -s -X PUT -H "Authorization: Bearer $FM_CONFIG_LIBRARY_KEY" -H "Content-Type: application/json" \
  -d '{"data": {...}, "expected_revision": 4, "note": "Shorter footer"}' https://dev.1m8.ai/v1/config-library/entries/document_template/tpl_invoice
```

## Test organizations

A sandbox test organization records its **starting state** when it is
created (`config-library/initial-state.ts`): its global settings (flags, app
offers and activations, placements, project tabs, settings; never credits or
billing) and its scope flags. The dev console lists every changed path, flips one, and
restores some paths or all of them. A full restore puts everything back (settings added
since are removed) and clears the organization's guided experience progress
and exposures so every Get Started tour and setup plays as new. Projects,
documents and other records are untouched. Test organizations made before
this existed record their start with `capture`.

## Snapshot

`public/v1/config-library/snapshot/<kind>/<id>.json` plus `_assets/`. It is
what fresh databases, tests and production read. It is produced from the store
and **never edited by hand**: each file carries the sha256 of its data and a
read refuses a file that does not match. To bring the checked-in snapshot up
to date with dev:

```bash
FM_CONFIG_LIBRARY_KEY=fmck_... node --import tsx scripts/config-library-snapshot.ts --from https://dev.1m8.ai
```

(`--check` exits 1 when they differ; `--local` exports this machine's store.)
Production gets library changes only through a snapshot in a release; there
is no production write path.

## Generation

The library was built in one run from the code seeds it replaced
(`scripts/config-library-generate.ts` with one generator per kind in
`config-library/generate/`), so nothing was typed again by hand: commit
`7de32873` (2026-10-28), 27 kinds and 216 entries. Random ids the seed builders
made were fixed at that moment. The seeds and the generators were then deleted;
`generate/all.ts` keeps the frame, and its history holds every generator.

## Kinds

| Kind | Entries | Domain doc | Organizations keep copies |
|---|---|---|---|
| `document_theme`, `document_template`, `document_workflow` | 3, 21, 13 | [document history](document-history.md) | yes (`documents/library-copies.ts`) |
| `presentation_deck` (browser) | 3 | [presentation modules](presentation-modules.md) | yes |
| `form_template` | 7 | [forms](forms.md) | no (a form is copied once) |
| `scope_template` (the scope library, industry scopes included) | 13 | [automation authoring](automation-authoring.md) | yes (`scopes/library.ts`) |
| `automation_rule_default` | 9 | [automation authoring](automation-authoring.md) | no (merged live; an organization stores only its changes) |
| `guided_experience`, `guided_tab_faqs`, `setup_step`, `guided_copy` | 11, 7, 2, 0 | [guided experiences](guided-experiences.md) | no (platform-wide) |
| `tab_promo` (browser, images as assets), `app_welcome` | 1, 8 | [app experience](app-experience.md) | no |
| `terminology_namespace` (browser, append-only keys) | 46 | [terminology](terminology.md) | no (an organization stores overrides only) |
| `app_flag_defaults`, `capability_defaults`, `capability_preset`, `capability_signup_preset` | 1, 1, 5, 1 | [app experience](app-experience.md) | no |
| `sandbox_configuration` (declarative; setup steps name `sandbox.*` published actions) | 6 | this doc | saved sandbox workflows follow untouched |
| `measurement_definition`, `measurement_partition`, `measurement_schema`, `measurement_equivalence` (append-only) | 37, 3, 3, 1 | [measurement schemas](measurement-schemas.md) | no |
| `work_item`, `work_schema` (append-only) | 13, 1 | [requirements](requirements.md) | no |
| `pricebook_template`, `material_library`, `pricebook_setup` | 1, 1, 4 | [materials calculus](materials-calculus.md) | price books upgrade additively by version |

## Production (not built)

Production reads the snapshot and refuses writes; there is no promote path
yet. Before this reaches a production release:

- The operator routes that edited capability presets, the signup preset and
  app flag defaults write the library, so on production they refuse. Anything
  production saved in its platform configuration documents
  (`capability_presets`, `capability_signup_preset`, `app_flag_defaults`) is
  not read there: it must be exported into the snapshot first (on dev those
  documents are imported once, author `import:platform-configuration`).
- Organizations' copies made before the library are stamped on first read
  (documents, scopes), and saved sandbox workflows without a stamp are
  replaced once.
- The measure editor (`public/measure/internal/index.php`) still reads
  `config/app_flag_defaults.json`; the internal PUT keeps writing it until the
  editor reads `GET /v1/internal/admin/app-flag-defaults`.

## Rules for agents

- A default is a library entry. Change it on dev through the API; never add or
  change one in code, and never edit the snapshot.
- Adding a new **kind** is code: a kind file with its schema, checks and copy
  handling, read through `library.ts`. Its first entries are written on dev.
- Procedural setup is a published action (`platform/publication/actions.ts`)
  that a declarative entry names; library entries hold no code beyond what a
  kind already defines as data (formula strings evaluated by an existing
  sandbox).
- Run `tests/config-library.test.ts` for changes to the library itself, and the
  tests of each domain whose kind you change.
