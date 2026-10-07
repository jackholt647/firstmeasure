# Full-house report workflow

Implementation prepared October 6, 2026 and subsequently
[deployed to development](../deploy/digitalocean/development-full-house-workflow-20261006.md).
This change does not enable organization flags or activate a production release.

## Pilot configuration

Customer ordering remains behind the existing organization feature flag
`firstmeasure.exteriors`. Keep it disabled except for explicitly selected pilot
organizations. The existing ordering flow creates residential `exteriors_` projects
with `measurement_scope: full_house`. Gutters are mandatory on those projects.

Internal user settings have two independent, default-off qualifications:

- `can_draft_full_house`: permits drafting claims and reservations.
- `can_qa_full_house`: permits QA claims, reservations, approval and full-house
  quality audit marking, subject to the user's existing role permissions.

Enable each qualification only for the appropriate staff. Administrator access
does not implicitly grant either qualification. Existing training scaffolding is
preserved; course recordings and content still need to be supplied manually.

## Report lifecycle

Customer full-house projects use the regular editor submission, QA, saved report
and customer delivery workflow. Internal `fullhouse_` development drafts retain
their preview-only behavior. Use a feature-enabled pilot organization to exercise
the customer lifecycle in a development environment.

Submission requires roof and exterior measurements, mandatory gutter settings on
all four sides, and a completed synchronized main PDF. The PDF renderer includes
the exterior and gutter pages even if older saved preferences hide those pages.
The submission and delivery checks verify the saved PDF against the pinned render
job's SHA-256 digest. Direct completion and bulk QA approval cannot bypass the
full-house review.

Full-house QA adds seven confirmations: roof, walls, openings, finishes and trim,
gutters, references, and the complete PDF. Confirmations are tied to the PDF
revision; a newly rendered revision needs a new review. Manager escalation also
requires the full-house qualification and confirmations. Delivery requires an
approved current revision and attaches the saved main PDF through the existing
delivery service, including its normal receipt and retry handling.

The **QA Quality** tab adds exterior-specific error categories only for full-house
reports. Results can be filtered by report scope when full-house results exist;
scope columns and aggregates are conditional. Ordinary roof QA controls and
quality categories remain unchanged. Queue claims exclude full-house work for
unqualified staff. Customer reference walkthrough videos appear in Resources.

## Validation and release considerations

Validation covers the workflow on SQLite and PostgreSQL; missing or unfinished
PDFs; changed PDF bytes; revoked qualifications; QA approval and delivery job
creation; captured email attachments and receipts; manager quality controls;
PHP feature isolation; reference uploads; and training access boundaries.
Browser tests generate actual PDFs, check mandatory full-house pages, compare
default versus explicit US roof output, and check QA controls across report types
and revisions. Email transport tests capture delivery locally; they do not send
customer email.

Relevant repeatable checks:

- `public/v1/tests/full-house-workflow.test.ts`
- `public/v1/tests/full-house-delivery.test.ts`
- `dev/full-house-workflow.browser.cjs`
- `dev/full-house-review-ui.browser.cjs`
- Existing manager-review, QA, exterior PDF, PHP and tutorial regression tests.

The shared PDF recipe is `2026-10-06.1`. Deploy matching editor and backend/worker
assets using the established release procedure; an already-open editor may need
a reload. Complete a development pilot with a real staff account and controlled
recipient before enabling selected production organizations. Production activation
remains a separate authorized deployment step.
