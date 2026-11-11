# Offline: code, saved data and queued changes on the device

Status: agreed design (2026-11-10), being built on `claude/offline-platform-20261110`.
Development (dev.1m8.ai) only until a production release is authorized.

Read this before changing the service worker, anything in
`public/libraries/platform-offline/`, `public/v1/platform/offline/`, an offline
contract, or how the native hosts store files and upload in the background.

## What it does

1. **The app's code is on the device.** Every browser file the portal needs is
   downloaded as one consistent set per release and served from the device
   when there is no connection. With a connection, pages load from the server
   exactly as before, so they always run the newest release (and, on dev, the
   live layer). A new set downloads in the background and is used from the
   next load; nothing reloads a page by itself.
2. **Data that was seen is saved.** Every JSON read is kept on the device and
   served when the server cannot be reached. A project can be made available
   offline, which downloads everything its apps read.
3. **Changes made without a connection are queued** and sent, in order, when
   the connection returns. A change is sent at most once in effect
   (idempotency keys), survives closing the page, and is shown in the app
   while it waits.
4. **Photos and files** are kept in private app storage (never the camera roll
   unless the person turns that on), queued, uploaded, and then removed. A
   rolling cache keeps thumbnails.
5. **The same engine runs in a browser and in the native app.** The native
   hosts add what only an app can do: uploads that finish after the app is
   closed, and saving a copy to the camera roll.

## Rules

- **One interception point: the service worker.** Twenty-four `*-api`
  libraries and many apps call `fetch` themselves, so no page library sees
  every request. Offline behaviour is added in the service worker and in
  contracts, never by wrapping `fetch` in an app or adding a second cache.
- **A write is queued only if a contract says how.** A contract names the
  route, what the app gets back while it waits, what the queued change does to
  saved reads, and what happens on a conflict. A write without a contract
  fails offline with the error `offline_unavailable`; it is never silently
  dropped and never reported as saved.
- **Ids are made on the device.** A record created offline uses the id the
  client generated (almost every create route already accepts one). Do not add
  a create route that only the server can name.
- **A queued change is replayed with its idempotency key** and the server
  answers a repeat with the first answer (`platform/offline/idempotency.ts`).
  Do not add per-route duplicate checks for the queue's sake.
- **Nothing is recorded as saved until the server said so.** The app shows a
  queued change as waiting; the queue entry is removed only on a 2xx answer.
- **Offline data belongs to one person in one organization.** Saved reads,
  the queue and files are keyed by user and organization, are never shown to
  or replayed for another identity, and saved reads are removed at sign-out.
- **Online behaviour does not change.** With a connection the service worker
  passes requests through; it only answers from the device when the network
  failed or did not answer in time. The realtime stream is never intercepted.
- **No page reloads by itself** (the Refresh pill rule applies to new code
  sets too).
- An optimization of the engine must return exactly the same results; record
  known shortcuts in [the optimization backlog](../optimization-backlog.md).

## Parts

| Part | Where | Runs in |
|---|---|---|
| Service worker | `public/portal/sw.js` (scope `/portal/`) | worker |
| Engine (store, contracts, queue, overlays, replay, merge) | `public/libraries/platform-offline/offline-core.js` | worker and page (classic script, no imports, attaches `FMOffline`) |
| Contracts | `public/libraries/platform-offline/contracts/*.js`, listed in `contracts/index.js` | worker and page |
| Page API | `public/libraries/platform-offline/platform-offline.js` (`window.PlatformOffline`) | page |
| UI (indicator, sync tray, conflicts, settings) | `public/libraries/platform-offline/offline-ui.js` | page |
| Native hand-off (durable files, background upload) | `public/libraries/platform-offline/native-uploads.js` + bridge methods in `phone-features.js` | page |
| Server | `public/v1/platform/offline/` (`idempotency.ts`, `assets.ts`, `api.ts`) | Node |
| Native hosts | `native/firstmate/android`, `native/firstmate/ios` | app |

The service worker loads the engine and contracts with `importScripts`, and
the registration uses `updateViaCache: 'none'` so a changed engine or contract
file is picked up at the next update check. `contracts/index.js` sets
`self.FM_OFFLINE_CONTRACTS`, the contract file names in load order; a contract
file that fails to load is skipped and the rest still work.

Only the top-level page registers the worker and replays the queue; project
window frames use the same `PlatformOffline` and the same worker. The
top-level page loads the engine and the contracts itself, when it first
replays, with `fetch(..., { cache: 'no-cache' })` so it runs the server's
current copy (the set's copy without a connection). The worker reports the
engine's `FMOffline.version`; a page whose copy differs loads it again and
does not replay until they match.

## Code on the device

### Asset manifest

`GET /v1/platform/offline/assets` (public: a list of static file paths and
hashes) answers

```json
{ "enabled": true, "release": "<release id>", "generated_at": "...",
  "files": { "/libraries/platform-api/platform-api.js": ["<sha256>", 12345], "...": ["...", 0] },
  "shells": ["/portal/"],
  "external": ["https://cdnjs.cloudflare.com/.../all.min.css"] }
```

- `release` is the name of the release the web node is serving (the same value
  as `servedRelease()` in `platform/live_assets.ts`); a browser-only release
  that keeps the Node process changes it. The files are read through the same
  `current` link NGINX serves from, never from the release Node started in,
  so the list and the files always belong together; a production release that
  skips the Node restart is picked up the same way
  (`release-node-fingerprint.py` lists the reader, with nothing for Node to
  keep). While a rollout moves from one web
  node to the next, two nodes can name different releases for a moment; each
  file's hash is still checked by the device.
- `files` is every browser file an offline portal can need, as
  `[sha256, bytes]`, chosen by `ASSET_RULES` in `platform/offline/assets.ts`
  (the include and exclude lists are data, in that one place):

  | In the set | |
  |---|---|
  | `/libraries/**` | every library and app bundle |
  | `/portal/scripts/**`, `/portal/mobile/**` | the portal's own scripts and the mobile shell's script and style |
  | `/portal/landing/shared/**` | the signup widget the portal page loads |
  | `/portal/signup-sandbox/**`, `/portal/media/**`, `/portal/manifest.webmanifest` | sandbox bar, sample images, the web app manifest |
  | `/fonts.css`, `/fonts/**`, `/images/**`, `/favicon.ico` | fonts and images |

  | Left out | Why | Size on 2026-11-10 |
  |---|---|---|
  | language catalogs the catalog manifest no longer names | older hashed files stay on disk; only `manifest.json` and the files it names are current | 406 files, 77.2 MB |
  | `/libraries/calls-runtime/effects/**` | call background effects (WASM and models); a call needs a connection | 12 files, 34.5 MB |
  | `*-sample.json` under `/libraries` | the report settings preview's sample report | 3.2 MB |
  | `.php` | server pages; a person's shell is saved by the service worker | |
  | `.md`, `.txt`, licences, `.map`, `package.json`, `package-lock.json` | not browser files | 0.5 MB |
  | `.html`, `/libraries/apps/smoke/**` | development previews, embed pages and smoke pages; no portal page needs one offline | 0.3 MB |
  | `.eot` | a font format no supported browser asks for | |
  | everything else under `/portal/` (landing and marketing pages, samples), `/measure/`, `/v1/` | not included in the first place | |

  Measured on 2026-11-10: **547 files, 40.2 MB** (42,112,314 bytes); the
  manifest itself is 68 KB. The budget is 60 MB (`ASSET_BUDGET_BYTES`):
  `tests/offline-assets.test.ts` fails over it, and the route logs a warning
  and still answers. A file left out is not broken online: the worker does not
  answer for it, so it loads from the network as before.
- `shells` is `["/portal/"]`.
- `external` is the other-origin stylesheets and scripts
  `public/portal/index.php` needs to render: the Font Awesome stylesheet, the
  four font files it loads (and their folder as a prefix, `.../webfonts/*`,
  for any other format a browser asks for), three.js, OrbitControls and
  geotiff. Analytics,
  pixels and Google Maps are never listed (`externalLeftOut`). The test fails
  when the page gains an outside file that is in neither list.
  An entry that ends with `*` is a prefix: files under it are cached when
  first used. External files are best effort and never hold a set back.
- The list is computed once per release per process (hashing the set takes
  about a third of a second; see
  [the backlog](../optimization-backlog.md#the-offline-asset-manifest-hashes-every-file-once-per-release-in-every-process))
  and answered with a weak `ETag` and `Cache-Control: private, no-cache`, so a
  check that finds nothing new is a `304` with no body. A checkout without a
  release link (a developer's machine) is checked by file size and time on
  every request instead, because its files change in place.
- `enabled: false` is the kill switch: the service worker removes its caches
  (`fm-*`) and saved reads and unregisters, and pages stop registering it.
  Queued changes are never removed by it. The top-level page reads the
  manifest itself on every load and check: it registers the worker only when
  the manifest names a release, and on `enabled: false` it unregisters the
  worker and deletes the caches from the page, so the switch works even when
  the worker cannot run. When the manifest cannot be reached an installed
  worker stays as it is. Two switches, either of which turns it off
  (`platform/offline/switch.ts`):
  - `OFFLINE_ENABLED=0` on a host: off for everyone that host serves.
  - the `platform.offline` [flag](feature-flags.md), an organization switch
    like any other: the flag console turns it on or off for one organization,
    by percentage, or **Off for everyone**, which every web process reads
    within 15 seconds and needs no release. Its default is data
    (`capability_defaults/platform` in the config library) and is off until
    that entry names it: development's entry gets `"platform.offline": true`
    once this is released there (`tools/config-library/cli.mjs`: `get`, add
    the value, `put`), production's does not name it. It does not
    need expanded access: offline is how the app runs, not an app, so an
    account that only orders reports gets it too.

  The route is public; when the request carries a session, `enabled` is that
  person's organization's flag. A request without a session (a device whose
  session ran out still checks for updates) is answered `true` unless the
  flag is Off for everyone, so that device keeps its code and its queued
  changes until someone signs in. The `ETag` covers `enabled`, so a device
  holding an old tag still hears a switch.

### Sets

A **set** is one release's files plus the person's shells, in the cache
`fm-set-<release>`. The service worker:

1. fetches the manifest when a page loads, when a page asks
   (`PlatformOffline.checkForUpdate()`, also called on the dev `release`
   realtime event) and every 30 minutes while a page is open;
2. for a new release, creates the new cache, copies every file whose hash is
   unchanged from the active set and downloads the rest (`cache: 'no-store'`,
   six at a time), checking each body's sha256 against the manifest. A file
   whose bytes differ is retried once; a response marked `X-FirstMate-Live: 1`
   (the dev live layer) is accepted as served;
3. fetches each shell with the person's session and stores the HTML;
4. only when every file and shell is stored, records the set as active in the
   `meta` store and deletes sets other than the active and the previous one.

A set that cannot be completed (connection lost, session expired) leaves the
active set as it is and is resumed at the next check. Requests match set
entries by path only: `?v=` values are ignored, because the same file is
requested under several of them.

- The page fetches the manifest and hands it to the worker with the check;
  the worker fetches it itself when it is given none. Checks run one after
  another, so a later manifest is never answered by an earlier check.
- Each stored file carries the sha256 of its bytes. Resuming skips every file
  the new cache already holds with the listed hash; three network failures
  in a row end the attempt until the next check.
- A shell belongs to one person: the worker stores a page as a shell only
  when it is a 200 HTML answer with `X-FirstMate-Identity` (whose page it is)
  and, where `X-FirstMate-Release` is sent, the set's release. A login
  redirect or an error page never qualifies, so a set does not become active
  without a signed-in session. At a check of the active set the worker
  fetches any shell the person signed in now does not have yet.
- Sets a page still runs from (offline mode, below) are kept beside the
  active and the previous one.

### Serving

| Request | With a connection | Without |
|---|---|---|
| Navigation to a shell (`/portal/`, `/portal/index.php`, `/portal/mobile/`, with any query) | network; the answer replaces the stored shell when it is a 200 for the release of the active set (`X-FirstMate-Release` header) | the stored shell, when someone is signed in on this device; otherwise the built-in "connect once" page |
| File in the set | network, falling back to the set if the request fails | the set first, then the network |
| Listed external file (fonts, icon CSS) | cache, refreshed in the background | cache |
| Anything else | not answered by the worker | - |

A navigation waits for the network 8 seconds (3.5 seconds when the last
request failed) before the stored shell is used; with nothing stored it keeps
waiting for the network. Any HTTP answer is an answer: a 503 from the server
is shown, not replaced. A page that was served from the set is in **offline
mode** for its lifetime: its files come from the set without waiting for the
network. Which pages are in offline mode is kept in the `meta` store by
client id, so it survives the worker being stopped; a frame opened by such a
page (a project window) is served from the same set.

`index.php` and `mobile/index.php` send two headers (`portal/offline-shell.php`)
and load `platform-offline.js` first, right after `window.__APP`:

- `X-FirstMate-Release`: the release the page was rendered from, the name the
  manifest reports. While a release is being switched a page still rendered
  by the previous release names that one. Not sent from a local checkout.
- `X-FirstMate-Identity`: `<user id>/<organization id>`, each URL-encoded.

The shell is the server-rendered page as that person last received it, so its
user data, feature gates and script list are theirs. There is one shell per
path and person: PHP renders the same page for `?projectWindow=`, `?tab=` and
every query the browser code reads. A navigation whose query changes what PHP
renders (`project`, `projectTab`, `photoScope`, `onboarding`, `paid`,
`tutorial`) is served but does not replace the shell.

The built-in "connect once" page (status 503) uses the language keys
`platform-offline.connect_once_title`, `_body` and `_retry`, which the page
sends the worker once the catalog is loaded; its button is the only reload,
and a person presses it.

## Saved reads

Every same-origin `GET` under `/v1/` that answers JSON is saved, unless a
contract's deny list names it (`FMOffline.contracts.deny`: auth, the realtime
stream and poll, payments checkout and processor data, session replay,
assistant streams). A read made with `POST` is saved only when a contract
declares it (`reads`: `portal-action` read actions, the FirstMeasure order
list, publication `data/read`, `data/list`, `widgets/resolve`, assignable
subjects, feed sources, a project's requirements, a document's resolve),
keyed by the body fields the contract names. Each such route was read in the
server to change nothing; `tests/offline-contracts.test.ts` keeps the list
and fails on a route outside it. Portal actions that write when they are
read (`portal_bonus_upfront_match_status`, `portal_customer_referral_status`)
and `auth_status` are not declared.

- **The session read** (`GET /v1/platform/auth/session`) is on the deny list
  and is never saved. Without a connection `PlatformAPI.auth.session()`
  falls back to the person's saved profile (`GET /v1/platform/me`, the same
  fields), so a page that runs from the device shows the apps and
  permissions they last had. Any HTTP answer is still final.

- **Whose read it is.** A request is saved, answered or queued under the
  identity its own page declared (the worker keeps identity per client id).
  A request from a page that has not said who is signed in is not answered
  by the worker at all.
- **Network first.** The saved answer is used only when the request fails or
  does not answer within 8 seconds (1.5 seconds when the last request
  failed); the network answer still updates the saved copy when it arrives.
  Any answer restores the long wait. An answer served from the device has
  `X-FM-Offline: saved` and `X-FM-Saved-At`. Only a 200 JSON answer of at
  most 20 MB is saved; requests with `Accept: text/event-stream` or a `Range`
  header are not answered.
- **Key.** `METHOD path?query`: the origin is dropped, cache-buster
  parameters (`_`, `_t`, `_ts`, `_cb`, `cb`, `cachebust`, `cache_bust`,
  `nocache`) are removed, and the rest are sorted by name, values of one name
  keeping their order. A declared `POST` read adds the read's id and the
  contract's `key(ctx)` as JSON with sorted keys.
- **Store.** IndexedDB database `fm-offline-v1`, store `responses`, key
  `[user, org, key]`, with size and last-used time. Default budget 150 MB,
  least recently used first; a pinned project's reads and the boot reads
  (routes a contract lists under `boot`) are never evicted. The budget is
  checked after each megabyte written and eviction stops at 90% of it; last
  use is recorded at most once an hour per read.
- **Media files** (`/media/:id/file?variant=`) are kept in the cache
  `fm-media-v1` and served from it first (a variant never changes; a markup
  variant carries its revision). Thumbnails (a variant that starts with
  `thumb`) are always kept; other variants only up to 8 MB each: a file that
  announces a larger length is not copied, and one of unknown length is read
  only up to the limit. Files are kept per person (cache key
  `/.fm-media/<user>/<org>/...`, index in the `media` store). Default budget
  300 MB, least recently used first, pinned projects exempt. The server says how long each answer may be kept
  (`mediaFileCaching` in `platform/media_variants.ts`), always `private`,
  always with an `ETag`, and only after the same access checks as before
  (a `304` is never sent to someone who may not read the file):

  | Request | `Cache-Control` |
  |---|---|
  | a rendition (`thumb_320`, `display_2400`, ...): made once, at upload | `private, max-age=31536000, immutable` |
  | a markup thumbnail with its revision in the URL (`thumb_320_markup&v=<markup revision>`) | the same |
  | a markup thumbnail without `v`, or with any other value (the photo feed sends a timestamp) | `private, no-cache` |
  | the original (`variant=original` or none) | `private, no-cache` |
  | any variant of a slot record (a logo, an avatar: `replace_slot` makes the id from the slot) | `private, no-cache` |
  | a receipt | `private, no-store`, as before |

  `no-cache` answers are asked about every time and cost a `304` when
  nothing changed; the tag follows the bytes (a new upload under the id, a
  markup thumbnail rendered again), not a rename or a tag. The original is
  never `immutable` because a later upload naming the same id replaces the
  record. That also replaces its renditions, which a browser that already
  kept them will not ask about again: nothing does this today (an upload
  makes a new id, a slot upload is never kept, and an offline retry sends the
  same file), and a feature that replaces a picture in place must give it a
  new id. An error answer carries neither header. So the worker serves from
  its media cache first only what was answered `immutable`; anything answered
  `no-cache` (an avatar, a logo, an original) goes to the network first and
  falls back to the cache. On the Postgres store a markup thumbnail is not
  rendered (the plain thumbnail is served in its place), so it is always
  `no-cache` there.
  `FMOffline.media.put(identity, url, blob, { fixed })` keeps a file the
  device made under a media URL (the small copy of a queued photo): served
  from the device first like a rendition, or with `fixed: false` only when
  the server cannot be reached.
- **Pinned projects.** `PlatformOffline.pinProject(org, project)` runs every
  contract's `prefetch` for that project (the project, its lists, its
  documents, its thumbnails) and repeats it when the connection returns and
  every 15 minutes while a page is open. The ten most recently opened
  projects are pinned automatically (setting `autoPinRecent`): the app calls
  `pinProject(org, project, { auto: true })` when a project is opened, and
  the oldest automatic pins beyond ten are let go. A pin the person made is
  never dropped for them. A read that cannot be fetched during a refresh
  stays pinned from the last time.
- **Budgets** are the device settings `readsBudgetMb` and `mediaBudgetMb`.

There is no change feed yet: a refresh re-reads the pinned set
(see [the backlog](../optimization-backlog.md#pinned-offline-projects-are-refreshed-by-reading-everything-again)).

## Queued changes

### Contracts

A contract file registers what an app can do offline:

```js
FMOffline.contracts.add({
  id: 'project.notes',
  deny: [],                                   // routes the worker never saves, answers or queues
  boot: [],                                   // GET patterns of boot reads, never evicted
  reads: [ /* POST reads: { id, match, when(ctx), key(ctx) } */ ],
  prefetch: [ /* (ctx:{org,project,user}) => urls, or { url, each(json, ctx) => urls } */ ],
  writes: [{
    id: 'notes.post',
    match: 'POST /v1/channels/organizations/:org/channels/:channel/messages',
    when: (ctx) => true,                      // optional: for routes that carry several actions
    kind: 'create',                           // create | action | patch | upload | delete
    scope: (ctx) => `project:${ctx.body.project_id}`,   // entries of one scope replay in order
    label: (ctx) => ({ title: 'Note', detail: ctx.body.text.slice(0, 80) }),
    records: (ctx) => [ctx.body.client_msg_id],         // ids apps can ask "is this waiting?"
    prepare: (ctx) => ctx.body,               // optional: fill device-made ids before sending
    respond: (ctx) => ({ ok: true, message: { /* what the route would answer */ } }),
    effects: (ctx) => [{ match: 'GET /v1/channels/organizations/:org/channels/:channel/messages',
                         when: (m) => m.channel === ctx.params.channel,
                         apply: (json) => ({ ...json, messages: [...json.messages, ctx.response.message] }) },
                       // a read nothing was saved for: what a record made on this device answers
                       { match: 'GET /v1/things/:id', when: (m) => m.id === ctx.body.id, seed: () => ({ ok: true, thing: ctx.response.thing }) }],
    // optional: a refusal that means the server already has this change (answer is { status, code, body })
    duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'thing_exists',
    // kind 'upload' only, optional: which media ids the form's files stand for
    media: (ctx) => [{ id: ctx.body.id, field: 'file' }],
    // kind 'patch' only:
    conflict: { current: (ctx) => url, pick: (json) => ({ doc, revision }),
                fields: (ctx) => ['title', 'address'], send: (ctx, merged, revision) => body }
  }]
});
```

`ctx` is `{ method, url, params, query, body, headers, user, org, now, id,
response, base, saved(url), find(pattern), queued(record) }`: `url` is the
path and query, `body` is the parsed JSON or the form fields (files as
`{ name, type, size, blob }`), `headers` has lower-case names, `id` is the
entry's idempotency key, `response` is what `respond` returned, `saved(url)`
resolves the saved answer of a `GET` as the person would see it (earlier
queued changes applied) or `null`. Contract functions are pure and may be
async; they run in the worker, and in the top-level page when it replays.

- `base` is, for a queued `patch`, the record as it was when the change was
  made (what `conflict.pick` gave), else `null`. An effect uses it to merge
  the change over a newer answer instead of replacing whole lists.
- `find(pattern)` resolves every saved `GET` of a route as
  `[{ url, query, params, json }]`, for a record that is only known from
  lists, whatever their filters were (a to-do).
- `queued(record)` resolves the earlier changes still on the device that name
  a record, as `[{ id, contract, write, kind, scope, state }]`. A change to a
  record that was made on this device takes the scope of the change that
  made it, so it is sent after it.
- **Seeds.** An effect may carry `seed` (a value or a function) instead of, or
  beside, `apply`. A read that has no saved answer is then answered from the
  first queued change that seeds it, with later changes applied on top
  (`X-FM-Offline: queued`). The same happens when the server answers `404`
  while that change still waits. This is how a project made without a
  connection opens: nothing was ever saved for its reads. A seeded answer is
  never stored as a saved read.
- **Duplicates.** `duplicate(ctx, answer)` names the refusal that means the
  server already has the change (`project_exists`, `contact_exists` for an
  id the device made: the first try arrived and its answer was lost). The
  entry is then done, as after a 2xx, and `synced` has `response: null`.
- **POST reads of a pinned project.** A `prefetch` entry may name a read made
  with `POST` as `{ url, body }`. It is sent only when a contract declares
  that route and body as a read, with the CSRF token, and saved under that
  read's key. In the worker the token comes from the Cookie Store API; where
  that is missing these reads are saved when the tab is first opened instead.
- `conflict.pick(json, ctx)` also gets `ctx`, for a record that is one item
  of a larger answer (one event of a project).

- **Patterns** are `[METHOD ]/path`: `:name` and `*` match one segment, `**`
  any number. A `deny` pattern without a method covers every method;
  `FMOffline.contracts.deny(...patterns)` adds some outside a contract.
- The first write whose route and `when(ctx)` match is used, then the first
  read. An effect's `when(m, read)` gets the read's route parameters and
  `read = { method, path, url, query, body, key }`.
- Without `scope` the scope is `default`. Without `media`, an `upload`'s
  first file stands for `records(ctx)[0]`. Without `conflict.fields`, the
  body's keys; `conflict.mine(ctx, base)` may build the person's document
  when the body is not a plain set of fields.
- A contract function that throws while a request is handled makes that
  request behave as if there were no contract. An effect that throws is
  skipped; it never breaks a read.

A contract's routes are checked against the server's registered routes by
`tests/offline-contracts.test.ts`.

### Queueing

For a request that matches a write contract the service worker

1. adds `Idempotency-Key: fmo1-<uuid>` and `X-FM-Offline-User`,
   `X-FM-Offline-Org`;
2. sends it, unless the device is known to be offline or the same scope
   already has entries waiting (order is kept);
3. on a network failure (no answer; an HTTP error is an answer) stores the
   entry in the `outbox` store with its body (form files in the `blobs`
   store) and answers the page with `respond(ctx)`, status 200, header
   `X-FM-Offline-Queued: <id>`.

A write that matches no contract and fails on the network is answered
`503 { ok: false, error: "offline_unavailable" }`.

- "Known to be offline" is `navigator.onLine === false`. A scope has entries
  waiting while one of its entries is `waiting` or `delegated`, or is a
  failed or parked `create`.
- An `Idempotency-Key` the app sent is kept when it starts with `fmo1-`.
- An entry keeps the request's headers except cookies, the CSRF token and
  the multipart boundary; those are set again when it is sent.
- An entry is `waiting`, `delegated`, `failed`, `parked` or `conflict`.
- A change that cannot be stored is answered `507 offline_storage_full`
  (no room) or `503 offline_unavailable`; an answer the worker made itself
  has `X-FM-Offline` (`saved`, `queued`, `set`, `shell`, `unavailable`,
  `storage-full`, `connect-once`).
- A page aborting its request is never a reason to queue it.

### Replay

`FMOffline.replay.run()` sends entries oldest first per scope, scopes in
parallel (three at a time). It runs in the top-level page under the Web Lock
`fm-offline-replay` (one tab at a time), started when the connection returns,
when an entry is queued while online, and every 20 seconds while entries
wait; the worker also runs it on a Background Sync event where the browser
has one. Replayed requests carry `X-FM-Offline-Replay: 1` and are passed
through by the worker.

| Answer | What happens |
|---|---|
| 2xx | entry removed, its effects dropped, the reads it affected re-read, `synced` event with the real answer |
| no answer | stays queued; retried after 2 s, 5 s, 15 s, 1 min, then every 5 min |
| 401, or 403 `csrf_required` after one retry with a fresh token | the queue pauses (`blocked: sign-in`) until the same person signs in |
| 409 `offline_identity_mismatch` | parked; never sent under another identity |
| 409 `idempotency_in_progress` | retried after 2 s |
| 409 on a `patch` entry | three-way merge (below); unresolved → `conflict` |
| a refusal the contract names as a duplicate (`duplicate`) | done: the server already has it |
| a refusal the contract answers with another body (`resend`) | sent again once under a new key |
| other 4xx | `failed`, waits for the person (retry or discard) |
| 5xx | retried like no answer, eight times, then `failed` |

A failed `create` holds the rest of its scope (later entries need the record);
other failures do not.

- **The lock** is held for one run: until no entry is due. Entries in
  backoff wait for a later run and the lock is free in between, so another
  tab can take over when this one closes. A browser without Web Locks runs
  without one; the idempotency keys keep that safe.
- **No answer stops the run**: what was not already on its way is not sent
  into a dead connection. `PlatformOffline.syncNow()` and the browser's
  `online` event send entries that wait in backoff at once; `syncNow()` also
  lifts a sign-in pause. A sync that was asked for runs after one already on
  its way, never instead of it.
- **CSRF.** The token is never stored with an entry. A page reads the
  readable cookie when a run starts, and again for the one retry after
  `csrf_required`. For Background Sync the page tells the worker the cookie's
  name with its identity and the worker reads it with the Cookie Store API;
  where that API is missing the worker does not replay and the queue waits
  for a page.
- **Keys.** An entry is sent under the key it was queued with. Three cases
  get a new `fmo1-` key, because the server keeps the first answer for a key
  and a body: a merged `patch` body the server has not seen, a retry by the
  person after a 4xx, a parked entry when it is sent again, and a 401 or
  `csrf_required` that came back as a stored answer
  (`Idempotency-Replayed`). In each the first request did not run. The
  server should not store 401 or `csrf_required` answers as receipts.
- **Sign-in pause and parked entries** are lifted when a page of the same
  person loads (its identity message): PHP rendered it, so they are signed
  in.
- **Re-reads.** After a 2xx the saved reads the entry's effects match are
  read again, at most 25 per entry; the rest are refreshed the next time
  they are read online.
- A `patch` whose merge leaves nothing to change (the first send arrived but
  its answer was lost) is removed without a request; `synced` then has
  `response: null`. After three repeated merges a 409 waits like no answer.
- **Native hand-off.** `FMOffline.queue.delegate(id, info)` marks an entry
  `delegated`; its scope waits. `FMOffline.replay.report(id, response)`
  applies the host's answer (a `Response`, or `null` for none) by the table
  above. `FMOffline.configure({ external: (entry) => boolean })` names
  waiting entries something else will send (the app's uploader, before it
  has marked them): replay never sends one, and its scope waits. See
  [Native hand-off](#native-hand-off).

### Overlays

While an entry is waiting, failed or in conflict, its `effects` are applied to
every matching read the worker answers, saved or fresh, so a queued note is in
the notes list on every load until the server has it.

### Conflicts

A `patch` entry keeps the document as it was when the change was made
(`base`). On replay the engine reads the current document and merges field by
field (`FMOffline.merge3(base, mine, theirs)`): a field only one side changed
takes that side; objects merge by key; arrays whose items have ids merge by
id; anything else changed on both sides differently is a conflict. A clean
merge is sent with `expected_revision`; a 409 repeats the merge (three
times). A conflict waits in the sync tray, where the person keeps theirs or
the server's value per field. Additive changes (`create`, `action`, `upload`)
never conflict.

- `merge3` returns `{ value, conflicts: [{ path, base, mine, theirs }] }`.
  Paths look like `title`, `address.city` and `items.#12.qty` (`#12` is the
  item with id 12); two different reorders of one list conflict at
  `items.#order`. Until it is settled a conflict's `value` is mine.
- `PlatformOffline.resolve(id, choices)` takes `{ '<path>': 'mine' |
  'theirs' }` for every path the conflict lists; the entry is then merged
  with the server's document as it is at that moment and sent.
- `base` is what `conflict.pick` returns for `ctx.saved(conflict.current)`
  when the change is made, so a second offline edit of a record starts from
  the first. Where the record was never saved there is no base: the person's
  values are sent with the server's current revision.

## Photos and files

A photo taken or chosen without a connection is kept in the device's private storage (the `blobs` store; in the
app, also the host's private folder), shown in the project at once, uploaded when a connection returns, and then
removed from the device. A small copy stays in the rolling media cache. The contract is
`contracts/media.js`; the page side is `media.upload` and `projectMedia.uploadMedia` in `platform-api.js`, the
project Photos tab (`apps/photos/project.js`), the Feed (`apps/photos/feed.js`) and the camera
(`camera-capture/camera-capture.js`).

### What is queued

| Change | Route | Kind | Scope |
|---|---|---|---|
| a project's photo or video | `POST .../media` (owner `project`, slot `photos`, with the id the device made) | `upload` | `project:<id>` |
| a photo with no project yet (the Feed camera) | the same route, owner `organization`, slot `photos` | `upload` | `user:<id>` |
| the project's photo list: add, trash, restore, remove | `POST .../projects/:project/photos` | `patch` | `project:<id>` |
| pairing photos with a project | `POST .../media/assign` | `action` | `user:<id>` |

- A project photo is two entries, the upload and then the list save. Both are in the project's scope, so they
  follow the project's own create when that still waits. A photo with no project and its pairing are in the
  person's scope, so the pairing follows the upload. Pairing with a project that itself still waits to be created
  is refused by the server (404) and waits for the person to send it again.
- **Not queued**, answered `offline_unavailable`:
  - an upload that replaces a slot (a logo, an avatar): the server names it by its slot;
  - every other upload (contact media, note and message attachments, documents, receipts, FirstMeasure order
    reference photos): each is followed by a write of its own app in another scope, which would have to wait
    behind the file. Add them to that app's contract together with that write;
  - renaming and tagging (`PATCH .../media/:id`). The route replaces the whole name or tag list with the device's
    copy and has no revision, so a replay hours later would undo a newer edit; and the request names only the
    media id, so the scope of a photo that still waits cannot be told from it and the change could be sent
    before its upload. Both need a connection.
  - A video, a PDF or another file in a project's `photos` slot is queued like a photo, within the limits below.

### Ids and the time a photo was taken

- `media.upload` sends an `id` it makes (`media_` and 16 hex digits, the server's own format) unless the upload
  replaces a slot. The id belongs to the file and its owner: the same file sent again to the same owner (a
  retry) carries the same id and the server replaces the record instead of adding one; the same file sent to
  another owner gets another id, because the server refuses an id that another owner holds (`409
  media_id_taken`). A caller's own `id` is sent as given.
- A picture or video carries `metadata.taken_at`: the camera's shot time, or the file's own time
  (`lastModified`) for a chosen file. `metadata.uploaded_at` is when the app sent it to be uploaded and the
  record's `created_at` is when it arrived. The server stores `taken_at` as sent; the project's photo list entry
  carries it too.
- Lists sort and show by `taken_at` where there is one (the gallery and the Feed through `photoTakenAt` in
  `feed.js`, the viewer through `uploader()` in `firstmate-markup.js`), so a photo that waited is listed under
  the day it was taken, and so is an older picture chosen from the device today. A Feed post's time and the
  five-minute grouping of posts still follow `uploaded_at`.

### While a photo waits

- The worker answers the record the route would answer for a new upload (`respond`): the same fields, with the
  variants the server will make. The worker reads the picture's size to know them (thumbnails only for a
  picture of 1024 px or more); where it cannot decode the file it takes a photo to be large.
- The worker answers that media id's file URLs (any variant, and `Range` requests) from the stored file. A
  thumbnail URL is answered from the small copy (below) once it is there, so a grid of waiting photos does not
  decode full-size files.
- Its effects put the record into the media lists (`GET .../media`, by the read's own filters) and the Feed's
  catalog, and the list save's effects put the photo into the project (`GET .../projects/:id` and the project
  in `GET .../projects`), so a page opened later without a connection shows it.
- `PlatformOffline.isPending(<media id>)` is true while the upload or the list save that added it waits. A
  gallery tile of such a photo has a slot (`data-offline-wait="<media id>"`) that is filled with
  `PlatformOfflineUI.waitingBadge({ record })`, or with a plain mark where the offline UI is not loaded.

### The list save is merged when it is sent

The page sends the whole photo list as it has it. Sent hours later as it was, that copy would undo what someone
else did to another photo meanwhile. So the list save is a `patch`: when it is sent, the list is merged photo by
photo with the server's list as it is then (`merge3`, by photo identity). What only this change touched is
applied, what only the server changed is kept, a photo is removed only when this change removed it and nobody
changed it since, and the same field of the same photo changed on both sides is a conflict in the sync list. A
save the server already has is not sent again. Each list save reads the project once before it is sent
([backlog](../optimization-backlog.md#each-waiting-photo-reads-the-project-again-before-its-list-save-is-sent)).

A replayed list save (`X-FM-Offline-Replay: 1`) never adds a photo whose media record does not exist
(`mergeProjectPhotos`, `uploadedOnly`): an upload that was refused or discarded on the device does not leave an
entry without a file.

### After it is uploaded

- The entry and its file are removed from the device.
- **The small copy.** When an upload is queued, the page makes a JPEG of at most 640 px on its longer side
  (`PlatformAPI.media.smallImageCopy`, drawn with the picture's EXIF orientation) and keeps it under the
  thumbnail URLs browser code asks for, `thumb_320` and `thumb_640`
  (`PlatformOffline.media.put(url, blob)`, which is `FMOffline.media.put` in the top-level page; a frame asks
  its top-level page). After the upload those URLs are answered from the device, so the picture is not
  downloaded again. The copy is a media cache file like any other: least recently used copies go when the
  budget (`mediaBudgetMb`) is reached.
- A picture the server makes no thumbnails for (under 1024 px, a GIF, an SVG) is shown from its original, so
  the file itself is kept (up to 8 MB) under `variant=original`, with `fixed: false`: asked from the server
  when there is a connection, answered from the device when there is not.
- A video has no small copy.

### In the apps

- **Photos tab.** A photo added without a connection replaces its placeholder with the record under its own
  id, drawn from the stored file. When the upload arrives the record takes the server's values and the tile
  keeps its picture: nothing is drawn again unless the tile would ask for a different file. There is no
  "local preview" that never uploads: a refused upload is removed and the person is told why. Deleting a
  waiting photo discards its upload and its list save (`PlatformOffline.discard`) instead of moving a record
  the server never had to the trash; an upload discarded from the sync list leaves the gallery and the list.
  The whole-project save that follows an upload is skipped while its photos wait.
- **Camera.** An entry is `pending`, `uploading`, `waiting` (kept on the device: a cloud mark, no Retry),
  `done` or `failed`. The queue is the one record of a waiting photo; its tile follows the queue's `synced`,
  `failed` and `discarded` events. Retry is shown only for a refused photo: `PlatformOffline.retry` for one the
  queue holds, a new upload of the same file (the same id) for one that never got there. Done does not wait
  for uploads while there is no connection.
- **Feed.** The phone camera's photos wait with no project and are listed under Unassigned; the "Add to a
  project?" step works with their ids, and its pairing waits behind them.

### Free space

Free space is checked before a file is queued (`navigator.storage`): the browser must report room for the files
plus 10 MB. With less the write is answered `507 { ok: false, error: "offline_storage_full" }` and nothing is
queued; `media.upload` then rejects with `code: 'offline_storage_full'` and words a person can act on (connect so
the waiting photos can upload, or lower the picture storage in the offline settings). A change without a file is
always queued.

### Limits

- One file has to fit in what the browser still allows the site, less 10 MB (`state().storage`: `quota` and
  `usage`). There is no limit on how many wait; each waiting project photo is two entries.
- The server takes an upload of at most 128 MB (`fileSize` in `src/app.ts`; NGINX allows 256 MB), and the app's
  host takes a file of at most 150 MB and 2,000 jobs. So the largest photo or video that can wait and then
  arrive is 128 MB.
- A failed upload starts again from the beginning. A large video on a slow connection may not finish in the
  time the system gives the app in the background (about ten minutes at a time on Android) and then needs the
  app open.
- In the app a waiting file is on the device twice until it is uploaded: in the web view's store, which shows
  it, and in the host's folder, which uploads it.

### Camera roll

Capture never writes to the camera roll. The device setting `saveToCameraRoll` (off by default) is passed to
the host as `saveToPhotos` when an upload is handed over, where the app reports `photoLibrarySave`; the host
then saves one add-only copy when it creates the job. A browser cannot write to the camera roll, so there the
setting does nothing and is shown only in the app.

### Native hand-off

Where the bridge reports `offlineUploads`, `platform-offline.js` loads `native-uploads.js` in the top-level page
(`window.PlatformOfflineNativeUploads`) and the app's host sends queued uploads: it keeps each file in private
app storage and uploads it with the web view's session cookies in the background (WorkManager on Android, a
background `URLSession` on iOS), also after the app is closed. The queue stays the one record of what waits.

1. A waiting `upload` entry of the signed-in person is marked `delegated`
   (`FMOffline.queue.delegate`), before anything is handed over.
2. Its file goes to the host (`offlineUploads.putBlob`), or the host takes a native camera capture by its token
   (`PlatformOfflineNativeUploads.useCameraToken(mediaId, capture)`; no platform app uses the native camera for
   photos today, the photo apps use the web camera).
3. `offlineUploads.enqueue` gets the entry's URL, text fields, file field, the entry's idempotency key, the
   identity headers, the CSRF cookie's name and `saveToPhotos`. The job's id is the entry's id.
4. `offlineUploads.status` is polled every five seconds while entries are delegated and the page is visible,
   and when the app returns to the front, a change is queued or the connection returns.
5. The host's answer is applied with `FMOffline.replay.report`, then acknowledged (`offlineUploads.ack`).

| The host says | What happens |
|---|---|
| `done` (2xx) | the answer is reported (the entry is removed, `synced`), then acknowledged |
| `needs_sign_in` | the queue pauses for a sign-in once (reported as a 401); the host queues the job again by itself |
| `failed` with a 4xx | reported: the entry is `failed` and waits for the person. Retry queues the same job again with the entry's new key; Discard cancels it |
| `failed`, `retries_exhausted` (5xx, 408, 425, 429, 3xx) | reported as that answer: one server error, tried again after the queue's backoff |
| `failed`, `redirected` (no status) | reported as no answer, tried again after the backoff |
| `failed`, `file_missing` | the job is cancelled and the stored file is handed over again |
| `failed`, `untrusted_url`; or the host cannot take the file or the request (`file_too_large`, `queue_full`, ...) | the entry goes back to `waiting` and this page sends it itself |
| no such job | handed over again (the page was closed before the job was queued, or the app's data was cleared) |

- **Never both.** The page's replay does not send an upload the host will take
  (`FMOffline.configure({ external })`), and never a delegated one. An entry left to the page is sent by the
  page only.
- **Order.** An upload is handed over when nothing before it in its scope has to reach the server first: it
  waits behind the project's own create, not behind an earlier photo's list save, so all the photos of a
  project can be with the host at once. The list saves are sent by the page when it is open again.
- **Closing the page between steps.** Every step can be repeated. At the next start the host's status decides:
  no job means the file is handed over again, a finished job is reported and acknowledged, an answer whose
  entry is already gone is acknowledged.
- A job that has not arrived is never cancelled because its entry is missing. It is cancelled only when the
  person discards the entry. An upload already in flight may still arrive.

## Identity and privacy

- The worker knows whose page a portal page is from the answer to its
  navigation (`X-FirstMate-Identity`, or the owner of the stored shell it
  served), so the page's first requests are already saved and answered as
  theirs; the page then says the same itself (`identity` message from
  `window.__APP`: user, organization). A page that is nobody's saves and
  queues nothing, and each page's requests are kept under its own identity.
  The last identity a page declared is the person "signed in on this
  device", whose shell an offline navigation gets. (Found on dev: without
  the navigation step the reads a page makes while it boots were neither
  saved nor answered offline.)
- **Sign-out** is the navigation to `/portal/logout.php`, which the worker
  sees (every sign-out link and script goes there; `logout.php` itself needs
  no code), or `PlatformOffline.signedOut()`. It removes that person's
  shells, saved reads, media files and pinned downloads from the device, in
  every organization, also when the server cannot be reached. The list of
  pinned projects stays and is downloaded again after sign-in. Queued
  changes stay and are sent only after the same person signs in again; the
  sign-out flow warns when changes are waiting.
- Replayed requests carry the identity they were queued under and the server
  refuses a mismatch (`offline_identity_mismatch`); the header grants
  nothing. A run sends only the entries of the person it runs for; another
  person's entries are not sent, shown or counted.
- The device's own storage encryption protects the data at rest; the engine
  adds none.
- Storage is requested to be persistent (`navigator.storage.persist()`) when
  the first change is queued. Safari in a browser tab may clear a site's
  storage after seven days without a visit; the tray says so while changes
  wait in a browser that did not grant persistence. The native app is not
  affected.
- Sessions end seven days after sign-in whether or not the device was
  online; queued changes then wait for a sign-in.

## Server

- **Idempotency receipts** (`platform/offline/idempotency.ts`): a root hook
  for every mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) that carries
  `Idempotency-Key: fmo1-<uuid>` and a session. The first request runs and
  its status and JSON body are stored (key, user, organization, method, path,
  body hash for JSON bodies) for 30 days in the SQL store
  `offline_idempotency`; a repeat answers the stored response with
  `Idempotency-Replayed: true` and the handler does not run. A repeat while
  the first is still running answers `409 idempotency_in_progress` (with
  `Retry-After: 2`); a key reused with a different method, path or body
  answers `422 idempotency_key_reused`; a session other than
  `X-FM-Offline-User`/`-Org` answers `409 offline_identity_mismatch`. Only
  2xx and 4xx answers are stored; a 5xx or a crash frees the key. The details
  below are settled in the code and its tests.
- **Assets** (`platform/offline/assets.ts`): the manifest above.
- `POST /organizations/:org/leads` accepts a device-made `project_id`: 8 to
  80 lowercase letters, digits, `_` or `-`, starting with a letter or digit,
  used exactly as sent (`400 invalid_project_id` otherwise). A repeat with
  its receipt is the first answer. Without its receipt (the first try
  answered 5xx after the project was written) it is refused with
  `409 project_exists` before any contact is created a second time.
- `GET /v1/channels/organizations/:org/channels/project/:projectId` answers
  the project's channel for a member of it and creates nothing
  (`404 channel_not_found` otherwise; the `POST` on the same address still
  makes and joins it). `POST .../channels/project/:projectId/messages` finds
  or makes the channel and posts the message to it, with the same body and
  `client_msg_id` rule as the post by channel, and also answers `channel`.
- A photo's display rendition is encoded at the quality the app asked for:
  browser code sends `compression.quality` as a fraction (`0.88`), which is
  read as 88, not as a percentage rounded up to the lowest quality allowed.
- The media upload takes the record id a device made, keeps
  `metadata.taken_at`, and a replayed photo list save never adds a photo
  whose upload did not arrive: see [Photos and files](#photos-and-files).

### Receipts in detail

- **Whose keys.** Only keys that start with `fmo1-` are ours; one that does
  not continue with a UUID answers `400 idempotency_key_invalid`. Any other
  `Idempotency-Key` is passed through untouched, so routes that read the
  header themselves (payment receipts, the public FirstMeasure API) work as
  before. The worker must not replace a key the page set.
- **Whose receipts.** A receipt belongs to the session's user and
  organization; the same key from another person is another change. Without
  a session nothing is claimed or replayed and the handler answers as always
  (401), so the queue waits for a sign-in. The identity headers are checked
  on every mutating request that carries one, with or without a key, and can
  only refuse.
- **One runner.** The key is claimed by inserting its row, which fails when
  the row exists; nothing reads first, and nothing is remembered in the
  process, so two web nodes never both run the handler. The hook runs at
  `preHandler`: the body is parsed, the route gate has passed, and the
  handler's own checks (CSRF, permission) have not run yet, which is safe
  because a replay only gives a person the answer they were already given.
- **The same request** means the same method, the same path with its query,
  and the same body. A parsed body (JSON, or a form's fields) is hashed with
  its keys in order, so the same content written differently still matches.
  A multipart body is a stream the handler has not read yet: it is compared
  by `Content-Length`, within 2 KB, because the page and the native uploader
  choose different boundaries for the same file and fields. A JSON body over
  8 MB is compared by length too.
- **What is kept.** The answer is captured as it is sent (before
  compression), so an answer the device never received is still the answer a
  repeat gets. An answer over 1 MB, or one that is not JSON, is kept as its
  status with `{ ok: true, replayed: true }`; an empty answer (204) stays
  empty.
- **What frees the key instead.** A 5xx or a thrown error. A 4xx that is
  about the moment and not the request: 401, 403, 408, 409, 423, 425 and 429
  (a session that ran out, a stale CSRF token, a revision that moved, a rate
  limit), so the same entry runs again after a sign-in, a fresh token or a
  merge, under the same key and, after a merge, with a new body. Any 4xx
  when the connection dropped before the request had fully arrived, because
  that error may be about half an upload. Other 4xx answers (400, 404, 422)
  are kept: sending the same change again gets the same refusal, so a manual
  retry that should run again needs a new key.
- **A request that never answers.** A running request marks its claim every
  30 seconds, so a long upload is not taken for dead; a claim not marked for
  two minutes (its process was killed) is taken over by the next repeat, and
  the first request finishing late does not overwrite the taker's answer.
- **Proxied routes.** On a web node `/v1/communications` and `/v1/internal`
  are forwarded to the compatibility host, which runs the handler and keeps
  the receipt; the web node only checks the identity headers.
- **Cleaning up.** Each web process removes expired receipts 500 at a time,
  at most every ten minutes, when a keyed request arrives
  ([backlog](../optimization-backlog.md#offline-idempotency-receipts-are-pruned-by-whichever-web-process-sees-a-keyed-request)).

## Native hosts

Bridge version stays 1; new abilities are capabilities checked before use.

| Capability | Methods | Host work |
|---|---|---|
| `offlineUploads` | `offlineUploads.put` (chunked file transfer from the page), `.enqueue`, `.status`, `.ack`, `.cancel`; the exact contract is in `native/firstmate/README.md`, "Offline" | durable private store, background uploader, results kept until read |
| `photoLibrarySave` | `photoLibrarySave` | add-only save to the camera roll |
| `offlineShell` | - | service workers enabled for the portal origin (iOS: App-Bound Domains), a native "no connection yet" screen with retry in place of the browser error page |

A native release is needed only for these; the offline code set and the
engine update with every platform release.

## Page API

```js
PlatformOffline.ready                        // resolves with state()
PlatformOffline.state()                      // { supported, controlled, online, pending, failed, conflicts, syncing, blocked,
                                             //   lastSyncAt, code: { release, status, progress }, storage }
PlatformOffline.on(event, handler)           // 'state' | 'queued' | 'synced' | 'failed' | 'conflict' | 'discarded' | 'code'
PlatformOffline.pending({ scope, record })   // queue entries
PlatformOffline.isPending(recordId)
PlatformOffline.retry(id); PlatformOffline.discard(id); PlatformOffline.resolve(id, choices)
PlatformOffline.syncNow(); PlatformOffline.checkForUpdate()
PlatformOffline.pinProject(org, project); PlatformOffline.unpinProject(org, project); PlatformOffline.pinned()
PlatformOffline.settings.get(name); PlatformOffline.settings.set(name, value)
PlatformOffline.signedOut()
PlatformOffline.media.put(url, blob, { fixed })   // keeps a file under a media URL on this device
PlatformOffline.engine()                          // top-level page only: resolves FMOffline as this page runs it
```

- **`state()`** is a copy, kept current in every frame. `online` is false
  when the browser says so or the last request got no answer. `pending`
  counts entries that will be sent without the person (`waiting`,
  `delegated`), `failed` those waiting for them (`failed`, `parked`),
  `conflicts` those waiting on a choice. `blocked` is `'sign-in'` while the
  queue is paused, else `null`. `code.status` is `none`, `downloading`,
  `ready` or `disabled`; while a newer set downloads, `code.release` is still
  the active one and `code.next` names the new one.
- **`state().storage`** is in bytes: `{ quota, usage, persisted, reads,
  media, queued, budgets: { reads, media } }`. `quota` and `usage` are the
  browser's estimate for the whole site, `persisted` whether it granted
  persistent storage, `reads`, `media` and `queued` what saved reads, cached
  media files and waiting changes (their bodies and files) take. It is
  measured when a page loads.
- **Events.** `on` returns a function that stops listening. `queued`,
  `failed`, `conflict` and `discarded` carry the entry; `synced` adds
  `status` and `response`, the server's real answer; `conflict` adds
  `fields`; `code` carries `state().code`. A page hears only the events of
  the person signed in on it.
- **Entries** (`pending()`, a promise, and the events) are `{ id, contract,
  write, kind, scope, label, records, state, attempts, error: { status, code,
  message }, conflict: { revision, fields }, createdAt, nextAt }`.
- `retry`, `discard`, `resolve`, the pin calls, `settings.set`, `signedOut`
  and `checkForUpdate` return promises; `settings.get` and `isPending`
  answer at once. `syncNow()` resolves `{ sent, blocked }`.
- **Settings** are per device: `saveToCameraRoll` (false), `autoPinRecent`
  (true), `readsBudgetMb` (150), `mediaBudgetMb` (300).
- `pinProject(org, project, { auto: true })` marks a project as recently
  opened; `pinned()` resolves `[{ org, project, auto, at, refreshedAt, reads,
  media }]`.
- `media.put` resolves `true` when the file was kept and `false` where
  nothing could keep it (no worker, nobody signed in). It runs the engine in
  the top-level page, and a frame asks its top-level page, so it does not
  depend on which version of the worker is active. `engine()` is what
  `native-uploads.js` drives; `PlatformOffline.csrfCookie` is the name of the
  readable CSRF cookie.

## Adding offline support to an app

1. Reads need nothing: a JSON `GET` is saved the first time it is made. Add a
   `prefetch` entry so a pinned project downloads it, and a `reads` entry if
   the app reads with `POST`.
2. For each write the app should make offline, add a `writes` entry. Send a
   device-made id, describe the answer the route would give, and describe
   what the change does to the reads the app shows.
3. Show waiting records with `PlatformOffline.isPending(id)` and react to
   `synced` if the app keeps server-made values (timestamps, numbers).
4. Add the contract file to `contracts/index.js` and a case to the contract
   test.

## What works offline

The contracts are in `contracts/`: `portal.js` (start-up and lists),
`projects.js`, `notes.js`, `todos.js`, `contacts.js`, `schedule.js`,
`documents.js`. "Reads" means: shown as it was last seen, or as downloaded for
a pinned project. A project that is opened is pinned automatically
(`project-windows.js`, `mobile.js`), so its tabs are on the device even if
they were never clicked.

| App | Reads | Adds | Edits | Not offline, and why |
|---|---|---|---|---|
| Start-up, sidebar, top bar | everything a start reads; the person's apps and permissions come from their saved profile (`GET /me`) when the session read cannot be reached | | | the account switcher's list and sign-in (always the server's); the bonus offer and referral status (reading them writes) |
| My Projects | the project list; for an account that only orders reports, its FirstMeasure orders | a project (`Portal.ProjectStore`, id made on the device); a lead with `project_id` (`PlatformAPI.leads.create`) | a project's own fields, merged per field | ordering a report (it charges, and FirstMeasure measures); order thumbnails unless the browser still holds them; an order list that carries a refresh cursor |
| Project: Overview | the project, report widgets, data sets, measurement schema, custom fields, assignable people | | contact fields and address through the project and its contacts | the map (Google), report orders |
| Project: Notes tray | notes, pins, authors | a note (text) | | replies, attachments, editing, pinning and deleting a note; notes of a project whose channel is not on the device (see below) |
| Project: To Do tray, top bar To Do, to-do widget | the lists | a to-do added by hand | complete, reopen, claim, cancel; title, description, due date, priority, who it is assigned to | follow-ups (the server makes them and their outcomes) |
| Contacts | the list, a contact, a contact's projects | a contact | a contact's fields (`expected_revision`, merged per field); which contacts a project has | merging, importing, duplicate suggestions |
| Schedule (project tab and Scheduling) | events, calendar, resources, settings | an event on a project | an event's fields (`expected_event_revision`, merged per field) | events that belong to no project, deleting, recurring series; whether the assignee is free (the server checks when the event is sent) |
| Documents | the list, a document, its preview and editor view, workflow, sent versions | | | creating, editing, sending, signing, PDF: see "Documents" below |
| Operations (materials and labor) | the ledger, requirements and coverage, suppliers, price book | | | changing or generating lists, orders (the server prices and computes) |
| Financials | | | | everything: payments data is never kept on a device. The tab says so |
| Comms, Messages tray, Channels | what was last shown | | | sending (no contract yet); calls |
| Checklists, Activity, Feed | what was last shown | | | completing checklist items, comments and reactions (no contract yet) |
| Photos | see the photos contract (`media.js`) | | | |

How each kind of change is sent:

- **Scopes.** A project made on the device is `project:<id>`; its notes,
  contacts, events and to-dos take that scope and are sent after it. A
  contact is `contact:<id>`. A to-do on a project the server already has is
  `todo:<id>` (so a to-do the server refuses holds nothing else), and a
  change to a to-do takes the scope of the change that made it.
- **Already there.** `project_exists` and `contact_exists` for an id the
  device made mean the first try arrived: the entry is done. A manual to-do
  and a note repeat safely by themselves (the server answers with the record
  it has). An event save is an upsert.
- **To-do ids.** The server derives a manual to-do's plan and id from the
  page's id (`work/service.ts` `stableId`), and `todos.js` derives the same,
  so completing a to-do that was made offline addresses the right record.
  A change in that derivation must be made in both places; the contract test
  compares them.
- **Notes.** A note goes to the project's channel. The channel of a project
  is made by a `POST`, which cannot be sent without a connection, so the
  page then finds the channel on the device: `GET
  /v1/channels/organizations/:org/channels/project/:project` (read-only;
  saved for pinned projects), else the channel list, which names project
  channels that have messages. A project made on the device has no channel
  yet: its notes are kept under `chan_local_<project>` and sent with `POST
  .../channels/project/:project/messages`, where the server makes the
  channel and posts. A note the server refuses does not hold the project's
  other changes.
- **Published actions.** The to-do widget changes a to-do with
  `actions/invoke`, which carries its own `idempotencyKey`. The queued action
  is sent with the key it was made with, so the server runs it once and
  answers a repeat with the first result. `action_outcome_uncertain` means
  the server started the action under that key and does not know how it
  ended; the key is then refused for good. A contract may say such an action
  can be repeated (`resend`: setting a to-do's status or fields twice changes
  nothing more); it is then sent again once under a new key. Any other
  action fails and waits for the person. Only the two to-do actions are
  queued; every other published action needs a connection.
- **Edits.** A project edit sends only the top-level fields the page changed
  (`Portal.ProjectStore` compares with what it first read). The queued edit
  keeps the project as it was, and on replay each field is merged three ways
  and sent with `expected_revision`; lists whose items have ids merge by id.
  While it waits, the same merge is shown over newer answers (`ctx.base`), so
  a reload does not put an old whole list over a newer one, and the page's
  next edit again sends only what changed. A to-do edit has no revision to
  check: it is merged per field against the to-do as it is when it is sent.
- **What a pinned project downloads** is listed in `projects.js`
  (`projectReads`, `branchReads`), `notes.js`, `contacts.js`, `schedule.js`
  and `documents.js`. The addresses and bodies there must stay the ones the
  apps ask with: a read that is asked differently is saved the first time
  the tab is opened, not by the pin.

### Documents

Documents can be read offline; they cannot be made or changed. What is
missing before that is safe:

1. **Create replaces.** `POST .../projects/:project/documents` accepts an
   `id`, but a repeat with the same id replaces the document (status back to
   draft, overrides and outputs emptied) instead of answering "already
   there". The route must refuse an existing id (`document_exists`, which
   the store already has) before a device may name a document. The browser
   does not send an id today.
2. **The server makes what the page shows.** The preview and the editor
   render what `POST .../documents/:id/resolve` returns: line rows, totals,
   account figures and widget data are computed there and never stored.
   After an offline change to a document's data the saved resolve is stale,
   and a document made on the device has none. The enrichment
   (`enrichLineItemParams`, pricing, `deriveAccountParams`) would have to
   run on the device too.
3. **Some documents are only the server's to make**: invoices, change orders
   and completion certificates get their numbers and amounts at create, and
   a template with a program runs in the module sandbox.
4. **Edits merge all or nothing.** The editor saves its whole list of
   overrides, whose items have no ids, so two people's edits cannot be
   merged per item: one side's list wins or the person is asked.
5. **Steps and outputs do things.** `workflow/state` can make further
   documents, and `outputs/:key` records signatures and payments; neither
   may be answered by a device.
6. **History** (`saveDocumentInstance`) would record one revision at the
   time of the sync for everything done offline.

## Not built yet

- Offline document creation and editing (above).
- Order thumbnails and report images (`/v1/firstmeasure/projects/:id/thumbnail`,
  `/artifacts/*`) are not kept by the worker; My Projects shows them only
  while the browser's own cache has them.
- A read the server answers with `404` is not saved, so an app sees "no
  connection" where it saw "does not exist" online (for example a branch
  record that was never made).
- Sending messages, checklist items, feed comments, events without a
  project and deletes have no contract.
- A change feed for refreshing pinned projects without re-reading them
  ([backlog](../optimization-backlog.md#pinned-offline-projects-are-refreshed-by-reading-everything-again)).
- Resumable uploads for very large files (a failed upload starts again).
- Renaming and tagging a photo without a connection, and queueing the uploads
  of other apps (see [What is queued](#what-is-queued)).
- Offline sign-in (a person must have signed in on the device while online).
- Re-reading a declared `POST` read after a sync sends its text fields
  URL-encoded, also when the app sent them as a multipart form.
- The measure editor (`/measure/internal`) and pages outside `/portal/`.

## Tests

`tests/offline-core.test.mjs` (the engine case by case, with a Map for the
store and a scripted server: `node --test tests/offline-core.test.mjs`),
`tests/offline-sw-browser.test.mjs` (the real worker, engine and page API in
headless Chrome against a local server that can drop every connection:
`node --test tests/offline-sw-browser.test.mjs`, with `public/v1/node_modules`
installed and `CHROME_PATH` where Chrome is elsewhere),
`public/v1/tests/offline-idempotency.test.ts` (also on PostgreSQL:
`node tests/run-embedded-postgres.mjs tests/offline-idempotency.test.ts`),
`public/v1/tests/offline-assets.test.ts`,
`public/v1/tests/offline-routes.test.ts` (media caching, the lead route and
the receipts hook through the real app),
`public/v1/tests/media-quality.test.ts`,
`public/v1/tests/offline-contracts.test.ts` (every contract file in
`contracts/index.js` against the real app: each `match` is a registered
route, each write has `respond`, `scope` and `label`, each `POST` read is on
the checked list; then every write is made with the server unreachable, its
answer compared key by key with the real route's, and the queue replayed
against the real routes, including a lost first answer and an edit the server
also changed).

Photos: `tests/offline-photos.test.mjs` (the media contract case by case, with
the real engine), `tests/offline-photos-browser.test.mjs` (the real worker,
engine, contract and `platform-api.js` in headless Chrome with real
pictures: queued, shown, closed and reopened, sent once, the small copy and
its eviction, a small picture, an online retry, a photo stored on its side,
a device short on space),
`tests/offline-native-uploads.test.mjs` (`native-uploads.js` against a
stand-in for the app's host: the answer table, order, and closing the page
between steps), `public/v1/tests/offline-photos.test.ts` (the device's id,
`taken_at`, a repeat that replaces, the photo list and pairing repeated, a
replayed list that names a photo which never arrived).
