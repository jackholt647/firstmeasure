/* public/libraries/platform-offline/contracts/schedule.js
 *
 * Schedule events offline (docs/architecture/offline.md, "What works offline"; schedule-events.md).
 *
 * A project's event is saved with one upsert: `POST .../projects/:project/events` with the event's id made on
 * the device (`event_<time>_<random>`). An event that belongs to no project is a `calendar_events` document,
 * saved whole with `PUT .../calendar_events/:id`. A new event carries no revision; an edit (a move is an edit)
 * carries `expected_event_revision`, and the server refuses it with 409 `stale_event` when the event moved on.
 * Here a new event is queued as it is, an edit is merged per field with the event as the server has it, and a
 * delete is queued and replaces every change to that event still on the device.
 *
 * What cannot be known without the server: whether the assignee is free. The answer a page gets while the save
 * waits carries the overlaps the events saved on this device already show (`assignee_conflicts`, marked
 * `offline`), so the page warns as it does online. The server decides when the save is sent: where the
 * organization blocks double-booking it is refused, waits for the person with a sentence that says why
 * (`explain`), and the next save of that event from this device replaces it (`replaces`).
 *
 * Recurring series need a connection: the server makes every occurrence and its id, and records a changed or
 * deleted occurrence as an exception of its series, so a queued change could reach an occurrence that a series
 * edit has since made again or removed. A save or a delete of an occurrence is not queued either.
 */
(function () {
  'use strict';

  const ORG = '/v1/platform/organizations/:org';
  const CAL = ORG + '/calendar_events';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const has = (object, field) => isObject(object) && Object.prototype.hasOwnProperty.call(object, field);
  const iso = (ctx) => new Date(ctx.now).toISOString();
  const projectUrl = (ctx) => `/v1/platform/organizations/${enc(ctx.org)}/projects/${enc(ctx.params.project)}`;
  const calendarUrl = (ctx, id) => `/v1/platform/organizations/${enc(ctx.org)}/calendar_events${id ? '/' + enc(id) : ''}`;
  const REVISION_TOKENS = ['expected_event_revision', 'expectedEventRevision', 'if_event_revision'];

  /** The event of a save: the route reads it from `event`, `data` or the body itself. */
  const eventOf = (body) => (isObject(body) ? (isObject(body.event) ? body.event : isObject(body.data) ? body.data : body) : {});
  /** The revision an edit expects, wherever the page put it; 0 for a new event. */
  function expectedOf(body) {
    const event = eventOf(body);
    for (const source of [body, event]) for (const name of REVISION_TOKENS) if (isObject(source) && Number(source[name]) > 0) return Number(source[name]);
    return 0;
  }
  /** The fields of an event the person set: not its id and not the revision check. */
  function fieldsOf(event) {
    const fields = {};
    for (const [name, value] of Object.entries(event)) {
      if (['id', 'start', 'end'].concat(REVISION_TOKENS).includes(name) || name.startsWith('__')) continue;
      fields[name] = value;
    }
    return fields;
  }
  /** A body without the revision check, for a save that follows this device's own first save of the event. */
  function withoutRevision(body) {
    const strip = (value) => { const out = Object.assign({}, value); for (const name of REVISION_TOKENS) delete out[name]; return out; };
    const next = strip(body);
    for (const name of ['event', 'data']) if (isObject(next[name])) next[name] = strip(next[name]);
    return next;
  }
  /** An occurrence of a series, or a save that starts one: the server's to make (see the head of this file). */
  const recurring = (event) => isObject(event) && (!!text(event.recurrence_series_id) || isObject(event.recurrence));

  const eventsOf = (document) => list(document && document.data && document.data.events);
  const storedEvent = (document, id) => eventsOf(document).find((event) => event && text(event.id) === id) || null;

  /** The range and length of an event as the routes store them. */
  function timed(event) {
    const start = Date.parse(event.start_at), end = Date.parse(event.end_at);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) event.duration_minutes = Math.round((end - start) / 60000);
    else if (Number.isFinite(start) && Number(event.duration_minutes) > 0) event.end_at = new Date(start + Number(event.duration_minutes) * 60000).toISOString();
    return event;
  }

  /** The event as the project route answers it: what was stored with what was sent, one revision on. */
  function savedEvent(ctx, stored) {
    const sent = eventOf(ctx.body);
    const at = iso(ctx);
    const event = Object.assign({}, stored, fieldsOf(sent), { id: text(sent.id), project_id: ctx.params.project, updated_at: at, event_revision: (Number(stored && stored.event_revision) || 0) + 1 });
    if (!event.created_at) event.created_at = at;
    if (!event.status) event.status = 'scheduled';
    return timed(event);
  }

  /** A project document with the event added or replaced. */
  function withEvent(document, event) {
    if (!isObject(document)) return document;
    const events = eventsOf(document).filter((item) => item && text(item.id) !== text(event.id)).concat([event]);
    return Object.assign({}, document, { data: Object.assign({}, document.data, { events }) });
  }
  /** A project document without the event; its children stay, with no parent (as the route leaves them). */
  function withoutEvent(document, id) {
    if (!isObject(document) || !eventsOf(document).some((item) => item && text(item.id) === id)) return document;
    const events = eventsOf(document).filter((item) => item && text(item.id) !== id).map((item) => (item && text(item.parent_event_id) === id ? Object.assign({}, item, { parent_event_id: '', placement: null }) : item));
    return Object.assign({}, document, { data: Object.assign({}, document.data, { events }) });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Double-booking, as far as this device can see it
  // -------------------------------------------------------------------------------------------------------------

  const ASSIGNEE_KINDS = ['organization_user', 'resource_group', 'organization_connection'];
  /** The assignees an event names: its resources of the three assignee kinds, and the people in `assigned_user_ids`. */
  function assigneesOf(event) {
    const out = new Map();
    for (const ref of list(event && event.resource_refs)) {
      if (!isObject(ref) || !ASSIGNEE_KINDS.includes(text(ref.kind)) || !text(ref.id) || text(ref.role) === 'equipment') continue;
      out.set(text(ref.kind) + ':' + text(ref.id), { kind: text(ref.kind), id: text(ref.id), name: text(ref.name), unit_id: text(ref.unit_id) });
    }
    for (const id of list(event && event.assigned_user_ids)) if (text(id) && !out.has('organization_user:' + text(id))) out.set('organization_user:' + text(id), { kind: 'organization_user', id: text(id), name: '', unit_id: '' });
    return out;
  }
  /** The time an event holds, or null: cancelled and unscheduled events hold nothing. */
  function rangeOf(event) {
    if (!isObject(event) || ['unscheduled', 'cancelled', 'canceled'].includes(text(event.status).toLowerCase())) return null;
    const start = Date.parse(event.start_at);
    if (!Number.isFinite(start)) return null;
    const end = Date.parse(event.end_at);
    return { start, end: Number.isFinite(end) && end > start ? end : start + (Number(event.duration_minutes) > 0 ? Number(event.duration_minutes) : 60) * 60000 };
  }
  /** Every event the device has saved, as the person would see them now: [{ event, project_id, project_title }]. */
  async function knownEvents(ctx) {
    const seen = new Map();
    const take = (event, document) => {
      if (!isObject(event) || !text(event.id)) return;
      const data = (document && document.data) || {};
      seen.set(text(event.id), { event, project_id: document ? text(document.id) : '', project_title: document ? text(data.title || data.customer_name || data.address) : '' });
    };
    for (const found of await ctx.find('GET ' + ORG + '/projects')) for (const document of list(found.json && found.json.documents)) for (const event of eventsOf(document)) take(event, document);
    for (const found of await ctx.find('GET ' + ORG + '/projects/:project')) { const document = found.json && found.json.document; for (const event of eventsOf(document)) take(event, document); }
    for (const found of await ctx.find('GET ' + CAL)) for (const document of list(found.json && found.json.documents)) if (document && isObject(document.data)) take(Object.assign({}, document.data, { id: text(document.id) || text(document.data.id) }), null);
    return [...seen.values()];
  }
  /**
   * The overlaps the saved events already show for this event, in the shape of the server's `assignee_conflicts`
   * (schedule-events.md, "Overlap"), each marked `offline: true`. Two events overlap when their ranges cross and
   * they share an assignee; an event's own parent and children are left out, and two events that name different
   * units of one assignee do not conflict. How many jobs an assignee's units can hold at once is the server's to
   * count, so this can warn where the server will not; it never refuses anything.
   */
  async function overlapsOnDevice(ctx, event) {
    const mine = assigneesOf(event), range = rangeOf(event);
    if (!mine.size || !range) return [];
    const id = text(event.id), found = new Map();
    for (const other of await knownEvents(ctx)) {
      const theirs = other.event, otherId = text(theirs.id);
      if (otherId === id || otherId === text(event.parent_event_id) || text(theirs.parent_event_id) === id) continue;
      const held = rangeOf(theirs);
      if (!held || held.start >= range.end || held.end <= range.start) continue;
      for (const [key, assignee] of assigneesOf(theirs)) {
        const own = mine.get(key);
        if (!own || (own.unit_id && assignee.unit_id && own.unit_id !== assignee.unit_id)) continue;
        if (!found.has(key)) found.set(key, { event_id: id, assignee: Object.assign({ kind: own.kind, id: own.id, name: own.name || assignee.name }, own.unit_id ? { unit_id: own.unit_id } : {}), reason: 'overlap', capacity: 1, mode: 'warn', offline: true, conflicts: [] });
        found.get(key).conflicts.push({ event_id: otherId, project_id: other.project_id, project_title: other.project_title, title: text(theirs.title), start_at: text(theirs.start_at), end_at: text(theirs.end_at) });
      }
    }
    return [...found.values()];
  }

  /** What a refusal at sync means, in a sentence a person can act on. */
  function explain(ctx, answer) {
    const event = eventOf(ctx.body);
    if (answer.status === 409 && answer.code === 'assignee_conflict') {
      const conflicts = list(answer.body && answer.body.details && answer.body.details.conflicts);
      const names = [...new Set(conflicts.map((entry) => text(entry && entry.assignee && entry.assignee.name)).filter(Boolean))].slice(0, 3).join(', ');
      return FMOffline.label('fail_event_booked', 'Not saved: someone on this event is already booked at that time. Open the event and change its time or who it is assigned to.', names);
    }
    if (answer.status === 409 && answer.code === 'equipment_conflict') return FMOffline.label('fail_event_equipment', 'Not saved: equipment on this event is already booked at that time. Open the event and change its time or its equipment.', '');
    if (answer.status === 409 && answer.code === 'project_event_locked') return FMOffline.label('fail_event_locked', 'Not saved: this item was locked. Unlock it with a connection, then move it.', text(event.title));
    return null;
  }

  /** Earlier saves of this event still on the device, oldest first. */
  const earlier = async (ctx, id) => (await ctx.queued(id)).filter((entry) => entry.contract === 'schedule');
  /** True while this device's own first save of the event has not reached the server: the server has no revision of it. */
  const madeHere = async (ctx, id, write) => (await earlier(ctx, id)).some((entry) => entry.write === write);
  /** A save carries the whole event, so it stands in for a save of the same event that the server refused. */
  const replacesRefused = async (ctx, id) => (await earlier(ctx, id)).filter((entry) => entry.state === 'failed').map((entry) => entry.id);
  /** A delete stands in for every change to the event still on the device. */
  const replacesAll = async (ctx, id) => (await earlier(ctx, id)).map((entry) => entry.id);

  const detail = (event) => [text(event.title), text(event.start_at).slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ');

  // -------------------------------------------------------------------------------------------------------------
  // A project's events
  // -------------------------------------------------------------------------------------------------------------

  async function respond(ctx) {
    const saved = await ctx.saved(projectUrl(ctx));
    const document = saved && saved.document ? saved.document : { id: ctx.params.project, organization_id: ctx.org, collection: 'projects', data: { events: [] }, metadata: {}, revision: 0 };
    const event = savedEvent(ctx, storedEvent(document, text(eventOf(ctx.body).id)));
    const next = withEvent(document, event);
    // The panel reads `document`. Children are re-placed and equipment is checked by the server when this is sent.
    return { ok: true, event, document: next, project: next.data, material_list: null, related_events: [], blocked_children: [], assignee_conflicts: await overlapsOnDevice(ctx, event), roster_warnings: [], equipment_conflicts: [], equipment_operator_warnings: [] };
  }

  function effects(ctx) {
    const event = ctx.response.event;
    return [
      { match: 'GET ' + ORG + '/projects/:project', when: (m) => m.project === ctx.params.project, apply: (json) => (json && json.document ? Object.assign({}, json, { document: withEvent(json.document, Object.assign({}, storedEvent(json.document, event.id), event)) }) : json) },
      { match: 'GET ' + ORG + '/projects', apply: (json) => (json && Array.isArray(json.documents) && json.documents.some((item) => item && item.id === ctx.params.project) ? Object.assign({}, json, { documents: json.documents.map((item) => (item && item.id === ctx.params.project ? withEvent(item, Object.assign({}, storedEvent(item, event.id), event)) : item)) }) : json) }
    ];
  }

  const projectSave = (ctx) => isObject(ctx.body) && !!text(eventOf(ctx.body).id) && !ctx.body.unlock_confirmed && !eventOf(ctx.body).unlock_confirmed && !recurring(eventOf(ctx.body));
  const projectScope = (ctx) => 'project:' + ctx.params.project;

  /** The event a delete names, from the project as the device has it. */
  async function projectEventFor(ctx) {
    const saved = await ctx.saved(projectUrl(ctx));
    return { document: saved && saved.document ? saved.document : null, event: storedEvent(saved && saved.document, ctx.params.event) };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Events that belong to no project (calendar_events documents)
  // -------------------------------------------------------------------------------------------------------------

  /** The calendar event document as the device has it: its own read, else the calendar list. */
  async function calendarDocument(ctx, id) {
    const own = await ctx.saved(calendarUrl(ctx, id));
    if (own && own.document) return own.document;
    const all = await ctx.saved(calendarUrl(ctx));
    return list(all && all.documents).find((document) => document && text(document.id) === id) || null;
  }
  /** The document the save answers with: the route replaces `data` with what was sent, one revision on. */
  async function calendarSaved(ctx) {
    const id = ctx.params.event, at = iso(ctx);
    const stored = await calendarDocument(ctx, id);
    // The document's data is the event as the page sent it (its `id` with it, where the page put one there).
    const data = Object.assign(has(ctx.body.data, 'id') ? { id: ctx.body.data.id } : {}, fieldsOf(eventOf(ctx.body)), { event_revision: (Number(stored && stored.data && stored.data.event_revision) || 0) + 1 });
    const document = Object.assign({}, stored, {
      schema_version: 1, id, organization_id: ctx.org, collection: 'calendar_events', data,
      metadata: isObject(ctx.body.metadata) ? ctx.body.metadata : {}, revision: (Number(stored && stored.revision) || 0) + 1,
      created_at: (stored && stored.created_at) || at, updated_at: at
    });
    const conflicts = await overlapsOnDevice(ctx, Object.assign({}, data, { id }));
    // The route puts the overlaps on the document, and only when there are some.
    return Object.assign({ ok: true, document: conflicts.length ? Object.assign({}, document, { assignee_conflicts: conflicts }) : document });
  }
  const bare = (document) => { const out = Object.assign({}, document); delete out.assignee_conflicts; delete out.roster_warnings; return out; };
  function calendarEffects(ctx) {
    const id = ctx.params.event, document = bare(ctx.response.document);
    return [
      { match: 'GET ' + CAL, apply: (json) => (json && Array.isArray(json.documents) ? Object.assign({}, json, { documents: json.documents.filter((item) => item && text(item.id) !== id).concat([document]) }) : json) },
      { match: 'GET ' + CAL + '/:event', when: (m) => m.event === id, seed: () => ({ ok: true, document }), apply: (json) => (json && json.document ? Object.assign({}, json, { document: Object.assign({}, json.document, document) }) : json) }
    ];
  }
  const calendarSave = (ctx) => isObject(ctx.body) && isObject(ctx.body.data) && !recurring(ctx.body.data);
  /** A calendar event has an order of its own; a change to one made on this device follows the save that made it. */
  async function calendarScope(ctx) {
    const before = await earlier(ctx, ctx.params.event);
    return before.length ? before[0].scope : 'event:' + ctx.params.event;
  }

  FMOffline.contracts.add({
    id: 'schedule',
    prefetch: [
      // The organization's calendar and what the schedule views ask about the people on it.
      (ctx) => [`/v1/platform/organizations/${enc(ctx.org)}/calendar_events`]
    ],
    writes: [
      {
        // A new event on a project, and any further save of it while this device's first save still waits or
        // was refused: the server has no revision of it yet, so the whole event is sent again without one.
        id: 'event.create',
        match: 'POST ' + ORG + '/projects/:project/events',
        when: async (ctx) => projectSave(ctx) && (!expectedOf(ctx.body) || await madeHere(ctx, text(eventOf(ctx.body).id), 'event.create')),
        // The save is an upsert, so a later edit does not need this one to have arrived: an event the server
        // refuses (double-booking where the organization blocks it) does not hold the project's other changes.
        kind: 'action',
        scope: projectScope,
        records: (ctx) => [text(eventOf(ctx.body).id)],
        label: (ctx) => (FMOffline.label('sync_event_new', 'Schedule event', detail(eventOf(ctx.body)))),
        prepare: (ctx) => (expectedOf(ctx.body) ? withoutRevision(ctx.body) : undefined),
        respond,
        effects,
        explain,
        replaces: (ctx) => replacesRefused(ctx, text(eventOf(ctx.body).id))
      },
      {
        // An edit of an event the server has: its fields, its time (a move), its status (cancelled, unscheduled).
        id: 'event.edit',
        match: 'POST ' + ORG + '/projects/:project/events',
        when: (ctx) => projectSave(ctx) && expectedOf(ctx.body) > 0,
        kind: 'patch',
        scope: projectScope,
        records: (ctx) => [text(eventOf(ctx.body).id)],
        label: (ctx) => (FMOffline.label('sync_event_edit', 'Schedule change', detail(eventOf(ctx.body)))),
        respond,
        effects,
        explain,
        replaces: (ctx) => replacesRefused(ctx, text(eventOf(ctx.body).id)),
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
      },
      {
        // Deleting a project's event. The route answers a repeat, or an event that never arrived, with `deleted: false`.
        id: 'event.delete',
        match: 'DELETE ' + ORG + '/projects/:project/events/:event',
        when: async (ctx) => !recurring((await projectEventFor(ctx)).event),
        kind: 'delete',
        scope: projectScope,
        records: (ctx) => [ctx.params.event],
        label: async (ctx) => (FMOffline.label('sync_event_delete', 'Event deleted', detail((await projectEventFor(ctx)).event || {}))),
        respond: async (ctx) => {
          const { document, event } = await projectEventFor(ctx);
          const next = withoutEvent(document || { id: ctx.params.project, organization_id: ctx.org, collection: 'projects', data: { events: [] }, metadata: {}, revision: 0 }, ctx.params.event);
          return Object.assign({ ok: true, deleted: !!event }, event ? { event } : {}, { event_id: ctx.params.event, document: next, project: Object.assign({ id: ctx.params.project }, next.data) });
        },
        effects: (ctx) => [
          { match: 'GET ' + ORG + '/projects/:project', when: (m) => m.project === ctx.params.project, apply: (json) => (json && json.document ? Object.assign({}, json, { document: withoutEvent(json.document, ctx.params.event) }) : json) },
          { match: 'GET ' + ORG + '/projects', apply: (json) => (json && Array.isArray(json.documents) && json.documents.some((item) => item && item.id === ctx.params.project) ? Object.assign({}, json, { documents: json.documents.map((item) => (item && item.id === ctx.params.project ? withoutEvent(item, ctx.params.event) : item)) }) : json) }
        ],
        // Gone already (a repeat, an event that never arrived, a project that was deleted): that is what was asked for.
        duplicate: (ctx, answer) => answer.status === 404,
        replaces: (ctx) => replacesAll(ctx, ctx.params.event)
      },
      {
        // A new event with no project, and any further save of it while this device's first save still waits
        // or was refused (see `event.create`).
        id: 'calendar.create',
        match: 'PUT ' + CAL + '/:event',
        when: async (ctx) => calendarSave(ctx) && (!expectedOf(ctx.body) || await madeHere(ctx, ctx.params.event, 'calendar.create')),
        kind: 'action',
        scope: calendarScope,
        records: (ctx) => [ctx.params.event],
        label: (ctx) => (FMOffline.label('sync_event_new', 'Schedule event', detail(ctx.body.data))),
        prepare: (ctx) => (expectedOf(ctx.body) ? withoutRevision(ctx.body) : undefined),
        respond: calendarSaved,
        effects: calendarEffects,
        explain,
        replaces: (ctx) => replacesRefused(ctx, ctx.params.event)
      },
      {
        // An edit of a calendar event the server has. The route replaces the whole event, so what is sent is the
        // server's event as it is then with this change's fields merged in.
        id: 'calendar.edit',
        match: 'PUT ' + CAL + '/:event',
        when: (ctx) => calendarSave(ctx) && expectedOf(ctx.body) > 0,
        kind: 'patch',
        scope: calendarScope,
        records: (ctx) => [ctx.params.event],
        label: (ctx) => (FMOffline.label('sync_event_edit', 'Schedule change', detail(ctx.body.data))),
        respond: calendarSaved,
        effects: calendarEffects,
        explain,
        replaces: (ctx) => replacesRefused(ctx, ctx.params.event),
        conflict: {
          current: (ctx) => calendarUrl(ctx, ctx.params.event),
          pick: (json) => {
            const data = json && json.document && isObject(json.document.data) ? json.document.data : null;
            return { doc: data, revision: data ? Number(data.event_revision) || 0 : undefined };
          },
          // Every field either side has: the page sends the whole event, so a field it left out was removed.
          fields: (ctx) => [...new Set(Object.keys(fieldsOf(ctx.body.data)).concat(Object.keys(fieldsOf(ctx.base || {}))))].filter((field) => !['updated_at', 'event_revision'].includes(field)),
          mine: (ctx) => fieldsOf(ctx.body.data),
          send: (ctx, merged, revision, theirs) => {
            const data = Object.assign(fieldsOf(theirs || {}), merged);
            for (const name of Object.keys(data)) if (data[name] === null && !(name in ctx.body.data)) delete data[name];
            delete data.event_revision;
            if (has(ctx.body.data, 'id')) data.id = ctx.body.data.id; else if (theirs && has(theirs, 'id')) data.id = theirs.id;
            return { data: Object.assign(data, revision ? { expected_event_revision: revision } : {}), metadata: isObject(ctx.body.metadata) ? ctx.body.metadata : {} };
          }
        }
      },
      {
        // Deleting a calendar event. The route answers a repeat, or an event that never arrived, with 404.
        id: 'calendar.delete',
        match: 'DELETE ' + CAL + '/:event',
        when: async (ctx) => { const document = await calendarDocument(ctx, ctx.params.event); return !recurring(document && document.data); },
        kind: 'delete',
        scope: calendarScope,
        records: (ctx) => [ctx.params.event],
        label: async (ctx) => { const document = await calendarDocument(ctx, ctx.params.event); return FMOffline.label('sync_event_delete', 'Event deleted', detail((document && document.data) || {})); },
        // The route answers with the document it removed, or `false` when there was none.
        respond: async (ctx) => { const document = await calendarDocument(ctx, ctx.params.event); return { ok: true, deleted: document ? bare(document) : false }; },
        effects: (ctx) => [
          { match: 'GET ' + CAL, apply: (json) => (json && Array.isArray(json.documents) ? Object.assign({}, json, { documents: json.documents.filter((item) => item && text(item.id) !== ctx.params.event) }) : json) }
        ],
        // Gone already (a repeat, an event that never arrived, a project that was deleted): that is what was asked for.
        duplicate: (ctx, answer) => answer.status === 404,
        replaces: (ctx) => replacesAll(ctx, ctx.params.event)
      }
    ]
  });
})();
