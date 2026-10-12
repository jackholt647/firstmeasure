# Realtime: one stream per page

A browser page holds **one** long-lived connection to the platform: the
organization event stream, `GET /v1/platform/organizations/:orgId/events/stream`.
Everything the server pushes to a page travels on it. Nothing else may open a
streaming connection from the browser, and the server has no other streaming
endpoint for browsers to use.

## Why this is a rule and not a preference

Browsers allow six HTTP/1.1 connections per site, shared by every tab of that
site. A streaming connection never finishes, so each one permanently removes
a slot. In October 2026 the portal had four per tab (events, who is online,
who is viewing the project, document collaboration). With a second tab open
there were no slots left, and ordinary requests queued behind them: the last
step of a document lost its buttons and Send appeared to hang for twenty
seconds, until closing the document freed a slot. Nothing was slow and nothing
errored. That is what a duplicated stream costs, and it only shows up once
enough of them exist.

HTTP/2 lifts the six-connection limit, and the load balancer should serve it.
Keep the rule anyway: the app must not depend on it, and one connection is
cheaper for the server and simpler to reason about on every transport.

## The two things the stream carries

**Platform events** are facts that already happened, published by domain code
with `publishRealtimeEvent({ organization_id, topic, user_ids?, payload })` in
`public/v1/platform/realtime.ts`. They have a sequence number, are replayed
after a reconnect, and fall back to polling. A page receives them with
`PlatformRealtime.subscribe(orgId, topicPrefix, handler, { onResync })`.
Use this for "something changed, refresh what you show".

**Channels** are live state the server keeps *for this page while it watches*:
who is viewing a project, the other people editing a document. A page asks for
them by name and the server ends them when the page stops asking or goes away.

| Channel | Carries | Owner |
|---|---|---|
| `presence:online` | who is signed in and active | `platform/presence.ts`, registered in `platform/api.ts` |
| `presence:project:<id>` | who is looking at a project | same |
| `collab:<documentId>` | hello, other people's command batches, the roster | `documents/collab/service.ts`, registered in `documents/collab/routes.ts` |

A page watches one with
`PlatformRealtime.watchChannel(orgId, name, { onEvent(event, data), onDown(code) })`,
which returns a function that stops watching. `watchPresence` and the document
collaboration client (`DocumentsAPI.collab.connect`) are built on it.

## How it works

- The page's watched channels are part of the stream URL: `?watch=presence:online&watch=collab:doc_1`.
  When the set changes, the client opens the replacement connection first and
  closes the old one once the new one is open, so nothing is missed. Platform
  events are de-duplicated by sequence number; a channel's owner must tolerate
  a frame arriving on both connections during that moment (collaboration drops
  command batches it has already seen by revision).
- Being in the URL, rather than a separate "subscribe" request, is deliberate:
  with several API replicas a second request may reach a different process than
  the one holding the socket.
- The server authorizes each watched channel before the response starts. One
  that is refused or unknown is reported on the stream as that channel's
  `error` frame; the connection and its other channels carry on.
- Channel frames are `event: channel` with `{ channel, event, data }` and no
  id, so they never move the platform event cursor.
- Presence is tied to the connection: closing it is what removes the page from
  a roster. The client lets go of the stream on `pagehide`, and viewing
  presence is only watched while the page is visible.
- Someone without the management or field app may hold the stream for the
  channels they are allowed (their own online presence); they are sent no
  platform events.

## Adding something that pushes to the page

1. If it is a fact that happened, publish a platform event. Stop here.
2. If it is state kept per watching page, add a channel kind:
   `registerRealtimeChannelKind("thing", async (request, { orgId, id, query }) => { /* authorize, throw to refuse */ return (send, ended) => { /* start; */ return stop; }; })`.
   Authorize inside the factory with the same checks the rest of your domain
   uses. `send(event, data)` writes a frame; `ended(code)` tells the page the
   channel stopped on its own. Return what stops it; it runs when the
   connection closes.
3. On the page, consume it with `PlatformRealtime.watchChannel`. Embedded
   project panes already share their host's client.

Do **not** create an `EventSource`, a `WebSocket` or a streaming `fetch` in
browser code, and do not write a `text/event-stream` response in a new server
file. `tests/realtime-single-stream.test.ts` fails if either appears, and
names this document. The only exceptions are the third-party calling library,
which signals over its own socket while a call is up, and one-off downloads
that finish.

## What still exists for older clients

`GET .../presence/:scope` and `GET /v1/documents/:documentId/collab/stream`
remain as thin wrappers over the same presence and collaboration sessions.
The portal does not use them. Do not build on them; remove them once nothing
else calls them.

## Not done yet

- One connection per *browser* rather than per tab (a shared worker or a
  leader tab relaying to the others). Each tab currently holds its own stream.
- Channels do not work while the client is in its polling fallback; rosters
  read as empty until the stream comes back, which the client retries every
  three seconds when a channel is being watched.

## Tests

`tests/realtime-single-stream.test.ts` (one connection end to end, and the two
guards), `tests/view-presence-client.test.mjs` and
`tests/platform-realtime-client.test.mjs` (the browser client),
`tests/view-presence*.test.ts`, `tests/documents-collab.test.ts`,
`tests/channels-sse.test.ts`.
