import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { audioMediaPublicUrl, validAudioMediaToken } from "../audio-notes/links.js";
import { defaultChatSettings } from "../chat/service.js";
import { defaultCommsSettings, normalizeCommsSettings } from "../comms/settings.js";

test("voice-message defaults favor audio for chat/SMS and dictation for email", () => {
  assert.equal((defaultChatSettings().voice as Record<string, unknown>).mode, "attachment");
  assert.deepEqual(defaultCommsSettings().voice, { sms: "attachment", email: "dictation" });
  assert.deepEqual(normalizeCommsSettings({ voice: { sms: "dictation", email: "off" } }).voice, {
    sms: "dictation",
    email: "off"
  });
});

test("public audio links are signed and scoped to organization and media", () => {
  const url = new URL(audioMediaPublicUrl("org_voice", "media_voice"));
  const parts = url.pathname.split("/");
  const token = parts.at(-1) || "";
  assert.equal(validAudioMediaToken("org_voice", "media_voice", token), true);
  assert.equal(validAudioMediaToken("org_other", "media_voice", token), false);
  assert.equal(validAudioMediaToken("org_voice", "media_other", token), false);
});

test("communications surfaces expose labeled inline voice controls", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const [inbox, project, widget] = await Promise.all([
    readFile(path.join(root, "libraries/apps/chat/app.js"), "utf8"),
    readFile(path.join(root, "libraries/apps/comms/project.js"), "utf8"),
    readFile(path.join(root, "libraries/chat-embed/firstmate-chat-embed.js"), "utf8")
  ]);
  assert.match(inbox, /data-voice/);
  assert.match(inbox, /Attach audio/);
  assert.match(project, /data-co-sms-voice/);
  assert.match(project, /data-co-email-voice[\s\S]*Dictate/);
  assert.match(project, /data-co-chat-voice/);
  assert.match(widget, /Attach audio message/);
  assert.match(widget, /fmce-voice-mount/);
});
