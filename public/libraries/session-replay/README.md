# Session replay library

Records a web page as a DOM snapshot plus changes, and replays it without video. Architecture, wire format and limits:
[docs/architecture/session-replay.md](../../../docs/architecture/session-replay.md).

| File | Role |
| --- | --- |
| `session-replay-codec.js` | Wire format shared by every part: tokens, templates, content addresses, pointer paths. Works in browsers and Node. |
| `session-replay-recorder.js` | The recorder. Generic: needs a transport. |
| `session-replay-loader.js` | FirstMate binding, loaded by `platform-api.js`: asks the platform whether to record, provides the transport and `window.FMReplay`. |
| `session-replay-player.js` | Rebuilds and plays a recording in a sandboxed iframe. |
| `viewer.html`, `session-replay-viewer.js`, `session-replay-viewer.css` | The replay viewer for platform administrators. |

Finished sessions are archived on the server (`public/v1/session-replay/archive.ts`); the chunks endpoint restores them
exactly, so nothing here changes for archived sessions.

Recording anywhere else (an extension, another site):

```js
const recorder = FMReplayRecorder.create({
  sessionId, pageId,
  transport: {
    sendChunk: async (item) => ({ ok: true }),   // item.json, or item.data (gzip, base64) once compressed
    missingBlobs: async (keys) => keys,          // which content addresses the store lacks
    sendBlob: async ({ key, data }) => ({ ok: true }),
    beacon: (item) => {}                          // last chance while the page unloads
  }
});
recorder.start();
```

When a file here changes, bump its `?v=` in `session-replay-loader.js` (recorder and codec), `viewer.html` (player,
viewer, codec) or `platform-api.js` (loader).
