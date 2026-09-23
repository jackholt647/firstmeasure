# Production tutorial final-test upload repair — September 23, 2026

## Symptom and cause

The tutorial project save completed, but submitting a final test then displayed “Tutorial save failed” and prevented advancement. The subsequent artifact upload returned HTTP 400, “No artifact was uploaded.” The web service's legacy proxy received the multipart upload stream, but `@fastify/http-proxy` forwarded no request body because Fastify's `request.body` was unset for multipart requests. This explains the saved project data alongside the failed final-test submission.

## Targeted release

Hotfix commit `3fa1f34b865983953ab0024c92bfca45be2747e3` was branched from the exact prior production release `3d424a69a869c2ba0b2b8897481af1b0e63c4b68` and pushed to `codex/production-tutorial-multipart-20260923`. The application change assigns the raw multipart stream to the proxied request body, so the existing legacy artifact endpoint receives the file. A real HTTP proxy regression verifies multipart forwarding. The fix and test are also in the canonical branch as `44e7b507`.

The production archive was constructed from the previous production archive with only `public/v1/src/app.ts`, its compiled JavaScript, the regression test and its compiled JavaScript changed, plus release metadata. All 18,146 baseline archive paths were compared. The new archive SHA-256 is `02d0fea7f0ac8234e9a2fb403c7e02cacaaf9f6f157940740b11475c50349ebc` (249,773,495 bytes). The prior archive SHA-256 was `f89677da96c3cb57256e4f2b3f28e3d13a1111661b1fc13d718a7ec6b7c857ae`. The regression, TypeScript check and build passed locally and on Linux before publication.

The signed production replacement channel was published with compare-and-swap against the prior archive SHA-256. All six web nodes independently downloaded, verified and installed the new archive before activation. The web nodes were then activated one at a time, waiting for each node to pass local readiness and rejoin the public load balancer before proceeding. The six web instances are `do-599442759`, `do-599442763`, `do-599442764`, `do-599442766`, `do-599442768` and `do-599442769`. A final 100 public readiness requests had zero failures, returned the new release ID on every response and reached all six nodes. Compatibility and worker roles remained on `3d424a69a869c2ba0b2b8897481af1b0e63c4b68`, since their application code was unchanged.

No live tutorial submission was created for verification, to avoid modifying a trainee's data. The user can retry a final-test submission. The failed artifact uploads may have left the main project data saved; this fix lets the full submission complete on retry.

## Rollback

If this release causes a regression, republish the prior production archive to the signed replacement channel with compare-and-swap against `02d0fea7f0ac8234e9a2fb403c7e02cacaaf9f6f157940740b11475c50349ebc`, verify the channel on every web node, then activate the prior `3d424a69a869c2ba0b2b8897481af1b0e63c4b68` release one web node at a time with the same local and public readiness checks. This hotfix has no database migration.
