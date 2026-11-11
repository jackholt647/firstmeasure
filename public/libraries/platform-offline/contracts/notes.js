/* public/libraries/platform-offline/contracts/notes.js
 *
 * Project notes offline (docs/architecture/offline.md, "What works offline").
 *
 * A project's notes are messages in the project's channel. The page makes `client_msg_id`, and the server
 * answers a repeat of it with the message it already has, so a queued note arrives once. Two routes carry a
 * note: by channel, when the device knows the channel, and by project, for a project made on this device whose
 * channel the server has not made yet (its notes are kept under a local channel id, `chan_local_<project>`).
 *
 * A note's file is an upload of its own (`note.upload`) with ids the page made, in a scope of its own; the note
 * names the attachment, so the engine sends the note after the file (`after`) and holds it while the file has
 * not arrived. Replies, voice notes, edits and pins need a connection, and so do files on a project made on this
 * device (its channel does not exist yet).
 */
(function () {
  'use strict';

  const CHANNELS = '/v1/channels/organizations/:org';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const base = (ctx) => `/v1/channels/organizations/${enc(ctx.org)}`;
  const notesUrl = (ctx, channel) => `${base(ctx)}/channels/${enc(channel)}/messages?limit=200&view=notes`;
  const localChannelId = (projectId) => 'chan_local_' + projectId;

  /** What the notes tray, the messages tray and the composer read for one channel. */
  function channelReads(ctx, channel) {
    const c = enc(channel);
    return [
      `${base(ctx)}/channels/${c}/messages?limit=200&view=notes`,
      `${base(ctx)}/channels/${c}/pins?view=notes`,
      `${base(ctx)}/channels/${c}/note-authors`,
      `${base(ctx)}/channels/${c}/messages?limit=60`,
      `${base(ctx)}/drafts/${enc('channel:' + channel)}`,
      `${base(ctx)}/collaboration-preferences`,
      `${base(ctx)}/scheduled-messages`
    ];
  }

  const attachmentIds = (body) => (Array.isArray(body && body.attachment_ids) ? body.attachment_ids.map(text).filter(Boolean) : []);
  /** The waiting upload that makes an attachment, as it answered the page, or null. */
  async function waitingAttachment(ctx, id) {
    const made = (await ctx.queued(id)).find((entry) => entry.write === 'note.upload' && entry.response && entry.response.attachment);
    return made ? made.response.attachment : null;
  }
  /**
   * A note this device can keep: text the page wrote, with its own id, that is not a reply. Its files, if any,
   * are uploads still waiting here (a file the server already has is named by an id the device knows nothing of).
   */
  async function plainNote(ctx) {
    const body = ctx.body;
    if (!(isObject(body) && body.project_note === true && !!text(body.client_msg_id) && !body.parent_id)) return false;
    for (const id of attachmentIds(body)) if (!(await waitingAttachment(ctx, id))) return false;
    return true;
  }
  /** A plain note of a project made on this device: its channel does not exist yet, so it carries no file. */
  const plainNoteNoFiles = (ctx) => { const body = ctx.body; return isObject(body) && body.project_note === true && !!text(body.client_msg_id) && !body.parent_id && !attachmentIds(body).length; };

  /** The form of a note's file as the page sends it (channels-api.js uploads.send with deviceIds), or null. */
  function noteFile(ctx) {
    const body = isObject(ctx.body) ? ctx.body : {};
    const field = Object.keys(body).find((name) => body[name] && typeof body[name] === 'object' && body[name].blob);
    const attachment = text(body.attachment_id), media = text(body.media_id), channel = text(body.channel_id);
    if (!field || !/^att_[a-z0-9-]{16,64}$/.test(attachment) || !/^media_[a-f0-9]{16}$/.test(media) || !channel || channel.startsWith('chan_local_')) return null;
    return { field, file: body[field], attachment, media, channel };
  }

  /** The message the post route answers with, as far as the device can know it. It cannot be edited until it is sent. */
  async function madeMessage(ctx, channel) {
    const body = ctx.body;
    const at = new Date(ctx.now).toISOString();
    const me = (await ctx.saved('/v1/platform/me')) || {};
    const list = (await ctx.saved(notesUrl(ctx, channel))) || {};
    const last = (Array.isArray(list.messages) ? list.messages : []).reduce((most, message) => Math.max(most, Number(message && message.seq) || 0), 0);
    return {
      id: text(body.client_msg_id), channel_id: channel, seq: last + 1, parent_id: null, kind: 'message',
      author: { id: ctx.user, name: text(me.user && me.user.name) || text(me.identity && me.identity.name), email: text(me.identity && me.identity.email) || text(me.user && me.user.email), avatar: text(me.user && me.user.avatar) },
      created_at: at, edited_at: null, deleted_at: null, deleted_by: null, deleted_by_user: null,
      pinned_at: body.pin === true ? at : null, reply_count: 0, last_reply_at: null,
      audience: Array.isArray(body.audience) ? body.audience : [], tags: Array.isArray(body.tags) ? body.tags : [],
      can_edit: false, can_delete: false, can_restore: false, is_saved: false,
      language_code: 'und', language_confidence: 0, translation: { available: false },
      text: text(body.text), mention_users: Array.isArray(body.mention_users) ? body.mention_users : [],
      metadata: Object.assign({ department_ids: Array.isArray(body.department_ids) ? body.department_ids : [], mention_broadcasts: [] }, isObject(body.metadata) ? body.metadata : {}, { project_note: true }),
      reactions: [], attachments: await noteAttachments(ctx, channel), reply_participants: [], thread_muted: false
    };
  }

  /** The note's files as the message will carry them: each waiting upload's attachment, now on this message. */
  async function noteAttachments(ctx, channel) {
    const out = [];
    for (const id of attachmentIds(ctx.body)) {
      const attachment = await waitingAttachment(ctx, id);
      if (attachment) out.push(Object.assign({}, attachment, { message_id: text(ctx.body.client_msg_id), channel_id: channel }));
    }
    return out;
  }

  /** The note in every list of that channel that shows notes. */
  function noteEffects(channel, message) {
    const withNote = (json) => (json && Array.isArray(json.messages) ? Object.assign({}, json, { messages: [...json.messages.filter((item) => item && item.id !== message.id), message] }) : json);
    const here = (m) => m.channel === channel;
    return [
      // The newest page of the notes view (a `before` page holds older notes only).
      { match: 'GET ' + CHANNELS + '/channels/:channel/messages', when: (m, read) => here(m) && ['notes', 'all'].includes(text(read.query.view)) && !read.query.before, apply: withNote },
      ...(message.pinned_at ? [{ match: 'GET ' + CHANNELS + '/channels/:channel/pins', when: here, apply: withNote }] : [])
    ];
  }

  const label = (ctx) => (FMOffline.label('sync_note_new', 'Note', text(ctx.body.text).slice(0, 80)));

  FMOffline.contracts.add({
    id: 'notes',
    prefetch: [
      // The project's channel: the read-only lookup, and the channel list for a server that does not have it yet.
      { url: (ctx) => `${base(ctx)}/channels/project/${enc(ctx.project)}`, each: (json, ctx) => (json && json.channel && json.channel.id ? channelReads(ctx, json.channel.id) : []) },
      {
        url: (ctx) => `${base(ctx)}/channels`,
        each: (json, ctx) => {
          const found = (Array.isArray(json && json.channels) ? json.channels : []).find((channel) => channel && text(channel.project_id) === ctx.project);
          return found ? channelReads(ctx, found.id) : [];
        }
      }
    ],
    writes: [
      {
        // A file for a note (project-notes.js prepareUpload). The page names the attachment and its media, so the
        // file is shown from the device and the note that follows names it. It is in a scope of its own: the
        // note is held behind it by what it names, and a file the server refuses holds only its own note.
        id: 'note.upload',
        match: 'POST ' + CHANNELS + '/uploads',
        when: (ctx) => !!noteFile(ctx),
        kind: 'upload',
        scope: (ctx) => 'attachment:' + noteFile(ctx).attachment,
        records: (ctx) => { const upload = noteFile(ctx); return [upload.attachment, upload.media]; },
        media: (ctx) => { const upload = noteFile(ctx); return [{ id: upload.media, field: upload.field }]; },
        label: (ctx) => FMOffline.label('sync_note_file', 'Note attachment', text(noteFile(ctx).file.name)),
        respond: (ctx) => {
          const upload = noteFile(ctx);
          return { ok: true, attachment: {
            id: upload.attachment, organization_id: ctx.org, channel_id: upload.channel, message_id: null, media_id: upload.media,
            file_name: text(upload.file.name) || 'upload', content_type: text(upload.file.type) || 'application/octet-stream', size_bytes: upload.file.size,
            uploaded_by: ctx.user, created_at: new Date(ctx.now).toISOString()
          } };
        }
      },
      {
        id: 'note.post',
        match: 'POST ' + CHANNELS + '/channels/:channel/messages',
        when: plainNote,
        // Nothing that is queued depends on a note, so a note the server refuses does not hold the project's other changes.
        kind: 'action',
        // The channel's project, from the notes list the tray read; a channel the device knows nothing about keeps its own order.
        scope: async (ctx) => {
          const list = await ctx.saved(notesUrl(ctx, ctx.params.channel));
          const project = text(list && list.channel && list.channel.project_id);
          return project ? 'project:' + project : 'channel:' + ctx.params.channel;
        },
        records: (ctx) => [text(ctx.body.client_msg_id)],
        label,
        respond: async (ctx) => ({ ok: true, message: await madeMessage(ctx, ctx.params.channel), deduplicated: false }),
        effects: (ctx) => noteEffects(ctx.params.channel, ctx.response.message)
      },
      {
        id: 'note.post.project',
        match: 'POST ' + CHANNELS + '/channels/project/:project/messages',
        when: plainNoteNoFiles,
        // Nothing that is queued depends on a note, so a note the server refuses does not hold the project's other changes.
        kind: 'action',
        scope: (ctx) => 'project:' + ctx.params.project,
        records: (ctx) => [text(ctx.body.client_msg_id)],
        label,
        respond: async (ctx) => {
          const channel = localChannelId(ctx.params.project);
          const lookup = await ctx.saved(`${base(ctx)}/channels/project/${enc(ctx.params.project)}`);
          return { ok: true, message: await madeMessage(ctx, channel), deduplicated: false, channel: (lookup && lookup.channel) || { id: channel, type: 'project', project_id: ctx.params.project } };
        },
        effects: (ctx) => noteEffects(ctx.response.message.channel_id, ctx.response.message)
      }
    ]
  });
})();
