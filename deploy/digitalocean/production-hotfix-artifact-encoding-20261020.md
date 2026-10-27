# Production hotfix 10d8d525: undo history loads — October 20–21, 2026

## Symptom

After [release 31f87be5](production-release-20261020.md), QA and technicians
reported "Load Error: Failed to fetch" when opening some projects. The map
stayed at latitude 0, longitude 0, and the project did not open.

## Cause

From this release, the editor saves undo history as gzip artifacts
(`editor-history-<sha256>.bin`). `@fastify/compress`, which is registered
globally in `src/app.ts`, passes an already-gzipped body through unchanged but
labels it with the browser's preferred encoding:

- **Chrome** asks for `br`, so the gzip bytes arrived labeled
  `Content-Encoding: br`. Decoding failed, and `fetch` rejected with
  "Failed to fetch".
- **Browsers that accept only gzip** decompressed the body themselves, so the
  editor's integrity check would fail.

Every project saved with the new editor was affected the next time anyone
opened it.

Before the fix, production returned `content-encoding: br` for the failing file
(`7d1d7806…/editor-history-177b6e98….bin`). The stored file itself was intact:
correct SHA-256, valid gzip.

Neither dev nor the October 20 rollout caught it: no roof project on dev had
saved undo history to reopen.

## Fix (`10d8d525`, branch `codex/hotfix-artifact-encoding-20261020`)

- **Server.** `GET /v1/firstmeasure/projects/:id/artifacts/:name` is registered
  with `{ compress: false }`, so artifacts go out byte for byte. Other routes are
  still compressed.
- **Editor.** `main.js` opens a project with a fresh undo history when a saved
  one cannot be read, instead of failing the load.
- **Test.** `tests/artifact-download-encoding.test.ts` registers compression
  exactly as `app.ts` does and checks that a gzip artifact arrives byte for byte
  for every `Accept-Encoding`. It fails without the route change.

Two alternatives were tested locally, and both still broke the download:

- a `Content-Encoding: identity` header;
- `reply.compress = false`.

## Rollout

The release was built on the dev worker with the same `build.sh` as
`31f87be5`: archive `30ef0eb0…`, 358,614,379 bytes, verified.

**Dev.** The fix was merged onto the live files on all four roles. The running
dev service returned `insights.json` uncompressed (581,279 of 581,279 bytes),
and dev serves the fixed `main.js`.

**Production, October 21 (UTC):**

| Time | Step | Result |
| --- | --- | --- |
| 04:33 | Compatibility | Activated in 12 s. No errors. Production serves the fixed `main.js`. |
| — | Signed web channel | Published, checked against `9f0305b0…` (`31f87be5`). |
| — | Canary web node | Served the failing file as 5,652 bytes with no encoding; SHA-256 matched and it decompressed. An old node still returned `content-encoding: br` for the same request. |
| — | Remaining five web nodes | Activated one at a time with the drain, about 94 s each. All passed readiness, the asset match and the sandbox 404. |
| — | Worker | Unchanged, on `31f87be5`. It serves no artifacts or editor files. |

Afterwards:

- Public readiness returned 30/30 on `10d8d525`.
- The failing file returns 200 with 5,652 bytes, unencoded, through the load
  balancer.
- Live `editor-history` downloads return 200, and no application errors were
  logged.

## Rollback

Each role keeps its previous release:

- compatibility and web: `31f87be5`
- worker: unchanged

Republish `31f87be5` (`9f0305b0…`) to the channel before rolling back a web node.
