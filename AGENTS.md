# FirstMeasure working instructions

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
