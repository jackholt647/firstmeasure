# Development to-do publication and header tray — October 6, 2026

Code release: `53ef9c7334c75c23b2d2e0358bc65e542faa9f19` on `codex/consolidated-firstmeasure-20260923`.
Final agent-scope follow-up: `68aebd0cb6304c7f62477e4533c66e041bfdeb68`.
Verified live on `https://dev.1m8.ai` and all four development roles.

## Changes

- Publishes `todos.items` and ten discoverable Work actions for personal/project
  lists, reads, creation, editing/assignment, lifecycle transitions, caller-owned
  display state, follow-up outcomes, history and branch Work configuration.
- API, agents, modules and authenticated Work consumers share the same services,
  permissions, schemas, resource checks and mutation receipts. Trusted autonomous
  Work creation remains separate from the caller-owned agent surface.
- The header To Do control opens the existing shared list in the standard right
  dockable window. It survives navigation, supports minimize/restore and mobile,
  and is independently controlled by the default-on `topbar.todos` feature.
- Exact requested due dates are retained; clearing personal seen/hidden/dismissed
  marks is supported without changing another user's state.

See [to-do architecture](../../docs/architecture/todos.md).

## Validation

- `npm run check`: pass.
- `npm run test:publication`: 50 pass, one opt-in PostgreSQL test skipped.
- The shared-agent publication API test passes, including discovery of to-do
  creation/editing and denial of to-do data when assistant project access is off.
- `todo-publication.test.ts`: three tests pass, covering receipt replay, multiple
  same-project tasks, editing, assignments, publication schemas, permission and
  tenant/project denial, caller-owned state and follow-up cadence/outcomes.
- `todo-tray-browser.test.mjs` and `project-todo-tray.test.mjs`: Chrome checks pass.
  The global tray works with no left column, honors the feature flag, retains its
  renderer through minimization, fits a phone and rebuilds on branch change.
- Work API: 15/17 pass. The due-notification and scheduled-project-event failures
  reproduce in a pre-change source copy. The older follow-up UI contract still
  expects the retired standalone Calls app; that source is unchanged by this task.

## Rollout and preservation

Ignored task evidence: `output/todos-20261006/`, including inventories, task-only
commit source, reviewed three-way overlays, role manifests and verification.
The task commit excludes unrelated local and staged work. Each role retains its
actual live baseline. Permission-bundle and ownership-inventory conflicts were
resolved by adding only the to-do entries to the role's existing catalogs.

The web baseline changed during another development rollout; its inventory and
payload were refreshed before staging. The web root had insufficient capacity
for the deployment tool's required one-GiB reserve. Clearing only disposable APT
package-download caches restored sufficient space; release code, dependencies,
configuration and runtime data were preserved.

## Rollback

Each role retains its previous release. Restore its recorded previous current
symlink and restart that role's existing service, one role at a time, then verify
readiness and development isolation. No database migration or dependency update
is part of this change. Disabling `topbar.todos` closes and hides the new global
tray independently of the left-column list.

The follow-up adds `todos.*` to the shared assistant project-data scope gate;
it does not widen permissions. Concurrent lead-import and native-camera rollouts
retained the to-do implementation. Worker, compatibility and pool payloads were
refreshed against their actual live releases before restaging. Final verification
found worker and compatibility on `68aebd0c`, and web and pool on `08e24e41`,
which retain both to-do commits. All four passed source/compiled scope-fix hashes,
main to-do implementation hashes, publication registration checks, readiness and
development isolation. Public health returned the ready development web release;
the public tray asset matched its committed source. The pool activation's older
public probe waited for release `68aebd0c` after the concurrent rollout advanced
traffic to `08e24e41`; direct verification of the current release supersedes that
probe. No topology changes were made.

Follow-up evidence: `output/todos-agent-scope-20261006/verified-deployment.json`
and `verified-main-and-public.json`. The verification exercises deployed file
integrity and readiness; agent/tool behavior is covered by local integration
tests, rather than a live LLM session.
