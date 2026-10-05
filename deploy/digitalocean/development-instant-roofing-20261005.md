# Instant Full Org roofing documents — October 5, 2026

Development only. Production was not activated.

Runtime release `a6975afbf61dbd0a6a426c2e648753c764462612` seeds new Instant Full
Org organizations as roofing/exteriors companies and supplies four document
templates with native input workflows:

- Roof replacement · Per-square estimate (Clean).
- Roof replacement · Itemized proposal (Margin).
- Summer roof · Fixed-price proposal (Triangles).
- Gutters · Exterior improvement estimate (Clean).

Each carries a document-owned material deliverable and shares the organization
price book. Signed roof and gutter contracts produce separate pending sets.
Generate materials evaluates the accepted recipe against its declared project
measurements/product inputs. Missing accessory measurements produce warnings.
Site-specific accessories still require review; prices are demonstration selling
prices, not supplier quotes. These samples are for development testing.

Instant Full Org members default to the enabled left apps bar with Instant
Tooltips behavior, including subsequently created members. Explicit personal
preferences remain respected.

Frontend followup `ec3371957af56db3b40b98dd6f6a482893439677` preserves fractional
measured quantities and signed shingle colors in the original native materials
grid. The ledger adapter retains separate lines, price-book additions, atomic
amendments, order allocations and receipts without duplicating native list data.
Formula authoring remains on the document. Supplier transmission is not enabled.

## Verification

`npm run check` passed. Publication suite: 50 passed, one skipped. Focused signing,
recipe, ledger and Instant integration tests passed. Native Scope browser checks
covered inline quantity, price-book addition, list visibility and ordering UI.
The integration test covers accepted documents, generated requirements, amendment,
ordering and receipt, including 25.5 squares rounding to 77 bundles.

Fresh hosted fixture: organization `org_28e881210cebff10`, sandbox instance
`sbi_b82edaed06520aa9`, project `project_roofing_6ab387ac3ae2`. Four templates are
present; roof and gutter documents were signed by the internal sandbox tester
without outgoing email. Itemized and package proposals remain drafts for review.
Hosted browser checks verified generation into the native grid, editing to 23.5
squares, price-book addition, second-member navigation defaults and no page errors.
Evidence/scripts are under `output/instant-roofing-20261005` locally.

## Runtime and rollback

Live signing exposed missing Chromium on development web/legacy/pool hosts.
Installed the repository-locked Playwright Chromium headless shell revision 1217
with its Linux dependencies under `/opt/firstmeasure/browsers`, using the existing
PDF runtime installation procedure. `/usr/bin/chromium` points to that executable;
verified execution as the service user and successful hosted signing/PDF retention.
Service hardening was preserved. New development hosts need this documented PDF
runtime dependency too.

Both releases use verified immutable overlays, retaining unrelated deployed
changes and the existing per-role backend differences. The worker runs the main
release; web, legacy and pool receive the frontend followup. To roll back the UI,
activate the retained `a6975afbf61dbd0a6a426c2e648753c764462612` release using the
normal development procedure. For a complete rollback use each role's prior
release recorded in `output/instant-roofing-20261005/manifest.json`; verify current
state before activation. Do not remove the browser needed for signed PDFs.
