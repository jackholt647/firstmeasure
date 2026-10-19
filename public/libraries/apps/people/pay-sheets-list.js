/* public/libraries/apps/people/pay-sheets-list.js
 *
 * Every assignee's pay sheets in one place (docs/architecture/pay-sheets.md#the-editor), opened from the Groups and
 * outside company headers. Grouped by kind of work, filterable by kind of work and by kind of assignee, and showing
 * who is able to do a kind of work but has no pay sheet for it. A sheet opens in the same editor the assignee's own
 * Pay sheets tab uses.
 *
 *   FirstMatePeople.paySheets.openList({ opener, assigneeKind })   assigneeKind preselects 'resource_group' | 'organization_connection' | 'organization_user'
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.paySheets) return;
  const kit = People.kit;
  const model = People.paySheetModel;
  const { esc, t } = kit;
  const text = (value) => String(value ?? '').trim();
  const arr = (value) => (Array.isArray(value) ? value : []);
  const ICON = 'fa-file-invoice-dollar';
  const KIND_ICONS = { organization_user:kit.ICONS.user, resource_group:kit.ICONS.group, organization_connection:kit.ICONS.company };
  const keyOf = (assignee) => `${assignee?.type}:${assignee?.id}`;

  function kindNames(){
    const labels = People.data?.state?.groupLabels || {};
    return {
      organization_user:[t('user', 'User'), t('users', 'Users')],
      resource_group:[labels.singular || t('group', 'Group'), labels.plural || t('groups', 'Groups')],
      organization_connection:[labels.connectionSingular || kit.term('workforce.organization_connection_singular', t('subcontractor', 'Subcontractor')), labels.connectionPlural || kit.term('workforce.organization_connection_plural', t('subcontractors', 'Subcontractors'))]
    };
  }
  /* Names come from People's own store, which is already limited to the branches the viewer may see. */
  function directory(){
    const state = People.data?.state || {};
    const names = new Map();
    arr(state.users).forEach((row) => names.set(`organization_user:${row.id}`, { name:text(row.name || row.email) || row.id, photoUrl:row.photoUrl || '' }));
    arr(state.groups).forEach((row) => names.set(`resource_group:${row.id}`, { name:text(row.name) || row.id, color:row.color || '' }));
    arr(state.connections).forEach((row) => names.set(`organization_connection:${row.id}`, { name:text(row.name) || row.id }));
    return names;
  }

  function openList(options = {}){
    People.paySheetEditor.ensureStyles();
    const orgId = text(People.data?.orgId?.() || window.__APP?.userOrgId || window.__APP?.orgId);
    const shared = { vocab:null, overview:null, error:'' };
    let modal = null;
    const summary = (host) => {
      const sheets = arr(shared.overview?.sheets);
      const missing = shared.missing || 0;
      host.innerHTML = kit.summary({
        kind:'pay_sheets', id:'all', name:t('ps_pay_sheets', 'Pay sheets'), icon:ICON, secondary:t('ps_list_secondary', 'How every assignee is paid'),
        facts:shared.overview ? [
          { icon:ICON, label:t('ps_fact_sheets', 'Pay sheets'), value:String(sheets.length) },
          { icon:'fa-layer-group', label:t('ps_fact_kinds', 'Kinds of work'), value:String(new Set(sheets.flatMap((sheet) => arr(sheet.schema_ids))).size) },
          { icon:'fa-triangle-exclamation', label:t('ps_fact_missing', 'Missing a sheet'), value:String(missing), tooltip:t('ps_fact_missing_tip', 'Assignees marked as able to do a kind of work who have no pay sheet for it') }
        ] : []
      }, 'panel');
    };
    modal = People.entityModal.open({
      label:t('ps_pay_sheets', 'Pay sheets'), opener:options.opener,
      summary,
      actions:() => [],
      tabs:[{ id:'pay_sheets', needs:'pay_sheets', label:t('ps_pay_sheets', 'Pay sheets'), icon:ICON, mount:(panel, ctx) => mountList(panel, ctx) }]
    });
    /* Save belongs to a sheet: the footer shows only while one is open. */
    const footer = (show) => { const foot = modal?.el?.querySelector(".pp-modal-foot"); if (foot) foot.hidden = !show; };
    footer(false);

    function mountList(panel, ctx){
      let editor = null;
      let list = null;
      let filterKind = 'all';
      let filterAssignee = options.assigneeKind || 'all';
      let query = '';
      const canEdit = People.data?.allows ? People.data.allows('pay_sheets.edit') : true;
      const canTry = People.data?.allows ? People.data.allows('pay_sheets.try') : true;
      const names = () => directory();
      function rows(){
        const vocab = shared.vocab;
        const known = names();
        const sheets = arr(shared.overview?.sheets).filter((sheet) => known.has(keyOf(sheet.subject)));
        const out = sheets.map((sheet) => ({ type:'sheet', sheet, assignee:sheet.subject, kind:arr(sheet.schema_ids)[0] || '__none' }));
        for (const row of arr(shared.overview?.assignees)) {
          if (!known.has(keyOf(row.assignee))) continue;
          const own = sheets.filter((sheet) => keyOf(sheet.subject) === keyOf(row.assignee));
          for (const kindId of arr(row.capable_schema_ids)) if (vocab.kind(kindId) && !own.some((sheet) => arr(sheet.schema_ids).includes(kindId))) out.push({ type:'missing', assignee:row.assignee, kind:kindId });
        }
        shared.missing = out.filter((row) => row.type === 'missing').length;
        return out;
      }
      function visible(all){
        const lower = query.trim().toLowerCase();
        const known = names();
        return all.filter((row) => (filterKind === 'all' || row.kind === filterKind) && (filterAssignee === 'all' || row.assignee.type === filterAssignee) && (!lower || `${known.get(keyOf(row.assignee))?.name || ''} ${row.sheet?.name || ''}`.toLowerCase().includes(lower)));
      }
      function openEditor(sheet, assigneeName){
        footer(true);
        list?.destroy(); list = null;
        panel.replaceChildren();
        const host = document.createElement('div');
        panel.appendChild(host);
        editor = People.paySheetEditor.mount(host, {
          orgId, sheet, vocab:shared.vocab, sheets:arr(shared.overview?.sheets), assigneeName, readOnly:!canEdit, canTry,
          onDirty:(value) => ctx.setDirty(value), onStatus:(state, words) => ctx.setStatus(state, words),
          onSaved:(saved) => { shared.overview.sheets = [...arr(shared.overview.sheets).filter((row) => row.id !== saved.id), saved]; ctx.setStatus('saved', t('saved', 'Saved')); modal.refreshSummary(); },
          onArchived:(gone) => { shared.overview.sheets = arr(shared.overview.sheets).filter((row) => row.id !== gone.id); ctx.setDirty(false); modal.refreshSummary(); showList(); },
          onDuplicated:(made) => { shared.overview.sheets = [...arr(shared.overview.sheets), made]; modal.refreshSummary(); },
          onBack:async () => {
            if (editor?.isDirty()) {
              const leave = await kit.confirm(panel.querySelector('[data-ps-back]') || panel, { title:t('discard_changes', 'Discard unsaved changes?'), confirmLabel:t('discard', 'Discard'), cancelLabel:t('keep_editing', 'Keep editing'), tone:'danger', align:'start' });
              if (!leave) return;
            }
            ctx.setDirty(false); ctx.setStatus("", "");
            showList();
          }
        });
        panel.scrollTop = 0;
      }
      function showList(){
        footer(false);
        editor?.destroy(); editor = null;
        panel.replaceChildren();
        const host = document.createElement('div');
        panel.appendChild(host);
        const vocab = shared.vocab;
        const all = rows();
        const nouns = kindNames();
        const kinds = [...new Set(all.map((row) => row.kind))];
        const kindLabel = (id) => (id === '__none' ? t('ps_kind_none_short', 'No kind of work') : vocab.kindTitle(id));
        list = People.listPage.mount(host, {
          embedded:true, columns:false, title:t('ps_pay_sheets', 'Pay sheets'),
          search:{ placeholder:t('ps_search', 'Search assignees and sheets'), value:query, onInput(value){ query = value; list.setItems(visible(all)); subtitle(); } },
          filters:kinds.length > 1 ? { label:t('ps_kind', 'Kind of work'), value:filterKind, items:[{ id:'all', label:t('all', 'All') }, ...kinds.map((id) => ({ id, label:kindLabel(id), count:all.filter((row) => row.kind === id && row.type === 'missing').length || '' , tooltip:t('ps_filter_kind_tip', '{kind} pay sheets, and who is missing one', { kind:kindLabel(id) }) }))], onChange(id){ filterKind = id; list.setItems(visible(all)); subtitle(); } } : null,
          empty:{ icon:ICON, title:t('ps_list_empty', 'No pay sheets yet') },
          section:(row) => ({ key:row.kind, title:kindLabel(row.kind), icon:ICON, order:row.kind === '__none' ? 999 : vocab.kinds.findIndex((kind) => kind.id === row.kind) }),
          row:(row) => {
            const who = names().get(keyOf(row.assignee)) || { name:row.assignee.id };
            const kindPill = { label:nouns[row.assignee.type]?.[0] || '', tone:'neutral', icon:KIND_ICONS[row.assignee.type], tooltip:t('assignee_kind', 'Kind of assignee') };
            if (row.type === 'missing') return { key:`missing:${keyOf(row.assignee)}:${row.kind}`, entity:{ id:row.assignee.id, name:who.name, photoUrl:who.photoUrl, color:who.color }, square:row.assignee.type !== 'organization_user', title:who.name, secondary:t('ps_missing_secondary', 'Able to do {kind} work, with no pay sheet for it', { kind:lowerFirst(kindLabel(row.kind)) }), pills:[kindPill, { label:t('ps_no_sheet', 'No pay sheet'), tone:'warn', icon:'fa-triangle-exclamation', tooltip:t('ps_no_sheet_tip', 'Labor lists for this assignee cannot be generated for this kind of work until it has a pay sheet') }], actions:canEdit ? [{ id:'add', needs:'pay_sheets.edit', icon:'fa-plus', label:t('ps_add_sheet', 'Add pay sheet') }] : [] };
            const base = People.paySheetEditor.sheetRow(row.sheet, vocab);
            return { ...base, key:`sheet:${row.sheet.id}`, entity:{ id:row.assignee.id, name:who.name, photoUrl:who.photoUrl, color:who.color }, square:row.assignee.type !== 'organization_user', title:who.name, secondary:`${row.sheet.name} · ${base.secondary}`, pills:[kindPill], actions:[{ id:'open', needs:'pay_sheets', icon:kit.ICONS.edit, label:t('open', 'Open') }] };
          },
          onOpen:(row) => open(row),
          onAction:(id, row) => open(row)
        });
        list.el.classList.add('ps-all');
        // Which kind of assignee: users, groups or outside companies, named as this organization names them.
        const kindsPresent = [...new Set(all.map((row) => row.assignee.type))];
        if (kindsPresent.length > 1) {
          list.controlHost.innerHTML = People.paySheetEditor.select({ attrs:'data-ps-assignee-filter', label:t('assignee_kind', 'Kind of assignee'), value:filterAssignee, groups:[{ options:[{ value:'all', label:t('ps_all_assignees', 'Every assignee') }, ...['resource_group', 'organization_connection', 'organization_user'].filter((type) => kindsPresent.includes(type)).map((type) => ({ value:type, label:nouns[type][1] }))] }] });
          list.controlHost.querySelector('select').addEventListener('change', (event) => { filterAssignee = event.target.value; list.setItems(visible(all)); subtitle(); });
        } else filterAssignee = 'all';
        function subtitle(){ const shown = visible(all); list.setSubtitle(kit.countPhrase([[shown.filter((row) => row.type === 'sheet').length, t('ps_sheet_one', 'pay sheet'), t('ps_sheet_many', 'pay sheets')], [shown.filter((row) => row.type === 'missing').length, t('ps_missing_count', 'missing')]])); }
        list.setItems(visible(all));
        subtitle();
        modal?.refreshSummary();
      }
      function open(row){
        const who = names().get(keyOf(row.assignee))?.name || '';
        if (row.type === 'sheet') openEditor(row.sheet, who);
        else if (canEdit) openEditor(model.starter(row.assignee, row.kind === '__none' ? '' : row.kind, shared.vocab, who), who);
      }
      const lowerFirst = model.lowerFirst;
      panel.innerHTML = `<div class="pp pp-state" aria-busy="true"><i class="fas ${ICON}" aria-hidden="true"></i><strong>${esc(t('loading', 'Loading…'))}</strong></div>`;
      Promise.all([People.paySheetEditor.kindsFor(orgId), model.api.overview(orgId), People.data?.load ? People.data.load().catch(() => null) : null]).then(([vocab, overview]) => {
        shared.vocab = vocab; shared.overview = { sheets:arr(overview?.sheets), assignees:arr(overview?.assignees) };
        showList();
      }).catch((error) => { panel.innerHTML = `<div class="pp pp-state" role="alert"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i><strong>${esc(error?.message || t('load_failed', 'Could not load'))}</strong></div>`; });
      return { save:async () => { if (editor?.isDirty()) await editor.save(); }, destroy(){ editor?.destroy(); list?.destroy(); } };
    }
    return modal;
  }

  People.paySheets = { openList };
})();
