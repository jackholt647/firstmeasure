---
name: dev-push
description: Ship committed code to dev.1m8.ai through the dev push router (the only way to deploy to development). Use whenever work should go to dev, to "roll out", "deploy to dev", "ship", "push to dev", to run regression tests on the server, to check where a submission is, or when a submission was rejected.
---

# Ship to dev

Read `docs/architecture/dev-lanes.md` once. Everything goes through the router; never write rollout scripts, never
SSH to a dev host to stage or activate, never push canonical or a lane branch, never commit a rollout record.

1. **Commit** only your own files on your branch (worktree or clone). Rebase on the lane tip in the router's
   repository (remote `devpush`, added on first submit):
   `git fetch devpush && git rebase devpush/codex/consolidated-firstmeasure-20260923`
   (measure editor: `devpush/lane/measure-internal`).
2. **Submit and wait:**
   ```
   node tools/dev-push/submit.mjs --wait [--title "what changed"] [--regression]
   ```
   The lane comes from the changed paths: `public/measure/internal/**` and `dev/**` are measure-internal,
   everything else platform. Files of both lanes in one commit range are refused: split them. Defaults and
   templates are config (the config library), not code; a browser file you are still tuning belongs on the live
   layer first.
3. **Tests are opt-in.** Without `--regression` only second-scale checks run. Add `--regression` (or run
   `node tools/dev-push/submit.mjs regression --wait` to test without shipping) only when you suspect a bug, when
   Jack asks, or after ~20+ minutes of work. They run once, on the server: do not run suites locally first.
4. **Rejected** (exit 1): the output names the conflicting files or the failing check and what to do next. Fix,
   commit, submit again with the same slug (it replaces the queued entry).
5. **Live** (exit 0): the release id and the stage timings are printed; the work is on dev and in canonical (GitHub
   gets it by a background mirror). Check it on dev.1m8.ai. Tell the user it is live, with the release id.

Other commands: `submit.mjs status [--mine] [--lane L]`, `submit.mjs wait [<slug>]`, `submit.mjs withdraw [<slug>]`.
Status for anyone: https://dev.1m8.ai/__dev-push/status.json. A lane `paused` with a note means the router needs a
person: tell the user the note, do not work around it.
