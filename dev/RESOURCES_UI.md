# Resources and pane controls

UI-only integration points in editor.php: load project_resources.js and expose resizeEditorPanes after the existing split-ratio helper. Geometry and model serialization are unchanged.

- Click a circular swap button to exchange views. Drag it at least five pixels to resize instead. The smaller circle at the junction changes both splits.
- Resources is a tab in the map pane, and follows that pane when swapped. Expand it for more drawing space.
- Open a saved project, then add/drop reference files (no application-level total file-size cap). Images support pan, wheel zoom, fit, pen, ellipse, rectangle, line, arrow, text, selection/move, color/width changes, deletion, undo/redo, and technician notes.
- Save markup writes an immutable revision beside the media. Switching references or projects saves pending changes first. Refresh fetches other technicians' additions. Original media remains unchanged.
- Videos/audio use browser playback. Mark this frame creates a separate PNG reference, so multiple annotated video frames remain independent. Other file types can be downloaded with Original; PDFs and office documents are not rendered into the drawing canvas.
- The PHP bridge checks the existing internal editor session and forwards only prefixed resource files through the existing QA artifact store, using the server's internal API secret. It never exposes that secret to JavaScript. Resources and markup are not added to customer reports or model data.
- Deploy the API guards together with the PHP/UI files. The guards restrict direct artifact reads/writes, exclude internal files from anonymous artifact lists, and reject public thumbnail derivatives. Restart the isolated API to load changed TypeScript; it is not a watcher. The existing runtime was left running during this work to avoid interrupting the concurrent engine task.

Large media storage:

- The browser sends 8 MB parts with progress and up to three attempts per part. This is a per-request bound, not a file-size cap, so existing web-server and API request limits do not need to be increased.
- Parts are stored as `internal-markup-part-<uuid>-<number>.bin` in the existing artifact store. A small `internal-resource-v2-<uuid>-<name>` JSON index is published only after the server verifies all part sizes. Lists hide unfinished uploads and parts and report the original total size.
- The internal PHP bridge reconstructs downloads as a stream and implements HTTP byte ranges for seeking, including suffix ranges and ranges crossing parts. Memory use is bounded by a part rather than the whole video. Earlier unchunked references still work.
- Total capacity remains subject to available project storage. Interrupted uploads retry automatically in the current browser session; closing the page requires selecting the file again. Abandoned parts remain hidden in artifact storage; automatic garbage collection is not implemented.
- This upload change requires a page reload, not an API restart.

Verification:

- `node dev/resources-check.cjs` runs browser checks against the existing isolated editor, creating synthetic local test projects. It checks all resize gestures, real artifact upload, annotation persistence, and video frame capture. `dev/fixtures/resources-video.webm` is a generated two-second color test clip.
- From public/v1: `node --experimental-sqlite --import tsx --test --test-force-exit tests/project-resources.test.ts` checks internal artifact access and thumbnail bypass protection against an isolated API instance.
- PHP lint, JS syntax checks, and `npm run check` validate the changed sources.

- `node dev/resources-large-check.cjs` uploads a synthetic 160 MB video through the UI, simulates a transient upload failure, verifies the complete download hash and byte ranges, and checks that an incomplete upload cannot be published.

Persistence and shared deployment:

- Uploaded bytes, resource indexes, and markup are server-side project artifacts. No browser storage is used as the source of truth. Opening Resources fetches the project catalogue; Refresh retrieves additions by other technicians.
- Every new part carries a SHA-256 digest. The PHP bridge checks incoming bytes, reads the saved bytes back from the artifact store, and acknowledges only a matching digest. The resource index retains part checksums and downloads validate them. Older resources without checksums remain readable.
- The completed index records the original filename, total size, project ID, and server-supplied uploader identity and UTC timestamp. Markup revisions also record the authenticated saver and project ID. The UI reports files as saved only after publication succeeds.
- This sandbox is explicitly local: start-exteriors.ps1 sets FIRSTMEASURE_ARTIFACT_STORAGE=local and stores projects under .local-runtime/exteriors/data/firstmeasure/projects. Its localhost URL is not accessible from a different computer. Files here are durable on this machine but have not been copied to a shared service.
- For shared deployment, serve the internal editor from a common authenticated application URL. Use the existing QA artifact storage: configure FIRSTMEASURE_ARTIFACT_STORAGE=spaces and the deployment's existing bucket, prefix, endpoint, region and credentials. All application instances must use the same project database and artifact namespace. Do not expose the development router or create a public bucket. The Resources bridge and API access guards must be deployed together.
- Back up/retain the complete project namespace: part objects, completed indexes, markup revisions and the project database. Database backups alone cannot restore the video bytes. Bucket versioning, backup retention, capacity monitoring and restoration checks are deployment responsibilities and were not configured against a live service in this workspace.
- Incomplete-upload garbage collection remains future work. A safe collector must use completed indexes as references, retain in-progress uploads for a grace period, and only remove old unreferenced part UUIDs. Never age-delete parts of completed videos.

Additional verification:

- resources-check.cjs closes the uploader page, opens a clean browser context, verifies exact original bytes, reloads annotations, plays the video, checks persisted uploader metadata, and rejects a bad upload checksum. The local router supplies the same test identity; this tests browser-session independence, not a live second technician account.
- `node dev/resources-shared-storage-check.mjs` runs the actual Spaces adapter in independent writer and reader processes against an isolated S3-compatible test service. It verifies shared retrieval of parts, catalogue and markup and separation of project IDs. This does not claim a live cloud deployment or cross-computer test.

Media-focused viewer redesign:

- One 36 px toolbar; the file list closes after selection. Files, Markup and Notes toggle side trays. Narrow panes use overlay trays, and choosing a drawing tool closes the tray to expose the media. Notes/text inputs are absent until requested.
- Images and live videos share a viewport transform. Fit uses the full available height for portrait media and width for landscape media, preserving aspect ratio. Fill deliberately crops to cover the viewer. Resizing and opening trays refit automatically unless the user has manually zoomed/panned.
- Wheel zoom stays anchored beneath the cursor. Left-drag pans videos and Pan-mode images; middle/right-drag pans while drawing. Double-click or Fit resets the view. Zoom buttons and Fill also work on videos.
- Video playback controls occupy a fixed 34 px strip: play/pause, timeline, time, mute and playback speed. They remain reachable when the video is zoomed or panned. Space plays/pauses with viewer focus; arrow keys seek five seconds.
- Opening Markup pauses the video. Choosing a drawing tool captures an independent frame reference, preserves the zoomed view and exposes a Return to video action that saves pending markup and returns to the captured timestamp. The frame is saved through the existing checksum-verified artifact path.
- `node dev/resources-viewer-check.cjs` checks portrait/landscape layouts, cursor-anchored wheel zoom, pan, persistent transport controls, seeking, Fill, optional trays, frame markup and return to the source timestamp. Existing resource persistence/browser tests also cover the revised drawers.

### Live video scrubbing

Dragging the timeline pauses playback and previews decoded frames before release. Seek requests are coalesced to the latest pointer position, allowing an outstanding seek to decode and paint before starting another. The timeline follows the requested position while decoding catches up; releasing lands at the exact selected time and resumes only if the video was playing beforehand. Media changes discard pending scrubs. The viewer browser check verifies changing decoded pixels while the mouse remains held, final seek accuracy, and pause/resume behavior. Read-only verification against the 194 MB house walkthrough also confirmed intermediate decoded frames during dragging.
### Shared favorite video frames

With a video active, click the Note button in the playback controls or press N while focused within Resources (including during a timeline drag), type a label, then Enter to save. Ordinary typing does not start a favorite, and N remains normal input inside text fields. Starting a note freezes the requested timestamp and waits for decoding before capturing a full-resolution PNG. Playback resumes after saving only if it was playing before typing or scrubbing. Escape cancels and restores playback. Existing text fields and other editor panes retain their keyboard behavior.

The Frames tray lists thumbnails and labels by timestamp. Open a thumbnail to mark it up; Jump to video returns to its source timestamp. Each favorite is an independent internal-markup-favorite UUID JSON record linking label, exact timestamp, source video and PNG artifact, published after the PNG upload is verified. This uses the existing internal QA artifact store. Concurrent additions have separate IDs; failed saves retain the label for retry. Markup records also retain source-video provenance. Refresh project files loads favorites added by other technicians. Reloading the project retrieves favorites from storage, without browser-local persistence.

Run node dev/resources-favorites-check.cjs to verify keyboard creation, paused and playing behavior, creation during an active scrub, persisted timestamps and images in a fresh browser session, and source-video return.
