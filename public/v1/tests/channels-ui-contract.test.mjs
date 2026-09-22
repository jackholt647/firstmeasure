import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

async function loadLibrary(relativePath, windowShim = {}) {
  const source = await readFile(new URL(relativePath, root), 'utf8');
  const window = { __APP: {}, ...windowShim };
  vm.runInNewContext(source, { window, Date, Math, Set, Map, String, Array, Object, Number, JSON, Promise, console, URLSearchParams, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent });
  return window;
}

test('channels-ui exposes the embeddable factory with per-instance feature toggles', async () => {
  const window = await loadLibrary('libraries/channels-ui/channels-ui.js');
  const lib = window.FirstMateChannels;
  assert.ok(lib, 'window.FirstMateChannels is defined');
  assert.equal(typeof lib.create, 'function');
  // The instantiation contract: every Slack-style capability is a toggle so
  // surfaces (Channels tab vs project-notes embed) can turn features off.
  for (const feature of ['threads', 'reactions', 'dms', 'attachments', 'audioNotes', 'pins', 'saved', 'editHistory', 'deleteRestore', 'typing', 'search', 'channelCreate', 'channelSettings', 'audienceSelector']) {
    assert.ok(feature in lib.DEFAULT_FEATURES, `feature toggle ${feature} exists`);
  }
});

test('all Channels sidebar message groups are collapsible and remember their state', async () => {
  const ui = await readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8');
  for (const group of ['channels', 'dms', 'projects']) {
    assert.match(ui, new RegExp(`key: '${group}'`), `${group} group is rendered through the shared collapsible section`);
  }
  assert.match(ui, /collapsedGroups: loadCollapsedGroups\(\)/);
  assert.match(ui, /fm_channels_collapsed_groups_v1/);
  assert.match(ui, /aria-expanded/);
  assert.match(ui, /fm-ch-side-items/);
  assert.match(ui, /fm-ch-group-badge/);
  assert.match(ui, /head\.addEventListener\('click', toggleGroup\)/);
  assert.match(ui, /event\.stopPropagation\(\);\s*group\.add\(\)/);
  assert.match(
    ui,
    /head\.appendChild\(title\);[\s\S]*if \(group\.add\)[\s\S]*head\.appendChild\(addBtn\);[\s\S]*head\.appendChild\(toggle\);/,
    'the collapse control is the final header action, after the add button when present',
  );
});

test('integrated Channels routes attention views into the conversation overlay', async () => {
  const [ui, app, core] = await Promise.all([
    readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8'),
    readFile(new URL('libraries/apps/channels/app.js', root), 'utf8'),
    readFile(new URL('portal/scripts/core.js', root), 'utf8')
  ]);
  assert.match(ui, /mode === 'list' && typeof options\.onOpenView === 'function'/);
  assert.match(ui, /openView\(view\)/);
  assert.match(app, /function openOverlayView\(view\)/);
  assert.match(app, /openView: openOverlayView/);
  assert.match(core, /onOpenView\(view\)[\s\S]*FirstMateChannelsOverlay\?\.openView\?\.\(view\)/);
});

test('integrated conversations are flush, lightly styled, and support a persistent Starred section', async () => {
  const [ui, app] = await Promise.all([
    readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8'),
    readFile(new URL('libraries/apps/channels/app.js', root), 'utf8')
  ]);
  assert.match(ui, /\.fm-ch--conversation\{border:none;border-radius:0\}/);
  assert.match(ui, /section\.id === 'starred'/);
  assert.match(ui, /title:'Starred'/);
  assert.match(ui, /toggleStarredChannel/);
  assert.match(ui, /api\.sidebarSections\.save\(orgId, 'starred'/);
  assert.match(ui, /starButton\.setAttribute\('aria-pressed'/);
  assert.match(ui, /Added to Starred/);
  assert.match(app, /\.fm-channels-overlay-actions button\{appearance:none;border:0;background:transparent;box-shadow:none/);
});

test('workflow shortcuts align consistently and stale huddle refreshes cannot reopen a left session', async () => {
  const ui = await readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8');
  assert.match(ui, /\.fm-ch-workflow-list\{display:flex;flex-direction:column;gap:10px\}/);
  assert.match(ui, /\.fm-ch-workflow-list \.fm-ch-resource\{width:100%;align-items:flex-start;gap:14px/);
  assert.match(ui, /const shortcuts = el\('div', 'fm-ch-workflow-list'\)/);
  assert.match(ui, /const expectedHuddleId = state\.huddle\.id/);
  assert.match(ui, /if \(state\.huddle\?\.id !== expectedHuddleId\) return/);
  assert.match(ui, /stream = await navigator\.mediaDevices\.getUserMedia[\s\S]*api\.huddles\.create/);
  assert.match(ui, /const huddleId = state\.huddle\?\.id/);
  assert.match(ui, /finally \{[\s\S]*if \(state\.huddle\?\.id === huddleId\) stopHuddleSession\(\)/);
});

test('huddles use the calls plane, resize, expose participants, and retain optional video', async () => {
  const [ui, app, core, settings, api, callsApi, schemas, callsService] = await Promise.all([
    readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8'),
    readFile(new URL('libraries/apps/channels/app.js', root), 'utf8'),
    readFile(new URL('portal/scripts/core.js', root), 'utf8'),
    readFile(new URL('libraries/apps/settings/channels.js', root), 'utf8'),
    readFile(new URL('libraries/channels-api/channels-api.js', root), 'utf8'),
    readFile(new URL('libraries/calls-api/calls-api.js', root), 'utf8'),
    readFile(new URL('v1/channels/schemas.ts', root), 'utf8'),
    readFile(new URL('v1/calls/service.ts', root), 'utf8')
  ]);
  assert.match(ui, /FirstMateWindows\.attach/);
  assert.match(ui, /function detachCall\(\)/);
  assert.match(ui, /huddleWindow\?\.setMode/);
  assert.match(ui, /share = el\('button', '', '<i class="fas fa-desktop"><\/i>'\)/);
  assert.match(ui, /function startHuddleRecording\(\)/);
  assert.match(ui, /function finishHuddleRecording\(\)/);
  assert.match(ui, /function channelHuddleDefaults\(channel = state\.activeChannel\)/);
  assert.match(ui, /Record huddles by default/);
  assert.match(ui, /Include video and shared screens by default/);
  assert.match(ui, /Recording for this huddle/);
  assert.match(ui, /await startHuddle\(\{ recordingEnabled, recordVideo \}\)/);
  assert.match(ui, /recording_enabled:Boolean\(recordingEnabled\)/);
  assert.doesNotMatch(ui, /Â·/);
  assert.match(ui, /function connectLiveKitHuddle\(connection, stream\)/);
  assert.match(ui, /attachHuddleCompositeVideo\(recording\)/);
  assert.match(ui, /fm-ch-huddle-roster/);
  assert.match(app, /FirstMateWindows\.attach/);
  assert.match(ui, /api\.huddles\.recording\(orgId, recording\.huddleId, uploaded\.attachment\.id\)/);
  assert.match(ui, /fm-ch-huddle-recording/);
  assert.match(app, /recording: enabled\('recording', false\)/);
  assert.match(app, /recordVideo: enabled\('record_video', true\)/);
  assert.match(core, /recording: !!flags\.has\?\.\('channels', 'recording', false\)/);
  assert.match(settings, /Include video and shared screens/);
  assert.match(settings, /'channels\.recording': enabled,[\s\S]*'channels\.record_video': Boolean\(recordHuddleVideo\?\.checked\)/);
  assert.match(settings, /rawVideoRecording === undefined[\s\S]*videoRecordingDefault !== false/);
  assert.match(settings, /capabilities\?\.update\?\.\(\{ 'channels\.record_video': enabled \}\)/);
  assert.match(api, /recording: \(orgId, huddleId, attachmentId\)/);
  assert.match(api, /mediaState: \(orgId, huddleId, input\)/);
  assert.match(callsApi, /root\.CallsAPI = api/);
  assert.match(callsService, /providerJoinConfiguration/);
  assert.match(schemas, /recording_enabled: z\.boolean\(\)\.default\(false\)/);
});

test('attention views provide filters, grouped unreads, participated threads, and huddle activity', async () => {
  const [ui, api, service, collaboration] = await Promise.all([
    readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8'),
    readFile(new URL('libraries/channels-api/channels-api.js', root), 'utf8'),
    readFile(new URL('v1/channels/service.ts', root), 'utf8'),
    readFile(new URL('v1/channels/collaboration.ts', root), 'utf8')
  ]);
  assert.match(ui, /data-activity-filter/);
  assert.match(ui, /huddle_started:\['Huddle started'/);
  assert.match(ui, /\.fm-ch-attention-heading\{display:flex;align-items:baseline;gap:10px/);
  assert.match(ui, /\.fm-ch-attention-actions\{display:flex;align-items:center;justify-content:flex-end/);
  assert.match(ui, /\.fm-ch-attention-actions \.fm-ch-icon-btn\{[\s\S]*background:#e2ebf5;color:#244f78/);
  assert.match(ui, /const showPreview = previewText && previewText\.toLocaleLowerCase\(\) !== label\.toLocaleLowerCase\(\)/);
  assert.match(ui, /read\.setAttribute\('aria-label', 'Mark activity read'\)/);
  assert.match(ui, /fm-ch-unread-group/);
  assert.match(ui, /fm-ch-thread-card/);
  assert.match(api, /readAll: \(orgId\)/);
  assert.match(api, /markRead: \(orgId, rootMessageId, lastReplySeq\)/);
  assert.match(service, /listParticipatedThreadRows/);
  assert.match(collaboration, /recordChannelEventAttention/);
});

test('the DM picker loads organization teammates and uses full-row multi-select controls', async () => {
  const ui = await readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8');
  assert.match(ui, /platform\.users\.list\(orgId\)/);
  assert.match(ui, /Choose one teammate for a direct message, or select multiple people to start a group conversation\./);
  assert.match(ui, /fm-ch-member-row fm-ch-member-choice/);
  assert.match(ui, /\.fm-ch-member-choice\+\.fm-ch-member-choice\{margin-top:5px\}/);
  assert.match(ui, /rowNode\.setAttribute\('aria-pressed', nextSelected \? 'true' : 'false'\)/);
  assert.match(ui, /class="fas fa-check"/);
  assert.doesNotMatch(ui, /fm-ch-member-row'[\s\S]{0,300}<input type="checkbox">/);
});

test('channels API client covers the messaging surface', async () => {
  const window = await loadLibrary('libraries/channels-api/channels-api.js');
  const api = window.ChannelsAPI;
  assert.ok(api, 'window.ChannelsAPI is defined');
  assert.equal(typeof api.channels.ensureProject, 'function');
  assert.equal(typeof api.messages.revisions, 'function', 'edit history endpoint');
  assert.equal(typeof api.messages.restore, 'function', 'soft-delete recovery endpoint');
  assert.equal(typeof api.messages.react, 'function');
  assert.equal(typeof api.messages.thread, 'function');
  assert.equal(typeof api.messages.translate, 'function', 'cached message translation endpoint');
  assert.equal(typeof api.preferences.get, 'function', 'viewer translation preferences endpoint');
  assert.equal(typeof api.readState.unreads, 'function');
  assert.equal(typeof api.readState.markUnread, 'function');
  assert.equal(typeof api.readState.markAllRead, 'function');
  assert.equal(typeof api.activity.list, 'function');
  assert.equal(typeof api.activity.readAll, 'function');
  assert.equal(typeof api.threads.list, 'function');
  assert.equal(typeof api.threads.markRead, 'function');
  assert.equal(typeof api.drafts.save, 'function');
  assert.equal(typeof api.scheduled.create, 'function');
  assert.equal(typeof api.reminders.create, 'function');
  assert.equal(typeof api.tabs.list, 'function');
  assert.equal(typeof api.resources.list, 'function');
  assert.equal(typeof api.huddles.create, 'function');
  assert.equal(typeof api.huddles.recording, 'function');
  assert.equal(typeof api.huddles.mediaState, 'function');
  assert.equal(typeof api.huddles.signal, 'function');
  assert.equal(typeof api.saved.add, 'function');
  assert.equal(typeof api.uploads.send, 'function');
  assert.equal(typeof api.search, 'function');
});

test('channel and project-note surfaces expose compact reversible translations', async () => {
  const [channels, notes, settings] = await Promise.all([
    readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8'),
    readFile(new URL('libraries/project-notes/project-notes.js', root), 'utf8'),
    readFile(new URL('libraries/apps/settings/company.js', root), 'utf8')
  ]);
  assert.match(channels, /data-act="translate"/);
  assert.match(channels, /Show original message/);
  assert.match(channels, /translation\.auto_translate/);
  assert.match(notes, /dataset\.pnTranslate/);
  assert.match(notes, /Translated from/);
  assert.match(settings, /Show translations automatically/);
  assert.match(settings, /Save my settings/);
});

test('audio notes are loaded before channel and project-note surfaces', async () => {
  const [audio, channels, notes, portal] = await Promise.all([
    readFile(new URL('libraries/audio-notes/audio-notes.js', root), 'utf8'),
    readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8'),
    readFile(new URL('libraries/project-notes/project-notes.js', root), 'utf8'),
    readFile(new URL('portal/index.php', root), 'utf8')
  ]);
  for (const method of ['record', 'recordInline', 'transcribe', 'prepare', 'prepareInline', 'createPlayer', 'mountPrepared', 'playerHtml', 'hydrate']) {
    assert.match(audio, new RegExp(`\\b${method}\\b`), `audio-note library exposes ${method}`);
  }
  assert.match(channels, /FirstMateAudioNotes\.prepareInline/);
  assert.match(channels, /metadata:\{ audio_note:state\.pendingAudioNote \}/);
  assert.match(notes, /recordAudio/);
  assert.match(notes, /audioPlayerHtml/);
  assert.match(portal, /channels-api\/channels-api\.js[\s\S]*audio-notes\/audio-notes\.js[\s\S]*channels-ui\/channels-ui\.js/);
});

test('audio-note time labels reject non-finite browser metadata', async () => {
  const source = await readFile(new URL('libraries/audio-notes/audio-notes.js', root), 'utf8');
  const document = {
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: '', id: '' }),
    head: { appendChild: () => {} }
  };
  const window = {};
  vm.runInNewContext(source, {
    window, document, Date, Math, Set, Map, String, Array, Object, Number, JSON,
    Promise, console, URLSearchParams, setTimeout, clearTimeout
  });
  assert.equal(window.FirstMateAudioNotes.formatTime(Infinity), '0:00');
  assert.equal(window.FirstMateAudioNotes.formatTime(Number.NaN), '0:00');
  assert.equal(window.FirstMateAudioNotes.formatTime(65), '1:05');
});

test('platform realtime client is a shared, topic-filtered subscription hub', async () => {
  const window = await loadLibrary('libraries/platform-realtime/platform-realtime.js');
  const realtime = window.PlatformRealtime;
  assert.ok(realtime, 'window.PlatformRealtime is defined');
  assert.equal(typeof realtime.subscribe, 'function');
  const unsubscribe = realtime.subscribe('', 'channels.', () => {});
  assert.equal(typeof unsubscribe, 'function', 'subscribe returns an unsubscribe handle even for invalid input');
});

test('project-notes keeps its original UI while the model is channels-backed', async () => {
  const [notes, host, materials, order, calls, portal, manifest, photos] = await Promise.all([
    readFile(new URL('libraries/project-notes/project-notes.js', root), 'utf8'),
    readFile(new URL('libraries/apps/project-request/app.js', root), 'utf8'),
    readFile(new URL('libraries/apps/materials/project.js', root), 'utf8'),
    readFile(new URL('libraries/apps/firstmeasure/order/app.js', root), 'utf8'),
    readFile(new URL('libraries/apps/calls/app.js', root), 'utf8'),
    readFile(new URL('portal/index.php', root), 'utf8'),
    readFile(new URL('libraries/apps/firstmate-apps-manifest.js', root), 'utf8'),
    readFile(new URL('libraries/apps/photos/project.js', root), 'utf8')
  ]);

  // The shared model keeps its original API surface but talks to /v1/channels.
  const window = { __APP: {}, Portal: {} };
  const vmContext = { window, Date, Math, Set, Map, String, Array, Object, Number, JSON, Promise, console, CustomEvent: class {}, setTimeout, clearTimeout };
  const vmModule = await import('node:vm');
  vmModule.runInNewContext(notes, vmContext);
  const api = window.Portal.ProjectNotes;
  for (const method of ['add', 'update', 'remove', 'all', 'visible', 'owns', 'canSee', 'renderTypeTags', 'visibilityLabel']) {
    assert.equal(typeof api[method], 'function', `original API method ${method} survives`);
  }
  for (const method of ['load', 'flush', 'timeline', 'restore', 'revisions', 'replies', 'reply', 'bindHistoryExtras']) {
    assert.equal(typeof api[method], 'function', `channels-backed addition ${method} exists`);
  }
  assert.match(notes, /ChannelsAPI/);
  assert.match(notes, /ensureProject/);
  assert.match(notes, /prepareUpload/);
  assert.match(notes, /mountPreparedUpload/);
  assert.match(notes, /mediaAttachmentsHtml/);
  assert.match(notes, /fm:project-note-media-uploaded/);
  assert.match(photos, /fm:project-note-media-uploaded/);
  assert.match(photos, /hydrateOwnedProjectMedia\(\)/);
  assert.match(photos, /isVisualMediaRecord/);
  assert.doesNotMatch(notes, /project_note_items\s*=/, 'the model never writes project-document note arrays');

  // The original note panel markup is intact (history deck, composer shell,
  // visibility menu) — the UI was preserved, only the data layer moved.
  assert.match(order, /id="rProjectNoteHistoryDeck"/);
  assert.match(order, /class="r-note-composer-shell"/);
  assert.match(order, /id="rProjectNoteVisibility"/);
  assert.match(order, /id="rProjectNoteUpload"/);
  assert.match(order, /id="rProjectNoteUploadInput"/);
  assert.match(order, /Who can see it\?/);
  assert.match(order, />History<\/span>/);
  assert.doesNotMatch(order, /rProjectChannelsMount/);

  // Primary project modal: original renderer + placement machinery, with the
  // subtle channels extras (edit history, restore, replies) delegated in.
  assert.match(host, /renderProjectNoteHistory/);
  assert.match(host, /syncProjectNotesPlacement/);
  assert.match(host, /data-project-note-edit/);
  assert.match(host, /bindHistoryExtras/);
  assert.match(host, /timeline/);
  assert.match(host, /fm:project-notes:refreshed/);
  assert.match(host, /prepareUpload/);
  assert.doesNotMatch(host, /ensureProjectChannelsEmbed/);

  // Scope/materials left rail keeps its original compose + list UI.
  assert.match(materials, /data-mt-note-save/);
  assert.match(materials, /data-mt-note-visibility/);
  assert.match(materials, /data-mt-note-upload/);
  assert.match(materials, /data-mt-note-upload-input/);
  assert.match(materials, /bindHistoryExtras/);
  assert.doesNotMatch(materials, /data-mt-channels-notes/);

  // Calls dialer reads notes through the shared model (channels-backed).
  assert.match(calls, /noteApi/);
  assert.match(calls, /fetchProjectNotes/);
  assert.match(calls, /call_note/);

  // The portal loads the channels libraries, then the notes model on top.
  assert.match(portal, /platform-realtime\/platform-realtime\.js/);
  assert.match(portal, /channels-api\/channels-api\.js/);
  assert.match(portal, /channels-ui\/channels-ui\.js/);
  assert.match(portal, /apps\/channels\/app\.js/);
  assert.match(portal, /settings\/channels\.js/);
  assert.match(portal, /channels-api\/channels-api\.js[\s\S]*project-notes\/project-notes\.js/, 'notes model loads after its API client');

  // Manifest: Channels portal tab registered; note surfaces bundle the model.
  assert.match(manifest, /'portal\.channels': 'apps\.channels'/);
  assert.match(manifest, /portalTabId: 'channels'/);
  assert.match(manifest, /channelThread/);
  assert.match(manifest, /project-notes\/project-notes\.js/);
});

test('channels UI uses FontAwesome icons and platform design tokens, not emoji chrome', async () => {
  const ui = await readFile(new URL('libraries/channels-ui/channels-ui.js', root), 'utf8');
  assert.match(ui, /--primary-readable/);
  assert.match(ui, /--primary-rgb/);
  for (const icon of ['fa-hashtag', 'fa-lock', 'fa-diagram-project', 'fa-thumbtack', 'fa-bookmark', 'fa-face-smile', 'fa-pen', 'fa-trash', 'fa-xmark', 'fa-paperclip', 'fa-magnifying-glass', 'fa-gear']) {
    assert.match(ui, new RegExp(icon), `uses ${icon}`);
  }
  // Emoji belong in the reaction picker data only — never as UI chrome.
  const withoutPicker = ui.replace(/const EMOJI_SET[\s\S]*?\];/, '');
  for (const emoji of ['📁', '📌', '🔖', '✕', '🙂', '📎', '🔍', '👥', '⚙️', '🗑️', '✏️', '💬', '🔒', '⏳', '📑']) {
    assert.ok(!withoutPicker.includes(emoji), `no ${emoji} outside the emoji picker data`);
  }
});

test('left-column modes support a configurable default and can collapse to a headerless Channels-only layout', async () => {
  const [portal, core, definitions, company] = await Promise.all([
    readFile(new URL('portal/index.php', root), 'utf8'),
    readFile(new URL('portal/scripts/core.js', root), 'utf8'),
    readFile(new URL('v1/platform/capability_defs.ts', root), 'utf8'),
    readFile(new URL('libraries/apps/settings/company.js', root), 'utf8')
  ]);
  assert.match(definitions, /key: "platform\.left_column_apps"[\s\S]*?default: true/);
  assert.match(definitions, /key: "platform\.left_column_default_mode"[\s\S]*?default: "apps"[\s\S]*?\["channels", "Channels"\]/);
  assert.match(company, /key: 'platform\.left_column_apps'/);
  assert.match(company, /key: 'platform\.left_column_default_mode'[\s\S]*?\['channels', 'Channels'\]/);
  assert.match(core, /flags\.has\?\.\('platform', 'left_column_apps', true\)/);
  assert.match(core, /flags\?\.value\?\.\('platform', 'left_column_default_mode', 'apps'\)/);
  assert.match(core, /sidebarModeUserSelected && available\.some/);
  assert.match(core, /sidebar-modes-switchable', available\.length > 1/);
  assert.match(portal, /\.sidebar\.sidebar-modes-switchable \.sidebar-mode-tabs/);
  assert.match(portal, /\.sidebar:not\(\.apps-list-enabled\) #sidebarAppsTab/);
});

test('the configurable New button can be turned off on desktop and mobile', async () => {
  const [portal, definitions, company] = await Promise.all([
    readFile(new URL('portal/index.php', root), 'utf8'),
    readFile(new URL('v1/platform/capability_defs.ts', root), 'utf8'),
    readFile(new URL('libraries/apps/settings/company.js', root), 'utf8')
  ]);
  assert.match(definitions, /key: "platform\.new_button_mode"[\s\S]*?\["off", "Off"\]/);
  assert.match(company, /key: 'platform\.new_button_mode'[\s\S]*?\['off', 'Off'\]/);
  assert.match(portal, /fieldOnly \|\| mode === 'off'/);
  assert.match(portal, /wrap\.hidden = unavailable/);
  assert.match(portal, /mobileBtn\.hidden = unavailable/);
});

test('mention notifications deep-link into channels and project messages', async () => {
  const [topbar, channelsApp, company] = await Promise.all([
    readFile(new URL('portal/scripts/topbar.js', root), 'utf8'),
    readFile(new URL('libraries/apps/channels/app.js', root), 'utf8'),
    readFile(new URL('libraries/apps/settings/company.js', root), 'utf8')
  ]);
  assert.match(topbar, /openChannelMessageNotification/);
  assert.match(topbar, /open_channel_message/);
  assert.match(topbar, /open_project_message/);
  assert.match(topbar, /projectNote:noteId \|\| null/, 'project message mentions reuse the projectNote reveal route');
  assert.match(channelsApp, /fm:open-channel-message/);
  assert.match(channelsApp, /registerPortalApp/);
  // Company settings hosts the Channels pane and the deep-link event.
  assert.match(company, /renderChannelsSettings/);
  assert.match(company, /fm:open-channels-settings/);
  assert.match(company, /FirstMateChannelsSettings/);
});

test('mention notifications are not consumed as empty celebration records', async () => {
  const source = await readFile(new URL('libraries/platform-notifications/platform-notifications.js', root), 'utf8');
  const statePatches = [];
  const window = {
    PlatformAPI: { notifications: {
      list: async () => ({ notifications: [{
        id: 'notification_mention_1',
        kind: 'mention',
        celebration: {},
        created_at: '2026-07-15T21:05:37.304Z',
        user_state: { completed_at: '2026-07-15T21:05:37.361Z' }
      }] }),
      setUserState: async (_orgId, notificationId, patch) => {
        statePatches.push({ notificationId, patch });
        return { state: patch };
      }
    } },
    PlatformCelebrations: { loadConfig: async () => null, fromNotification: () => null }
  };
  vm.runInNewContext(source, { window, Date, Set, String, Array, Object, Number, Promise, setTimeout });
  const state = await window.PlatformNotifications.load('org_1');
  assert.equal(state.notifications.length, 1);
  assert.equal(state.unread_count, 1);
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0].patch.completed, false);
});
