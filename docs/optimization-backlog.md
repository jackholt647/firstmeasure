# Optimization backlog

The one place that lists work deferred on purpose to a later optimization pass. Each entry says what is slow or
wasteful today, where the change goes, and why it can wait. None of these changes what any feature computes: an
optimization here must return exactly the same results.

Add an entry when you knowingly ship something that reads more than it needs, repeats work, or will not scale, and
link the entry from the architecture doc's "Not built" section. Remove an entry when it is done.

## Indexed selections and change feeds for pay refresh

**Today.** A pay rule declares its inputs as selections (`platform/publication/select.ts`). Every selection is
answered by reading the whole published collection and filtering it, up to 50,000 rows, so pricing one person's June
hours reads every shift. Every refresh selects all inputs again; unchanged results are skipped by digest, but the
reads still happen.

**Where the change goes.** Both halves are centralized and are drop-in:

- *Indexes:* a provider adds the optional `select` hook already declared in `platform/publication/providers.ts`.
  `selectPublishedData` uses it when present and falls back to the scan otherwise (`selectionSupport` reports which).
  The hook must return exactly the rows the scan would, so no rule, plan or setup changes. Add a test per provider
  that runs the same selections both ways and compares.
- *Change feeds:* a source publishes "rows changed since revision N". A refresh then starts from those rows and uses
  `pay_rule_evidence` (already stored, keyed by source row) to find the earnings they affect, instead of selecting
  everything. This lives in `payroll/pay-refresh.ts` only.

**Why it can wait.** Results are identical either way; only cost changes. Worth doing when a real organization's time
clock, projects or commitments make a refresh noticeably slow, starting with the time clock.
(docs/architecture/pay-rules.md, data-publication.md "Declared selections")

## Pay previews and projections run every payee's rules

**Today.** Previewing a rule, plan or default change, and the managers' projected earnings totals, evaluate every
affected payee's rules on demand, capped at 200 payees (results say `truncated` beyond that). The projected totals
only run when someone presses the button for that reason.

**Where the change goes.** `payroll/pay-rules.ts` previews and `projectPayeeEarnings` in `payroll/pay-refresh.ts`:
reuse stored unit digests, and run payees in batches in the background with progress instead of one request.

**Why it can wait.** Organizations on the platform are far below 200 payees.

## Labor commitments are listed by reading the whole collection

**Today.** Commitments for a project or an assignee are found by reading every commitment and filtering
(`labor/commitments.ts`; the published `labor_commitments` source does the same).

**Where the change goes.** An index by project and by assignee in the labor store, and the `select` hook on the
published source (see the first entry).

**Why it can wait.** Fine until an organization has many thousands of commitments. (docs/architecture/assignees.md)

## Assignee directory and roster read everything on every request

**Today.** The assignee directory reads every assignee, and each user's custom fields one at a time, on every read.
The roster's conflict check reads every project's schedule events.

**Where the change goes.** `public/v1/assignees/directory.ts` (batch the field reads; cache per request) and
`roster.ts` (read events for the window and the assignees involved only, through an index on schedule events).

**Why it can wait.** Small organizations; the cost grows with users times fields and with total events.
(docs/architecture/assignee-base.md)

## Schedule roster reads every project

**Today.** `schedule-roster.events` (`public/v1/scheduling/roster.ts`) answers up to 200 events per read. It reads
every project and calendar event once per read to find the other work in the window the events cover, keeping only
events in that window that name an assignee, and `assessAssigneeOverlap` reads them all again for the overlap check.
Time off and the scheduling settings' days off are read once per read. Each event still runs `checkAssignment`, which
loads the assignee directory (with the fields of only the people involved) and the base records, so a read of a busy
week does that once per event.

**Where the change goes.** An index on schedule events by time and by assignee key, read by both `scheduledWork` in
`assignees/roster.ts` and `scheduledEvents` in `scheduling/occupancy.ts`, so one bounded query serves the window.
For the per-event directory load, `checkAssignment` / `loadRoster` would take an already loaded directory as one more
`sources` entry (an assignee-base change: the contract itself is unchanged).

**Why it can wait.** The views ask only for the events on screen, in one read per render, and cache the answer for a
minute. Cost grows with the total number of events and with events on screen.
(docs/architecture/schedule-events.md, "Roster and warnings")

## Stats datasets over full scans and fast-changing sources

**Today.** Stats materializations accept sources that can only be fully scanned; very high-cardinality or
continuously changing sources still need an indexed or snapshot adapter.

**Where the change goes.** A provider-specific adapter per such source. (docs/architecture/stats-materializations.md)

**Why it can wait.** No current dataset hits these limits.

## Generation outcomes read one query per run

**Today.** `history/outcomes.ts` answers `project-history.generations` and `generation-outcomes` by listing runs,
then, for each run, reading the next run of the same list and that list's changes in between. Reading 500 runs
across an organization is about 1,000 small queries.

**Where the change goes.** `generationsWithOutcomes` only: read the runs and the `project_changes` rows of their
subjects in one ranged query each, then pair them in memory. The outcome must stay exactly the same, so compare both
ways in `tests/project-history.test.ts`.

**Why it can wait.** It is read only by an agent looking for patterns, on demand, and is fast for the run counts a
company has today. (docs/architecture/project-history.md, "Known limits")

## Contact options and projection fan-out

**Today.** `contactOptions` (`contacts/service.ts`), which fills typed contact pickers, pages through every contact
(up to 5,000) and returns them all. A contact edit rewrites `project.contacts` on every linked project, one document
write each (`refreshProjections` in `contacts/records.ts`).

**Where the change goes.** Pickers call `contacts.records` with a text query instead of loading options, and options
is removed. The fan-out goes away when readers use the contacts client instead of the projection (contacts phase 5).

**Why it can wait.** An organization has few contacts per project, and pickers stay fast below a few thousand
contacts. (docs/architecture/contacts.md)
