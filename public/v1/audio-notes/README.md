# Audio notes

Audio notes are regular Channels messages with three coordinated pieces:

- `text` is the searchable transcript. Agents and existing message search read it
  without any audio-specific logic.
- The original recording is a normal Channels attachment.
- `metadata.audio_note` contains waveform presentation data:

```json
{
  "version": 1,
  "duration_seconds": 18.42,
  "peaks": [0.12, 0.44, 0.81],
  "transcription_model": "gpt-4o-transcribe"
}
```

## Server API

`POST /v1/audio-notes/organizations/:orgId/transcriptions` accepts authenticated
`multipart/form-data` with a required `file` and optional `language` and `prompt`
fields. It returns:

```json
{
  "ok": true,
  "transcription": {
    "text": "Searchable transcript",
    "model": "gpt-4o-transcribe",
    "usage": {}
  }
}
```

The server calls OpenAI so API keys never reach the browser. Configure
`OPENAI_API_KEY`; optionally override `OPENAI_TRANSCRIPTION_MODEL` and
`OPENAI_TRANSCRIPTION_TIMEOUT_MS`.

The reusable provider wrapper is `audio-notes/transcription.ts`. It validates
supported audio types and the 25 MB application limit before calling OpenAI.

## Browser library

`libraries/audio-notes/audio-notes.js` exposes `window.FirstMateAudioNotes`:

- `record(options)` records and returns a `File`, duration, and waveform peaks.
- `recordInline({ mount })` records directly inside a composer.
- `transcribe(orgId, file, options)` calls the authenticated server endpoint.
- `prepare(orgId, channelId, options)` records, transcribes, and uploads.
- `prepareInline(orgId, channelId, { mount, onRemove })` runs the inline
  record → transcribe → attach flow while rendering each state in `mount`.
- `createPlayer(options)` creates the interactive waveform player.
- `playerHtml(options)` plus `hydrate(container)` supports string-rendered hosts.

`prepare()` returns `{ text, attachment, metadata }`. Post `text` as the normal
message body, `attachment.id` in `attachment_ids`, and
`{ audio_note: metadata }` as message metadata.
