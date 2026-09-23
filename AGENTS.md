# FirstMeasure working instructions

> **Directory move pending (September 23):** The physical canonical checkout is
> still `C:/Users/jackh/Code/2026/FirstMeasure`. Windows blocked the move because
> multiple Codex helpers hold this directory open. `FirstMate Platform` paths
> below describe the intended destination; it does not exist yet. No alias or
> duplicate was created. See [rename status and completion](docs/canonical-rename-status.md).


On a fresh clone or another computer, read [NEW_COMPUTER.md](NEW_COMPUTER.md)
first for the handoff branch, prerequisites, SSH setup, and Git workflow. Read
the linked release and incident records before proposing a production release.
Git push authorization does not itself authorize production activation.

For deployment, production troubleshooting, infrastructure changes, or planning a release, read [DEPLOYMENT.md](DEPLOYMENT.md) first. It records the completed migration, current architecture, deployment workflow, required production fixes, and remaining release-baseline work. Verify current state; historical IPs and release IDs may change.

Preserve unrelated changes in the existing workspace. A fresh worktree may lack uncommitted code already deployed to production. Do not bulk deploy, reset, clean, or replace the workspace without reviewing the actual source baseline.

Production deployment requires user authorization; honor authorization already given in the current conversation without requesting it again. Preparing documentation or a release does not itself authorize activation.

## Named infrastructure

- `dev sync droplet` means the dedicated development host at SSH alias `dev-sync-droplet`.
- Its normal account is `dev`; its default project directory is `/home/dev/code`.
- Connect through the existing SSH configuration. Never expose, print, copy, or transmit a private SSH key.
- Infer sync paths/direction only from adequate context. Do not infer deletion, mirroring, or overwrite semantics from a generic sync request.

## Canonical source

The active combined platform checkout is `C:/Users/jackh/Code/2026/FirstMate Platform`
on `codex/consolidated-firstmeasure-20260923`. Read
[docs/canonical-checkout.md](docs/canonical-checkout.md) before source reconciliation
or handoff. Older worktrees preserve recovery history; do not silently switch
to them or reimport their files. Deploy immutable verified commits from the
canonical branch using the existing deployment workflow. Development deployment
authorization does not authorize production deployment or topology changes.

## Architecture continuity

Before data/action publication or document/scope architecture work, read
[the agreed design and pending audit](docs/architecture/data-actions-continuity.md).
It links the full-conversation continuation. Audit the canonical integrated
source before treating earlier checkout findings as current facts.

## Platform publications and programmable modules

Read [publication architecture](docs/architecture/publication-architecture.md)
before adding cross-app data access, business operations or programmable logic.
Read [permissions and agents](docs/architecture/permissions-and-agents.md)
before changing role grants, permission checks, published operation access, or
agent tools. Preserve FirstMeasure's seven production permission flags.
Publish typed data through `platform/publication/providers.ts` and business
actions through `platform/publication/actions.ts`; register adapters during
shared bootstrap. Reuse domain services and their resource authorization.
Do not expose raw collections, credentials, arbitrary HTTP proxies or privileged
work contexts to module code. Reads must not create or mutate domain records.

Update the application ownership inventory in `publication/coverage.ts` for
new apps, and add behavior tests for authorization, schemas and effects.
Run `npm run test:publication` and `npm run check` in `public/v1` for changes to
these contracts. Custom code uses the bounded document-module sandbox;
freezing belongs to consumer bindings, with immutable provenance and fresh
authorization on replay. Never substitute a new action implementation for a
pinned unavailable version. The architecture guide records migration limits;
registration coverage alone does not prove every legacy endpoint is migrated.

The concurrently maintained FirstMeasure editor under `public/measure/internal`
is outside this architecture change. Preserve its work and stage only the files
owned by the current task when preparing commits or release artifacts.
