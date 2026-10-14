/* public/libraries/apps/people/groups-page.js
 *
 * People > Groups: groups of users of any type (what an organization calls
 * them comes from terminology). Built on the shared pieces like Users.
 *
 *   FirstMatePeople.groupsPage.mount(container, { entity:'group:<id>', onEntity(key) }) -> { refresh(), openGroup(id), destroy() }
 *
 * Rules kept here: a group has exactly one type, picked from a dropdown;
 * members are added and removed here and nowhere else; joining gives the roles
 * the type names and the page says which; staffing requirements are a count and
 * a condition in the shared condition contract, and they warn, never block.
 * Tabs are chosen by trait (data.traits), not by kind.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.groupsPage) return;
  const kit = People.kit;
  const data = People.data;
  const pageKit = People.pageKit;
  const { esc, t, tip } = kit;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const sorted = (list) => [...list].sort();
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function ensureStyles(){
    if (document.getElementById('pp_groups_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_groups_css';
    style.textContent = `
      .pp-reqs{display:grid;gap:8px;align-content:start}
      .pp-req{display:grid;gap:8px;padding:10px 10px 10px 12px;border-radius:10px;background:var(--pp-soft)}
      .pp-req-head{display:flex;align-items:center;gap:8px;min-width:0}
      .pp-req-count{width:64px;flex:none;text-align:center;font-variant-numeric:tabular-nums}
      .pp-req-times{flex:none;color:var(--pp-faint);font-size:11px}
      .pp-req-head>.pp-input[data-req-label]{flex:1;min-width:80px}
      .pp-req-head>.pp-select{flex:0 0 132px}
      .pp-req-rules{display:grid;gap:6px;padding-left:72px}
      .pp-rule{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr) 28px;gap:6px;align-items:center}
      .pp-rule .pp-input{height:32px}
      .pp-req .pp-input{background:var(--pp-panel)}
      .pp-rule-fixed{grid-column:1/4;color:var(--pp-muted);font-size:12px}
      .pp-req-add{justify-self:start;height:28px;padding:0 9px;font-size:12px}
      @media (max-width:760px){.pp-req-rules{padding-left:0}.pp-rule{grid-template-columns:minmax(0,1fr) 28px}.pp-rule>.pp-select,.pp-rule>.pp-input{grid-column:1}.pp-rule>.pp-icon-btn{grid-column:2;grid-row:1}.pp-req-head{flex-wrap:wrap}}
    `;
    document.head.appendChild(style);
  }

  /* ---- staffing requirements: a count and a condition over the people on the work ---- */
  const LIST_FIELDS = ['type_ids', 'tag_ids', 'department_ids', 'group_ids'];
  function conditionFields(){
    const custom = new Set();
    data.state.directory.forEach((row) => { if (row.kind === 'organization_user') Object.keys(row.fields || {}).forEach((key) => custom.add(key)); });
    return [
      { value:'type_ids', label:t('cond_role', 'Role') },
      { value:'tag_ids', label:t('cond_tag', 'Tag') },
      { value:'department_ids', label:data.state.groupLabels.departmentSingular || t('department', 'Department') },
      { value:'group_ids', label:data.state.groupLabels.singular || t('group', 'Group') },
      { value:'id', label:t('cond_person', 'Person') },
      ...[...custom].sort().map((key) => ({ value:`fields.${key}`, label:key.replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase()) }))
    ];
  }
  const operatorsFor = (field) => LIST_FIELDS.includes(field)
    ? [{ value:'contains', label:t('op_has', 'has') }, { value:'not_contains', label:t('op_has_not', 'does not have') }]
    : field === 'id' ? [{ value:'equals', label:t('op_is', 'is') }, { value:'not_equals', label:t('op_is_not', 'is not') }]
      : [{ value:'equals', label:t('op_is', 'is') }, { value:'not_equals', label:t('op_is_not', 'is not') }, { value:'is_present', label:t('op_present', 'has a value') }, { value:'is_missing', label:t('op_missing', 'is empty') }, { value:'greater_or_equal', label:t('op_at_least', 'is at least') }, { value:'less_or_equal', label:t('op_at_most', 'is at most') }];
  const valueOptions = (field) => field === 'type_ids' ? data.activeRoles().map((role) => ({ value:role.id, label:role.name || role.id }))
    : field === 'tag_ids' ? data.state.tags.map((tag) => ({ value:String(tag.id), label:tag.name || tag.id }))
      : field === 'department_ids' ? data.state.departments.map((department) => ({ value:department.id, label:department.label || department.id }))
        : field === 'group_ids' ? data.state.groups.map((group) => ({ value:`resource_group:${group.id}`, label:group.name || group.id }))
          : field === 'id' ? [...data.state.users].sort(pageKit.byName).map((user) => ({ value:`organization_user:${user.id}`, label:user.name || user.email || user.id })) : null;
  const parseValue = (raw) => { const value = String(raw ?? '').trim(); return value === 'true' ? true : value === 'false' ? false : value !== '' && Number.isFinite(Number(value)) ? Number(value) : value; };
  const isRule = (rule) => rule && typeof rule === 'object' && typeof rule.field === 'string';

  function staffingEditor(panel, options){
    let list = options.value;
    const fields = conditionFields();
    const commit = () => options.onChange(list);
    const ruleHtml = (rule, requirementIndex, ruleIndex) => {
      if (!isRule(rule)) return `<div class="pp-rule"><span class="pp-rule-fixed"${tip(t('advanced_condition_tip', 'A nested condition written elsewhere. It is kept as it is.'))}>${esc(t('advanced_condition', 'Advanced condition'))}</span></div>`;
      const knownField = fields.some((field) => field.value === rule.field) ? fields : [...fields, { value:rule.field, label:rule.field }];
      const operators = operatorsFor(rule.field);
      const operator = operators.some((entry) => entry.value === rule.operator) ? rule.operator : operators[0].value;
      const choices = valueOptions(rule.field);
      const noValue = ['is_present', 'is_missing'].includes(operator);
      const valueControl = noValue ? '<span></span>' : choices
        ? kit.select({ value:rule.value ?? '', options:choices, placeholder:t('choose', 'Choose'), label:t('value', 'Value'), attrs:'data-rule-value', disabled:options.readOnly })
        : `<input class="pp-input" data-rule-value value="${esc(rule.value ?? '')}" placeholder="${esc(t('value', 'Value'))}" aria-label="${esc(t('value', 'Value'))}" ${options.readOnly ? 'disabled' : ''}>`;
      return `<div class="pp-rule" data-rule="${ruleIndex}">${kit.select({ value:rule.field, options:knownField, label:t('cond_what', 'What'), attrs:'data-rule-field', disabled:options.readOnly })}${kit.select({ value:operator, options:operators, label:t('cond_how', 'Comparison'), attrs:'data-rule-operator', disabled:options.readOnly })}${valueControl}${options.readOnly ? '<span></span>' : `<button type="button" class="pp-icon-btn" data-rule-remove aria-label="${esc(t('remove_condition', 'Remove condition'))}"${tip(t('remove_condition', 'Remove condition'))}><i class="fas fa-xmark" aria-hidden="true"></i></button>`}</div>`;
    };
    function draw(){
      panel.innerHTML = `<div class="pp-tab-bar"><strong>${esc(kit.countPhrase([[list.length, t('requirement_one', 'staffing requirement'), t('requirement_many', 'staffing requirements')]]) || t('no_requirements_count', '0 staffing requirements'))}</strong>${kit.info(t('staffing_tip', 'Who this group should always have when it is given work. An unmet requirement is a warning on the schedule. It never blocks a save.'))}<span class="pp-spacer"></span>${options.readOnly ? '' : `<button type="button" class="pp-btn" data-req-new><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('add_requirement', 'Add requirement'))}</button>`}</div>
        <div class="pp-reqs">${list.map((requirement, index) => `<div class="pp-req" data-req="${index}">
          <div class="pp-req-head"><input class="pp-input pp-req-count" type="number" min="1" max="500" step="1" data-req-count value="${esc(requirement.count)}" aria-label="${esc(t('how_many', 'How many'))}"${tip(t('how_many_tip', 'At least this many people'))} ${options.readOnly ? 'disabled' : ''}><i class="fas fa-xmark pp-req-times" aria-hidden="true"></i><input class="pp-input" data-req-label value="${esc(requirement.label || '')}" placeholder="${esc(t('requirement_label', 'Called, for example: CDL driver'))}" aria-label="${esc(t('requirement_name', 'What they are called'))}" ${options.readOnly ? 'disabled' : ''}>${(requirement.where?.rules || []).length > 1 ? kit.select({ value:requirement.where.match || 'all', options:[{ value:'all', label:t('match_all', 'All conditions') }, { value:'any', label:t('match_any', 'Any condition') }], label:t('match', 'Match'), attrs:'data-req-match', disabled:options.readOnly }) : ''}${options.readOnly ? '' : `<button type="button" class="pp-icon-btn danger" data-req-remove aria-label="${esc(t('remove_requirement', 'Remove requirement'))}"${tip(t('remove_requirement', 'Remove requirement'))}><i class="fas fa-trash" aria-hidden="true"></i></button>`}</div>
          <div class="pp-req-rules">${(requirement.where?.rules || []).map((rule, ruleIndex) => ruleHtml(rule, index, ruleIndex)).join('')}${options.readOnly ? '' : `<button type="button" class="pp-btn quiet pp-req-add" data-rule-new><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('add_condition', 'Condition'))}</button>`}</div>
        </div>`).join('') || `<div class="pp-state"><i class="fas fa-user-check" aria-hidden="true"></i><strong>${esc(t('no_requirements', 'No staffing requirements'))}</strong>${options.readOnly ? '' : `<button type="button" class="pp-btn" data-req-new>${esc(t('add_requirement', 'Add requirement'))}</button>`}</div>`}</div>`;
    }
    const newRule = () => ({ field:'type_ids', operator:'contains', value:'' });
    panel.addEventListener('click', (event) => {
      if (options.readOnly) return;
      const requirementEl = event.target.closest('[data-req]');
      const index = requirementEl ? Number(requirementEl.dataset.req) : -1;
      if (event.target.closest('[data-req-new]')) { list = [...list, { id:`requirement-${Date.now().toString(36)}`, label:'', count:1, where:{ rules:[newRule()] } }]; commit(); draw(); panel.querySelector('.pp-req:last-child [data-req-label]')?.focus(); return; }
      if (index < 0) return;
      if (event.target.closest('[data-req-remove]')) { list = list.filter((_, at) => at !== index); commit(); draw(); return; }
      if (event.target.closest('[data-rule-new]')) { list[index].where.rules.push(newRule()); commit(); draw(); return; }
      const ruleEl = event.target.closest('[data-rule]');
      if (ruleEl && event.target.closest('[data-rule-remove]')) {
        if (list[index].where.rules.length <= 1) return;
        list[index].where.rules.splice(Number(ruleEl.dataset.rule), 1);
        if (list[index].where.rules.length < 2) delete list[index].where.match;
        commit(); draw();
      }
    });
    const onEdit = (event) => {
      if (options.readOnly) return;
      const requirementEl = event.target.closest('[data-req]');
      if (!requirementEl) return;
      const requirement = list[Number(requirementEl.dataset.req)];
      const ruleEl = event.target.closest('[data-rule]');
      const rule = ruleEl ? requirement.where.rules[Number(ruleEl.dataset.rule)] : null;
      let redraw = false;
      if (event.target.matches('[data-req-count]')) requirement.count = Math.max(1, Math.min(500, Math.round(Number(event.target.value) || 1)));
      else if (event.target.matches('[data-req-label]')) requirement.label = event.target.value;
      else if (event.target.matches('[data-req-match]')) requirement.where.match = event.target.value;
      else if (rule && event.target.matches('[data-rule-field]')) { rule.field = event.target.value; rule.operator = operatorsFor(rule.field)[0].value; rule.value = ''; redraw = true; }
      else if (rule && event.target.matches('[data-rule-operator]')) { rule.operator = event.target.value; if (['is_present', 'is_missing'].includes(rule.operator)) delete rule.value; else if (rule.value === undefined) rule.value = ''; redraw = true; }
      else if (rule && event.target.matches('[data-rule-value]')) rule.value = valueOptions(rule.field) ? event.target.value : parseValue(event.target.value);
      else return;
      commit();
      if (redraw && event.type === 'change') draw();
    };
    panel.addEventListener('input', onEdit);
    panel.addEventListener('change', onEdit);
    draw();
    return { setValue(next){ list = next; draw(); }, destroy(){ panel.replaceChildren(); } };
  }
  function staffingProblem(list){
    for (const requirement of list) {
      if (!String(requirement.label || '').trim()) return t('requirement_needs_name', 'Say what each staffing requirement counts.');
      for (const rule of requirement.where?.rules || []) if (isRule(rule) && !['is_present', 'is_missing'].includes(rule.operator) && (rule.value === '' || rule.value === undefined)) return t('requirement_needs_value', 'Finish each condition of {name}.', { name:requirement.label });
    }
    return '';
  }

  /* English plural of a type name for a section heading: "Crew" heads "Crews". */
  function pluralOf(name){
    const word = String(name || '').trim();
    if (!word || /s$/i.test(word)) return word;
    if (/(x|z|ch|sh)$/i.test(word)) return word + 'es';
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    return word + 's';
  }

  function mount(container, options = {}){
    if (!container) throw new Error('groupsPage.mount requires a container.');
    ensureStyles();
    const can = data.can;
    let query = '';
    let destroyed = false;
    let openEntity = null;
    const labels = () => data.state.groupLabels;
    const plural = () => labels().plural || t('groups', 'Groups');
    const singular = () => labels().singular || t('group', 'Group');
    const users = (group) => data.groupMembers(group).map((member) => data.user(member.user_id)).filter(Boolean);

    function rowModel(group){
      const members = users(group);
      return {
        key:group.id, square:true,
        entity:{ id:group.id, name:group.name, icon:kit.ICONS.group, color:'#0e7090' },
        title:group.name || group.id,
        // The section heading names the type, so the row does not repeat it.
        aside:kit.stack(members.map((user) => ({ id:user.id, name:user.name || user.email, photoUrl:data.assetUrl(user.profile_photo_url || user.profile_photo) })), data.groupMembers(group).length),
        chipGroups:[{ chips:data.groupDepartments(group).map((department) => ({ label:department.label, color:department.color })) }],
        actions:[{ id:'edit', needs:'groups.view', icon:kit.ICONS.edit, label:t('edit', 'Edit') }, can.settings ? { id:'archive', needs:'groups.edit', icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger' } : null],
        hover:`resource_group:${group.id}`
      };
    }
    let filter = options.filter === 'empty' ? 'empty' : 'all';
    const branchFilter = People.branches.filter('groups', { onChange:() => renderList() });
    const visible = () => data.state.groups.filter((group) => branchFilter.matches('group', group)).filter((group) => filter !== 'empty' || !data.groupMembers(group).length).filter((group) => !query || [group.name, data.typeName('resource_group', group.kind_id), ...users(group).map((user) => user.name)].join(' ').toLowerCase().includes(query))
      .sort((left, right) => typeOrder(left) - typeOrder(right) || typeTitle(left).localeCompare(typeTitle(right)) || String(left.name || '').localeCompare(String(right.name || '')));
    /* The list is sectioned by group type, each type under its plural name; groups with no type come last. */
    const typeTitle = (group) => group.kind_id ? pluralOf(data.typeName('resource_group', group.kind_id)) : t('groups_without_type', 'No type');
    const typeOrder = (group) => group.kind_id ? 0 : 1;
    const subtitle = () => {
      const lower = plural().toLowerCase();
      const count = data.state.groups.length;
      const people = new Set(data.state.groups.flatMap((group) => data.groupMembers(group).map((member) => member.user_id))).size;
      return `${count.toLocaleString()} ${count === 1 ? singular().toLowerCase() : lower}${people ? `, ${kit.countPhrase([[people, t('person_in_one', 'person in one'), t('people_in_one', 'people in one')]])}` : ''}`;
    };
    function renderList(){
      if (destroyed || !data.state.loaded) return;
      list.setItems(visible());
      list.setSubtitle(subtitle());
      list.setFilters([{ id:'all', label:t('filter_all', 'All') }, { id:'empty', label:t('filter_no_members', 'No members'), count:data.state.groups.filter((group) => !data.groupMembers(group).length).length }], filter);
    }
    async function archive(group, anchor){
      const yes = await kit.confirm(anchor, { title:t('archive_confirm', 'Archive {name}?', { name:group.name || group.id }), confirmLabel:t('archive', 'Archive'), tone:'danger' });
      if (!yes) return false;
      try { await data.archiveGroup(group.id); kit.toast(t('archived', 'Archived'), group.name || '', true); return true; }
      catch (error) { pageKit.failed(t('not_archived', 'Not archived'), error); return false; }
    }
    function create(button){
      const types = data.types('resource_group');
      kit.form(button, {
        title:t('new_group', 'New {group}', { group:singular().toLowerCase() }), submitLabel:t('create', 'Create'),
        fields:[{ id:'name', label:t('name', 'Name'), required:true }, { id:'typeId', label:t('type', 'Type'), type:'select', required:true, options:types.map((type) => ({ value:type.id, label:type.name })), value:types[0]?.id || '', placeholder:types.length ? undefined : t('no_types', 'No types yet') }],
        submit:(values) => data.createGroup({ name:values.name, typeId:values.typeId })
      }).then((group) => { if (group?.id) openGroup(group.id, { opener:button }); });
    }

    const list = People.listPage.mount(container, {
      icon:kit.ICONS.group, title:t('user_groups', 'User Groups'), subtitle:'',
      section:(group) => ({ key:String(group.kind_id || ''), title:typeTitle(group), icon:kit.ICONS.group, color:'#0e7090', order:typeOrder(group) }),
      sorts:[
        { id:'name', label:t('sort_name', 'Name'), compare:(left, right) => String(left.name || '').localeCompare(String(right.name || '')) },
        { id:'members', label:t('sort_members', 'Members'), first:'desc', compare:(left, right) => (data.groupMembers(left).length - data.groupMembers(right).length) || String(right.name || '').localeCompare(String(left.name || '')) },
        { id:'department', label:labels().departmentSingular || t('department', 'Department'), compare:(left, right) => {
          const first = (group) => data.groupDepartments(group).map((department) => department.label).sort()[0] || '';
          const a = first(left), b = first(right);
          if (!a !== !b) return a ? -1 : 1;
          return a.localeCompare(b) || String(left.name || '').localeCompare(String(right.name || ''));
        } }
      ],
      sort:{ id:'name', dir:'asc' }, sortStore:'groups',
      search:{ placeholder:t('search', 'Search'), onInput(value){ query = value.trim().toLowerCase(); renderList(); } },
      filters:{ items:[{ id:'all', label:t('filter_all', 'All') }], value:filter, onChange(next){ filter = next; renderList(); } },
      actions:[
        { id:'types', needs:'groups.view', label:t('types', 'Types'), icon:'fa-tags', onClick:(button) => pageKit.typesModal({ kind:'resource_group', opener:button }) },
        { id:'tags', needs:'groups.edit', label:t('tags', 'Tags'), icon:'fa-tag', onClick:(button) => People.lists.tags({ opener:button }) },
        can.settings ? { id:'new', needs:'groups.edit', label:t('new_group', 'New {group}', { group:singular().toLowerCase() }), icon:'fa-plus', primary:true, onClick:create } : null
      ].filter(Boolean),
      empty:{ icon:kit.ICONS.group, title:t('no_groups_yet', 'No {groups} yet', { groups:plural().toLowerCase() }) },
      row:rowModel,
      onOpen:(group, row) => openGroup(group.id, { opener:row.querySelector('[data-row-open]') }),
      onAction:(action, group, button) => { if (action === 'edit') openGroup(group.id, { opener:button }); else if (action === 'archive') archive(group, button); }
    });
    branchFilter.attach(list.controlHost);
    const detachHover = People.hoverCard.attach(list.el, {});
    const unsubscribe = data.subscribe((state, change) => { if (destroyed) return; renderList(); openEntity?.refresh?.(change); });
    async function refresh(force = true){
      try { await data.load({ refresh:force }); renderList(); }
      catch (error) { if (!data.state.loaded) list.setError(error?.message || t('load_failed', 'Could not load'), () => { list.setLoading(true); refresh(true); }); }
    }

    function openGroup(id, extra = {}){
      const start = data.group(id);
      if (!start) return null;
      const current = () => data.group(id) || start;
      const key = `resource_group:${id}`;
      const traits = data.traits(key);
      const directDepartments = () => data.groupDepartments(current()).filter((department) => department.direct).map((department) => department.id);
      const baseline = () => ({ name:current().name || '', typeId:String(current().kind_id || ''), tagIds:[...(current().assignment_tag_ids || [])].map(String), scopeIds:[...(current().capability_scope_ids || [])].map(String), departmentIds:directDepartments(), staffing:data.staffing(id) });
      let base = baseline();
      const draft = clone(base);
      let editing = false;
      let members = null;
      let staffingPanel = null;
      const granted = new Map();     // user id -> role names given on joining, this session
      const sync = () => {
        modal.setDirty('identity', draft.name.trim() !== base.name.trim() || draft.typeId !== base.typeId);
        modal.setDirty('tags', !same(sorted(draft.tagIds), sorted(base.tagIds)) || !same(sorted(draft.scopeIds), sorted(base.scopeIds)));
        modal.setDirty('departments', !same(sorted(draft.departmentIds), sorted(base.departmentIds)));
        modal.setDirty('staffing_requirements', !same(draft.staffing, base.staffing));
        modal.setTabBadge('staffing', draft.staffing.length || '');
      };
      function drawSummary(host){
        const model = data.groupSummary(current(), draft);
        const editable = data.allows('groups.edit');
        model.sections.forEach((section) => {
          if (!editable) return;
          if (section.id === 'departments' && data.allows('departments.members') && data.state.departments.length) section.action = { id:'departments', label:t('change_departments', 'Change departments') };
          if (section.id === 'tags' && data.state.tags.length) section.action = { id:'tags', label:t('change_tags', 'Change tags') };
          if (section.id === 'scopes' && data.state.scopes.length) section.action = { id:'scopes', label:t('change_kinds_of_work', 'Change kinds of work') };
        });
        model.sections = model.sections.filter((section) => section.action || section.chips.length);
        host.innerHTML = kit.summary(model, 'panel', { editAction:editable && !editing ? t('edit_group_identity', 'Edit name and type') : '' });
        if (editing) pageKit.identity(host, [{ id:'name', value:draft.name, placeholder:t('name', 'Name') }, { id:'typeId', type:'select', value:draft.typeId, placeholder:t('type', 'Type'), options:data.types('resource_group').map((type) => ({ value:type.id, label:type.name })) }]);
      }
      async function changeMembers(next, joined){
        try {
          const result = await data.setGroupMembers(id, next);
          const given = result.grants.filter((grant) => grant.role_ids?.length && !grant.error);
          given.forEach((grant) => granted.set(String(grant.user_id), grant.role_ids.map((roleId) => data.role(roleId)?.name || roleId)));
          const problem = result.grants.find((grant) => grant.error);
          if (problem) kit.toast(t('roles_not_given', 'Roles not given'), problem.error, false);
          else if (given.length && joined) kit.toast(t('roles_given', '{name} was given {roles}', { name:joined.name || joined.email, roles:given.flatMap((grant) => grant.role_ids).map((roleId) => data.role(roleId)?.name || roleId).join(', ') }), t('roles_given_detail', 'From joining this {group}. They stay if the person leaves.', { group:singular().toLowerCase() }), true);
          modal.setStatus('saved', t('saved', 'Saved'));
          members?.refresh();
        } catch (error) { pageKit.failed(t('not_saved', 'Not saved'), error); }
      }
      const entity = data.entityFor('resource_group', id, start.name);
      const tabs = [
        traits.has_members ? { id:'members', needs:'groups.view', label:t('members', 'Members'), icon:kit.ICONS.users, mount(panel, ctx){
          members = pageKit.peopleList(panel, {
            count:() => kit.countPhrase([[data.groupMembers(current()).length, t('member_one', 'member'), t('member_many', 'members')]]) || t('no_members', 'No members'),
            items:() => data.groupMembers(current()).map((member) => ({ member, user:data.user(member.user_id) })).filter((item) => item.user).map((item) => ({
              user:item.user,
              pills:[...(item.member.is_lead ? [{ label:t('lead', 'Lead'), tone:'role', icon:'fa-star' }] : []), ...(item.member.role && !['member', 'lead'].includes(item.member.role) ? [{ label:item.member.role, tone:'neutral', tooltip:t('role_in_group', 'Role in this {group}', { group:singular().toLowerCase() }) }] : [])],
              chips:[...new Set([...(granted.get(item.user.id) || []), ...item.member.joined_role_ids.map((roleId) => data.role(roleId)?.name || roleId)])].map((label) => ({ label, tone:'role', tooltip:t('given_on_joining', 'Given on joining') })),
              chipTone:'role',
              actions:can.settings ? [{ id:'lead', needs:'groups.edit', icon:'fa-star', label:item.member.is_lead ? t('remove_lead', 'Remove as lead') : t('make_lead', 'Make lead') }, { id:'role', needs:'groups.edit', icon:'fa-user-tag', label:t('role_in_group', 'Role in this {group}', { group:singular().toLowerCase() }) }, { id:'remove', needs:'groups.edit', icon:'fa-user-minus', label:t('remove_member', 'Remove'), tone:'danger' }] : []
            })),
            actions:can.users && can.settings ? [{ id:'invite', needs:'groups.invite', label:t('invite', 'Invite'), icon:kit.ICONS.invite, tooltip:t('invite_into_group_tip', 'Invite someone new straight into this {group}', { group:singular().toLowerCase() }), onClick(button){
              kit.form(button, {
                title:t('invite_user', 'Invite user'), submitLabel:t('send_invite', 'Send invitation'), submitIcon:kit.ICONS.invite,
                fields:[{ id:'name', label:t('name', 'Name') }, { id:'email', label:t('email', 'Email'), type:'email', required:true }],
                /* They start with the roles this type gives on joining, so they can sign in to what the group uses. */
                submit:(values) => data.invite({ name:values.name, email:values.email, roleIds:data.state.types.find((type) => type.kind === 'resource_group' && type.id === String(current().kind_id))?.member_role_ids || [] })
              }).then((result) => {
                if (!result?.user?.id) return;
                kit.toast(t('invite_sent', 'Invitation sent'), result.user.email || '', true);
                changeMembers([...data.groupMembers(current()), { user_id:result.user.id, role:'member', is_lead:false }], result.user);
              });
            } }] : [],
            add:data.allows('groups.edit') ? { needs:'groups.edit',
              candidates:() => data.state.users.filter((user) => !data.isSuspended(user)).map((user) => ({ user, checked:data.groupMembers(current()).some((member) => member.user_id === user.id) })),
              onToggle(user, on){
                const now = data.groupMembers(current());
                changeMembers(on ? [...now, { user_id:user.id, role:'member', is_lead:false }] : now.filter((member) => member.user_id !== user.id), on ? user : null);
              }
            } : null,
            onAction(action, user, button){
              const now = data.groupMembers(current());
              if (action === 'remove') changeMembers(now.filter((member) => member.user_id !== user.id));
              else if (action === 'role') {
                /* What someone is in this group, in the organization's own words. There is no fixed list: the words already in use are offered. */
                const member = now.find((entry) => entry.user_id === user.id);
                const words = data.memberRoleWords();
                kit.form(button || modal.el.querySelector('.pp-members [data-list-action]') || modal.el, {
                  title:t('role_in_group', 'Role in this {group}', { group:singular().toLowerCase() }), submitLabel:t('save', 'Save'),
                  fields:[{ id:'role', label:user.name || user.email, value:member && !['member', 'lead'].includes(member.role) ? member.role : '' }],
                  choices:words.length ? { id:'picked', label:t('in_use', 'In use'), items:words.map((word) => ({ id:word, label:word })), value:[] } : null
                }).then((values) => {
                  if (!values) return;
                  const word = String(values.role || (values.picked || [])[0] || '').trim().slice(0, 180);
                  changeMembers(now.map((entry) => entry.user_id === user.id ? { ...entry, role:word || (entry.is_lead ? 'lead' : 'member') } : entry));
                });
              }
              else if (action === 'lead') { const isLead = now.find((member) => member.user_id === user.id)?.is_lead; changeMembers(now.map((member) => ({ ...member, is_lead:!isLead && member.user_id === user.id, role:!isLead && member.user_id === user.id ? 'lead' : member.role === 'lead' ? 'member' : member.role }))); }
            },
            empty:{ icon:kit.ICONS.users, title:t('no_members', 'No members') }
          });
          void ctx;
          return members;
        } } : null,
        traits.has_members ? { id:'staffing', needs:'groups.view', label:t('staffing_requirements', 'Staffing requirements'), icon:'fa-user-check', mount(panel){
          staffingPanel = staffingEditor(panel, { value:draft.staffing, readOnly:!can.settings, onChange(next){ draft.staffing = next; sync(); } });
          return staffingPanel;
        } } : null,
        People.slots.tab('compensation', entity, { readOnly:!can.settings }),
        People.slots.tab('fields', entity, { readOnly:!can.settings })
      ].filter(Boolean);
      const modal = People.entityModal.open({
        label:start.name || singular(), opener:extra.opener, returnFocus:() => list.rowElement(id)?.querySelector('[data-row-open]'), tab:extra.tab,
        summary:drawSummary,
        actions:() => can.settings ? [{ id:'archive', needs:'groups.edit', icon:'fa-box-archive', label:t('archive', 'Archive'), tone:'danger', onClick:async (button) => { if (await archive(current(), button)) modal.close(true); } }] : [],
        tabs,
        async onSave(){
          const problem = staffingProblem(draft.staffing);
          if (problem) throw new Error(problem);
          const patch = {};
          if (draft.name.trim() !== base.name.trim()) patch.name = draft.name;
          if (draft.typeId !== base.typeId) patch.typeId = draft.typeId;
          if (!same(sorted(draft.tagIds), sorted(base.tagIds))) patch.tagIds = draft.tagIds;
          if (!same(sorted(draft.scopeIds), sorted(base.scopeIds))) patch.scopeIds = draft.scopeIds;
          if (Object.keys(patch).length) await data.saveGroup(id, patch);
          if (!same(sorted(draft.departmentIds), sorted(base.departmentIds))) await data.saveSubjectDepartments('group', id, draft.departmentIds);
          if (!same(draft.staffing, base.staffing)) await data.saveStaffing(id, draft.staffing.map((requirement) => ({ ...requirement, label:String(requirement.label).trim() })));
          base = baseline();
          Object.assign(draft, clone(base));
          editing = false;
          modal.refreshSummary();
          staffingPanel?.setValue(draft.staffing);
        },
        onClose(){ if (openEntity?.modal === modal) { openEntity = null; options.onEntity?.(''); } }
      });
      const summaryHost = modal.el.querySelector('[data-modal-summary]');
      summaryHost.addEventListener('click', (event) => {
        if (event.target.closest('[data-people-identity]')) { editing = true; modal.refreshSummary(); summaryHost.querySelector('[data-identity="name"]')?.focus(); return; }
        const button = event.target.closest('[data-people-section-action]');
        if (!button) return;
        const section = button.dataset.peopleSectionAction;
        const refocus = () => modal.el.querySelector(`[data-people-section-action="${section}"]`)?.focus();
        const apply = (field) => (next) => { draft[field] = next; modal.refreshSummary(); sync(); };
        if (section === 'departments') pageKit.checkMenu(button, { label:labels().departmentPlural, items:data.state.departments.map((department) => ({ id:department.id, label:department.label || department.id, color:department.color })), selected:draft.departmentIds, onChange:apply('departmentIds'), refocus });
        else if (section === 'tags') pageKit.checkMenu(button, { label:t('tags', 'Tags'), items:data.state.tags.map((tag) => ({ id:String(tag.id), label:tag.name || tag.id })), selected:draft.tagIds, onChange:apply('tagIds'), refocus });
        else if (section === 'scopes') pageKit.checkMenu(button, { label:t('kinds_of_work', 'Kinds of work'), items:data.state.scopes.map((scope) => ({ id:scope.id, label:scope.name })), selected:draft.scopeIds, onChange:apply('scopeIds'), refocus });
      });
      const onIdentity = (event) => { const field = event.target.closest('[data-identity]'); if (!field) return; draft[field.dataset.identity] = field.value; sync(); if (field.dataset.identity === 'typeId') { /* the type pill follows on the next redraw */ } };
      summaryHost.addEventListener('input', onIdentity);
      summaryHost.addEventListener('change', onIdentity);
      openEntity = { key:`group:${id}`, modal, refresh(){
        if (!data.group(id)) { modal.close(true); return; }
        if (!modal.isDirty()) { base = baseline(); Object.assign(draft, clone(base)); }
        if (!editing) modal.refreshSummary();
        members?.refresh();
      } };
      options.onEntity?.(openEntity.key);
      sync();
      return modal;
    }

    refresh(false).then(() => {
      if (destroyed || !options.entity) return;
      const [kind, ...rest] = String(options.entity).split(':');
      if (kind === 'group') openGroup(rest.join(':'));
    });
    return {
      refresh:() => refresh(true), openGroup,
      destroy(){ destroyed = true; unsubscribe(); branchFilter.destroy(); detachHover(); People.hoverCard.hide(); openEntity?.modal.close(true); list.destroy(); }
    };
  }

  People.groupsPage = { mount, staffingEditor };
  People.views.register('groups', mount);
})();
