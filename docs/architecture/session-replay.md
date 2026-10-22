# Session replay

Session replay records what people do in the platform so it can be watched again later, without video and without
knowing which release of a page was running. It records the page's DOM as a snapshot plus every change after it,
the pointer path, clicks, typing, scrolling, focus and hover, and replays them by rebuilding the same DOM in a
script-free iframe. Because the recording carries its own markup and stylesheets, a replay keeps working after the
app that produced it has been changed or deleted.

It is a standalone library, `public/libraries/session-replay/`, that knows nothing about FirstMate except through
its loader. Apps never mark anything to be tracked.

## Switching it on

- `platform.session_replay` is an organization feature, **off by default**, in `platform/capability_defs.ts`. It
  does not need expanded platform access (it is in `firstMeasureCapabilities`), no preset turns it on
  (`PRESET_EXCLUDED` in `platform/capabilities.ts`) and FirstMeasure signups start with it off.
- A platform administrator switches it per organization in the viewer (`/libraries/session-replay/viewer.html`),
  which calls `PUT /v1/platform/session-replay/admin/organizations/:orgId`. That writes the one capability through
  `saveCapabilityValues` (other switches are untouched) and keeps who changed it in `session_replay_org_settings`.
  Operators can also flip it in Company settings › Developer Settings like any other feature.
- When it is on, every signed-in member of the organization is recorded on every page that loads
  `platform-api.js`; a page already open starts on its next load.
- "Platform administrator" is a full internal admin (the same test as FirstMeasure price changes:
  `readInternalUser(identity email)` is active and an admin, system admin, legacy admin or `platform_admin`).
  Customer owners and admins cannot read replays: a replay shows every member's screen.

## How a page is recorded

1. `platform-api.js` adds `session-replay-loader.js` to every page that loads it (portal, project windows, mobile
   web, canvassing, the FirstMeasure admin index). Frames never start their own recording: a same-origin frame is
   recorded as part of its parent.
2. The loader calls `GET /v1/platform/session-replay/config` once. Off, signed out or unreachable: nothing else
   loads. On: it loads `session-replay-codec.js` and `session-replay-recorder.js` and starts the recorder with a
   transport that posts to the platform. It defines `window.FMReplay` either way.
3. The recorder writes a META event (device, viewport, page) and a SNAPSHOT of the document, then observes it.

What is recorded, and how:

| What | How |
| --- | --- |
| DOM changes | One `MutationObserver` on the document, every same-origin iframe document and every shadow root (open, and closed ones the page attaches after the recorder loads). Records are batched for 40 ms, or flushed before any click, key, input, focus or hover so ids exist. Nothing is diffed by hand: the browser hands over the exact change. |
| Stylesheets | The text of each `<style>`, each same-origin `<link rel=stylesheet>` (from `cssRules`, with `url()`s made absolute, captured when it loads) and rules added with `insertRule`. Cross-origin sheets keep their URL and load from the network at replay. |
| Form values | Values and checked states from `input`/`change` events and from scripts setting `.value`/`.checked`/`.selectedIndex` (setters are wrapped). Text changes are sent as splices. Passwords, `autocomplete="cc-*"`, one-time codes and anything marked `data-fmr-mask` become `*` of the same length, and an element masked once stays masked. |
| Pointer | Every `pointermove` sample, reduced per chunk to the points a straight, time-synchronous line cannot reproduce within 1.5 px (top-down time ratio); a rest longer than 100 ms keeps its end point. The player draws a Catmull-Rom spline through them. |
| Clicks | Down, up, click, double click and context menu with position, button, pointer type, the target, and for clicks a short label and selector path so clicks can be analysed without replaying. |
| Keys | Every key down; printable characters without modifiers are recorded only as `char`. |
| Other | Hover target, focus (and whether it is focus-visible), element and window scroll (sampled every 100 ms, stamped when it happened), viewport and pinch zoom, URL changes (`pushState`, `replaceState`, `popstate`, `hashchange`), tab visibility, script errors and unhandled rejections, and `FMReplay.track(name, data)` markers. |
| Never | Scripts, comments, `on*` attributes, canvas or WebGL pixels, video frames, cross-origin iframes (for example the payment element), anything inside an element with `data-fmr-ignore`. |

## Wire format

`session-replay-codec.js` is shared by the recorder, the player and the server test. In short:

- **Tokens.** Every tag, attribute name, attribute value and text is interned in a per-page string table and
  referred to by number. A text node is a number; an element is `[tag, [name, value, ...] | 0, ...children]`.
  Node ids are never written: a subtree's ids are its base id plus each node's pre-order position.
- **Second-order tokens.** Every element subtree of three or more nodes that is written out in full becomes a
  numbered template, on both sides, in the same order. A later identical subtree is `[-1 - n]`; one with the same
  structure and some different values is `[-1 - n, slot, value, ...]`. A hovered dropdown that closes and reopens is
  one reference; a re-rendered list of 60 rows is 60 references or small patches. Hashes only find candidates;
  every match is verified, so a collision costs a comparison, never a wrong replay.
- **Blobs.** A string of 2,048 characters or more (stylesheets, data URLs) is replaced by its content address and
  uploaded once per organization. The server recomputes the address (`session-replay/hash.ts`) before storing it,
  so stylesheets that do not change between releases are stored once for every session.
- **Chunks.** Every 5 seconds (the first after 1 second, and when the tab is hidden or closed) the recorder sends
  the new strings, the events with millisecond deltas and the pointer track as gzip JSON. Chunks of a page are
  numbered from 0 and sent in order; a retry of a stored chunk changes nothing.

## Storage

`session-replay/storage.ts` is an `openSqlStore` store (`session_replay`, schema version 1):
`session_replay_sessions` (one per tab session: person, organization, times, sizes, device),
`session_replay_pages` (one per page load, with its META), `session_replay_chunks` (the gzip bodies),
`session_replay_blobs` (per organization, by content address) and `session_replay_org_settings`. A session is one
browser tab until 30 idle minutes pass or the person or organization changes; another person writing into it gets
409 and the recorder starts a new one. A session stops accepting chunks at 256 MB.

## Replay and the viewer

`session-replay-player.js` rebuilds a page in an `<iframe sandbox="allow-same-origin">` (no scripts) and applies
events in recorded order. `:hover`, `:active`, `:focus`, `:focus-visible` and `:focus-within` in recorded
stylesheets are rewritten to classes the player sets from the recorded hover, pointer and focus events, so menus
that open on hover open in the replay. The browser's own focus ring is added with zero specificity. Seeking back
rebuilds the page from its snapshot.

The viewer (`viewer.html`) lists sessions (live ones pulse), switches organizations on and off, plays with speed,
idle skipping and a pointer trail, and has four panels: **Events** (clicks with their labels, pages, navigation,
keys, typing, errors), **Storage** (bytes stored, cost per page load, cost per minute after loading, the growth
chart, the organization's per-hour rate and a monthly cost calculator), **Performance** (recorder CPU, page heap,
recorder memory, DOM size and main-thread lag over time) and **Device**. A live session can be followed as it records.

Storage numbers separate a page's load (its first 15 seconds: the snapshot plus the app rendering into it) from the
time after it, idle time included, because a short session is almost all load. The calculator models a month as
average concurrent users × 730 hours × (page loads per user-hour × KB per load + 60 × KB per minute after loading).

## Diagnostics

In a recorded tab's console:

- `FMReplay.status()` prints what the recorder has done and cost so far.
- `FMReplay.overlay()` toggles a panel with recorder CPU (now and total), snapshot time, batch times, recorder memory,
  page heap, DOM size, long tasks, main-thread lag, bytes sent raw and gzip, bytes per minute and hour, template hits
  and upload state, with a CPU and heap sparkline. It stays on for the tab until closed, and is never recorded.
- `FMReplay.viewer()` opens this session in the viewer, following it live.

The same numbers go into the recording every 5 seconds while the person is active (every minute when idle) as DIAG
events, which the viewer charts. Heap figures are Chrome's `performance.memory` and describe the whole page.

## Using the library elsewhere

The recorder needs only `FMReplayRecorder.create({ transport, sessionId, pageId })`, where `transport` has
`sendChunk(item)`, `missingBlobs(keys)`, `sendBlob(blob)` and `beacon(item)`. A browser extension or another site
can load the codec and recorder and point a transport at any endpoint; the player and viewer only need the chunks and
blobs.

## Not built

- Canvas and WebGL content: the FirstMeasure editor's 2D and 3D views replay as empty canvases.
- Cross-origin iframes, video frames, constructable (`adoptedStyleSheets`) stylesheets, the top layer (`showModal`,
  popovers) and closed shadow roots attached before the recorder loaded.
- Customer-facing pages (customer portal, websites) and pages without `platform-api.js` (the FirstMeasure editor pages
  on the compatibility host) are not recorded.
- Retention: nothing deletes old recordings yet except Delete in the viewer.
- Archiving: a finished session could be re-packed into one zstd stream using a per-organization dictionary built
  from its earlier sessions (Node's `zlib` has zstd with dictionaries on the hosts). Measured on dev on 2026-10-22:
  1.3–1.6× smaller alone, 1.7× with one earlier session as the dictionary, 3–4× with three or four
  ([record](../../deploy/digitalocean/development-session-replay-20261022.md)).
- Per-person audiences: an organization is recorded entirely or not at all.
- Performance shortcuts shipped on purpose are in [the optimization backlog](../optimization-backlog.md): chunk bodies
  in the database, rebuild-on-seek, and one config request per page load.

## Tests

`tests/session-replay-browser.test.mjs` records a scripted session in Chrome and checks that the replay's DOM,
computed styles and scroll positions match the live page at every checkpoint, playing forward and seeking back.
`tests/session-replay.test.ts` covers the switch, who may read and write, chunk storage and retries, conflicts and
blob addresses.
