# Project change history

Everything done in a project's Project tab is real work: its material lists,
work orders, equipment, scope artifacts, assignments and schedule. The change
history records every change to that work, append-only, with who or what made
it. It keeps generated work apart from what people did to it afterwards, so an
agent can find what automatic generation keeps getting wrong and propose a fix
(the `improve_generation_from_history` how-to,
[agent how-to index](agent-how-to-index.md)).

Read this page before adding a writer that changes a project's lists, scope or
schedule, or a generator that writes them.

Documents keep their own version history, which is not part of this log:
see [document history](document-history.md). Both take their source from
`history/source.ts`.

## Words

| Word | Meaning |
| --- | --- |
| **Change** | One row in `project_changes`: what changed (`domain`, `subject_type`, `subject_id`, `op`), before and after, and its **source**. Never edited or deleted. |
| **Source** | Who or what made a change: `person`, `agent`, `automation`, `module`, `generator` or `system`, with the user, the published action and its receipt, the generator and its run, and an interface **tool** where one made the change for a person (Fix all is `requirements.fix_all`). |
| **Generator** | Code that writes part of a project from inputs: `labor.pay_sheet` (a work order priced on a pay sheet), `materials.calculus` (material a document's or a scope's calculation made), `scope.resources` (lists a scope built). |
| **Generation run** | One row in `generation_runs`: the generator, its version (the sheet, calculation or template version it used), what it was given (`inputs`) and the lines it made (`output`). Every line it writes carries `metadata.generation_id`. |
| **Outcome** | What people did to a run's lines before the same list was generated again: lines removed, changed (each field before and after) and added beside them. |

## Where it lives

`public/v1/history/`

- `source.ts` carries the source of the work being done, in async context:
  `withChangeSource` and `currentChangeSource`. Nothing passes it by hand.
- `storage.ts` is the store (`project-history.sqlite` locally, the shared
  Postgres pool on hosts) and the only writer: `recordProjectChange`,
  `recordGeneration`, `newGenerationId`.
- `diff.ts` describes lines (`lineFacts`) and compares them (`lineDiff`,
  `fieldDiff`, `generationOutcome`); missing, empty text and empty lists count
  as the same nothing, so filling one in is not a change. It also names the
  schedule event fields kept (`SCHEDULE_HISTORY_FIELDS`). Lines are matched by id; a calculated line
  by its key, because applying a calculation again gives its lines new ids.
- `outcomes.ts` puts a run beside its outcome.
- `publication.ts` publishes it read-only.

## Who records what

The domain writers record, on the server. Nothing in the browser can skip it.

| Writer | Records |
| --- | --- |
| `createMaterialList` (materials/storage.ts) | `created`, with every line added |
| `commitMaterialVersion` | `lines`: added, removed and changed, and in `after` the lines as they then stand. Skipped when no line changed. `input.change_tool` names an interface tool. |
| `patchMaterialList` | `fields`: title, status, delivery status, assignment, colour, scope template and piece, schedule enabled and group, controls, compensation, excluded work (`metadata.work_scope`), each before and after |
| `materialsCommand` (materials/calculus.ts) | `lines` for every set whose lines changed, and `work` (domain `scope`) when its work list changed. Applying the calculation of a set a document, a scope or the organization's measurement defaults published is a `materials.calculus` run. |
| `generateLaborList` (labor/generation.ts) | a `labor.pay_sheet` run with the sheet and revision, assignee, measurements, the project's materials and fields, typed numbers, required and excluded work; its write is the generator's |
| `initializeProjectMaterialListsFromScope` | its writes are `scope.resources`' |
| `saveProjectScheduleEvent` and the event delete route (platform/api.ts) | `created`, `event` (title, kind, status, start and end, all day, resources, parent, placement, lock, each before and after) and `deleted`. Events a parent's placement moved are recorded as the `schedule.placement` generator's. |
| `ensureMaterialListScheduleEvent`, `disableGeneratedResourceScheduleEvent` (materials/storage.ts) | the list's event and the span it created or changed. Both write the project on the revision they read and retry on a conflict, so a schedule save in between is never overwritten. |
| `invokeAction` (platform/publication/actions.ts) | the source of everything an action does: `agent`, `automation` (work), `module` or `person` (api), with the action id and receipt |

`domain` is `materials`, `work_order` or `equipment` by the list's resource
type, `scope` for work lists, and `schedule` for schedule events.

A generator wraps its writes in `withChangeSource({ kind: "generator", ... })`
after `recordGeneration`, and stamps `generation_id` on the lines it makes. A new
generator does the same; a new writer of a project's lists, scope or schedule
calls `recordProjectChange` after its write succeeds.

## Reading it

Provider `project-history`, read-only, in the project management permission
bundle:

- `changes` (project): changes oldest first, filtered by domain, subject,
  generation run or time.
- `generations` (project): each run with its inputs and outcome.
- `generation-outcomes` (organization): runs of one generator across projects,
  `edited_only` to leave out runs nobody changed. This is what an agent reads to
  find a pattern, such as starter strip added on most jobs with a given shingle.

An outcome compares the list as the run left it (its own `lines` change, which
includes lines it kept that people had added earlier) with the lines just
before the same list was generated again, or as they stand now. Lines another
generator made are not counted as people's additions.

## Known limits

- Recording is best effort: it runs after the domain write, and a failure is
  logged (`project_history_record_failed`) without undoing the work. A change can
  therefore be missing, never invented.
- Calculus orders and deliveries are kept in the ledger's own events, not here.
  Other writers of project events (recurring series, appointment booking,
  imports) are not recorded yet.
- Outcomes read one query per run ([optimization backlog](../optimization-backlog.md)).
- History starts when this shipped. Nothing before it is back-filled.

## Verification

From `public/v1`: `tests/project-history.test.ts`, plus
`npm run test:publication` and `tests/agent-how-to-index.test.ts` when changing
the provider or the how-to.
