/* public/libraries/platform-offline/contracts/schedule.js
 *
 * Schedule events offline (docs/architecture/offline.md, "What works offline"; schedule-events.md).
 *
 * A project's event is saved with one upsert: `POST .../projects/:project/events` with the event's id made on
 * the device (`event_<time>_<random>`). A new event carries no revision; an edit carries
 * `expected_event_revision`, and the server refuses it with 409 `stale_event` when the event moved on. Here a
 * new event is queued as it is, and an edit is merged per field with the event as the server has it.
 *
 * What cannot be known without the server: whether the assignee is free. A queued event is checked when it is
 * sent; where the organization blocks double-booking it is then refused and waits for the person.
 * Events that belong to no project (calendar_events), deleting an event and recurring series need a connection.
 */
(function () {
  'use strict';

  const ORG = '/v1/platform/organizations/:org';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const iso = (ctx) => new Date(ctx.now).toISOString();
  const projectUrl = (ctx) => `/v1/platform/organizations/${enc(ctx.org)}/projects/${enc(ctx.params.project)}`;

  /** The event of a save: the route reads it from `event`, `data` or the body itself. */
  const eventOf = (body) => (isObject(body) ? (isObject(body.event) ? body.event : isObject(body.data) ? body.data : body) : {});
  /** The revision an edit expects, wherever the page put it; 0 for a new event. */
  function expectedOf(body) {
    const event = eventOf(body);
    for (const source of [body, event]) for (const name of ['expected_event_revision', 'expectedEventRevision', 'if_event_revision']) if (isObject(source) && Number(source[name]) > 0) return Number(source[name]);
    return 0;
  }
  /** The fields of an event the person set: not its id and not the revision check. */
  function fieldsOf(event) {
    const fields = {};
    for (const [name, value] of Object.entries(event)) {
      if (['id', 'expected_event_revision', 'expectedEventRevision', 'if_event_revision', 'start', 'end'].includes(name) || name.startsWith('__')) continue;
      fields[name] = value;
    }
    return fields;
  }

  const eventsOf = (document) => list(document && document.data && document.data.events);
  const storedEvent = (document, id) => eventsOf(document).find((event) => event && text(event.id) === id) || null;

  /** The event as the route answers it: what was stored with what was sent, one revision on. */
  function savedEvent(ctx, stored) {
    const sent = eventOf(ctx.body);
    const at = iso(ctx);
    const event = Object.assign({}, stored, fieldsOf(sent), { id: text(sent.id), project_id: ctx.params.project, updated_at: at, event_revision: (Number(stored && stored.event_revision) || 0) + 1 });
    if (!event.created_at) event.created_at = at;
    if (!event.status) event.status = 'scheduled';
    const start = Date.parse(event.start_at), end = Date.parse(event.end_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) event.duration_minutes = Math.round((end - start) / 60000);
    else if (Number.isFinite(start) && Number(event.duration_minutes) > 0) event.end_at = new Date(start + Number(event.duration_minutes) * 60000).toISOString();
    return event;
  }

  /** A project document with the event added or replaced. */
  function withEvent(document, event) {
    if (!isObject(document)) return document;
    const events = eventsOf(document).filter((item) => item && text(item.id) !== text(event.id)).concat([event]);
    return Object.assign({}, document, { data: Object.assign({}, document.data, { events }) });
  }

  async function respond(ctx) {
    const saved = await ctx.saved(projectUrl(ctx));
    const document = saved && saved.document ? saved.document : { id: ctx.params.project, organization_id: ctx.org, collection: 'projects', data: { events: [] }, metadata: {}, revision: 0 };
    const event = savedEvent(ctx, storedEvent(document, text(eventOf(ctx.body).id)));
    const next = withEvent(document, event);
    // The panel reads `document`; the lists of conflicts are empty because only the server can look for them.
    return { ok: true, event, document: next, project: next.data, material_list: null, related_events: [], blocked_children: [], assignee_conflicts: [], roster_warnings: [], equipment_conflicts: [], equipment_operator_warnings: [] };
  }

  function effects(ctx) {
    const event = ctx.response.event;
    return [
      { match: 'GET ' + ORG + '/projects/:project', when: (m) => m.project === ctx.params.project, apply: (json) => (json && json.document ? Object.assign({}, json, { document: withEvent(json.document, Object.assign({}, storedEvent(json.document, event.id), event)) }) : json) },
      { match: 'GET ' + ORG + '/projects', apply: (json) => (json && Array.isArray(json.documents) && json.documents.some((item) => item && item.id === ctx.params.project) ? Object.assign({}, json, { documents: json.documents.map((item) => (item && item.id === ctx.params.project ? withEvent(item, Object.assign({}, storedEvent(item, event.id), event)) : item)) }) : json) }
    ];
  }

  const when = (ctx) => isObject(ctx.body) && !!text(eventOf(ctx.body).id) && !ctx.body.unlock_confirmed;
  const detail = (ctx) => {
    const event = eventOf(ctx.body);
    return [text(event.title), text(event.start_at).slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ');
  };

  FMOffline.contracts.add({
    id: 'schedule',
    prefetch: [
      // The organization's calendar and what the schedule views ask about the people on it.
      (ctx) => [`/v1/platform/organizations/${enc(ctx.org)}/calendar_events`]
    ],
    writes: [
      {
        id: 'event.create',
        match: 'POST ' + ORG + '/projects/:project/events',
        when: (ctx) => when(ctx) && !expectedOf(ctx.body),
        // The save is an upsert, so a later edit does not need this one to have arrived: an event the server
        // refuses (double-booking where the organization blocks it) does not hold the project's other changes.
        kind: 'action',
        scope: (ctx) => 'project:' + ctx.params.project,
        records: (ctx) => [text(eventOf(ctx.body).id)],
        label: (ctx) => ({ key: 'sync_event_new', title: 'Schedule event', detail: detail(ctx) }),
        respond,
        effects
      },
      {
        id: 'event.edit',
        match: 'POST ' + ORG + '/projects/:project/events',
        when: (ctx) => when(ctx) && expectedOf(ctx.body) > 0,
        kind: 'patch',
        scope: (ctx) => 'project:' + ctx.params.project,
        records: (ctx) => [text(eventOf(ctx.body).id)],
        label: (ctx) => ({ key: 'sync_event_edit', title: 'Schedule change', detail: detail(ctx) }),
        respond,
        effects,
        conflict: {
          current: (ctx) => projectUrl(ctx),
          // The document that is merged is the one event, per field; its revision is the event's own.
          pick: (json, ctx) => {
            const event = storedEvent(json && json.document, text(eventOf(ctx.body).id));
            return { doc: event, revision: event ? Number(event.event_revision) || 0 : undefined };
          },
          fields: (ctx) => Object.keys(fieldsOf(eventOf(ctx.body))).filter((field) => field !== 'updated_at'),
          mine: (ctx, base) => Object.assign({}, base, fieldsOf(eventOf(ctx.body))),
          send: (ctx, merged, revision) => ({ event: Object.assign({ id: text(eventOf(ctx.body).id) }, merged, revision ? { expected_event_revision: revision } : {}), branch_id: text(ctx.body.branch_id) })
        }
      }
    ]
  });
})();
