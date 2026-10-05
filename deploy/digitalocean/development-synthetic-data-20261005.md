# Development header and synthetic data — October 5, 2026



Development-only release: `57b7a4aa0919622907f2dea2ed0d3d498997b901`

(main implementation `499ea7b928b8809f42effa85c315b2c6f622ead4`).

Production activation is not authorized or performed.



The code icon sits between Search and the AI assistant. Hover shows a compact

preview; click opens the shared window manager with close, resize, dock and

minimize controls. On mobile it is an item in the existing header More menu.

Synthetic Data is collapsible. All eight switches default on and Roofing &

exteriors is the initial company choice. The catalog and schema are explicit

extension points for future company packs and development tools.



The API derives organization from the authenticated session, checks the development

data environment, sandbox metadata and matching instance, and requires company

settings plus each selected category's permission and capability. POST uses the

normal CSRF token. The browser library loads only after sandbox recognition;

backend generators are dynamically imported behind the development route guard.

Implementation and extension instructions: [development library](../../public/v1/development/README.md).



Generators add six standalone calendar events, equipment registry samples, four

projects with typed roof measurement datasets, five contacts, four manual material

lists, four roofing estimate templates/workflows with draft proposals, four team

channels, and fictional retained inbound communications. Counts can be lower on

repeat runs because existing samples are retained. Channel members are fictional

fixture records. Communication creates channel replies only when Channels is also

selected. No outbound transport or fake customer signature is invoked.



Material lists and draft proposals require the known sample projects. If those do

not exist and Projects is off, results explain that dependency without silently

creating projects. Estimates remain drafts for real review/signing and subsequent

material artifact generation. Existing sample records and user edits are retained.

Stable tenant-scoped IDs and a durable generation lease make repeat runs additive.

Partial failures are reported per category and can be retried.



## Verification and rollout



Local TypeScript check and focused fixture tests passed. Coverage includes normal

organization and production-environment rejection, permission checks, unauthenticated

HTTP rejection, CSRF rejection, all-on generation, independent category toggles,

repeat runs, concurrent requests and preserving edited sample data. Existing sandbox

sample tests still pass after the fixture implementation moved into the development

library. Browser checks cover hover, default switches, selection payload, result

feedback, close/reopen, desktop scrolling and mobile More access.



Earlier staged releases stopped when a concurrent deployment changed the baseline;

they were never activated. The final immutable overlays were rebuilt against the

updated live baselines (`27926ec287e1331e6cfa981766ae3ec6a4e9a5ba`). All roles use immutable hard-link cloning with detached writes for changed files. The pool had 2.3 GiB free and shared the baseline filesystem; capacity/inode checks retain a 1 GiB reserve. No historical release was deleted. Source/payload manifests and verification artifacts are in

`output/development-tools-20261005`. The payload includes only this task's seven

runtime files and compiled backend counterparts; unrelated workspace/deployed edits

are preserved. Use the per-role previous release paths in that folder's manifest

for rollback, rechecking current state before activation.



A later whole-workspace TypeScript run encountered concurrent uncommitted commerce/property-market and related test errors outside this task. Each immutable Linux release payload is independently typechecked before activation.



## Hosted completion



The new `Development Tools · Roofing Test` sandbox (`sbi_cea6633115e45c6a`,

organization `org_168f48c3e1d5cd13`) passed generation through the live header panel.

All eight category results completed: five contacts, four projects, five equipment

types/ten units/one yard, six events, four material lists, four draft estimates,

four channels and three inbound email threads with twelve fictional channel replies.

The existing Instant roofing templates were reused. A repeat request created no

additional material lists or drafts. The real inbox API returned all three email

threads. Desktop/mobile interactions passed without page errors.



A concurrent later release (`6f179e94405dadc4bd351adb60b3919733ded225`) retained this

feature on web-serving nodes. Final verification compares every task-owned source,

compiled file and browser asset hash against the active release rather than requiring

that later unrelated releases keep this task's release ID. Development readiness

and outbound isolation remain healthy. See `final-verification.json` and

`hosted-result.json` in the local output folder for the per-role and category results.

