/* public/libraries/platform-offline/contracts/todos.js
 *
 * To-dos offline (docs/architecture/offline.md, "What works offline"): a to-do added by hand, completing and
 * reopening one, and edits to its fields.
 *
 * The page makes a manual to-do's id (`action_item_manual_<time>_<random>`), and the server derives the plan
 * and the to-do's own id from it (work/service.ts stableId), so the device can name the record before the server
 * has it: plan `work_plan_` + sha256("<org>:manual_todo:<id>")[0..24], to-do `work_node_` + sha256("<plan>:task")[0..24].
 * A repeat of the same id answers with the to-do that exists. Follow-ups are made by the server and need a
 * connection.
 */
(function () {
  'use strict';

  const WORK = '/v1/work/organizations/:org';
  const enc = encodeURIComponent;
  const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value) => String(value == null ? '' : value).trim();
  const list = (value) => (Array.isArray(value) ? value : []);
  const iso = (ctx) => new Date(ctx.now).toISOString();
  const nodeUrl = (ctx, node) => `/v1/work/organizations/${enc(ctx.org)}/nodes/${enc(node)}`;

  async function stableId(prefix, value) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    let hex = '';
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
    return prefix + '_' + hex.slice(0, 24);
  }
  /** The ids the server will give a manual to-do made with this page id. */
  async function idsFor(ctx) {
    const plan = await stableId('work_plan', `${ctx.org}:manual_todo:${text(ctx.body.id)}`);
    return { plan, node: await stableId('work_node', `${plan}:task`) };
  }
  const projectOf = (body) => text(body.project_id) || text(list(body.project_ids)[0]);

  /** A manual to-do the page named: not a follow-up (the server makes those). */
  const manualTodo = (ctx) => isObject(ctx.body) && !!text(ctx.body.id) && text(ctx.body.kind) !== 'follow_up';

  /** The to-do the create route answers with, as far as the device can know it. */
  async function madeTodo(ctx) {
    const body = ctx.body;
    const ids = await idsFor(ctx);
    const at = iso(ctx);
    const metadata = Object.assign({
      kind: text(body.kind) || 'manual', frontend_action: body.frontend_action || { kind: 'manual' }, payload: body.payload || {},
      project_title: text(body.project_title || body.context_title), project_address: text(body.project_address || body.context_address)
    }, isObject(body.metadata) ? body.metadata : {}, { department_ids: list(body.department_ids), history: [] });
    const todo = {
      id: ids.node, organization_id: ctx.org, branch_id: text(body.branch_id) || 'default', plan_id: ids.plan, project_id: projectOf(body) || null,
      parent_id: null, template_node_id: 'task', scope_piece_id: null, terminology_key: 'work.task',
      title: text(body.title) || 'To-do', description: text(body.body || body.description), sort_order: 0, depth: 0,
      status: 'ready', completion_mode: 'manual', actionable: true, show_in_todo_list: true, priority: Math.max(0, Math.round(Number(body.priority) || 0)),
      assigned_user_ids: list(body.assigned_user_ids), assigned_role_ids: list(body.assigned_role_ids), assigned_resource_group_ids: list(body.assigned_resource_group_ids),
      automation_bindings: {}, external_triggers: [], notes: [], metadata, department_ids: list(body.department_ids),
      due_at: text(body.due_at) || null, ready_at: at, started_at: null, completed_at: null, skipped_at: null, canceled_at: null, created_at: at, updated_at: at,
      project_title: metadata.project_title, project_address: metadata.project_address
    };
    const plan = { id: ids.plan, organization_id: ctx.org, branch_id: todo.branch_id, project_id: todo.project_id, source_type: 'manual_todo', source_id: text(body.id), source_key: 'manual_todo:' + text(body.id), title: todo.title, status: 'active', root_node_id: ids.node, created_at: at, updated_at: at };
    return { todo, plan };
  }

  /** Whether a to-do list that was asked with these filters shows this to-do. */
  function listShows(read, todo) {
    const query = read.query || {};
    const project = text(query.project_id);
    if (project && project !== text(todo.project_id)) return false;
    const projects = text(query.project_ids).split(',').map(text).filter(Boolean);
    if (projects.length && !projects.includes(text(todo.project_id))) return false;
    // A contact's list names the contact; a to-do made elsewhere does not belong to it.
    if (text(query.contact_id) || text(query.contact_email) || text(query.contact_phone)) {
      const refs = list(todo.metadata && todo.metadata.contact_refs);
      if (!refs.some((ref) => ref && ((text(query.contact_id) && text(ref.contact_id) === text(query.contact_id)) || (text(query.contact_email) && text(ref.email) === text(query.contact_email))))) return false;
    }
    const branch = text(query.branch_id);
    return !branch || branch === text(todo.branch_id);
  }

  /** A to-do list with one to-do changed by `change`; unchanged when it is not there. */
  function withChanged(json, id, change) {
    if (!json || !Array.isArray(json.todos) || !json.todos.some((todo) => todo && todo.id === id)) return json;
    return Object.assign({}, json, { todos: json.todos.map((todo) => (todo && todo.id === id ? change(todo) : todo)) });
  }

  /** The to-do as the device last saw it: its own read, else whichever list holds it. */
  async function knownTodo(ctx, id) {
    const own = await ctx.saved(nodeUrl(ctx, id));
    if (own && own.node) return own.node;
    for (const found of await ctx.find('GET ' + WORK + '/todos')) {
      const todo = list(found.json && found.json.todos).find((item) => item && item.id === id);
      if (todo) return todo;
    }
    return null;
  }

  /** A change to a to-do made on this device is sent after the change that made it; any other to-do keeps its own order. */
  async function scopeOf(ctx, id) {
    const earlier = await ctx.queued(id);
    return earlier.length ? earlier[0].scope : 'todo:' + id;
  }

  function moved(todo, body, at) {
    const status = text(body.status);
    const history = list(todo.metadata && todo.metadata.history).concat([{ from: todo.status, to: status, reason: text(body.reason), actor_user_id: '', at, payload: {} }]);
    return Object.assign({}, todo, {
      status, updated_at: at, metadata: Object.assign({}, todo.metadata, { history }),
      completed_at: status === 'completed' ? at : null,
      started_at: status === 'active' ? at : todo.started_at || null,
      canceled_at: status === 'canceled' ? at : null
    });
  }

  /** Published to-do actions that set a status or fields: sending one twice changes nothing more. */
  const TODO_ACTIONS = ['work.todos.transition', 'work.todos.patch'];

  FMOffline.contracts.add({
    id: 'todos',
    writes: [
      {
        id: 'todo.create',
        match: 'POST ' + WORK + '/todos',
        when: manualTodo,
        kind: 'create',
        // A to-do on a project that was made on this device waits for that project; any other to-do has its own order.
        scope: async (ctx) => {
          const project = projectOf(ctx.body);
          const waiting = project ? await ctx.queued(project) : [];
          return waiting.some((entry) => entry.kind === 'create') ? 'project:' + project : 'todo:' + (await idsFor(ctx)).node;
        },
        records: async (ctx) => [(await idsFor(ctx)).node, text(ctx.body.id)],
        label: (ctx) => ({ key: 'sync_todo_new', title: 'New to-do', detail: text(ctx.body.title) }),
        respond: async (ctx) => Object.assign({ ok: true }, await madeTodo(ctx)),
        effects: (ctx) => {
          const todo = ctx.response.todo;
          return [
            { match: 'GET ' + WORK + '/nodes/:node', when: (m) => m.node === todo.id, seed: () => ({ ok: true, node: todo }) },
            {
              match: 'GET ' + WORK + '/todos', when: (m, read) => listShows(read, todo),
              apply: (json) => (json && Array.isArray(json.todos) && !json.todos.some((item) => item && item.id === todo.id) ? Object.assign({}, json, { todos: [...json.todos, todo], count: (Number(json.count) || json.todos.length) + 1 }) : json)
            }
          ];
        }
      },
      {
        // Complete, reopen, claim or cancel. A repeat of the same status changes nothing on the server.
        id: 'todo.transition',
        match: 'POST ' + WORK + '/nodes/:node/transition',
        when: (ctx) => isObject(ctx.body) && ['completed', 'ready', 'active', 'canceled'].includes(text(ctx.body.status)),
        kind: 'action',
        scope: (ctx) => scopeOf(ctx, ctx.params.node),
        records: (ctx) => [ctx.params.node],
        label: async (ctx) => {
          const todo = await knownTodo(ctx, ctx.params.node);
          const done = text(ctx.body.status) === 'completed';
          return { key: done ? 'sync_todo_done' : 'sync_todo_status', title: done ? 'To-do completed' : 'To-do changed', detail: text(todo && todo.title) };
        },
        respond: async (ctx) => {
          const todo = (await knownTodo(ctx, ctx.params.node)) || { id: ctx.params.node, metadata: {} };
          return { ok: true, node: moved(todo, ctx.body, iso(ctx)) };
        },
        effects: (ctx) => {
          const change = (todo) => moved(todo, ctx.body, iso(ctx));
          return [
            { match: 'GET ' + WORK + '/todos', apply: (json) => withChanged(json, ctx.params.node, change) },
            { match: 'GET ' + WORK + '/nodes/:node', when: (m) => m.node === ctx.params.node, apply: (json) => (json && json.node ? Object.assign({}, json, { node: change(json.node) }) : json) }
          ];
        }
      },
      {
        // An edit to a to-do's own fields (title, description, due date, priority, who it is assigned to).
        id: 'todo.patch',
        match: 'PATCH ' + WORK + '/nodes/:node',
        when: (ctx) => isObject(ctx.body) && Object.keys(ctx.body).length > 0,
        kind: 'patch',
        scope: (ctx) => scopeOf(ctx, ctx.params.node),
        records: (ctx) => [ctx.params.node],
        label: async (ctx) => ({ key: 'sync_todo_edit', title: 'To-do change', detail: text(ctx.body.title) || text(((await knownTodo(ctx, ctx.params.node)) || {}).title) }),
        respond: async (ctx) => ({ ok: true, node: Object.assign({}, await knownTodo(ctx, ctx.params.node), ctx.body, { id: ctx.params.node, updated_at: iso(ctx) }) }),
        effects: (ctx) => {
          const change = (todo) => Object.assign({}, todo, ctx.body, { updated_at: iso(ctx) });
          return [
            { match: 'GET ' + WORK + '/todos', apply: (json) => withChanged(json, ctx.params.node, change) },
            { match: 'GET ' + WORK + '/nodes/:node', when: (m) => m.node === ctx.params.node, apply: (json) => (json && json.node ? Object.assign({}, json, { node: change(json.node) }) : json) }
          ];
        },
        // The route has no revision to check, so the merge is per field against the to-do as it is now: a field
        // the person did not change is never sent, and the same field changed differently on both sides is asked about.
        conflict: {
          current: (ctx) => nodeUrl(ctx, ctx.params.node),
          pick: (json) => ({ doc: json && json.node ? json.node : null, revision: json && json.node ? json.node.updated_at : undefined }),
          fields: (ctx) => Object.keys(ctx.body),
          send: (ctx, merged) => merged
        }
      },
      {
        // The to-do widget (platform-widgets/todo-widgets.js) completes, reopens and edits a to-do through a
        // published action, which carries its own `idempotencyKey`. The queued action is sent with that key, so the
        // server runs it once. If the server answers `action_outcome_uncertain` (it started the action under that
        // key and does not know how it ended; the key is then refused for good), the action is sent again once
        // under a new key: setting a to-do's status or fields a second time changes nothing more.
        id: 'todo.action',
        match: 'POST /v1/publication/organizations/:org/actions/invoke',
        when: (ctx) => isObject(ctx.body) && TODO_ACTIONS.includes(text(ctx.body.action)) && !!text(ctx.body.idempotencyKey)
          && isObject(ctx.body.target) && !!text(ctx.body.target.id) && isObject(ctx.body.input)
          && (text(ctx.body.action) !== 'work.todos.transition' || ['completed', 'ready', 'active', 'canceled'].includes(text(ctx.body.input.status))),
        kind: 'action',
        scope: (ctx) => scopeOf(ctx, text(ctx.body.target.id)),
        records: (ctx) => [text(ctx.body.target.id)],
        label: async (ctx) => {
          const todo = await knownTodo(ctx, text(ctx.body.target.id));
          const done = text(ctx.body.input.status) === 'completed';
          const edit = text(ctx.body.action) === 'work.todos.patch';
          return { key: edit ? 'sync_todo_edit' : done ? 'sync_todo_done' : 'sync_todo_status', title: edit ? 'To-do change' : done ? 'To-do completed' : 'To-do changed', detail: text(ctx.body.input.title) || text(todo && todo.title) };
        },
        respond: (ctx) => ({
          value: Object.assign({ id: text(ctx.body.target.id) }, ctx.body.input),
          receipt: { id: 'offline_' + ctx.id, status: 'succeeded', replayed: false, action: text(ctx.body.action), version: text(ctx.body.version) || '1', implementation: '' }
        }),
        resend: (ctx, answer) => (answer.status === 409 && answer.code === 'action_outcome_uncertain' ? Object.assign({}, ctx.body, { idempotencyKey: 'todo-offline-' + crypto.randomUUID() }) : null),
        effects: (ctx) => {
          const id = text(ctx.body.target.id), input = ctx.body.input, at = iso(ctx);
          const transition = text(ctx.body.action) === 'work.todos.transition';
          const change = (todo) => (transition ? moved(todo, input, at) : Object.assign({}, todo, input, { updated_at: at }));
          // The widget's own list: published items, where a to-do that can be done is `open` and `workflow_status` is the raw status.
          const item = (todo) => (transition
            ? Object.assign({}, todo, { status: text(input.status) === 'ready' ? 'open' : text(input.status), workflow_status: text(input.status), completed_at: text(input.status) === 'completed' ? at : null, updated_at: at })
            : Object.assign({}, todo, input, { updated_at: at }));
          return [
            { match: 'GET ' + WORK + '/todos', apply: (json) => withChanged(json, id, change) },
            { match: 'GET ' + WORK + '/nodes/:node', when: (m) => m.node === id, apply: (json) => (json && json.node ? Object.assign({}, json, { node: change(json.node) }) : json) },
            {
              match: 'POST /v1/publication/organizations/:org/data/read', when: (m, read) => isObject(read.body) && text(read.body.provider) === 'todos',
              apply: (json) => (json && Array.isArray(json.value) && json.value.some((todo) => todo && todo.id === id) ? Object.assign({}, json, { value: json.value.map((todo) => (todo && todo.id === id ? item(todo) : todo)) }) : json)
            }
          ];
        }
      }
    ]
  });
})();
