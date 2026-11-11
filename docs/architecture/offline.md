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
  that keeps the Node process changes it.
- `files` is every browser file an offline portal can need, chosen by the
  rules in `platform/offline/assets.ts` (`ASSET_RULES`: include
  `/libraries/**`, `/portal/scripts/**`, portal styles and images, fonts;
  exclude marketing pages, samples, PHP, Markdown, language catalogs that the
  catalog manifest no longer names, the call effects WASM and
  `/measure/internal`). The list is computed once per release per process and
  answered with an `ETag`.
- `enabled: false` is the kill switch (`OFFLINE_ENABLED=0`, or the
  `platform.offline` flag): the service worker removes its caches and
  unregisters, and pages stop registering it.

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
  pinned projects exempt. The server sends `Cache-Control: private,
  max-age=31536000, immutable` for a variant.
- **Pinned projects.** `PlatformOffline.pinProject(org, project)` runs every
  contract's `prefetch` for that project (the project, its lists, its
  documents, its thumbnails) and repeats it when the connection returns and
  every 15 minutes while a page is open. The ten most recently opened
  projects are pinned automatically (setting `autoPinRecent`).

There is no change feed yet: a refresh re-reads the pinned set
(see the optimization backlog).

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
  for every mutating request that carries `Idempotency-Key: fmo1-...` and a
  session. The first request runs and its status and JSON body are stored
  (key, user, organization, method, path, body hash for JSON bodies) for 30
  days in the SQL store `offline_idempotency`; a repeat answers the stored
  response with `Idempotency-Replayed: true`. A repeat while the first is
  still running answers `409 idempotency_in_progress`; a key reused with a
  different method, path or body answers `422 idempotency_key_reused`; a
  session other than `X-FM-Offline-User`/`-Org` answers
  `409 offline_identity_mismatch`. Only 2xx and 4xx answers are stored; a 5xx
  or a crash frees the key.
- **Assets** (`platform/offline/assets.ts`): the manifest above.
- `POST /organizations/:org/leads` accepts a device-made `project_id`.

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

- A change feed for refreshing pinned projects without re-reading them.
- Resumable uploads for very large files (a failed upload starts again).
- Offline sign-in (a person must have signed in on the device while online).
- The measure editor (`/measure/internal`) and pages outside `/portal/`.

## Tests

`tests/offline-core.test.mjs`, `tests/offline-sw-browser.test.mjs` (root),
`public/v1/tests/offline-idempotency.test.ts`,
`public/v1/tests/offline-assets.test.ts`,
`public/v1/tests/offline-contracts.test.ts`.
