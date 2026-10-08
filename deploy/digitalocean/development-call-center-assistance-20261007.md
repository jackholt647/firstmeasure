# Development call-center assistance — October 7, 2026

Requested target: `https://dev.1m8.ai`. This is a development-only activation.

Source release: `8f31161d75665dead5b3df3c773300c8d924ae83`, following implementation commit `a23184cfe79b2fbf560b9fce0a45e834b3bd6a9a` on `codex/consolidated-firstmeasure-20260923`. Task baseline: `b735ec05912b50ac2831778222831a70c9c57f6c`. Previous active development release on all four roles: `57ab1bb4ad14c5d45cd9f9bbce7ca68323d9348e`.

## Scope and handoff

The release adds live listen, whisper, barge and takeover through durable Telnyx conference operations; recording controls using the existing consent and retention pipeline; an explicit automatic call-list dialer; and AI notes with editable instructions and follow-up questions. Distinct ordinary permissions support department/division-scoped grants. See [architecture and UI handoff](../../docs/architecture/call-center-assistance.md).

Reusable source analysis lives in the existing agents library and uses the configured agent model, existing OpenAI key, usage accounting and settings. Calls supply the first retained-transcript adapter. Notes and answers remain behind fresh source authorization and retention checks. The generic assistant can request analysis and read processing/reference metadata; full source-derived text is available in the authorized call UI/API, avoiding an unrevocable duplicate in generic conversation history.

## Release baseline

Each role receives a reviewed 38-file runtime overlay (21 source files plus compiled outputs) derived from the immutable source commit and reconciled with its captured live baseline. Unrelated deployed code is preserved. Worker-specific older UI lifecycle behavior is retained, including an explicit registered-browser-endpoint guard for automatic dialing. A superseded, unactivated worker candidate was preserved before restaging the reviewed variant.

Web, pool and worker releases use `/opt/firstmeasure/releases`; compatibility uses the existing `/opt/firstmeasure/releases-root-archive` workflow because the older release volume has no free inodes. Changed hardlinks are detached before writing. Previous releases remain available for rollback. Provider configuration and topology are unchanged.

## Validation

- Full TypeScript checks on the working source and isolated committed candidate.
- Isolated backend suite: 73 passed across supervision, analysis, HTTP/publication authorization, existing calls, department scope and Telnyx provider behavior.
- Final supervisor concurrency/cleanup regression suite: 12 passed.
- Isolated publication suite: 65 passed, one existing PostgreSQL environment skip.
- Five new browser scenarios and the existing phone-tray browser test passed; four worker-baseline browser scenarios also passed. Desktop/mobile AI-note layouts were inspected.
- Each staged role passes JavaScript syntax, source/compiled-output equality, Linux runtime TypeScript checks and exact payload hashes before activation.

Provider/model tests use mocks. No real customer calls or paid model requests were initiated by this rollout. A supervised multi-party call is still required to verify live audibility, device behavior, recording/transcription and AI generation end to end with the configured providers.

## Activation evidence

Status: activated and independently verified on web, web pool, worker and compatibility. Public readiness returned the new release three times; all four checked browser assets matched the staged payload. Anonymous requests to both new call endpoints returned 401. Development session/outbound isolation remained enforced.

Verification is recorded in `output/call-center-20261007/`: captured live inventory, task-only source, per-role resolved payloads, manifest hashes, public asset/readiness checks and final role checks. The public site must report this release with development outbound safety enforced. No secrets or customer records are included in this record.

For acceptance testing, open Calls, register the phone endpoint and use a test call with a second authorized user. Exercise listen → whisper → barge → takeover, leaving supervision, consent-controlled recording and playback. Test Auto dial with a small call list, required outcomes, pause/resume and a second tab. After a retained transcript is available, generate AI notes, change instructions, ask a question and explicitly append a result to human notes. Repeat with a department-scoped supervisor and a user lacking the relevant capability.
