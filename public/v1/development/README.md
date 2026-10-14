# Development tools

The portal code icon is mounted only after the sandbox lookup and the authenticated
`GET /v1/signup-sandbox/development` eligibility check succeed. The browser library
lives at `public/libraries/development-tools`; the existing dev bar lazy-loads it
independently of whether the bottom test-run bar is dismissed. It is a single top-right anchored dropdown with button toggle, outside-click,
close-button and Escape dismissal. No generator is loaded by production boot.

`synthetic-data.ts` owns the category/company catalog, strict request schema,
authorization, durable organization lease, and orchestration. `roofing-company.ts` owns the connected development company fixtures. `fixtures.ts` holds
legacy fixtures used by the older sandbox sample button. The older module
is a re-export, not a second implementation.

Only the authenticated organization may be changed: it must be in the development
data environment, have sandbox metadata, and match a real sandbox instance record.
Company settings permission and each selected category's capability/permission
are checked before any writes. Requests require the normal platform CSRF token.
This private development operation is not published to document modules or agents.

All nine category toggles default on. Unselected categories are not synthesized.
Events can stand alone. Material lists and draft estimates attach only to the
known sample projects; if Projects is off and none exist, results explain how to
add them. Contacts are linked when generating new projects together. Channels
create fictional members; Communication adds retained inbound inbox examples and,
when Channels is selected, fictional channel replies. No transport is invoked.
Equipment creates registry data without hidden calendar events.

Stable organization-scoped identifiers and create-only checks preserve edits on
repeat runs. A ten-minute durable lease prevents concurrent web nodes from running
the same organization seed simultaneously. Category failures are reported
individually, and retry fills missing samples. This is additive seeding, not reset
or bulk replacement. Existing samples are not repopulated after user edits.

Roof measurements are typed project datasets published through the domain service.
Roofing templates reuse the organization price book and existing document material
recipes. Drafts remain unsigned: test the real customer acceptance path to publish
artifacts. Manual material samples coexist with these eventual document sets.

To add a category: declare its catalog entry, permission/capability preflight, and
bounded idempotent generator; add independent-selection and repeat-run coverage.
To add a company: add the allowed schema value and catalog entry, then select an
explicit company fixture implementation. Never accept arbitrary collection names,
source code, organization IDs, provider recipients or unbounded counts.

Tests: `tests/development-tools.test.ts` and `tests/signup-sandbox-samples.test.ts`.
Browser verification scripts and screenshots: `output/development-tools-20261005`.

Amount selects 1, 3, 5 or 10 fixture batches per click. The UI sends a UUID request_id;
request-scoped AsyncLocalStorage namespaces additive fixture IDs. Company users,
equipment and shared channels use stable organization IDs. A
retry keeps that UUID; a successful click clears it so the next click adds new data.
Templates remain shared. API amounts must be integers from 1 to 10; calls without
a request_id retain the original additive/idempotent fixture behavior.

## Roofing company balance

Each 1x batch adds 24 contacts and 16 residential roofing projects. Projects include
customer identity, addresses, scope notes, estimated values, measurements and real
work plans on the organization's sales pipeline, spread across its configured
stages. Manual fixture nodes contain no automation bindings; generating data does
not sign an estimate, order materials or send a message externally.

People (the `users` category, `roofing-people.ts`) builds a 40-person residential
and commercial roofing contractor from the platform's own concepts: custom access
roles beside the seeded ones (a user's types are their roles) with role-shaped
permissions and app defaults, six departments with icons and colours plus
department-scoped Department Manager grants, and three group types that are kinds
of group, each giving a role on joining: Crew, Sales team and Canvassing team.
Every install crew is a Crew; what it does is its capabilities, the scopes it is
marked as doing (`capability_scope_ids`) and its declared kinds of work
(`labor/capabilities.ts`): two shingle crews and a low-slope crew do roofing,
replacement and repairs, the gutter crew does gutters. Each crew requires a crew
foreman and a CDL driver. Repair technicians hold the seeded Repairman role in
Service & Repair and are in no group. Five company types and six outside companies
carry their own capabilities. Assignment tags, people fields on roles, the Crew type
and company types with sample values, worker classification, three sample pay
schedules and pay defaults from `payroll/sample-pay-rules.ts` (hourly for
installers and hourly staff, salary for the office, commission plans for sales, a
split by hours on the Crew type, committed labor for install subcontractors) and
own pay for leads and the general manager complete it. The sample pay sheets'
Crew A, B and C and two subcontractors are found by name and filled in rather than
doubled. Every Instant Full Org created in the development data environment gets
it at creation; the toggle refreshes it.

An organization with the earlier version's structure converges: its crews move to
Crew, and the generated Shingle, Low-slope, Gutter and Repair & service types and
the generated repair group are archived once nothing else uses them, with the
generator's pay default and field definitions on them cleared first.

Running it again changes only what it made: its roles, people, groups and
companies (`metadata.source = development_roofing_company`) and pay entries
carrying its note. Lists of roles, members, tags, types and department members
only grow; a role, type, department or pay default someone else made keeps its own
settings, and a typed field value wins over the sample. A suspended sample person
stays suspended and is an inactive member of their group. People have no login
identity, no notification roles, `@example.test` addresses and 555-01xx numbers;
companies are unlinked. Nothing is invited or messaged. Only development sandbox
organizations are accepted. Test: `tests/roofing-people.test.ts`.

Equipment creates four tracked units with reusable types and one yard;
only units count in the result. Both are organization-scoped and remain bounded
across batches and repeated clicks. Channels reuses two shared team spaces;
Communication fills those with threaded conversations and adds discussions to
only two project channels per project batch. Authors are the existing sample
team, or the requesting user when Users is off. Disabling Channels prevents new
channels while allowing Communication to populate existing ones.

New company scenarios are isolated in this library. The old sandbox fixtures are
preserved for that older API. Prior generated projects are not deleted or reset;
the project viewer's No board group exposes records with no workflow, and No stage
exposes cards missing a stage. Additional sample batches preserve user edits.
