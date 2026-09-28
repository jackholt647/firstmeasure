# Voice action icons

Use `record.svg` (plain microphone) for an audio recording or attachment.
Use `dictation.svg` (microphone with text lines) when speech becomes text,
including direct transcription and instructions for an AI.

Both are shared 24 × 24 SVG assets. Render as a `currentColor` CSS mask,
with `width:1em;height:1em`, so controls inherit their size and theme.
Decorative icons are `aria-hidden`; label the button with its action.
External chat embeds use an image from the configured service origin.
Call mute/unmute controls retain their separate microphone state icons.

Channels uses `FirstMateAudioNotes.prepareInline` with `mode:'dictation'`
to return text without uploading an attachment, and `mode:'record'` to
upload audio without requesting transcription. The default mode retains
the existing audio-plus-transcript behavior for other consumers.
