/* public/libraries/platform-offline/contracts/notes.js
 *
 * Project notes offline (docs/architecture/offline.md, "What works offline").
 *
 * A project's notes are messages in the project's channel. The page makes `client_msg_id`, and the server
 * answers a repeat of it with the message it already has, so a queued note arrives once. Two routes carry a
 * note: by channel, when the device knows the channel, and by project, for a project made on this device whose
 * channel the server has not made yet (its notes are kept under a local channel id, `chan_local_<project>`).
 * Replies, attachments, edits and pins need a connection.
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

  /** A plain note: text the page wrote, with its own id, that is not a reply and carries no uploaded file. */
  function plainNote(ctx) {
    const body = ctx.body;
    return isObject(body) && body.project_note === true && !!text(body.client_msg_id) && !body.parent_id
      && !(Array.isArray(body.attachment_ids) && body.attachment_ids.length);
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
      reactions: [], attachments: [], reply_participants: [], thread_muted: false
    };
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

  const label = (ctx) => ({ key: 'sync_note_new', title: 'Note', detail: text(ctx.body.text).slice(0, 80) });

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
        when: plainNote,
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
