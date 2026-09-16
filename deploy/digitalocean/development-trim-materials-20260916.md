# Development exterior trim and chimney-top update

Status: activated and verified on the development worker, web, and compatibility roles.

## Source and scope

- Runtime: `fc6c83129db9ef87205c537de1834f6aa8dadfa7`.
- Previous development runtime: `7eb21f3ae0020980c50513d0c662391bfe85d009`.
- Source branch: `codex/exterior-trim-controls`, isolated from concurrent report and display work in `codex/internal-exteriors`.
- Preserve this branch's changes when preparing subsequent releases. The working editor changes were also retained in the original checkout; do not replace that checkout wholesale.
- Eleven editor JavaScript modules changed. No PHP, API, compiled Node runtime, dependency, database, provider, access, or production changes.

## Behavior

- T applies a total six-inch band above, below, then three inches on each side. Coplanar divider classification is independent of noncoplanar return faces touching the same line.
- Merge Faces protects trim bands and their restoration metadata. Point-deletion healing retains its prior merge behavior.
- Compact roof/wall trim controls: separate additive Auto Select Walls and Auto Select Ground, six/eight/custom width, color, and Apply to the current editable edge selection.
- Material switches list materials currently in the model, resolving project default finishes. Default selects siding, vertical siding, soffit and unfinished surfaces; All and None plus individual switches override it. Apply filters each supporting face separately, preserving the full shell for corner classification.
- Ground candidates use actual shared base/ground boundary intervals, including slopes and partial contact.
- Fascia uses a small depth bias in all three display modes. No measured geometry or picking positions are offset.
- New and implicitly finished saved chimney caps get a plain light-gray chimney-top material. Explicit finishes remain intact. Cap centers are excluded from report surfaces and quantities, while trim remains eligible and reportable.
- Extruding a chimney cap gives new shaft walls an adjoining wall finish (or project default), never the report-excluded cap material.

## Validation

- All 804 local dev tests passed in the isolated checkout.
- All 416 focused geometry, controller, chimney, finish and report tests passed on Linux.
- Browser-checked the local model in a separate tab: wall automatic selection selected 8 edges, ground selection added to reach 25; compact menu and Default/All/None material switches worked. No model edits were saved.
- Development browser session required login, so authenticated visual verification used the local editor. Development served-source and health verification are performed separately.
- Local sandbox router now serves current wall_trim, wall_chimneys, exterior_finishes and exterior_report_model modules from the canonical checkout, retaining sandbox data.

## Artifact and deployment

- Artifact `/home/dev/exteriors-fc6c831.tar.gz`, 249922200 bytes.
- SHA-256 `d22cf8a2fa1645cca93a214b71eaf1724d8d93d5db5a552101c4f3169b21ec5f`.
- Generic artifact manifest labels are inherited packaging schema; actual environment guards require development, enforced outbound isolation, and the existing jack@1m8.ai experimental allowlist.
- Each stage verifies 1326 unchanged public source files before activation.
- Earlier candidates 92d4da4 and 7b0a566 were prepared/staged on the worker but never activated.

- Public `https://dev.1m8.ai/v1/health/ready` returned healthy, development, release `fc6c83129db9ef87205c537de1834f6aa8dadfa7`, with outbound safety enforced.
- All eleven JavaScript modules served by dev.1m8.ai matched the tested Git release bytes (line-ending normalized).
- All three live roles retained the experimental allowlist and passed runtime readiness checks. Production was not activated or changed.
