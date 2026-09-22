import test from "node:test";
import assert from "node:assert/strict";

import {
  AUDIO_NOTE_MAX_BYTES,
  transcribeAudio,
  validateAudio
} from "../audio-notes/transcription.js";

test("audio transcription sends the supported OpenAI multipart contract", async () => {
  const requestState: { current: RequestInit | null } = { current: null };
  const result = await transcribeAudio({
    bytes: Buffer.from("test audio"),
    fileName: "note.webm",
    contentType: "audio/webm"
  }, {
    apiKey: "test-key",
    model: "gpt-4o-transcribe",
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
      requestState.current = init ?? null;
      return new Response(JSON.stringify({
        text: "The roof inspection starts at seven.",
        usage: { type: "duration", seconds: 3 }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  assert.equal(result.text, "The roof inspection starts at seven.");
  assert.equal(result.model, "gpt-4o-transcribe");
  const request = requestState.current as RequestInit;
  assert.equal((request.headers as Record<string, string>).Authorization, "Bearer test-key");
  assert.ok(request.body instanceof FormData);
  assert.equal((request.body as FormData).get("model"), "gpt-4o-transcribe");
  assert.equal((request.body as FormData).get("response_format"), "json");
});

test("audio validation rejects unsupported and oversized uploads", () => {
  assert.throws(() => validateAudio({
    bytes: Buffer.from("not audio"),
    fileName: "notes.txt",
    contentType: "text/plain"
  }), /Use an FLAC/);

  assert.throws(() => validateAudio({
    bytes: Buffer.alloc(AUDIO_NOTE_MAX_BYTES + 1),
    fileName: "too-large.webm",
    contentType: "audio/webm"
  }), /25 MB/);
});
