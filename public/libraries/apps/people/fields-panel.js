/* public/libraries/apps/people/fields-panel.js
 *
 * Fills the People 'fields' slot with custom fields. The shared custom fields
 * library (FirstMateCustomFields) draws and validates; this file does the
 * reading and writing it deliberately leaves to the page.
 *
 *   A record (a user, a group of users, an outside company)
 *     reads   custom-fields-<owner>.resolved
 *     shows   mountValuesForm, grouped by the role or type each field comes from
 *     saves   custom-fields.<owner>.write with the record revision
 *     Fields that have no home yet come last, and someone who manages company
 *     settings can place one on a role or type the record has.
 *
 *   A home (a role, a group type, a company type, one department)
 *     reads   custom-fields-homes.definitions
 *     shows   mountDefinitionsEditor
 *     saves   custom-fields.definitions.save with that home's revision
 *
 * Which one an entity is comes from its kind, or from entity.home = { kind, id }
 * when the caller says so outright:
 *     organization_user, resource_group, organization_connection      records
 *     access_role -> role          resource_group_kind -> group_type
 *     department  -> department    organization_connection_type -> company_type
 *
 * What reference fields point at is taken from People's own store where it is
 * already loaded (users, groups, departments); outside companies, contacts and
 * media are read once per page, and only when a field needs them.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.fieldsPanel || !People.slots || !People.kit) return;
  const kit = People.kit;
  const { esc, t, tip } = kit;

  const RECORDS = { organization_user:'user', resource_group:'team', organization_connection:'company' };
  const HOMES = { access_role:'role', resource_group_kind:'group_type', organization_connection_type:'company_type', company_type:'company_type', department:'department' };
  const HOME_OF_OWNER = { user:'role', team:'group_type', company:'company_type' };
  const CONTACT_TYPES = ['contact', 'human_contact', 'org_contact'];
  const MEDIA_TYPES = ['media', 'photo', 'video'];
  const arr = (value) => Array.isArray(value) ? value : [];
  const obj = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (...values) => { for (const value of values) { const clean = String(value ?? '').trim(); if (clean) return clean; } return ''; };
  const api = () => window.PlatformAPI;
  const cf = () => window.FirstMateCustomFields;
  const key = () => `people_fields_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const homeKindLabel = (kind) => ({ role:t('role', 'role'), group_type:t('group_type', 'group type'), company_type:t('company_type', 'company type'), department:t('department', 'department') }[kind] || kind);

  function ensureStyles(){
    if (document.getElementById('pp_fields_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_fields_css';
    style.textContent = `
      .pp-fields{display:grid;gap:14px;min-width:0;align-content:start}
      .pp-fields-note{font-size:12px;font-weight:650;color:#b42318}
      .pp-fields-place{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;border-top:1px solid var(--pp-line,#e4e7ec);padding-top:12px}
      .pp-fields-place .pp-input{width:auto;min-width:0;max-width:100%;flex:0 1 auto}
      .pp-fields-place .pp-btn:disabled{opacity:.6;cursor:default}
      /* The shared custom fields controls, dressed in the People kit: same heights, radii, borders and type sizes. */
      .pp-fields .fm-cf-label{min-height:18px;align-items:center}
      .pp-fields .fm-cf-field>label{font-size:10.5px;font-weight:700;letter-spacing:.04em;color:var(--pp-muted,#667085)}
      .pp-fields .fm-cf-input{min-height:34px;padding:6px 10px;border:1px solid #d0d5dd;border-radius:9px;background:var(--pp-panel,#fff);color:var(--pp-text,#101828);font-size:13px}
      .pp-fields select.fm-cf-input{height:34px;padding-top:0;padding-bottom:0}
      .pp-fields .fm-cfx-ro{min-height:34px;border-radius:9px;border-color:var(--pp-line,#e4e7ec);background:var(--pp-hover,#f9fafb);font-size:13px}
      .pp-fields .fm-cf-toggle{min-height:34px;box-sizing:border-box;border-color:#d0d5dd;border-radius:9px;padding:4px 10px;font-size:12px;font-weight:650}
      .pp-fields .fm-cf-choice span{border-radius:9px;font-size:12px;font-weight:650;padding:7px 11px}
      .pp-fields .fm-cfx-group-title,.pp-fields .fm-cfd-head strong{font-size:13px;font-weight:650;color:var(--pp-strong,#101828)}
      .pp-fields .fm-cfx-group+.fm-cfx-group{border-top:1px solid var(--pp-line,#e4e7ec);padding-top:14px}
      .pp-fields .fm-cfd-btn{height:30px;min-height:30px;border-color:#d0d5dd;border-radius:9px;background:var(--pp-panel,#fff);color:var(--pp-strong,#101828);font-size:12.5px;font-weight:650}
      .pp-fields .fm-cfd-row{border-color:var(--pp-line,#e4e7ec);border-radius:12px}
      .pp-fields .fm-cfd-title{font-size:13px;font-weight:650;color:var(--pp-strong,#101828)}
      .pp-fields .fm-cfd-toggle{font-weight:600;font-size:12.5px}
      .pp-fields .fm-cfd-empty,.pp-fields .fm-cfx-empty{display:grid;place-items:center;min-height:120px;border:1px dashed var(--pp-line,#e4e7ec);border-radius:12px;color:var(--pp-muted,#667085);font-size:13px}
      .pp-fields-place strong{font-size:12px;font-weight:700;color:var(--pp-strong,#101828);display:inline-flex;align-items:center;gap:6px}
    `;
    document.head.appendChild(style);
  }

  /* ---- reading and writing through publication ---- */
  function failure(source, fallback){
    const data = obj(source?.data || source);
    const error = source instanceof Error ? source : new Error(text(data.message, fallback));
    error.code = text(error.code, data.code, obj(data.error).code, typeof data.error === 'string' ? data.error : '');
    error.details = obj(error.details && Object.keys(error.details).length ? error.details : data.details || obj(data.error).details);
    return error;
  }
  async function read(orgId, provider, name, target, args){
    let response;
    try { response = await api().publication.read(orgId, { provider, export:name, target, ...(args ? { args } : {}) }); }
    catch (error) { throw failure(error, t('load_failed', 'Could not load')); }
    const result = response?.result || response;
    if (result?.status !== 'ready') throw failure(result, t('load_failed', 'Could not load'));
    return result.value;
  }
  async function invoke(orgId, action, target, input){
    let response;
    try { response = await api().publication.invoke(orgId, action, target, input, { idempotencyKey:key() }); }
    catch (error) { throw failure(error, t('save_failed', 'Could not save')); }
    const result = response?.result || response;
    if (result?.status && result.status !== 'succeeded') throw failure(result, t('save_failed', 'Could not save'));
    return result?.value ?? result;
  }

  /* ---- what reference fields point at: People's store first, the rest once per page ---- */
  const once = new Map();
  const cached = (name, load) => { if (!once.has(name)) once.set(name, Promise.resolve().then(load).catch(() => [])); return once.get(name); };
  async function references(orgId, definitions, owner){
    const state = obj(People.data?.state), types = new Set(arr(definitions).map((field) => field.type));
    const needs = (...wanted) => wanted.some((type) => types.has(type));
    const refs = {
      users:arr(state.users).map((user) => ({ id:user.id, name:text(user.name, user.email, user.id) })),
      groups:arr(state.groups).map((group) => ({ id:group.id, name:text(group.name, group.id) })),
      departments:arr(state.departments).map((department) => ({ id:department.id, name:text(department.label, department.name, department.id), color:department.color, icon:department.icon, status:department.status })),
      companies:[], contacts:[], media:[]
    };
    const pending = [];
    if (Array.isArray(state.connections)) refs.companies = state.connections.map((company) => ({ id:company.id, name:text(company.name, company.id) }));
    else if (needs('organization_connection', 'assignable_subject')) pending.push(cached(`companies:${orgId}`, async () => {
      const result = await api().connections?.list?.(orgId);
      return arr(result?.organization_connections || result?.connections || result).map((row) => ({ id:row.id, name:text(row.name, row.id) }));
    }).then((rows) => { refs.companies = rows; }));
    if (needs(...CONTACT_TYPES)) pending.push(cached(`contacts:${orgId}`, async () => {
      const result = await api().contacts?.options?.(orgId, 'either');
      return arr(result?.contacts).map((contact) => ({ label:contact.name, reference:{ contact_id:contact.contact_id, project_id:contact.project_id }, kind:text(contact.kind, contact.contact_kind) }));
    }).then((rows) => { refs.contacts = rows; }));
    if (needs(...MEDIA_TYPES) && owner) pending.push(cached(`media:${orgId}`, async () => arr((await api().media?.list?.(orgId))?.media)).then((rows) => {
      refs.media = rows.filter((media) => text(media.owner?.type) === owner.type && text(media.owner?.id) === owner.id).map((media) => ({ label:media.file_name, reference:{ media_id:media.id }, content_type:media.content_type }));
    }));
    await Promise.all(pending);
    return refs;
  }

  function homeName(kind, id){
    const state = obj(People.data?.state);
    if (kind === 'role') return text(arr(state.roles).find((role) => role.id === id)?.name, id);
    if (kind === 'department') return text(arr(state.departments).find((department) => department.id === id)?.label, id);
    const named = (read) => { try { return text(read?.(id)); } catch (_) { return ''; } };
    if (kind === 'group_type') return text(named(People.data?.groupTypeName), id);
    if (kind === 'company_type') return text(named(People.data?.companyTypeName), id);
    return id;
  }
  /* The server's refusals, said so that the other home has a name. */
  function readable(error){
    const details = obj(error.details), path = text(details.path);
    if (error.code === 'custom_field_home_conflict') {
      const [kind, ...rest] = text(details.home).split(':'), id = rest.join(':');
      return t('field_home_conflict', '"{path}" is already used on the {kind} {name} with the type {type}. Use the same type here, or another key.', { path, type:text(details.type, 'different'), kind:homeKindLabel(kind), name:homeName(kind, id) });
    }
    if (error.code === 'custom_field_unassigned_conflict') return t('field_unassigned_conflict', '"{path}" already exists as a field with no home. Place that field here instead of adding it again.', { path });
    if (error.code === 'revision_conflict') return t('field_revision_conflict', 'Someone else changed these fields. Close and reopen to see the latest.');
    return error.message || t('save_failed', 'Could not save');
  }
  const state = (container, icon, message, alert) => { container.innerHTML = `<div class="pp-state"${alert ? ' role="alert"' : ' role="status"'}><i class="fas ${icon}" aria-hidden="true"></i><strong>${esc(message)}</strong></div>`; };

  /* ---- a record: its values, grouped by home ---- */
  function mountRecord(container, context, owner){
    const orgId = context.orgId, entity = context.entity, target = { scope:'organization', organizationId:orgId, id:entity.id };
    const provider = `custom-fields-${owner}`, canPlace = People.data?.can?.settings === true && !context.readOnly;
    let form = null, resolved = null, destroyed = false;
    const recordHomes = () => {
      // Every role or type the record has, whether or not it holds a field yet.
      const kind = HOME_OF_OWNER[owner], data = People.data, listed = arr(resolved?.homes).map((home) => ({ kind:home.kind, id:text(home.id) }));
      const safely = (run) => { try { return arr(run()); } catch (_) { return []; } };
      const own = owner === 'user' ? safely(() => data.userRoleIds(data.user(entity.id) || {}))
        : owner === 'team' ? [arr(data?.state?.groups).find((group) => group.id === entity.id)?.kind_id]
        : arr(entity.type_ids).length ? entity.type_ids : safely(() => data.companyTypeIds(entity.id));
      const seen = new Set();
      return [...listed, ...own.map((id) => ({ kind, id:text(id) }))].filter((home) => home.id && !seen.has(home.id) && seen.add(home.id)).map((home) => { const name = homeName(home.kind, home.id); return { ...home, name:name !== home.id ? name : text(arr(resolved?.homes).find((entry) => text(entry.id) === home.id)?.name, name) }; });
    };
    const placeHtml = () => {
      const paths = arr(resolved.unassigned), homes = recordHomes();
      const fields = arr(resolved.fields).filter((field) => paths.includes(field.path) && !field.inferred && field.enabled !== false);
      if (!canPlace || !fields.length || !homes.length) return '';
      return `<div class="pp-fields-place" data-people-fields-place><strong>${esc(t('place_field', 'Give a field a home'))}<span class="fm-cf-help-tip" tabindex="0" role="img" aria-label="${esc(t('place_field_tip', 'A field with no home shows on everyone. Placed on a role or type, it shows only on those who have it. Values already saved are kept.'))}"${tip(t('place_field_tip', 'A field with no home shows on everyone. Placed on a role or type, it shows only on those who have it. Values already saved are kept.'))}><i class="fas fa-circle-info" aria-hidden="true"></i></span></strong>
        <select class="pp-input" data-place-field aria-label="${esc(t('field', 'Field'))}">${fields.map((field) => `<option value="${esc(field.path)}">${esc(text(field.label, field.path))}</option>`).join('')}</select>
        <select class="pp-input" data-place-home aria-label="${esc(t('home', 'Role or type'))}">${homes.map((home) => `<option value="${esc(home.id)}" data-kind="${esc(home.kind)}">${esc(home.name)}</option>`).join('')}</select>
        <button type="button" class="pp-btn" data-place-go>${esc(t('place', 'Place'))}</button><span class="pp-fields-note" data-place-status role="status"></span></div>`;
    };
    const draw = async () => {
      resolved = await read(orgId, provider, 'resolved', target);
      const refs = await references(orgId, resolved.fields, { type:owner, id:entity.id });
      if (destroyed) return;
      container.innerHTML = `<div class="pp-fields" data-people-fields="record"><div data-people-fields-form></div>${placeHtml()}</div>`;
      form = cf().mountValuesForm(container.querySelector('[data-people-fields-form]'), {
        resolved, references:refs, readOnly:context.readOnly === true,
        unassignedLabel:t('other_fields', 'Other'), emptyText:t('no_fields', 'No fields'),
        onChange:({ changes }) => context.onDirty?.(Object.keys(changes).length > 0)
      });
      context.onDirty?.(false);
    };
    const start = () => draw().catch((error) => { if (!destroyed) state(container, 'fa-triangle-exclamation', error.message || t('load_failed', 'Could not load'), true); });
    const onClick = async (event) => {
      const button = event.target.closest?.('[data-place-go]');
      if (!button || !container.contains(button)) return;
      const box = button.closest('[data-people-fields-place]'), status = box.querySelector('[data-place-status]');
      const home = box.querySelector('[data-place-home]').selectedOptions[0];
      button.disabled = true; status.textContent = '';
      try {
        await invoke(orgId, 'custom-fields.definitions.place', { scope:'organization', organizationId:orgId }, { path:box.querySelector('[data-place-field]').value, kind:home.dataset.kind, id:home.value });
        await draw();
        context.onSaved?.();
      } catch (error) { status.textContent = readable(error); button.disabled = false; }
    };
    container.addEventListener('click', onClick);
    state(container, 'fa-spinner fa-spin', t('loading', 'Loading'));
    start();
    return {
      async save(){
        if (!form) return;
        const checked = form.validate();
        if (!checked.valid) throw new Error(checked.errors[0].message);
        const changes = form.getChanges();
        if (!Object.keys(changes).length) return;
        try { await invoke(orgId, `custom-fields.${owner}.write`, target, { values:changes, expectedRevision:Number(resolved.recordRevision || 0) }); }
        catch (error) {
          const path = text(obj(error.details).path);
          if (path) form.setErrors({ [path]:error.message });
          throw new Error(readable(error));
        }
        await draw();
      },
      destroy(){ destroyed = true; container.removeEventListener('click', onClick); try { form?.destroy(); } catch (_) {} }
    };
  }

  /* ---- a home: its definitions ---- */
  function mountHome(container, context, home){
    const orgId = context.orgId, target = { scope:'organization', organizationId:orgId };
    const readOnly = context.readOnly === true || People.data?.can?.settings !== true;
    let editor = null, current = null, destroyed = false;
    const draw = async () => {
      current = await read(orgId, 'custom-fields-homes', 'definitions', target, { kind:home.kind, id:home.id });
      const refs = await references(orgId, [{ type:'organization_connection' }, ...current.fields], null);
      if (destroyed) return;
      if (editor) { editor.setFields(current.fields); context.onDirty?.(false); return; }
      container.innerHTML = '<div class="pp-fields" data-people-fields="home"><div data-people-fields-editor></div><div class="pp-fields-note" data-people-fields-note role="alert" hidden></div></div>';
      editor = cf().mountDefinitionsEditor(container.querySelector('[data-people-fields-editor]'), {
        fields:current.fields, entity:current.entity, home:{ kind:home.kind, id:home.id }, references:refs, readOnly,
        title:t('fields', 'Fields'),
        onChange:() => { note(''); context.onDirty?.(editor ? editor.isDirty() : true); }
      });
      context.onDirty?.(false);
    };
    const note = (message) => { const node = container.querySelector('[data-people-fields-note]'); if (node) { node.textContent = message; node.hidden = !message; } };
    state(container, 'fa-spinner fa-spin', t('loading', 'Loading'));
    draw().catch((error) => { if (!destroyed) state(container, 'fa-triangle-exclamation', error.message || t('load_failed', 'Could not load'), true); });
    return {
      async save(){
        if (!editor || readOnly || !editor.isDirty()) return;
        const checked = editor.validate();
        if (!checked.valid) throw new Error(checked.errors[0].message);
        try { await invoke(orgId, 'custom-fields.definitions.save', target, { kind:home.kind, id:home.id, fields:editor.getFields(), expectedRevision:current.revision }); }
        catch (error) {
          const message = readable(error), path = text(obj(error.details).path);
          if (path) editor.setErrors({ [path]:message });
          note(message);
          throw new Error(message);
        }
        note('');
        await draw();
      },
      destroy(){ destroyed = true; try { editor?.destroy(); } catch (_) {} }
    };
  }

  function mount(container, context = {}){
    ensureStyles();
    const entity = obj(context.entity);
    if (!cf()?.mountValuesForm || !api()?.publication) { state(container, 'fa-triangle-exclamation', t('fields_unavailable', 'Fields are unavailable right now.'), true); return {}; }
    // A department is only ever a home: its modal shows the definitions made on it and nothing else.
    const home = obj(entity.home).kind ? { kind:text(entity.home.kind), id:text(entity.home.id, entity.id) } : HOMES[entity.kind] ? { kind:HOMES[entity.kind], id:text(entity.id) } : null;
    if (home) return mountHome(container, context, home);
    if (RECORDS[entity.kind]) return mountRecord(container, context, RECORDS[entity.kind]);
    state(container, 'fa-table-list', t('no_fields', 'No fields'));
    return {};
  }

  People.fieldsPanel = { mount, kinds:[...Object.keys(RECORDS), ...Object.keys(HOMES)] };
  People.slots.register('fields', { kinds:People.fieldsPanel.kinds, mount });
})();
