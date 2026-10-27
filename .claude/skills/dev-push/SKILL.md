---
name: dev-push
description: Ship committed code to dev.1m8.ai through the dev push router (the only way to deploy to development). Use whenever work should go to dev, to "roll out", "deploy to dev", "ship", "push to dev", to check where a submission is, or when a submission was rejected.
---

# Ship to dev

Read `docs/architecture/dev-lanes.md` once. Everything goes through the router; never write rollout scripts, never
SSH to a dev host to stage or activate, never push canonical or a lane branch, never commit a rollout record.

1. **Commit** only your own files on your branch (worktree or clone). Rebase on the lane tip:
   `git fetch origin && git rebase origin/codex/consolidated-firstmeasure-20260923`
   (measure editor: `origin/lane/measure-internal`).
2. **Run the browser tests yourself** for what you touched (the router's gate skips tests that need Chrome).
3. **Submit and wait:**
   ```
   node tools/dev-push/submit.mjs --wait [--title "what changed"] [--tests tests/x.test.ts,...]
   ```
   The lane comes from the changed paths: `public/measure/internal/**` is measure-internal, everything else
   platform. Files of both lanes in one commit range are refused: split them. Defaults and templates are config
   (the config library), not code; a browser file you are still tuning belongs on the live layer first.
4. **Rejected** (exit 1): the output has the conflicting files or the failing gate's output. Rebase, fix, submit
   again with the same slug (it replaces the queued entry).
5. **Live** (exit 0): the release id is printed; the work is on dev and in canonical. Check it on dev.1m8.ai. Tell
   the user it is live, with the release id. Done.

Other commands: `submit.mjs status [--mine] [--lane L]`, `submit.mjs wait [<slug>]`, `submit.mjs withdraw [<slug>]`.
Status for anyone: https://dev.1m8.ai/__dev-push/status.json. A lane `paused` with a note means the router needs a
person: tell the user the note, do not work around it.
