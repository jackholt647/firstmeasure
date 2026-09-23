# Development: experimental AI front-camera matching

Development web, worker and compatibility roles run `a9392d0d46c367e9e88d5960a6481cadd1f7e9d3`, based on the complete `5fc5918fc042ebabd1ea67defab50a2861025de7` runtime. The five-file runtime delta preserves the DSM chimney update and publication runtime. Production was not changed.

## Experiment

The exterior development panel has General, Speed and AI tabs. AI retains General's 190px width. The owner-only AI tab is enabled only on `dev.1m8.ai` with a private server credential present. The endpoint independently enforces hostname, owner session, same-origin POST, project authorization, image/request limits and a fixed model. No API key is committed or sent to the browser. The private credential is `/var/lib/firstmeasure-exterior-ai/api.key` on PHP-serving development hosts, outside release artifacts and the web root.

Jump to front uses the assigned Front elevation photo and a north-up metric model plan. GPT-6 Luna with low reasoning proposes absolute x/y positions. The editor supplies local grade plus 1.8288m height and aims at the complete model bounding-box center using the same coordinate conversion as wall rendering. It visibly animates an initial position and up to three refinements, with a final assessment of the last capture. Rotation and height are never delegated to AI. Captures use the active exterior material renderer, including textured presentation. Orthographic views automatically switch to perspective; the initial request includes field of view and aspect. The existing perspective field of view is retained; center aim, model differences and field of view may prevent exact photo alignment.

Reference photo, coordinate plan, each rendered view, exact camera coordinates, request context, model explanation, confidence and usage are retained in browser IndexedDB per project. Last saved run restores the most recent run; Export run downloads JSON including embedded JPEGs. Individual screenshots can also be downloaded. Captures are local to this browser/profile, not shared project artifacts. Stop aborts the active request; changing project or leaving exterior mode prevents stale responses from moving the camera. Model geometry is never edited by this experiment.

## Verification

- Live OpenAI request succeeded using `gpt-6-luna`, low reasoning. An authenticated real-house run completed initial placement and one refinement, with all four reference/render images restored from IndexedDB. Luna retained its initial position and stopped with only 32% confidence; it did not establish an exact visual match. The follow-up UI distinguishes low-confidence stops from a claimed match (65% threshold is presentation only, not calibrated accuracy).
- Pipeline browser test verifies narrow width, position validation, height on sloped terrain, center targeting, refinement cap, image persistence, restoration and stale-project cancellation.
- Existing wall-mode and performance suites: 60 checks passed. JavaScript syntax and PHP lint passed.
- Staging verified 24,496 unchanged files on web/compatibility and 24,510 on worker. Activation and role verification passed on all three roles with development-data and outbound-isolation guards.
- Public JavaScript matches source hashes; anonymous endpoint requests return 404. A transient load-balancer 503 during restart convergence cleared.

Evidence and guarded staging/rollout helpers: ignored `output/exterior-ai-20260923/`. Roll back to `5fc5918fc042ebabd1ea67defab50a2861025de7` using role readiness guards and PHP-FPM refresh on PHP-serving hosts. No database migration is involved. Remove the private experiment key to disable the feature without changing public source.
