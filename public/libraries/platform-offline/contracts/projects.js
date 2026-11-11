/* public/libraries/platform-offline/contracts/projects.js
 *
 * Projects offline (docs/architecture/offline.md, "What works offline"): what a pinned project downloads, a new
 * project made without a connection, and edits to a project's own fields.
 *
 * A project's id is made on the device (`project_<time>_<random>`), so a project created offline is the same
 * record when it is sent. Entries of one project share the scope `project:<id>`: they are sent in order, after
 * the project's own create.
 */
(function () {
  'use strict';

  const ORG = '/v1/platform/organizations/:org';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const projectUrl = (ctx, id) => `/v1/platform/organizations/${enc(ctx.org)}/projects/${enc(id)}`;
  const titleOf = (data) => text(data && (data.title || data.project_title || data.address || data.name));

  /** The tabs of a project window: each asks which guides it has. */
  const PROJECT_TABS = ['', 'project.map', 'project.photos', 'project.docs', 'project.schedule', 'project.comms', 'project.materials', 'project.money', 'project.checklists'];

  /** A channel id for a project that has no channel on the server yet (channels-api.js knows the prefix). */
  const localChannelId = (projectId) => 'chan_local_' + projectId;

  // ---------------------------------------------------------------------------------------------------------
  // What a pinned project downloads: every read its window and tabs make, also the ones a tab makes lazily.
  // ---------------------------------------------------------------------------------------------------------

  function projectReads(ctx) {
    const o = enc(ctx.org), p = enc(ctx.project);
    const target = { scope: 'project', organizationId: ctx.org, projectId: ctx.project };
    const publication = `/v1/publication/organizations/${o}`;
    return [
      // The project itself and what its tabs list.
      `/v1/platform/organizations/${o}/projects/${p}`,
      `/v1/platform/organizations/${o}/projects/${p}/documents`,
      `/v1/platform/organizations/${o}/media?project_id=${p}`,
      `/v1/platform/organizations/${o}/recurrence-series?project_id=${p}&include_cancelled=1`,
      `/v1/work/organizations/${o}/activity?limit=100&project_id=${p}`,
      `/v1/materials/organizations/${o}/projects/${p}/calculus`,
      `${publication}/projects/${p}/measurements`,
      `/v1/comms/organizations/${o}/projects/${p}/overview`,
      `/v1/comms/organizations/${o}/projects/${p}/settings`,
      `/v1/workforce/organizations/${o}/crew/projects/${p}/checklists`,
      ...PROJECT_TABS.map((tab) => `/v1/guided-experiences/organizations/${o}/experiences?tab=${enc(tab)}&project_id=${p}`),
      // What every project window reads about the organization.
      `/v1/platform/organizations/${o}`,
      `/v1/platform/organizations/${o}/projects`,
      `/v1/platform/organizations/${o}/users`,
      `/v1/platform/organizations/${o}/activity`,
      `/v1/platform/pricebook/organizations/${o}`,
      `/v1/comms/organizations/${o}/settings`,
      `/v1/materials/organizations/${o}/suppliers`,
      `/v1/equipment/organizations/${o}/units`,
      `/v1/equipment/organizations/${o}/types`,
      `/v1/work/organizations/${o}/boards?include_completed=1`,
      `/v1/channels/organizations/${o}/channels`,
      `/v1/channels/organizations/${o}/directory`,
      // Reads the window makes with POST (declared in portal.js): report widgets, data sets, measurement schema, custom fields.
      { url: `${publication}/data/list`, body: { source: { provider: 'datasets', export: 'value', target }, limit: 200 } },
      { url: `${publication}/data/read`, body: { provider: 'project-widgets', export: 'report', target } },
      { url: `${publication}/data/read`, body: { provider: 'measurement-schemas', export: 'manual', target } },
      { url: `${publication}/data/read`, body: { provider: 'custom-fields-project', export: 'contract', target } },
      { url: `/v1/materials/organizations/${o}/projects/${p}/requirements`, body: { legacy_measurements: {} } }
    ];
  }

  /** The reads that carry the person's branch in their address. */
  function branchReads(me, ctx) {
    const o = enc(ctx.org), p = enc(ctx.project);
    const branch = enc(text(me && me.membership && me.membership.branch_id) || 'default');
    return [
      `/v1/work/organizations/${o}/todos?project_id=${p}&branch_id=${branch}&include_completed=1&include_future=1&include_unassigned=1&all_users=1`,
      `/v1/work/organizations/${o}/branches/${branch}/config`,
      `/v1/workforce/organizations/${o}/branches/${branch}/assignable-resources`,
      `/v1/workforce/organizations/${o}/branches/${branch}/configuration`,
      `/v1/appointments/organizations/${o}/branches/${branch}/confirmation-settings`,
      `/v1/scopes/organizations/${o}/branches/${branch}/templates?include_disabled=1`
    ];
  }

  // ---------------------------------------------------------------------------------------------------------
  // A project made on this device
  // ---------------------------------------------------------------------------------------------------------

  /** The document the create route answers with, as far as a device can know it: no scope has started yet. */
  function madeDocument(ctx) {
    const at = new Date(ctx.now).toISOString();
    const sent = isObject(ctx.body.data) ? ctx.body.data : {};
    const data = Object.assign({}, sent, { contacts: Array.isArray(sent.contacts) ? sent.contacts : [] });
    return {
      schema_version: 1, id: ctx.params.project, organization_id: ctx.org, collection: 'projects',
      data, metadata: Object.assign({ kind: 'platform_project' }, ctx.body.metadata),
      revision: 0, created_at: at, updated_at: at
    };
  }

  /**
   * What the new project's own reads answer until the server has it. Nothing was ever saved for them, and an
   * empty list is the truth: the project exists only here.
   */
  function newProjectSeeds(ctx, document) {
    const id = ctx.params.project;
    const mine = (m) => m.project === id;
    const about = (name) => (m, read) => text(read.query[name]) === id;
    const channel = { id: localChannelId(id), type: 'project', name: titleOf(document.data) || 'Project', display_name: titleOf(document.data) || 'Project', topic: '', project_id: id, separate_notes: true, archived_at: null, message_seq: 0, last_message_at: null, settings: {}, created_by: ctx.user, created_at: document.created_at, member_count: 1, members: [], assistant_dm: false, is_member: true, can_manage: true, can_post: true, can_invite: false };
    const inChannel = (m) => m.channel === channel.id;
    return [
      { match: 'GET ' + ORG + '/projects/:project', when: mine, seed: () => ({ ok: true, document }) },
      { match: 'GET ' + ORG + '/projects/:project/documents', when: mine, seed: { ok: true, project_id: id, documents: [], special_documents: [], uploaded_documents: [] } },
      { match: 'GET ' + ORG + '/media', when: about('project_id'), seed: { ok: true, media: [] } },
      { match: 'GET ' + ORG + '/recurrence-series', when: about('project_id'), seed: { ok: true, series: [] } },
      { match: 'GET /v1/work/organizations/:org/projects/:project/plans', when: mine, seed: { ok: true, plans: [], count: 0 } },
      { match: 'GET /v1/work/organizations/:org/todos', when: about('project_id'), seed: { ok: true, todos: [], count: 0 } },
      { match: 'GET /v1/work/organizations/:org/activity', when: about('project_id'), seed: { ok: true, events: [], count: 0, next_before: null } },
      { match: 'GET /v1/documents/organizations/:org/projects/:project/documents', when: mine, seed: { ok: true, documents: [], count: 0 } },
      { match: 'GET /v1/materials/organizations/:org/projects/:project/calculus', when: mine, seed: { ledger: { revision: 0, project_id: id, sets: [], orders: [], deliveries: [], events: [], unallocated: [] } } },
      { match: 'GET /v1/guided-experiences/organizations/:org/experiences', when: about('project_id'), seed: { ok: true, experiences: [], reveals: [] } },
      // Its notes: a local channel until the server makes the real one (notes.js sends them addressed by project).
      { match: 'GET /v1/channels/organizations/:org/channels/project/:project', when: mine, seed: () => ({ ok: true, channel }) },
      { match: 'GET /v1/channels/organizations/:org/channels/:channel/messages', when: inChannel, seed: () => ({ ok: true, channel, messages: [], next_before: null }) },
      { match: 'GET /v1/channels/organizations/:org/channels/:channel/pins', when: inChannel, seed: { ok: true, messages: [] } },
      { match: 'GET /v1/channels/organizations/:org/channels/:channel/note-authors', when: inChannel, seed: { ok: true, authors: [] } }
    ];
  }

  /** The project list with one document added or replaced. */
  function withDocument(json, document) {
    if (!json || !Array.isArray(json.documents)) return json;
    const at = json.documents.findIndex((item) => item && item.id === document.id);
    const documents = json.documents.slice();
    if (at < 0) documents.push(document); else documents[at] = document;
    return Object.assign({}, json, { documents });
  }

  // ---------------------------------------------------------------------------------------------------------
  // An edit to a project's fields
  // ---------------------------------------------------------------------------------------------------------

  /**
   * A project's data with the queued change applied. Each changed field is merged three ways (as it was, as the
   * person left it, as it is now), so a list the server has since added to keeps those additions while the
   * change waits.
   */
  function patched(ctx, current) {
    const sent = isObject(ctx.body.data) ? ctx.body.data : {};
    const base = isObject(ctx.base) ? ctx.base : null;
    const data = Object.assign({}, current);
    for (const field of Object.keys(sent)) {
      data[field] = base ? FMOffline.merge3(base[field], sent[field], current ? current[field] : undefined).value : sent[field];
    }
    return data;
  }

  function patchedDocument(ctx, document) {
    const at = new Date(ctx.now).toISOString();
    const from = isObject(document) ? document : { schema_version: 1, id: ctx.params.project, organization_id: ctx.org, collection: 'projects', data: {}, metadata: {}, revision: 0, created_at: at };
    return Object.assign({}, from, {
      data: Object.assign(patched(ctx, isObject(from.data) ? from.data : {}), { updated_at: at }),
      metadata: Object.assign({}, from.metadata, ctx.body.metadata),
      updated_at: at
    });
  }

  FMOffline.contracts.add({
    id: 'projects',
    reads: [
      {
        // What a project requires and how its lists cover it: computed from the lists as they stand, nothing is stored.
        id: 'materials.requirements',
        match: 'POST /v1/materials/organizations/:org/projects/:project/requirements',
        when: (ctx) => isObject(ctx.body),
        key: (ctx) => ({ project: ctx.params.project, body: ctx.body })
      }
    ],
    prefetch: [
      projectReads,
      { url: '/v1/platform/me', each: branchReads },
      {
        url: (ctx) => `/v1/work/organizations/${enc(ctx.org)}/projects/${enc(ctx.project)}/plans?include_tree=1`,
        each: (json, ctx) => (Array.isArray(json && json.plans) ? json.plans : []).filter((plan) => plan && plan.id).map((plan) => `/v1/work/organizations/${enc(ctx.org)}/plans/${enc(plan.id)}`)
      }
    ],
    writes: [
      {
        // Portal.ProjectStore.saveRemote for a project this page never read: PUT with create_only.
        id: 'project.create',
        match: 'PUT ' + ORG + '/projects/:project',
        when: (ctx) => isObject(ctx.body) && ctx.body.create_only === true && isObject(ctx.body.data),
        kind: 'create',
        scope: (ctx) => 'project:' + ctx.params.project,
        records: (ctx) => [ctx.params.project],
        label: (ctx) => (FMOffline.label('sync_project_new', 'New project', titleOf(ctx.body.data))),
        respond: (ctx) => ({ ok: true, document: madeDocument(ctx) }),
        // The first try reached the server and its answer was lost: the project is there, with what was sent.
        duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'project_exists',
        effects: (ctx) => {
          const document = ctx.response.document;
          return [
            { match: 'GET ' + ORG + '/projects', apply: (json) => withDocument(json, document) },
            ...newProjectSeeds(ctx, document)
          ];
        }
      },
      {
        // A lead received from this device (PlatformAPI.leads.create) with the project id made here.
        id: 'lead.create',
        match: 'POST ' + ORG + '/leads',
        when: (ctx) => isObject(ctx.body) && /^[a-z0-9][a-z0-9_-]{7,79}$/.test(text(ctx.body.project_id)),
        kind: 'create',
        scope: (ctx) => 'project:' + ctx.body.project_id,
        records: (ctx) => [ctx.body.project_id],
        label: (ctx) => (FMOffline.label('sync_lead_new', 'New lead', text(ctx.body.title) || text(ctx.body.address) || text(ctx.body.customer && ctx.body.customer.name) || text(ctx.body.contacts && ctx.body.contacts[0] && ctx.body.contacts[0].name))),
        respond: (ctx) => {
          const at = new Date(ctx.now).toISOString();
          const people = (Array.isArray(ctx.body.contacts) ? ctx.body.contacts : ctx.body.customer ? [ctx.body.customer] : []).filter(isObject);
          const data = { title: text(ctx.body.title) || text(ctx.body.address), address: text(ctx.body.address), summary: text(ctx.body.summary), contacts: [], lead_source: { kind: text(ctx.body.source_kind || ctx.body.source), provider: text(ctx.body.provider), received_at: at }, created_at: at, updated_at: at };
          const project = { schema_version: 1, id: ctx.body.project_id, organization_id: ctx.org, collection: 'projects', data, metadata: { kind: 'platform_project' }, revision: 0, created_at: at, updated_at: at };
          return { ok: true, project, contacts: people.filter((person) => text(person.contact_id)).map((person) => Object.assign({}, person, { id: person.contact_id })), matched_contact_ids: [] };
        },
        duplicate: (ctx, answer) => answer.status === 409 && answer.code === 'project_exists',
        effects: (ctx) => {
          const document = ctx.response.project;
          const seedCtx = Object.assign({}, ctx, { params: Object.assign({}, ctx.params, { project: ctx.body.project_id }) });
          return [
            { match: 'GET ' + ORG + '/projects', apply: (json) => withDocument(json, document) },
            ...newProjectSeeds(seedCtx, document)
          ];
        }
      },
      {
        // Portal.ProjectStore.saveRemote for a project it read: PATCH of the top-level fields that changed.
        id: 'project.patch',
        match: 'PATCH ' + ORG + '/projects/:project',
        when: (ctx) => isObject(ctx.body) && isObject(ctx.body.data),
        kind: 'patch',
        scope: (ctx) => 'project:' + ctx.params.project,
        records: (ctx) => [ctx.params.project],
        label: async (ctx) => {
          const saved = await ctx.saved(projectUrl(ctx, ctx.params.project));
          return FMOffline.label('sync_project_edit', 'Project change', titleOf(Object.assign({}, saved && saved.document && saved.document.data, ctx.body.data)));
        },
        respond: async (ctx) => {
          const saved = await ctx.saved(projectUrl(ctx, ctx.params.project));
          return { ok: true, document: patchedDocument(Object.assign({}, ctx, { base: saved && saved.document ? saved.document.data : null }), saved && saved.document) };
        },
        effects: (ctx) => [
          { match: 'GET ' + ORG + '/projects/:project', when: (m) => m.project === ctx.params.project, apply: (json) => (json && json.document ? Object.assign({}, json, { document: patchedDocument(ctx, json.document) }) : json) },
          { match: 'GET ' + ORG + '/projects', apply: (json) => {
            const found = json && Array.isArray(json.documents) ? json.documents.find((item) => item && item.id === ctx.params.project) : null;
            return found ? withDocument(json, patchedDocument(ctx, found)) : json;
          } }
        ],
        conflict: {
          current: (ctx) => projectUrl(ctx, ctx.params.project),
          pick: (json) => ({ doc: json && json.document ? json.document.data : null, revision: json && json.document ? json.document.revision : undefined }),
          // `updated_at` is the time of the edit, not a choice: the newest wins without asking.
          fields: (ctx) => Object.keys(ctx.body.data).filter((field) => field !== 'updated_at'),
          mine: (ctx, base) => Object.assign({}, base, ctx.body.data),
          send: (ctx, merged, revision) => Object.assign({ data: merged, metadata: ctx.body.metadata || {} }, revision ? { expected_revision: revision } : {})
        }
      }
    ]
  });
})();
