# Session replay search for coding agents — development, October 22, 2026

Release `177d54dfd75a9e2b1462ca2e9493a8d979c9cacc` (parent `1115fb10`).
[Architecture](../../docs/architecture/session-replay-search.md#access-for-coding-agents).

**What it is.** Jack asked for remote access a coding agent can use, not a model built into the viewer. A platform
administrator creates an access key under **Agent access** in the replay viewer (top left of
`https://dev.1m8.ai/libraries/session-replay/viewer.html`) and gives it to Claude Code, Codex or any MCP client:

- MCP: `POST https://dev.1m8.ai/v1/platform/session-replay/mcp` with `Authorization: Bearer <key>`. This is
  Streamable HTTP with JSON responses only: GET and DELETE answer 405, and there is no event stream and there are no
  sessions. Claude Code connects with `claude mcp add --transport http firstmate-replay
  https://dev.1m8.ai/v1/platform/session-replay/mcp --header "Authorization: Bearer <key>"`. Codex connects with
  `[mcp_servers.firstmate_replay]`, `url` and `bearer_token_env_var = "FIRSTMATE_REPLAY_KEY"`.
- HTTP: the same key on `GET /v1/platform/session-replay/insights/tools` and `POST .../insights/call`.

A key opens the search tools only. It cannot manage keys, switch recording on or reach the replay admin routes, and
MCP takes keys only, never browser sessions. Keys are stored as SHA-256 hashes (table `replay_ix_access_keys`;
store `session_replay_insights` schema version 2), are shown once, expire after 7 days to a year, and can be revoked
at once.

**Tests.** `tests/session-replay-agent-access.test.ts` covers key creation and listing, the bearer paths, the MCP
handshake, tools/list, tools/call, input errors, an unknown method, batches, 401 and 405, browser sessions refused on
MCP, and revoked and expired keys. `tests/session-replay-insights-browser.test.mjs` and
`tests/realtime-single-stream.test.ts` still pass.

**Rollout.**
- Shipped to all four roles, which had settled on `db5f246c` (worker on `d35e275f`), with the search release's
  files unchanged on every role.
- Stage and each activation ran as separate commands.
- The SSH connection to web reset during its activation. On inspection the service had restarted onto this release,
  and it was listening a few seconds later. A check made in that gap saw "connection refused" and a public 502 from
  web's instance; verify passed once it was up.
- Every role reports `177d54df`, and every shipped file equals its payload (`verify-live.py`). Scripts:
  `output/session-replay-agent-20261022/`.

**Checked on dev.** A one-day test key was created on the web host. The official MCP SDK (1.32.1, Streamable HTTP
client) then connected to the dev endpoint as Claude Code would: the handshake succeeded, the guide came back as
instructions, and 14 tools were listed. `replay_overview` answered over all 23 indexed recordings, and
`replay_friction` found the ResizeObserver script error in 6 sessions on the reports screen. An invalid call came
back as a tool error. The test key was then revoked (it now gets 401) and its local copy deleted.
