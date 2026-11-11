/* public/libraries/platform-offline/contracts/messages.js
 *
 * Messages that can be read with no connection (docs/architecture/offline.md, "Messages").
 *
 * Channels, the project's Messages tray, Communications (conversations, texts, email threads, the call log) and
 * the top bar's message list read with GET, so what a person looked at is already saved. This file adds what
 * is downloaded ahead of time, with the addresses the apps themselves ask with (a read that is asked
 * differently would be saved a second time and never used):
 *
 *   - a project kept on the device: its channel, the two newest pages of its messages (120), the threads and
 *     pins of those, and its Comms tab (email threads, texts, portal chat, calls);
 *   - at start-up: the channel list, the directory, the message list of the top bar and the newest page of the
 *     channels a person is in. These are ordinary saved reads, within the saved-reads budget.
 *
 * There are no writes here on purpose. Sending a message, a text or an email, reacting, editing and deleting
 * need a connection: a message that arrives hours late, out of order with the answers to it, is worse than one
 * the person sends again. The apps say so and keep the text. (A project note is queued: contracts/notes.js.)
 *
 * Attachments are media files: kept as they are shown (thumbnails always, other variants up to the limit),
 * never downloaded ahead. Call recordings and voicemail audio are never kept on a device.
 */
(function () {
  'use strict';

  const enc = encodeURIComponent;
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const channels = (ctx) => `/v1/channels/organizations/${enc(ctx.org)}`;
  const comms = (ctx) => `/v1/comms/organizations/${enc(ctx.org)}`;

  /** The page of messages the apps open a conversation with (channels-ui.js setChannel). */
  const PAGE = 60;
  /** Threads of one page that are downloaded with a kept project: the newest ones that have replies. */
  const THREADS = 10;
  /** Channels whose newest page is downloaded at start-up: the ones with the newest messages. */
  const STARTUP_CHANNELS = 25;

  /** The page before the newest one, as the list asks for it when it is scrolled to the top (loadOlder). */
  function olderPage(ctx, channel, json) {
    const oldest = list(json && json.messages).reduce((least, message) => Math.min(least, Number(message && message.seq) || Infinity), Infinity);
    return Number.isFinite(oldest) && oldest > 1 && list(json.messages).length >= PAGE
      ? [`${channels(ctx)}/channels/${enc(channel)}/messages?before=${oldest}&limit=${PAGE}`]
      : [];
  }

  /** The threads a page of messages opens: its newest messages that have replies. */
  function threadsOf(ctx, json) {
    return list(json && json.messages)
      .filter((message) => message && message.id && Number(message.reply_count) > 0 && !message.parent_id)
      .slice(-THREADS)
      .map((message) => `${channels(ctx)}/messages/${enc(message.id)}/thread`);
  }

  /** What the Messages tray and the Channels app read to show one project's conversation. */
  function projectChannelReads(ctx, channel) {
    const c = enc(channel);
    return [
      // The newest page, then the page before it and the threads of the newest.
      { url: `${channels(ctx)}/channels/${c}/messages?limit=${PAGE}`, each: (json) => [...olderPage(ctx, channel, json), ...threadsOf(ctx, json)] },
      `${channels(ctx)}/channels/${c}`,
      `${channels(ctx)}/channels/${c}/pins`,
      `${channels(ctx)}/drafts/${enc('channel:' + channel)}`,
      `${channels(ctx)}/collaboration-preferences`,
      `${channels(ctx)}/directory`
    ];
  }

  /** The channels a person is in, newest message first. */
  function mine(json) {
    return list(json && json.channels)
      .filter((channel) => channel && channel.id && channel.is_member !== false && !channel.archived_at)
      .sort((a, b) => text(b.last_message_at).localeCompare(text(a.last_message_at)));
  }

  FMOffline.contracts.add({
    id: 'messages',
    deny: [
      // Call recordings, voicemail audio and transcripts: never kept on a device, never answered from one.
      '/v1/comms/organizations/:org/calls/:call/artifacts',
      '/v1/comms/organizations/:org/calls/:call/artifacts/**',
      // Who is typing, and huddles (live calls): only ever the server's.
      '/v1/channels/organizations/:org/channels/:channel/typing',
      '/v1/channels/organizations/:org/huddles/**'
    ],
    boot: [
      // Needed to draw any conversation at all: who people are and how this person reads messages.
      'GET /v1/channels/organizations/:org/directory',
      'GET /v1/channels/organizations/:org/collaboration-preferences',
      'GET /v1/channels/organizations/:org/sidebar-sections'
    ],
    startup: [
      (ctx) => [
        `${channels(ctx)}/directory`,
        `${channels(ctx)}/collaboration-preferences`,
        `${channels(ctx)}/sidebar-sections`,
        `${channels(ctx)}/inbox`
      ],
      {
        // The channel list, then the newest page of the channels with the newest messages.
        url: (ctx) => `${channels(ctx)}/channels`,
        each: (json, ctx) => mine(json).slice(0, STARTUP_CHANNELS).flatMap((channel) => [
          `${channels(ctx)}/channels/${enc(channel.id)}/messages?limit=${PAGE}`,
          `${channels(ctx)}/drafts/${enc('channel:' + channel.id)}`
        ])
      }
    ],
    prefetch: [
      // The project's channel: the read-only lookup, and the channel list for a server that does not have it yet
      // (the same two steps as contracts/notes.js, which downloads the notes view of the same channel).
      {
        url: (ctx) => `${channels(ctx)}/channels/project/${enc(ctx.project)}`,
        each: (json, ctx) => (json && json.channel && json.channel.id ? projectChannelReads(ctx, json.channel.id) : [])
      },
      {
        url: (ctx) => `${channels(ctx)}/channels`,
        each: (json, ctx) => {
          const found = list(json && json.channels).find((channel) => channel && text(channel.project_id) === ctx.project);
          return found ? projectChannelReads(ctx, found.id) : [];
        }
      },
      // The project's Comms tab (apps/comms/project.js): its email threads, each thread, its texts and portal chat.
      {
        url: (ctx) => `${comms(ctx)}/projects/${enc(ctx.project)}/email/threads`,
        each: (json, ctx) => list(json && json.threads).slice(0, 30)
          .map((thread) => text(thread && (thread.id || thread.conversation_id)))
          .filter(Boolean)
          .map((id) => `${comms(ctx)}/projects/${enc(ctx.project)}/email/threads/${enc(id)}`)
      },
      (ctx) => [
        `${comms(ctx)}/projects/${enc(ctx.project)}/sms`,
        `${comms(ctx)}/projects/${enc(ctx.project)}/chat`,
        // The project's calls, as its Calls tab lists them (who called, when, the outcome; no audio).
        `${comms(ctx)}/calls?limit=50&project_id=${enc(ctx.project)}`
      ]
    ]
  });
})();
