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
file is picked up at the next update check.

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
- The list is computed once per release per process (hashing the set takes
  about a third of a second; see
  [the backlog](../optimization-backlog.md#the-offline-asset-manifest-hashes-every-file-once-per-release-in-every-process))
  and answered with a weak `ETag` and `Cache-Control: private, no-cache`, so a
  check that finds nothing new is a `304` with no body. A checkout without a
  release link (a developer's machine) is checked by file size and time on
  every request instead, because its files change in place.
- `enabled: false` is the kill switch: the service worker removes its caches
  and unregisters, and pages stop registering it. Two switches, either of
  which turns it off (`platform/offline/switch.ts`):
  - `OFFLINE_ENABLED=0` on a host: off for everyone that host serves.
  - the `platform.offline` [flag](feature-flags.md), an organization switch
    like any other: the flag console turns it on or off for one organization,
    by percentage, or **Off for everyone**, which every web process reads
    within 15 seconds and needs no release. Its default is data
    (`capability_defaults/platform` in the config library) and is off until
    that entry names it: development's entry gets `"platform.offline": true`
    once this is released there (`tools/config-library/cli.mjs`: `get`, add
    the value, `put`), production's does not name it. Like every platform
    feature it needs expanded access.

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

### Serving

| Request | With a connection | Without |
|---|---|---|
| Navigation to a shell (`/portal/`, `/portal/index.php`, `/portal/mobile/`, with any query) | network; the answer replaces the stored shell when it is a 200 for the release of the active set (`X-FirstMate-Release` header) | the stored shell, when someone is signed in on this device; otherwise the built-in "connect once" page |
| File in the set | network, falling back to the set if the request fails | the set first, then the network |
| Listed external file (fonts, icon CSS) | cache, refreshed in the background | cache |
| Anything else | not answered by the worker | - |

A navigation waits for the network 8 seconds (3.5 seconds when the last
request failed) before the stored shell is used. A page that was served from
the set is in **offline mode** for its lifetime: its files come from the set
without waiting for the network.

`index.php` sends `X-FirstMate-Release` and loads `platform-offline.js`
before other libraries. The shell is the server-rendered page as that person
last received it, so its user data, feature gates and script list are theirs.

## Saved reads

Every same-origin `GET` under `/v1/` that answers JSON is saved, unless a
contract's deny list names it (`FMOffline.contracts.deny`: auth, the realtime
stream and poll, payments checkout and processor data, session replay,
assistant streams). A read made with `POST` is saved only when a contract
declares it (`reads`: `portal-action` read actions, publication
`data/read`, `data/list`, `widgets/resolve`), keyed by the body fields the
contract names.

- **Network first.** The saved answer is used only when the request fails or
  does not answer within 8 seconds (1.5 seconds when the last request
  failed); the network answer still updates the saved copy when it arrives.
  An answer served from the device has `X-FM-Offline: saved` and
  `X-FM-Saved-At`.
- **Store.** IndexedDB database `fm-offline-v1`, store `responses`, key
  `[user, org, key]`, with size and last-used time. Default budget 150 MB,
  least recently used first; a pinned project's reads and the boot reads are
  never evicted.
- **Media files** (`/media/:id/file?variant=`) are kept in the cache
  `fm-media-v1` and served from it first (a variant never changes; a markup
  variant carries its revision). Thumbnails are always kept; larger variants
  only up to 8 MB each. Default budget 300 MB, least recently used first,
  pinned projects exempt. The server says how long each answer may be kept
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
- **Pinned projects.** `PlatformOffline.pinProject(org, project)` runs every
  contract's `prefetch` for that project (the project, its lists, its
  documents, its thumbnails) and repeats it when the connection returns and
  every 15 minutes while a page is open. The ten most recently opened
  projects are pinned automatically (setting `autoPinRecent`).

There is no change feed yet: a refresh re-reads the pinned set
(see [the backlog](../optimization-backlog.md#pinned-offline-projects-are-refreshed-by-reading-everything-again)).

## Queued changes

### Contracts

A contract file registers what an app can do offline:

```js
FMOffline.contracts.add({
  id: 'project.notes',
  deny: [],                                   // GET patterns never saved
  reads: [ /* POST reads: { id, match, when(ctx), key(ctx) } */ ],
  prefetch: [ /* (ctx:{org,project,user}) => urls, or { url, each(json) => urls } */ ],
  writes: [{
    id: 'notes.post',
    match: 'POST /v1/channels/organizations/:org/channels/:channel/messages',
    kind: 'create',                           // create | action | patch | upload | delete
    scope: (ctx) => `project:${ctx.body.project_id}`,   // entries of one scope replay in order
    label: (ctx) => ({ title: 'Note', detail: ctx.body.text.slice(0, 80) }),
    records: (ctx) => [ctx.body.client_msg_id],         // ids apps can ask "is this waiting?"
    prepare: (ctx) => ctx.body,               // optional: fill device-made ids before sending
    respond: (ctx) => ({ ok: true, message: { /* what the route would answer */ } }),
    effects: (ctx) => [{ match: 'GET /v1/channels/organizations/:org/channels/:channel/messages',
                         when: (m) => m.channel === ctx.params.channel,
                         apply: (json) => ({ ...json, messages: [...json.messages, ctx.response.message] }) }],
    // kind 'patch' only:
    conflict: { current: (ctx) => url, pick: (json) => ({ doc, revision }),
                fields: (ctx) => ['title', 'address'], send: (ctx, merged, revision) => body }
  }]
});
```

`ctx` is `{ method, url, params, query, body, headers, user, org, now, id,
response, saved(url) }`: `body` is the parsed JSON or the form fields (files
as `{ name, type, size, blob }`), `id` is the entry's idempotency key,
`response` is what `respond` returned, `saved(url)` reads a saved answer.
Contract functions are pure and may be async; they run in the worker.

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
| other 4xx | `failed`, waits for the person (retry or discard) |
| 5xx | retried like no answer, eight times, then `failed` |

A failed `create` holds the rest of its scope (later entries need the record);
other failures do not.

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

## Photos and files

- A queued upload keeps its file in the `blobs` store (IndexedDB) and its
  record id is made on the device (`media.upload` sends `id` unless it
  replaces a slot), so the queued photo, its place in the project's photo
  list and its later upload are the same record.
- While it waits, the worker answers that media id's file requests from the
  stored file, so the app's ordinary thumbnail URLs work.
- When it is uploaded the original is deleted from the device; a 640 px copy
  made at capture goes into the media cache under the thumbnail URLs.
- Capture time is sent as `metadata.taken_at`, set when the photo was taken,
  not when it was uploaded.
- Free space is checked before a file is queued (`navigator.storage`); with
  too little the write fails with `offline_storage_full`.
- **Camera roll.** Capture never writes to the camera roll. The device
  setting `saveToCameraRoll` (off by default) saves a copy through the native
  bridge (`photoLibrarySave`); a browser cannot, so the setting is shown only
  in the app.
- **Native hand-off.** Where the bridge reports `offlineUploads`, the page
  hands a queued upload to the host (`offlineUploads.enqueue`: the stored
  file or a native camera token, URL, form fields, headers, idempotency
  key). The host keeps the file in private app storage and uploads it with
  the WebView's session cookies in the background (WorkManager on Android, a
  background `URLSession` on iOS), also after the app is closed. The entry
  stays in the queue as `delegated` until the host reports the answer
  (`offlineUploads.status`), so the queue remains the one record of what is
  waiting.

## Identity and privacy

- The page tells the worker who is signed in (`identity` message from
  `window.__APP`: user, organization). Nothing is saved or queued before
  that.
- **Sign-out** (`logout.php`, or `PlatformOffline.signedOut()`) removes that
  person's shells and saved reads from the device. Queued changes stay and
  are sent only after the same person signs in again; the sign-out flow warns
  when changes are waiting.
- Replayed requests carry the identity they were queued under and the server
  refuses a mismatch (`offline_identity_mismatch`); the header grants nothing.
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
- A photo's display rendition is encoded at the quality the app asked for:
  browser code sends `compression.quality` as a fraction (`0.88`), which is
  read as 88, not as a percentage rounded up to the lowest quality allowed.

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
| `offlineUploads` | `offlineUploads.enqueue`, `.status`, `.cancel`, `.put` (chunked file transfer from the page) | durable private store, background uploader, results kept until read |
| `photoLibrarySave` | `photoLibrarySave` | add-only save to the camera roll |
| `offlineShell` | - | service workers enabled for the portal origin (iOS: App-Bound Domains), a native "no connection yet" screen with retry in place of the browser error page |

A native release is needed only for these; the offline code set and the
engine update with every platform release.

## Page API

```js
PlatformOffline.ready                        // resolves with state()
PlatformOffline.state()                      // { supported, controlled, online, pending, failed, conflicts, syncing,
                                             //   lastSyncAt, code: { release, status, progress }, storage }
PlatformOffline.on(event, handler)           // 'state' | 'queued' | 'synced' | 'failed' | 'conflict' | 'code'
PlatformOffline.pending({ scope, record })   // queue entries
PlatformOffline.isPending(recordId)
PlatformOffline.retry(id); PlatformOffline.discard(id); PlatformOffline.resolve(id, choices)
PlatformOffline.syncNow(); PlatformOffline.checkForUpdate()
PlatformOffline.pinProject(org, project); PlatformOffline.unpinProject(org, project); PlatformOffline.pinned()
PlatformOffline.settings.get(name); PlatformOffline.settings.set(name, value)
PlatformOffline.signedOut()
```

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

## Not built yet

- A change feed for refreshing pinned projects without re-reading them
  ([backlog](../optimization-backlog.md#pinned-offline-projects-are-refreshed-by-reading-everything-again)).
- Resumable uploads for very large files (a failed upload starts again).
- Offline sign-in (a person must have signed in on the device while online).
- The measure editor (`/measure/internal`) and pages outside `/portal/`.

## Tests

`tests/offline-core.test.mjs`, `tests/offline-sw-browser.test.mjs` (root),
`public/v1/tests/offline-idempotency.test.ts` (also on PostgreSQL:
`node tests/run-embedded-postgres.mjs tests/offline-idempotency.test.ts`),
`public/v1/tests/offline-assets.test.ts`,
`public/v1/tests/offline-routes.test.ts` (media caching, the lead route and
the receipts hook through the real app),
`public/v1/tests/media-quality.test.ts`,
`public/v1/tests/offline-contracts.test.ts`.
