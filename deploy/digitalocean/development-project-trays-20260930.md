# Project trays and shared project notes — development rollout

Source: `ef95bf16e2668e7eb2128230a74e404311ba8691` on `codex/consolidated-firstmeasure-20260923`.
Target: `https://dev.1m8.ai`; development web, pool, worker and compatibility roles only.
Previous development release: `63538a453309343c5201ac3cb1987e7ecfcd7de4`.

## Implementation

Project shell icon tabs open Notes, Activity and Agent; split mode additionally exposes Messages. The shell mounts the existing Notes, Channels, activity APIs and global assistant libraries. It retains drafts across tray switches and disposes project-specific content when changing projects. No shared left-column region is introduced.

The project agent uses the global assistant definition, authorized tools, shared chat renderer, uploads/transcription and durable personal threads. One private conversation per person/project receives freshly authorized project and scope context each turn. No separate model credentials, window controls or thread selector are introduced.

`channels.separate_project_notes` (company capability **Separate project notes and messages**) defaults off. Combined mode preserves existing notes/message behavior. Split mode hides designated note messages from the main thread, search, message notifications and unread counts, provides a reusable Notes tab in the project channel, and permits explicit audience-preserving forward/share with a shared indicator. Disabling the flag reveals the same stored messages again. Historical untagged messages are not rewritten.

The shared Notes workspace includes pin-on-create, pinned section with expansion, searchable paginated history, audience controls, attachments, audio, replies, editing/revisions, delete/restore, copy, save and sharing. Note lifecycle events register as `project.note.*` and appear in Activity only in split mode. Typed published note actions use the same Channels authorization and services.

## Verification

- Isolated source: TypeScript check; project tray API tests (2); real-component browser test (1).
- Publication suite: 49 passed, 1 PostgreSQL-only test skipped (no local test PostgreSQL configured).
- Verified both selective source and assembled web-role payload; model calls mocked.
- The browser test also passed with JavaScript fetched from the served development assets (real shared components, mocked APIs).
- A read-only query against the development PostgreSQL instance verified the note-discriminator SQL against true, false and absent metadata values.
- Four broader notification assertions also fail on untouched source `39df5bc3`: two notification assistant expectations and two channel bell-routing expectations. They were not modified by this task.
- Rollout checks source/compiled hashes, development environment, session cookie, runtime release and outbound-safety enforcement; web readiness is checked before continuing to the next role.

## Rollout and rollback

An initial staging attempt refused activation because another development rollout changed the active baseline; no running source was changed. Payloads were rebuilt from the new live baseline. Existing role-specific code differences were retained, including compatibility-host window behavior. Each immutable release directory was copied before overlay; no production source, provider configuration, database migration or topology change was made.

The development inventory, role-specific merged payloads, hashes, archives and verification scripts are in ignored `output/project-trays/`. Each activated release has a `channels-release.json` receipt with prior release and deployed file hashes. Roll back by restoring the prior symlink and restarting only the affected development service after checking its current state; retain note data and feature flag state. Code rollback does not undo created/shared notes.

All four development roles activated and independently verified at source release `ef95bf16e2668e7eb2128230a74e404311ba8691`. Public development readiness and the served-component browser test passed.
