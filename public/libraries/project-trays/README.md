# Project trays

`FirstMateProjectTrays.mount` owns placement and tray lifetime inside the project shell. It reuses `Portal.ProjectNotes`, `FirstMateChannels`, `PlatformAssistant.mountProject`, and the existing project activity APIs. Overview continues to own its details column.

The Notes, Activity and Agent icon tabs appear under the window controls. Enable the organization capability `channels.separate_project_notes` in company settings to add Messages and the project channel Notes tab. The default keeps project notes and messages together.

Notes use Channels messages with reserved `metadata.project_note: true`. Split mode filters these records before pagination and excludes them from message unread counts and notifications. Sharing explicitly posts an audience-preserving forwarded note to the channel and marks the original as shared. Switching the flag off exposes the same stored notes as messages again. Older untagged messages remain messages in split mode; no historical data is rewritten.

The shared Notes workspace supports atomic create-and-pin, pinned notes with expandable content, history pagination, search, audience selection, attachments, audio, replies, editing and revision history, remove/restore, copy, save and explicit channel sharing. Registered `project.note.*` work events feed Activity in split mode; ordinary messages do not.

The project agent uses the global assistant definition, renderer, tools, attachments, transcription, and durable private thread storage. Each person has one conversation per project. Every turn refreshes project/scope context and authorization. The embedded conversation has no independent window or thread controls.

Validation: `npm run check`, `npm run test:publication`, and the `project-trays-api.test.ts` and `project-trays-browser.test.mjs` tests under `public/v1/tests`. The browser test uses real shared components and mocked APIs; the API test mocks the model provider and does not make live model calls.
