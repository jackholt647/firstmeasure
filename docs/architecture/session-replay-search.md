# Session replay search

Session replays ([session replay](session-replay.md)) are too many to watch, so they are indexed for questions a
person or a language model asks across many sessions: which sessions used this screen, what people click there and
in what order, what happens after a button, where people struggle. The index is built on the server from the
recordings alone. Apps never mark anything, and the same index works for any release of any app, because identities
come from what the recorded page showed.

## Two layers: searchable index, compressed recordings

- **The index** is small and always searchable: per-session behaviour steps, a catalogue of screens and elements with
  stable ids, day-level aggregates, and full-text over what appeared on screen. Questions about many sessions read the
  index only.
- **The recordings** stay exact and can be compressed as hard as the archive allows (cross-session vocabularies,
  dictionaries). They are opened only to drill into one moment (`replay_screen_at`, the viewer), through
  `readReplayChunks`, which returns the original chunks whether a session is live or archived.

The index is derived and can be rebuilt from the recordings at any time (bump `INDEX_VERSION` and the job re-indexes).

## How a session is indexed

`public/v1/session-replay/insights/` holds the server code. Run by the platform worker's `session-replay-index` job
every minute, and on demand with the `replay_index_now` tool.

1. A session is indexed once it has been quiet for 10 minutes. It is indexed again if more of it was recorded or the
   indexer changed (`staleSessions`).
2. `indexer.ts` replays each page into a **virtual DOM** (`public/libraries/session-replay/session-replay-model.js`).
   That is the player's logic on plain objects, with no browser, loaded through `library.ts` from the browser library
   so a recording is read exactly as the viewer reads it.
3. While walking the events it emits steps:

| Step | What it records |
| --- | --- |
| `screen` | A screen opened: its URL with ids removed (`/portal/?project=:id&projectTab=materials&tab=viewer`) and how long it stayed. |
| `click` | The element a click landed on: its role, name and path, plus any dialog or form it sits in. Also its outcome, the strongest thing that happened within 1.5 s: `error` > `navigated` > `dialog` > `toggled` > `changed` > `focus` > `none`. `none` on a non-field is a **dead click**. |
| `rage` | 3 or more clicks on the same element within 1 s. |
| `input` | One edit of a field: its name (label, `<label for>`, placeholder), number of changes, characters deleted, final length, and whether it was masked. **Never the value.** |
| `key` | Enter, Escape, Tab, shortcuts (printable characters are never recorded). |
| `dialog` | A dialog became visible after the page loaded. |
| `ui_error` | An error message became visible: `role=alert`, `aria-live=assertive`, `aria-invalid`, or an error/danger class. |
| `js_error` | A script error or unhandled rejection. |
| `idle`, `hidden`, `visible`, `end`, `custom` | Pauses of 30 s or more, tab switches, leaving, `FMReplay.track` markers. |

A page's first 2.5 seconds are its load: dialogs and errors the app renders while booting are not counted. Visibility
is judged from markup (the `hidden` attribute, `aria-hidden`, inline `display:none`, hiding classes, a closed
`<dialog>`), because no stylesheet is evaluated.

**Identity.** A screen id is a hash of its id-free URL. An element id is a hash of its role, its name (lower-cased,
numbers replaced by `#`) and its path (generated ids replaced). The same button has the same id in every session and
every organization, so behaviour can be compared across customers.

## Storage

`insights/store.ts`, store `session_replay_insights` (schema version 1):

- `replay_ix_sessions`: one row per session (counts, screens, device, `search_text`). On Postgres `search_text` has a
  GIN index on `to_tsvector('simple', …)`.
- `replay_ix_steps`: the steps, indexed by (organization, element), (organization, screen, kind) and
  (organization, kind).
- `replay_ix_screens`, `replay_ix_targets`: the catalogue (labels, paths, first and last seen).
- `replay_ix_screen_stats`, `replay_ix_target_stats`, `replay_ix_transitions`: per-day aggregates (visits, time,
  clicks, sessions, dead, rage, errors within 3 s of a click, element-to-element transitions with `^` entry and `$`
  exit).

Re-indexing a session subtracts its previous contribution from the aggregates, worked out from its stored steps, then
adds the new one.

## Tools for a language model

`GET /v1/platform/session-replay/insights/tools` returns a guide and JSON-schema tool definitions.
`POST /v1/platform/session-replay/insights/call` with `{tool, input}` runs one. Both are for platform administrators
only (CSRF on the call). The tools are meant for a frontier model working top-down with no data in its context:

| Tool | Answers |
| --- | --- |
| `replay_overview` | Totals for a period, the most used screens, friction counts, and index coverage. |
| `replay_screens` | Which screens exist, how much they are used, and how long people stay. |
| `replay_targets` | What is clicked on a screen, how often and by how many sessions, dead/rage/errors, and what usually comes next. |
| `replay_target` | One element: what clicking it usually did, and where it is used. |
| `replay_next` | What people click right after and right before an element. |
| `replay_flows` | The most common click sequences on a screen, from entry or from one element. |
| `replay_friction` | Rage clicks, dead clicks, clicks followed by errors, error messages and script errors, with example moments. |
| `replay_find_sessions` | Sessions by person, screen, elements clicked (in order), problems, text, or length; `order: random` samples. |
| `replay_search_text` | Sessions in which words appeared on screen, with a snippet. |
| `replay_session_timeline` | One session as readable lines. |
| `replay_screen_at` | What was on screen at a moment: URL, focus, pointer, headings, and an outline with node ids. |
| `replay_link`, `replay_recent_sessions`, `replay_index_now` | Viewer link, newest recordings, and indexing now. |

Outputs are sized for a context window: labels people recognise, ids to follow up with, and example
`(session_id, t)` moments to verify on.

## Access for coding agents

The tools are meant to be driven remotely by a coding agent (Claude Code, Codex, any MCP client), not by a model
built into the product. A platform administrator creates an **access key** in the viewer (Agent access, top left)
and gives it to the agent.

- **MCP:** `POST /v1/platform/session-replay/mcp` with `Authorization: Bearer <key>`. This is Streamable HTTP with
  JSON responses only: no event stream (GET and DELETE answer 405) and no MCP sessions. It handles `initialize` (the
  guide comes back as `instructions`), `ping`, `tools/list` and `tools/call`; notifications get 202.
  - Claude Code: `claude mcp add --transport http firstmate-replay https://dev.1m8.ai/v1/platform/session-replay/mcp --header "Authorization: Bearer <key>"`.
  - Codex: `[mcp_servers.firstmate_replay]` with `url` and `bearer_token_env_var = "FIRSTMATE_REPLAY_KEY"`.
- **Plain HTTP:** the same key on `GET …/insights/tools` and `POST …/insights/call` (no CSRF token, since it is not
  a cookie).
- **What a key opens:** the search tools only. It cannot manage keys, switch recording on, list or play recordings
  through the admin routes, or sign in anywhere. MCP takes keys only, never browser sessions.
- **How keys are kept:** `insights/keys.ts`, table `replay_ix_access_keys`. Keys are `fmrk_` followed by 32 random
  bytes. Only their SHA-256 is stored, the key is shown once, and it expires after 7 days to 1 year. Revoking it in
  the viewer stops it at once. Use is recorded at most once a minute, and every tool call is logged with the key's
  id and name.

## Measured

- **Real sessions (dev, 2026-10-22).** Jack's 60-second portal session (624 events, 866-node snapshot) indexed in
  36 ms into 35 steps across 3 screens and 9 elements. Clicks resolved to "Project", "Reports", "Comms" and the
  Summary, Model, Standard, Customer and Support sub-tabs, and tab clicks resolved to `navigated`.
- **Load test** (`output/session-replay-search-20261022/bench.mts`, SQLite on a laptop). 5,000 synthetic sessions
  (387,000 steps, 24 screens, 400 elements) took 26 ms per session to save. The index was about 31 KB per session
  including SQLite indexes. Overview, screens, targets, next and the timeline answered in 1–30 ms. Friction and
  finding sessions took 90–130 ms. Flows took 250 ms (scan capped at 200,000 steps). Text search took 165 ms on
  SQLite (a LIKE scan; Postgres uses the GIN index).
- **Tests.** `tests/session-replay-insights-browser.test.mjs` records two sessions of a small app through the real
  routes, indexes them, and checks every tool's answer: friction finds the rage and dead "Broken" button and the
  "Project name is required" error after Save; flows start with entry → "New project"; ordered element search,
  problem search and text search find the right sessions; the timeline never contains typed values; and
  `replay_screen_at` shows the error on screen.

## Not built

- Embeddings. Semantic matching is left to the model: it lists screens and element names and chooses. Embeddings over
  element names and screen text would let it search by meaning without listing.
- CSS-aware visibility. Elements hidden only by stylesheets can appear in outlines.
- Deleting a recording does not remove its index rows until the next index sweep finds the session missing (only
  `indexReplaySession` does that, for sessions it is asked to index).
- Scale shortcuts are listed in [the optimization backlog](../optimization-backlog.md): flows scan steps, friction
  scans error steps, and the indexing sweep lists sessions newest first.
