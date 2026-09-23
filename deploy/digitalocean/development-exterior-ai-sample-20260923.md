# Development: ten-call Luna sample

Release `b897412d541be2613a23951e0a02b67a191f517f` updates only exterior_ai.js and exterior_ai.php at runtime over the complete `44a3693faeba00222662bfc7dd34f011216eeb4b` baseline. Production is unchanged. Concurrent source changes outside these two files are not part of this delta.

Ask Luna x10 dispatches exactly ten asynchronous requests with the same saved reference, eight candidate images and prompt context. There are no retries or new captures. Single-call Ask Luna remains available. Sampling leaves the camera unchanged and records all successes and failures with sample IDs/timestamps, retaining provider responses, grouped counts and per-call history in browser IndexedDB/export. Counts are empirical sample frequencies, not model confidence. Equivalent reversed midpoint pairs merge; failures are counted separately. Completed results remain available if Stop cancels outstanding requests.

The owner-only development endpoint now allows up to thirty calls per rolling minute per PHP session, counting under the session lock and releasing it before external calls, so the previous two-second limiter does not reject the batch. The model, prompt, credentials and production access restrictions are unchanged.

Five focused AI/profiler tests passed, including ten dispatches before any mocked response is released, exact request equality with screenshot encoding disabled, clustered reversed midpoints, partial failures and an unchanged camera. JavaScript syntax and diff checks passed. Deployment evidence is in ignored output/exterior-ai-sample-20260923. Rollback uses the prior complete development baseline and the guarded workflow with PHP-FPM refresh.

The original staged candidate was not activated: the baseline guard detected the concurrent cyan line-center deployment. This release was restaged over that newer complete runtime to preserve it.

PHP lint passed. All development roles activated and verified with readiness and isolation guards. Public AI script hash matches the release.

Live authenticated sample `sample-1790188986726`: exactly one batch of ten calls on the existing saved house captures, with no recapture or retry. All ten succeeded; View 2 received 10/10 choices (100%), all other views and midpoints zero. Five pre-existing calls were excluded from this batch distribution. The browser history now contains fifteen total calls; the camera was unchanged. Full responses and batch distribution remain saved in that browser and available through Export run. This establishes agreement for this ten-call sample, not a general determinism guarantee.
