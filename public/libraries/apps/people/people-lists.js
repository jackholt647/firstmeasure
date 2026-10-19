/* public/libraries/apps/people/people-lists.js
 *
 * The short lists People keeps beside its pages, all in one pattern: a header
 * action opens the list in the entity modal; a row is renamed, archived or,
 * when it has more to say, opened.
 *
 *   FirstMatePeople.lists
 *     listModal(options)                  the pattern itself (see below)
 *     types({ kind, opener })             group types or company types; a row opens the type
 *     type({ kind, id, opener })          one type: name, description, roles on joining and the partner flag
 *                                         (group types), who has it, Compensation and Fields
 *     tags({ opener })                    the assignment tag list
 *     wording(anchor)                     what the organization calls a group, its members, an outside company, a department
 *
 *   listModal({ title, icon, color, opener, words:[one, many], legend:html, newLabel, onNew(button),
 *     rows() => [{ id, name, tooltip, chips:[chip], count, countTip, stack:html (faces in place of the count), open:bool, actions:[{ id, needs, icon, label, tone, disabled, tooltip }] }],
 *     onOpen(row, button), onAction(actionId, row, button), onClose })
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.lists) return;
  const kit = People.kit;
  const data = People.data;
  const pageKit = People.pageKit;
  const { esc, t, tip } = kit;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sorted = (list) => [...list].sort();

  function ensureStyles(){
    People.permissionsPanel?.ensureStyles?.();
    if (document.getElementById('pp_lists_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_lists_css';
    style.textContent = `
      .pp-type-open{flex:0 1 240px;min-width:90px;margin:0;padding:0;border:0;background:transparent;color:var(--pp-text);font:inherit;font-size:13px;font-weight:650;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
      .pp-type-open:hover{color:var(--pp-accent)}
      .pp-sum-switch{display:flex;align-items:center;gap:7px;min-height:28px;margin-top:2px;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-sum-switch>span{flex:1}
      .pp-sum-switch>i{width:14px;text-align:center;color:var(--pp-faint);font-size:11px}
      .pp-sum-extra{display:grid;gap:4px;margin-top:14px}
      .pp-type-faces{flex:none;display:inline-flex}
      .pp-wording{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(0,1fr);gap:8px 10px;align-items:center;width:400px;max-width:100%;margin:0;padding:14px}
      .pp-wording>strong{grid-column:1/-1;font-size:14px;font-weight:700}
      .pp-wording>em{color:var(--pp-muted);font-size:11px;font-weight:700;font-style:normal;letter-spacing:.04em;text-transform:uppercase}
      .pp-wording>i{color:var(--pp-faint);font-size:12px;text-align:center}
      .pp-wording .pp-form-foot{grid-column:1/-1}
      @media (max-width:760px){.pp-wording{width:calc(100vw - 16px)}}
    `;
    document.head.appendChild(style);
  }

  function listModal(options = {}){
    ensureStyles();
    let host = null;
    let rows = [];
    const draw = () => {
      if (!host) return;
      rows = options.rows();
      host.innerHTML = `<div class="pp-tab-bar"><strong>${esc(kit.countPhrase([[rows.length, options.words[0], options.words[1]]]))}</strong>${options.legend || ''}<span class="pp-spacer"></span>${options.onNew ? `<button type="button" class="pp-btn primary" data-list-new><i class="fas fa-plus" aria-hidden="true"></i>${esc(options.newLabel || t('new', 'New'))}</button>` : ''}</div>
        <div class="pp-types" role="list">${rows.map((row) => `<div class="pp-type" role="listitem" data-type-id="${esc(row.id)}">
          ${row.open ? `<button type="button" class="pp-type-open" data-list-open${tip(row.tooltip)}>${esc(row.name)}</button>` : `<span class="pp-type-name"${tip(row.tooltip)}>${esc(row.name)}</span>`}
          <div class="pp-chip-run">${(row.chips || []).map(kit.chip).join('')}</div>
          ${row.stack ? `<span class="pp-type-faces"${tip(row.countTip)}>${row.stack}</span>` : row.count == null ? '' : `<span class="pp-type-count"${tip(row.countTip)}>${esc(row.count)}</span>`}
          ${data.gate(row.actions, 'list-row').map((action) => `<button type="button" class="pp-icon-btn ${action.tone === 'danger' ? 'danger' : ''}" data-list-row-action="${esc(action.id)}" aria-label="${esc(action.label)}"${tip(action.tooltip || action.label)} ${action.disabled ? 'disabled' : ''}><i class="fas ${esc(action.icon)}" aria-hidden="true"></i></button>`).join('')}
        </div>`).join('') || `<div class="pp-state"><i class="fas ${esc(options.icon || 'fa-list')}" aria-hidden="true"></i><strong>${esc(options.empty || t('nothing_here', 'Nothing here yet'))}</strong>${options.onNew ? `<button type="button" class="pp-btn" data-list-new>${esc(options.newLabel || t('new', 'New'))}</button>` : ''}</div>`}</div>`;
    };
    const modal = People.entityModal.open({
      label:options.title, opener:options.opener, footer:false,
      summary(summaryHost){ summaryHost.innerHTML = kit.summary({ kind:'list', id:options.title, name:options.title, icon:options.icon || 'fa-list', color:options.color || '#475467', pills:[], facts:[], sections:[] }, 'panel'); },
      actions:() => [],
      tabs:[{ id:'list', needs:null, label:options.title, icon:options.icon || 'fa-list', mount(panel){ host = panel; draw(); return {}; } }],
      onClose(){ unsubscribe(); options.onClose?.(); }
    });
    const unsubscribe = data.subscribe(() => draw());
    modal.el.addEventListener('click', (event) => {
      const create = event.target.closest('[data-list-new]');
      if (create) { options.onNew(create); return; }
      const rowEl = event.target.closest('[data-type-id]');
      const row = rowEl ? rows.find((entry) => String(entry.id) === rowEl.dataset.typeId) : null;
      if (!row) return;
      const open = event.target.closest('[data-list-open]');
      if (open) { options.onOpen?.(row, open); return; }
      const action = event.target.closest('[data-list-row-action]');
      if (action && !action.disabled) options.onAction?.(action.dataset.listRowAction, row, action);
    });
    return modal;
  }
  const guarded = (work, title) => Promise.resolve().then(work).catch((error) => pageKit.failed(title || t('not_saved', 'Not saved'), error));
  const archiveConfirm = async (button, name) => kit.confirm(button, { title:t('archive_confirm', 'Archive {name}?', { name }), confirmLabel:t('archive', 'Archive'), tone:'danger' });

  /* ---- types ---- */
  const typeWords = (kind) => kind === 'resource_group'
    ? t('group_types_title', '{group} types', { group:data.state.groupLabels.singular || t('group', 'Group') })
    : t('company_types_title', '{company} types', { company:data.state.groupLabels.connectionSingular || t('subcontractor', 'Subcontractor') });
  function types(options = {}){
    const kind = options.kind;
    const forGroups = kind === 'resource_group';
    const can = data.can;
    return listModal({
      title:typeWords(kind), icon:'fa-tags', color:forGroups ? '#0e7090' : '#475467', opener:options.opener, words:[t('type_one', 'type'), t('type_many', 'types')], empty:t('no_types', 'No types yet'),
      legend:forGroups ? `<span class="pp-chip role"><span>${esc(t('roles_on_joining', 'Roles on joining'))}</span></span>${kit.info(t('roles_on_joining_tip', 'A user gets these roles when they join a group of this type. Nothing is removed when they leave, and people who are already members are not changed.'))}` : '',
      newLabel:t('new_type', 'New type'),
      onNew:data.allows(forGroups ? 'groups.edit' : 'companies.edit') ? (button) => kit.form(button, { title:t('new_type', 'New type'), submitLabel:t('create', 'Create'), fields:[{ id:'name', label:t('name', 'Name'), required:true }], submit:(values) => data.saveType({ kind, name:values.name }) }).then((saved) => { if (saved?.id) type({ kind, id:saved.id }); }) : null,
      rows:() => data.types(kind).map((entry) => {
        const used = data.typeUsage(kind, entry.id).length;
        return { id:entry.id, name:entry.name, tooltip:entry.description, open:true, count:used, countTip:t('type_usage_tip', 'How many have this type'),
          chips:forGroups ? [...(entry.member_role_ids || []).map((roleId) => ({ label:data.role(roleId)?.name || roleId, tone:'role' })), ...(data.typeFlag(entry.id) ? [{ label:t('open_to_partners', 'Open to partners'), tone:'group' }] : [])] : [],
          actions:can.settings ? [{ id:'archive', needs:(forGroups ? 'groups.edit' : 'companies.edit'), icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger', disabled:used > 0, tooltip:used ? t('type_in_use', 'In use: it cannot be archived') : '' }] : [] };
      }),
      onOpen:(row) => type({ kind, id:row.id }),
      async onAction(action, row, button){ if (action === 'archive' && await archiveConfirm(button, row.name)) guarded(() => data.saveType({ kind, id:row.id, name:row.name, status:'archived' }), t('not_archived', 'Not archived')); }
    });
  }
  /* One type, in the same modal as a role: it is where pay and field definitions for everything of that type live. */
  function type(options = {}){
    ensureStyles();
    const kind = options.kind;
    const id = String(options.id);
    const forGroups = kind === 'resource_group';
    const can = data.can;
    const current = () => data.state.types.find((entry) => entry.kind === kind && entry.id === id);
    if (!current()) return null;
    const baseline = () => ({ name:current().name || '', description:current().description || '', roleIds:[...(current().member_role_ids || [])], external:forGroups ? data.typeFlag(id) : false });
    let base = baseline();
    const draft = JSON.parse(JSON.stringify(base));
    let editing = false;
    let used = null;
    const sync = () => {
      modal.setDirty('identity', draft.name.trim() !== base.name.trim() || draft.description.trim() !== base.description.trim());
      modal.setDirty('roles', !same(sorted(draft.roleIds), sorted(base.roleIds)));
      modal.setDirty('external', draft.external !== base.external);
    };
    function drawSummary(host){
      const model = {
        kind:forGroups ? 'resource_group_kind' : 'organization_connection_type', id, name:draft.name || id, secondary:draft.description, icon:'fa-tags', color:forGroups ? '#0e7090' : '#475467', pills:[], facts:[],
        sections:forGroups ? [{ id:'roles', title:t('roles_on_joining', 'Roles on joining'), icon:kit.ICONS.role, tooltip:t('roles_on_joining_tip', 'A user gets these roles when they join a group of this type. Nothing is removed when they leave, and people who are already members are not changed.'), chips:draft.roleIds.map((roleId) => ({ label:data.role(roleId)?.name || roleId, tone:'role' })), empty:t('none', 'None'), action:data.allows('groups.type_roles') ? { id:'roles', label:t('change_roles_on_joining', 'Change roles on joining') } : null }] : []
      };
      host.innerHTML = kit.summary(model, 'panel', { editAction:data.allows(forGroups ? 'groups.edit' : 'companies.edit') && !editing ? t('edit_role_identity', 'Edit name and description') : '' })
        + (forGroups ? `<div class="pp-sum-extra"><label class="pp-sum-switch"><i class="fas fa-handshake" aria-hidden="true"></i><span>${esc(t('open_to_partners', 'Open to partners'))}</span>${kit.info(t('open_to_partners_tip', 'Connected organizations, or the teams they expose, can be given work meant for a group of this type.'))}<button type="button" class="pp-switch" role="switch" data-type-external aria-checked="${draft.external}" aria-label="${esc(t('open_to_partners', 'Open to partners'))}" ${data.allows('groups.edit') ? '' : 'disabled'}></button></label>${draft.external && window.Portal?.tabs?.activateTab ? `<button type="button" class="pp-btn quiet" data-type-partners style="justify-self:start;height:28px;padding:0 8px;font-size:12px"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i>${esc(t('partners', 'Partners'))}</button>` : ''}</div>` : '');
      if (editing) pageKit.identity(host, [{ id:'name', value:draft.name, placeholder:t('name', 'Name') }, { id:'description', type:'textarea', value:draft.description, placeholder:t('description', 'Description') }]);
    }
    const entity = data.entityFor(forGroups ? 'resource_group_kind' : 'organization_connection_type', id, current().name);
    const modal = People.entityModal.open({
      label:current().name || id, opener:options.opener,
      summary:drawSummary,
      actions:() => can.settings ? [{ id:'archive', needs:(forGroups ? 'groups.edit' : 'companies.edit'), icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger', disabled:data.typeUsage(kind, id).length > 0, onClick:async (button) => { if (await archiveConfirm(button, current().name)) guarded(async () => { await data.saveType({ kind, id, name:current().name, status:'archived' }); modal.close(true); }, t('not_archived', 'Not archived')); } }] : [],
      tabs:[
        { id:'used', needs:(forGroups ? 'groups.view' : 'companies.view'), label:forGroups ? (data.state.groupLabels.plural || t('groups', 'Groups')) : (data.state.groupLabels.connectionPlural || t('subcontractors', 'Subcontractors')), icon:forGroups ? kit.ICONS.group : kit.ICONS.company, mount(panel){
          panel.classList.add('pp-members');
          const list = People.listPage.mount(panel, {
            embedded:true, subtitle:'', empty:{ icon:forGroups ? kit.ICONS.group : kit.ICONS.company, title:t('none_of_type', 'None of this type yet') },
            row:(item) => ({ key:item.id, square:true, entity:{ id:item.id, name:item.name, icon:forGroups ? kit.ICONS.group : kit.ICONS.company, color:forGroups ? '#0e7090' : '#475467' }, title:item.name || item.id, aside:forGroups ? kit.stack([], data.groupMembers(item).length) : '', hover:`${forGroups ? 'resource_group' : 'organization_connection'}:${item.id}` })
          });
          const detach = People.hoverCard.attach(list.el, {});
          const paint = () => { const items = data.typeUsage(kind, id); list.setItems(items); const words = forGroups ? [data.state.groupLabels.singular || t('group', 'Group'), data.state.groupLabels.plural || t('groups', 'Groups')] : [data.state.groupLabels.connectionSingular || t('subcontractor', 'Subcontractor'), data.state.groupLabels.connectionPlural || t('subcontractors', 'Subcontractors')]; list.setSubtitle(items.length ? `${items.length} ${(items.length === 1 ? words[0] : words[1]).toLowerCase()}` : ''); };
          paint();
          used = { refresh:paint, destroy(){ detach(); list.destroy(); } };
          return used;
        } },
        forGroups ? null : People.onboarding?.requirementsTab(id),
        People.slots.tab('compensation', entity, { readOnly:!can.settings }),
        People.slots.tab('fields', entity, { readOnly:!can.settings })
      ].filter(Boolean),
      async onSave(){
        if (draft.name.trim() !== base.name.trim() || draft.description.trim() !== base.description.trim()) await data.saveType({ kind, id, name:draft.name, description:draft.description });
        if (!same(sorted(draft.roleIds), sorted(base.roleIds))) await data.setTypeMemberRoles(id, draft.roleIds);
        if (draft.external !== base.external) await data.setTypeExternal(id, draft.external);
        base = baseline();
        Object.assign(draft, JSON.parse(JSON.stringify(base)));
        editing = false;
        modal.refreshSummary();
      },
      onClose(){ unsubscribe(); options.onClose?.(); }
    });
    const unsubscribe = data.subscribe(() => { if (!current()) { modal.close(true); return; } if (!modal.isDirty()) { base = baseline(); Object.assign(draft, JSON.parse(JSON.stringify(base))); if (!editing) modal.refreshSummary(); } used?.refresh(); });
    const summaryHost = modal.el.querySelector('[data-modal-summary]');
    summaryHost.addEventListener('click', (event) => {
      if (event.target.closest('[data-people-identity]')) { editing = true; modal.refreshSummary(); summaryHost.querySelector('[data-identity="name"]')?.focus(); return; }
      const flag = event.target.closest('[data-type-external]');
      if (flag && !flag.disabled) { draft.external = !draft.external; modal.refreshSummary(); sync(); summaryHost.querySelector('[data-type-external]')?.focus(); return; }
      if (event.target.closest('[data-type-partners]')) { window.__fmPartnerAssignmentKind = id; modal.close().then((closed) => { if (closed) window.Portal.tabs.activateTab('partners'); }); return; }
      const button = event.target.closest('[data-people-section-action="roles"]');
      if (button) pageKit.checkMenu(button, { label:t('roles_on_joining', 'Roles on joining'), items:data.activeRoles().map((role) => ({ id:role.id, label:role.name || role.id, tooltip:role.description })), selected:draft.roleIds, onChange(next){ draft.roleIds = next; modal.refreshSummary(); sync(); }, refocus:() => summaryHost.querySelector('[data-people-section-action="roles"]')?.focus() });
    });
    summaryHost.addEventListener('input', (event) => { const field = event.target.closest('[data-identity]'); if (!field) return; draft[field.dataset.identity] = field.value; sync(); });
    sync();
    return modal;
  }

  /* ---- tags ---- */
  function tags(options = {}){
    const can = data.can;
    const edit = (button, tag) => kit.form(button, { title:tag ? t('rename', 'Rename') : t('new_tag', 'New tag'), submitLabel:tag ? t('save', 'Save') : t('create', 'Create'), fields:[{ id:'name', label:t('name', 'Name'), value:tag?.name || '', required:true }], submit:(values) => data.saveTag({ id:tag?.id, name:values.name }) });
    return listModal({
      title:t('tags', 'Tags'), icon:'fa-tag', opener:options.opener, words:[t('tag_one', 'tag'), t('tag_many', 'tags')], empty:t('no_tags', 'No tags yet'),
      legend:kit.info(t('tags_tip', 'Tags mark what people and groups can be given, and an event type can ask for them.')),
      newLabel:t('new_tag', 'New tag'), onNew:data.allows('groups.edit') ? (button) => edit(button, null) : null,
      rows:() => data.state.tags.map((tag) => ({ id:String(tag.id), name:tag.name || tag.id, count:data.tagUsage(tag.id), countTip:t('tag_usage_tip', 'People and groups with this tag'), actions:can.settings ? [{ id:'rename', needs:'groups.edit', icon:kit.ICONS.edit, label:t('rename', 'Rename') }, { id:'archive', needs:'groups.edit', icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger' }] : [] })),
      async onAction(action, row, button){
        if (action === 'rename') edit(button, { id:row.id, name:row.name });
        else if (action === 'archive' && await archiveConfirm(button, row.name)) guarded(() => data.saveTag({ id:row.id, name:row.name, status:'archived' }), t('not_archived', 'Not archived'));
      }
    });
  }

  /* ---- wording: the organization's own words for the things People lists ---- */
  /* The words an organization can change: only for what it has, and only when it may save them. */
  function wordingRows(){
    if (!data.allows('home.wording')) return [];
    return [
      data.can.groups ? ['member', kit.ICONS.user] : null,
      data.can.companies ? ['company', kit.ICONS.company] : null,
      data.allows('departments.edit') ? ['department', kit.ICONS.department] : null,
      data.multipleBranches() ? ['branch', 'fa-location-dot'] : null,
      data.multipleBranches() ? ['region', 'fa-map-location-dot'] : null
    ].filter(Boolean);
  }
  function wording(anchor){
    ensureStyles();
    const now = data.wording();
    const rows = wordingRows();
    const panel = document.createElement('form');
    panel.className = 'pp-wording';
    panel.noValidate = true;
    panel.setAttribute('aria-label', t('wording', 'Wording'));
    panel.innerHTML = `<strong>${esc(t('wording', 'Wording'))}</strong><span></span><em>${esc(t('one', 'One'))}</em><em>${esc(t('several', 'Several'))}</em>
      ${rows.map(([key, icon]) => `<i class="fas ${icon}" aria-hidden="true"></i><input class="pp-input" name="${key}_singular" value="${esc(now[key].singular)}" aria-label="${esc(`${now[key].singular}: ${t('one', 'One')}`)}" autocomplete="off"><input class="pp-input" name="${key}_plural" value="${esc(now[key].plural)}" aria-label="${esc(`${now[key].singular}: ${t('several', 'Several')}`)}" autocomplete="off">`).join('')}
      <div class="pp-form-foot"><span class="pp-form-error" role="alert"></span>${window.Portal?.navigation?.navigate ? `<button type="button" class="pp-btn quiet" data-wording-all${tip(t('all_wording_tip', 'Every other word the product uses is in Terminology'))}>${esc(t('all_wording', 'All wording'))}</button>` : ''}<button type="button" class="pp-btn quiet" data-wording-cancel>${esc(t('cancel', 'Cancel'))}</button><button type="submit" class="pp-btn primary">${esc(t('save', 'Save'))}</button></div>`;
    const handle = kit.layer(anchor, panel, { align:'end', onKey(event){
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll('input,button'));
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); event.stopPropagation(); focusable[focusable.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); event.stopPropagation(); focusable[0].focus(); }
    } });
    panel.addEventListener('click', (event) => {
      if (event.target.closest('[data-wording-cancel]')) handle.close('cancel');
      if (event.target.closest('[data-wording-all]')) { handle.close('select'); window.Portal.navigation.navigate({ tab:'company_settings', sub:'configuration', settingsView:'terminology', settingsEntity:'' }, { source:'people-wording', ownedKeys:['tab', 'sub', 'settingsView', 'settingsEntity'] }); }
    });
    panel.addEventListener('submit', async (event) => {
      event.preventDefault();
      const next = Object.fromEntries(rows.map(([key]) => [key, { singular:String(panel.elements[`${key}_singular`].value || '').trim(), plural:String(panel.elements[`${key}_plural`].value || '').trim() }]));
      const errorEl = panel.querySelector('.pp-form-error');
      if (Object.values(next).some((pair) => !pair.singular || !pair.plural)) { errorEl.textContent = t('wording_required', 'Give each one both forms'); return; }
      const submit = panel.querySelector('[type="submit"]');
      submit.disabled = true;
      try { await data.saveWording(next); handle.close('select'); kit.toast(t('saved', 'Saved'), t('wording_saved', 'Wording updated.'), true); }
      catch (error) { submit.disabled = false; errorEl.textContent = error?.message || t('save_failed', 'Could not save'); }
    });
    panel.querySelector('input').focus();
    return handle;
  }

  People.lists = { listModal, types, type, tags, wording, wordingRows, ensureStyles };
  /* The pages reach the type list through pageKit, as before. */
  pageKit.typesModal = types;
})();
