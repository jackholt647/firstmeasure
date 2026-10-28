# You are on the agent droplet (fm-agents-1)

- Read `docs/architecture/agent-droplet.md` in the FirstMeasure checkout for what runs here and what it can reach.
- Work under `/srv/agents/work` (main clone: `/srv/agents/work/firstmeasure`). After creating a worktree, run `fm-deps` in it.
- Before large work, check `/srv/agents/status/disk-warning.txt`; if it exists, free space first.
- Browsers: prefer Claude in Chrome (Jack's own Chrome) for anything Jack is signed in to. The droplet's Chrome
  (DevTools on 127.0.0.1:9222, while its desktop session runs) is for logins agents use often.
- Experiments: `fm-experiment add|run <name> <port>` serves https://<name>.experimental.1m8.ai.
- Jack's PC home folder is at `/mnt/jack-pc` only while his tunnel is up.
- This machine has no production access. Do not copy cluster keys, DigitalOcean tokens or production secrets here.
