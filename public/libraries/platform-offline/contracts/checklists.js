/* public/libraries/platform-offline/contracts/checklists.js
 *
 * A project's checklists offline (docs/architecture/offline.md, "What works offline").
 *
 * The apps (apps/checklists/app.js, the checklist tab of apps/crew/app.js) read one answer,
 * `GET .../crew/projects/:project/checklists`: every checklist with its items. A pinned project downloads it
 * (contracts/projects.js). Queued here:
 *
 *   - checking, unchecking and rating an item, its note and its title (`PATCH .../items/:item`): merged per field
 *     with the item as the server has it when it is sent, under the item's revision. Two people who change
 *     different items never meet; the same field of one item changed differently on both sides asks the person.
 *   - adding an item, and adding a checklist with its items (a blank one, or the items of a template the page
 *     holds): the ids are made on the device, here in `prepare` when the page sent none, so a later change can
 *     name the record before the server has it. A repeat whose first answer was lost is `checklist_exists` /
 *     `checklist_item_exists`: done.
 *   - the one sign-off a checklist can ask for, once every item on the device is done.
 *
 * Everything in one checklist is sent in order (`checklist:<id>`, or the scope of the change that made it).
 *
 * The seam for item photos and files (`POST .../items/:item/attachments`, another contract's upload): an item
 * that asks for evidence can be completed here only when the item, as this device sees it, already has it in
 * `metadata.attachments`. An upload contract that queues the attachment takes `scope` from `scopeOf` below
 * (FMOffline.checklists.scopeOf), names the item in `records`, and adds the attachment to the item with
 * `FMOffline.checklists.withItem` in its effects; completing the item then queues behind it.
 * Renaming or deleting a checklist, its settings and assignment, deleting an item, sending, voice and the
 * document need a connection.
 */
(function () {
  'use strict';

  const CREW = '/v1/workforce/organizations/:org/crew/projects/:project';
  const LISTS = CREW + '/checklists';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const texts = (value) => list(value).map(text).filter(Boolean);
  const has = (object, field) => Object.prototype.hasOwnProperty.call(object, field);
  const iso = (ctx) => new Date(ctx.now).toISOString();
  const listsUrl = (ctx) => `/v1/workforce/organizations/${enc(ctx.org)}/crew/projects/${enc(ctx.params.project)}/checklists`;
  const RATINGS = ['good', 'neutral', 'bad'];

  /** The project's checklists as the device has them (earlier queued changes applied), or null. */
  const known = (ctx) => ctx.saved(listsUrl(ctx));
  const checklistIn = (payload, id) => list(payload && payload.checklists).find((entry) => entry && text(entry.id) === id) || null;
  const itemIn = (checklist, id) => list(checklist && checklist.items).find((entry) => entry && text(entry.id) === id) || null;

  /** One checklist's changes are sent in order; a checklist made on this device follows the change that made it. */
  async function scopeOf(ctx, checklistId) {
    const earlier = await ctx.queued(checklistId);
    if (earlier.length) return earlier[0].scope;
    const project = await ctx.queued(ctx.params.project);
    return project.some((entry) => entry.kind === 'create') ? 'project:' + ctx.params.project : 'checklist:' + checklistId;
  }

  /** The checklists answer with one checklist changed by `change`; unchanged when it is not there. */
  function withChecklist(json, id, change) {
    if (!json || !Array.isArray(json.checklists) || !json.checklists.some((entry) => entry && text(entry.id) === id)) return json;
    return Object.assign({}, json, { checklists: json.checklists.map((entry) => (entry && text(entry.id) === id ? counted(change(entry)) : entry)) });
  }
  /** The checklists answer with one item changed by `change` (or added, when `change` is given no item). */
  function withItem(json, checklistId, itemId, change) {
    return withChecklist(json, checklistId, (checklist) => {
      const items = list(checklist.items);
      return Object.assign({}, checklist, { items: items.some((item) => item && text(item.id) === itemId) ? items.map((item) => (item && text(item.id) === itemId ? change(item) : item)) : items.concat([change(null)]) });
    });
  }
  const counted = (checklist) => Object.assign({}, checklist, { total_items: list(checklist.items).length, completed_items: list(checklist.items).filter((item) => item && item.completed).length });

  // -------------------------------------------------------------------------------------------------------------
  // Records as the routes answer them (workforce/crew_storage.ts checklistView, checklistItemView)
  // -------------------------------------------------------------------------------------------------------------

  const newId = (prefix) => prefix + '_' + crypto.randomUUID();
  const itemTitle = (input) => text(input.title || input.label || input.name);

  function madeItem(ctx, checklistId, input) {
    const at = iso(ctx);
    const type = ['todo', 'rating'].includes(text(input.item_type || input.type).toLowerCase()) ? text(input.item_type || input.type).toLowerCase() : 'todo';
    const rating = type === 'rating' && RATINGS.includes(text(input.rating).toLowerCase()) ? text(input.rating).toLowerCase() : '';
    const completed = type === 'rating' ? !!rating : input.completed === true || text(input.status) === 'completed';
    return {
      schema_version: 1, id: text(input.id), organization_id: ctx.org, project_id: ctx.params.project, checklist_id: checklistId,
      title: itemTitle(input), description: text(input.description), item_type: type, rating, note: text(input.note || input.notes),
      status: completed ? 'completed' : 'pending', completed, sort_order: Math.round(Number(input.sort_order || 0)),
      created_by_user_id: ctx.user, completed_by_user_id: completed ? ctx.user : '', completed_at: completed ? at : '',
      metadata: isObject(input.metadata) ? input.metadata : {}, revision: 1, created_at: at, updated_at: at
    };
  }

  /** What a patch asks for, in the item's own fields: `completed`, `rating`, `note`, `title`. */
  function asked(body) {
    const out = {};
    if (has(body, 'rating')) out.rating = RATINGS.includes(text(body.rating).toLowerCase()) ? text(body.rating).toLowerCase() : '';
    if (has(body, 'note') || has(body, 'notes')) out.note = text(has(body, 'note') ? body.note : body.notes);
    if (has(body, 'title')) out.title = text(body.title);
    if (has(body, 'completed')) out.completed = body.completed === true;
    else if (has(body, 'status')) out.completed = text(body.status) === 'completed';
    return out;
  }
  /** The item after the patch, as patchProjectChecklistItem stores it. */
  function changedItem(item, body, ctx) {
    const want = asked(body), at = iso(ctx);
    const rating = item.item_type === 'rating' ? (has(want, 'rating') ? want.rating : text(item.rating)) : '';
    const completed = item.item_type === 'rating' ? !!rating : has(want, 'completed') ? want.completed : !!item.completed;
    const moved = completed !== !!item.completed || rating !== text(item.rating);
    return Object.assign({}, item, {
      title: has(want, 'title') ? want.title : item.title, note: has(want, 'note') ? want.note : item.note, rating,
      status: completed ? 'completed' : 'pending', completed,
      completed_by_user_id: completed ? (moved ? ctx.user : item.completed_by_user_id || ctx.user) : '',
      completed_at: completed ? (moved ? at : item.completed_at || at) : '',
      revision: (Number(item.revision) || 1) + 1, updated_at: at
    });
  }

  /** The evidence an item still lacks before it may be completed (patchProjectChecklistItem's rule). */
  function unmetEvidence(item) {
    const metadata = isObject(item.metadata) ? item.metadata : {};
    const attachments = list(metadata.attachments).filter(isObject);
    const matches = (kind, attachment, allowed) => {
      const own = text(attachment.kind).toLowerCase(), type = text(attachment.content_type).toLowerCase();
      if (allowed && allowed.length) return allowed.some((one) => matches(one, attachment));
      if (kind === 'any') return true;
      if (kind === 'media') return ['photo', 'video', 'audio'].includes(own);
      if (kind === 'photo') return own === 'photo' || type.startsWith('image/');
      if (kind === 'video') return own === 'video' || type.startsWith('video/');
      if (kind === 'audio') return own === 'audio' || type.startsWith('audio/');
      if (kind === 'document') return own === 'document' || !/^(image|video|audio)\//.test(type);
      return false;
    };
    return list(metadata.required_attachments).filter(isObject).filter((requirement) => {
      const kind = text(requirement.kind).toLowerCase() || 'any', id = text(requirement.id);
      const least = Math.max(1, Math.min(20, Math.round(Number(requirement.min_count) || 1)));
      const allowed = texts(requirement.allowed_kinds).map((one) => one.toLowerCase());
      return attachments.filter((attachment) => (!id || !text(attachment.requirement_id) || text(attachment.requirement_id) === id) && matches(kind, attachment, allowed)).length < least;
    });
  }

  function customerAccess(value) {
    const input = isObject(value) ? value : {};
    const visible = input.visible === true || text(input.visibility).toLowerCase() === 'visible';
    const canEdit = visible && (input.can_edit_items === true || text(input.item_editing).toLowerCase() === 'customer');
    const canComplete = visible && (input.can_complete === true || text(input.completion).toLowerCase() === 'customer' || canEdit);
    return { schema_version: 1, visible, can_complete: canComplete, can_edit_items: canEdit, voice_mode: !visible || !canComplete ? 'off' : canEdit ? 'edit' : 'complete' };
  }

  /** The checklist the create route answers with (the row, without its items). */
  function madeChecklist(ctx, payload) {
    const body = ctx.body, at = iso(ctx);
    const departments = has(body, 'department_ids') && body.department_ids != null ? texts(body.department_ids) : texts(payload && payload.department_context && payload.department_context.member_department_ids);
    const metadata = Object.assign({}, isObject(body.metadata) ? body.metadata : {}, {
      department_ids: departments, assignment_policy: isObject(body.assignment_policy) ? body.assignment_policy : {},
      assigned_user_ids: texts(body.assigned_user_ids), assigned_role_ids: texts(body.assigned_role_ids), assigned_resource_group_ids: texts(body.assigned_resource_group_ids),
      customer_access: customerAccess(body.customer_access)
    }, body.signature_required !== undefined ? { signature_required: body.signature_required === true } : {});
    return {
      schema_version: 1, id: text(body.id), organization_id: ctx.org, project_id: ctx.params.project,
      title: text(body.title || body.name), description: text(body.description), kind: text(body.kind) === 'quality' ? 'quality' : 'todo',
      audience: text(body.audience).toLowerCase() === 'supervisor' ? 'supervisor' : 'crew', crew_editable: body.crew_editable === true,
      source: 'manual', source_key: '', icon: text(body.icon), sort_order: Math.round(Number(body.sort_order || 0)), created_by_user_id: ctx.user,
      department_ids: departments, assignment_policy: metadata.assignment_policy,
      assigned_user_ids: metadata.assigned_user_ids, assigned_role_ids: metadata.assigned_role_ids, assigned_resource_group_ids: metadata.assigned_resource_group_ids,
      customer_access: customerAccess(metadata.customer_access), signature_required: metadata.signature_required === true, crew_signature: null,
      metadata, revision: 1, created_at: at, updated_at: at, deleted_at: ''
    };
  }
  /** The items a new checklist is made with, as the route numbers them. */
  const madeItems = (ctx) => list(ctx.body.items).filter(isObject).map((input, index) => (itemTitle(input) ? madeItem(ctx, text(ctx.body.id), Object.assign({}, input, { sort_order: Number(input.sort_order == null ? (index + 1) * 10 : input.sort_order) })) : null)).filter(Boolean);
  /** The names the checklists answer already has for people and groups, so a new list shows them. */
  function namesFrom(payload, field, ids) {
    const names = {};
    for (const checklist of list(payload && payload.checklists).concat(list(payload && payload.deleted_checklists))) Object.assign(names, isObject(checklist && checklist[field]) ? checklist[field] : {});
    return Object.fromEntries(ids.map((id) => [id, names[id] || id]));
  }

  /** Ids for a new checklist and its items, when the page sent none. */
  function withIds(body) {
    if (!isObject(body)) return undefined;
    const items = list(body.items);
    if (text(body.id) && items.every((item) => !isObject(item) || text(item.id))) return undefined;
    return Object.assign({}, body, { id: text(body.id) || newId('checklist') }, Array.isArray(body.items) ? { items: items.map((item) => (isObject(item) && !text(item.id) ? Object.assign({}, item, { id: newId('checklist_item') }) : item)) } : {});
  }

  const ITEM_FIELDS = ['completed', 'status', 'rating', 'note', 'notes', 'title', 'expected_revision'];
  const itemDetail = (checklist, item) => [text(item && item.title), text(checklist && checklist.title)].filter(Boolean).join(' · ');

  /** What a refusal at sync means, where the server's sentence is about the request and not the person. */
  function explain(ctx, answer) {
    if (answer.code === 'checklist_attachments_required') return FMOffline.label('fail_checklist_evidence', 'Not saved: this item needs its photo or file before it can be completed.', '');
    if (answer.code === 'checklist_items_open') return FMOffline.label('fail_checklist_open', 'Not signed: an item on this checklist was reopened or added. Finish every item, then sign again.', '');
    if (answer.code === 'checklist_complete_forbidden' || answer.code === 'checklist_assignment_required') return FMOffline.label('fail_checklist_assignment', 'Not saved: this checklist is no longer assigned to you.', '');
    return null;
  }

  // Other contracts (an attachment upload) build on these.
  FMOffline.checklists = { scopeOf, withItem, withChecklist, listsUrl };

  FMOffline.contracts.add({
    id: 'checklists',
    writes: [
      {
        // A new checklist, blank or with the items the page sends (a template's).
        id: 'checklist.create',
        match: 'POST ' + LISTS,
        when: (ctx) => isObject(ctx.body) && !!text(ctx.body.title || ctx.body.name),
        kind: 'create',
        prepare: (ctx) => withIds(ctx.body),
        scope: (ctx) => scopeOf(ctx, text(ctx.body.id)),
        records: (ctx) => [text(ctx.body.id)].concat(list(ctx.body.items).map((item) => text(item && item.id)).filter(Boolean)),
        label: (ctx) => FMOffline.label('sync_checklist_new', 'New checklist', text(ctx.body.title || ctx.body.name)),
        respond: async (ctx) => ({ ok: true, checklist: madeChecklist(ctx, await known(ctx)) }),
        duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'checklist_exists',
        effects: (ctx) => {
          const row = ctx.response.checklist;
          return [{
            match: 'GET ' + LISTS, when: (m) => m.project === ctx.params.project,
            // A project made on this device has no answer saved: its first checklist is the whole answer.
            seed: () => ({ ok: true, project_id: ctx.params.project, management: true, permissions: { view: true, complete: true, supervise: true, manage: true, crew_send: false }, department_context: {}, checklists: [], deleted_checklists: [] }),
            apply: (json) => (json && Array.isArray(json.checklists) && !json.checklists.some((entry) => entry && text(entry.id) === row.id) ? Object.assign({}, json, { checklists: json.checklists.concat([counted(Object.assign({}, row, {
              items: madeItems(ctx).map((item) => Object.assign({}, item, { completed_by_name: '' })),
              assigned_user_names: namesFrom(json, 'assigned_user_names', row.assigned_user_ids), assigned_resource_group_names: namesFrom(json, 'assigned_resource_group_names', row.assigned_resource_group_ids),
              // Whoever may add a checklist may edit it; who may complete it is the server's to say once it has it.
              assignment_required: false, can_complete: true, can_edit: true
            }))]) }) : json)
          }];
        }
      },
      {
        id: 'checklist.item.create',
        match: 'POST ' + LISTS + '/:checklist/items',
        when: (ctx) => isObject(ctx.body) && !!itemTitle(ctx.body),
        kind: 'create',
        prepare: (ctx) => (isObject(ctx.body) && !text(ctx.body.id) ? Object.assign({}, ctx.body, { id: newId('checklist_item') }) : undefined),
        scope: (ctx) => scopeOf(ctx, ctx.params.checklist),
        records: (ctx) => [text(ctx.body.id)],
        label: (ctx) => FMOffline.label('sync_checklist_item_new', 'New checklist item', itemTitle(ctx.body)),
        respond: (ctx) => ({ ok: true, item: madeItem(ctx, ctx.params.checklist, ctx.body) }),
        duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'checklist_item_exists',
        effects: (ctx) => [{ match: 'GET ' + LISTS, when: (m) => m.project === ctx.params.project, apply: (json) => (itemIn(checklistIn(json, ctx.params.checklist), ctx.response.item.id) ? json : withItem(json, ctx.params.checklist, ctx.response.item.id, () => Object.assign({}, ctx.response.item, { completed_by_name: '' }))) }]
      },
      {
        // Check, uncheck, rate, note, rename. Not queued: an item this device does not have, a change to an item's
        // settings (`metadata`, `sort_order`, ...), and completing an item whose evidence is not on the device.
        id: 'checklist.item.patch',
        match: 'PATCH ' + LISTS + '/:checklist/items/:item',
        when: async (ctx) => {
          if (!isObject(ctx.body) || !Object.keys(ctx.body).length || Object.keys(ctx.body).some((field) => !ITEM_FIELDS.includes(field))) return false;
          const item = itemIn(checklistIn(await known(ctx), ctx.params.checklist), ctx.params.item);
          if (!item) return false;
          const next = changedItem(item, ctx.body, ctx);
          if (next.item_type === 'rating' && next.rating === 'bad' && !next.note) return false;
          return !(next.completed && unmetEvidence(next).length);
        },
        kind: 'patch',
        scope: (ctx) => scopeOf(ctx, ctx.params.checklist),
        records: (ctx) => [ctx.params.item],
        label: async (ctx) => {
          const checklist = checklistIn(await known(ctx), ctx.params.checklist), item = itemIn(checklist, ctx.params.item);
          const want = asked(ctx.body), done = want.completed === true || !!want.rating;
          return FMOffline.label(done ? 'sync_checklist_item_done' : 'sync_checklist_item', done ? 'Checklist item completed' : 'Checklist item changed', itemDetail(checklist, Object.assign({}, item, has(want, 'title') ? { title: want.title } : {})));
        },
        respond: async (ctx) => {
          const checklist = checklistIn(await known(ctx), ctx.params.checklist);
          return { ok: true, item: changedItem(itemIn(checklist, ctx.params.item), ctx.body, ctx), can_edit: !!(checklist && checklist.can_edit) };
        },
        effects: (ctx) => [{
          match: 'GET ' + LISTS, when: (m) => m.project === ctx.params.project,
          apply: (json) => {
            if (!itemIn(checklistIn(json, ctx.params.checklist), ctx.params.item)) return json;
            const next = withItem(json, ctx.params.checklist, ctx.params.item, (item) => Object.assign(changedItem(item, ctx.body, ctx), { revision: item.revision, completed_by_name: item.completed_by_name }));
            // A reopened item takes the sign-off with it, as on the server.
            return withChecklist(next, ctx.params.checklist, (checklist) => (checklist.crew_signature && list(checklist.items).some((item) => item && !item.completed) ? Object.assign({}, checklist, { crew_signature: null }) : checklist));
          }
        }],
        explain,
        conflict: {
          current: (ctx) => listsUrl(ctx),
          pick: (json, ctx) => { const item = itemIn(checklistIn(json, ctx.params.checklist), ctx.params.item); return { doc: item, revision: item ? Number(item.revision) || 0 : undefined }; },
          // A rating item is done when it is rated: only its rating is sent, never `completed`.
          fields: (ctx) => Object.keys(asked(ctx.body)).filter((field) => !(field === 'completed' && has(asked(ctx.body), 'rating'))),
          mine: (ctx, base) => Object.assign({}, base, asked(ctx.body)),
          send: (ctx, merged, revision) => Object.assign({}, merged, revision ? { expected_revision: revision } : {})
        }
      },
      {
        // The sign-off of a finished checklist. `signed_at` is the server's time when it arrives; the time on this
        // device goes with it as evidence (`device_signed_at`).
        id: 'checklist.sign',
        match: 'POST ' + LISTS + '/:checklist/signature',
        when: async (ctx) => {
          const checklist = checklistIn(await known(ctx), ctx.params.checklist);
          const signature = isObject(ctx.body) && isObject(ctx.body.signature) ? ctx.body.signature : ctx.body;
          return !!checklist && checklist.signature_required === true && list(checklist.items).every((item) => item && item.completed) && isObject(signature) && !!text(signature.signer_name || signature.name || signature.text);
        },
        kind: 'action',
        prepare: (ctx) => {
          const at = new Date(ctx.now).toISOString();
          if (isObject(ctx.body.signature)) return text(ctx.body.signature.device_signed_at) ? undefined : Object.assign({}, ctx.body, { signature: Object.assign({}, ctx.body.signature, { device_signed_at: at }) });
          return text(ctx.body.device_signed_at) ? undefined : Object.assign({}, ctx.body, { device_signed_at: at });
        },
        scope: (ctx) => scopeOf(ctx, ctx.params.checklist),
        records: (ctx) => [ctx.params.checklist],
        label: async (ctx) => FMOffline.label('sync_checklist_signed', 'Checklist signed off', text((checklistIn(await known(ctx), ctx.params.checklist) || {}).title)),
        respond: async (ctx) => {
          const checklist = Object.assign({}, checklistIn(await known(ctx), ctx.params.checklist));
          for (const field of ['items', 'total_items', 'completed_items', 'assigned_user_names', 'assigned_resource_group_names', 'assignment_required', 'can_complete', 'can_edit']) delete checklist[field];
          return { ok: true, checklist: Object.assign(checklist, { crew_signature: signed(ctx), revision: (Number(checklist.revision) || 1) + 1, updated_at: iso(ctx) }) };
        },
        effects: (ctx) => [{ match: 'GET ' + LISTS, when: (m) => m.project === ctx.params.project, apply: (json) => withChecklist(json, ctx.params.checklist, (checklist) => Object.assign({}, checklist, { crew_signature: ctx.response.checklist.crew_signature })) }],
        explain
      }
    ]
  });

  /** The sign-off as the checklist shows it (checklistSignatureSummary). */
  function signed(ctx) {
    const input = isObject(ctx.body.signature) ? ctx.body.signature : ctx.body;
    const drawn = text(input.type).toLowerCase() === 'drawn';
    return Object.assign({ signer_name: text(input.signer_name || input.name || input.text), signed_at: iso(ctx), signed_by_user_id: ctx.user, type: drawn ? 'drawn' : 'typed' }, drawn && text(input.image_data) ? { image_data: text(input.image_data) } : {});
  }
})();
