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

## Stats datasets over full scans and fast-changing sources

**Today.** Stats materializations accept sources that can only be fully scanned; very high-cardinality or
continuously changing sources still need an indexed or snapshot adapter.

**Where the change goes.** A provider-specific adapter per such source. (docs/architecture/stats-materializations.md)

**Why it can wait.** No current dataset hits these limits.

## Contact options and projection fan-out

**Today.** `contactOptions` (`contacts/service.ts`), which fills typed contact pickers, pages through every contact
(up to 5,000) and returns them all. A contact edit rewrites `project.contacts` on every linked project, one document
write each (`refreshProjections` in `contacts/records.ts`).

**Where the change goes.** Pickers call `contacts.records` with a text query instead of loading options, and options
is removed. The fan-out goes away when readers use the contacts client instead of the projection (contacts phase 5).

**Why it can wait.** An organization has few contacts per project, and pickers stay fast below a few thousand
contacts. (docs/architecture/contacts.md)
