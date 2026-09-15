# QA feedback / PHP bundle memory fixes — development only

Candidate `42ab264b13fcc953bed4688bf112b12adbcb781d`, branch
`codex/september-14-bugfixes`. Production remains the verified people-first
Tracking release `dcb8064af9f521d408974aa328da36d3393d533c`. This record does not
authorize production activation or change the signed production channel.

## Confirmed cause

Read the latest 177 Slack report and screenshots, then inspected the original
project read-only. Its two open QA threads are saved; its `pdf_state.json` is
106,897,754 bytes. Invoking the existing PHP bundle helper under the actual
production service environment with PHP's 128 MiB limit reproduced memory exhaustion at
`firstmeasure_node.php:61`. No customer/project data was changed. The team had
already cancelled/split the original order before this investigation.

The main editor had a direct Node fallback, but the notes overlay independently
retried the failing PHP bundle. This hid existing notes while the server correctly
required Fixed/Disputed responses. Recent memory-error sample: 337 editor bundle
failures, 328 at decoding and nine at response buffering. Earlier Apple/reroll
HTTP 500 observations are not established to share this cause.

## Changes

- Small feedback endpoint reads manifest/drafts without PDF state; the PHP
  action preserves session authentication and reviewer-identity hiding.
- Full editor bundle streams Node JSON through PHP without buffering/decoding
  its large PDF state. Node applies the equivalent blind-review transform before
  serialization. Images and geometry are not removed or downsampled.
- Tutorial feedback retains its existing isolated ownership-checked path.
- Submission safeguards remain: unresolved notes still block resubmission.

No schema, dependency, configuration, memory-limit, image or capacity change.
The full stream requires the already-installed production/development PHP cURL
extension. Upstream failures are not emitted as successful JSON bundles.

## Validation

Local and clean Linux build: typecheck/build, PHP lint for changed files, feedback
durability/refresh, API transport and reviewer-privacy tests passed. A real PHP
process streamed 140 MiB under a 32 MiB limit with exact byte count and SHA256;
upstream error bodies were withheld. Feedback API works even with an unreadable
PDF-state artifact, demonstrating it does not touch that artifact.

Artifact: 249,518,488 bytes; SHA256
`83d9bdeeda9c917f7923a7c1e280f8fe0e789208c9f9fb54004f4193046f3c6f`.
Built from the clean Linux worktree `/home/dev/code/people184-build` on the
development worker; retained as `/home/dev/tracking184-42ab264.tar.gz` and
`.tar.json`. Naming follows the existing staging helper; it is not an 184 release.

Identical artifact installed/activated on all three isolated development roles:
web 143.198.68.11, worker 137.184.44.82, compatibility 137.184.229.145. Each matched
all 1,609 non-dependency packaged files and passed runtime checks. Public readiness
confirmed development release identity and enforced outbound restrictions.
Production hosts/channel were not activated for this candidate.

Live development PostgreSQL/Spaces/PHP/FPM test with a synthetic technician:

- Unauthenticated feedback request: HTTP 401; authenticated feedback: 2,791 bytes.
- Reviewer identity hidden from technician; note text retained.
- Full 110 MiB synthetic PDF state received through PHP with geometry/image intact.
- Fixed draft persisted and reloaded through the small feedback action.

Jack's signed-in development browser loaded the real editor and synthetic note,
showed QA KICKBACK, expanded to the note with Fixed/Dispute controls, and saved
Fixed. PostgreSQL readback confirmed it; reloading showed All issues addressed.
The synthetic account was disabled; large padding was removed and fixtures were
hidden/cancelled after verification. No production grants, customer submissions,
charges, email or historical feedback were changed/reconstructed.

Full provider-backed Apple/reroll operations are not claimed fixed by these
checks. Native PDF generation itself is unchanged; this verifies state transport
and feedback persistence, not customer acceptance of a generated report.

177 and 187 may move to Done in Dev for this confirmed failure. Keep production
rollout held until authorized. Before promotion, reverify production baseline and
inventory, publish the signed artifact with compare-and-swap, roll/drain web
nodes, guard worker jobs, activate compatibility last, and verify live behavior.
Rollback is the retained dcb8064 artifact/channel; no schema rollback is needed.
