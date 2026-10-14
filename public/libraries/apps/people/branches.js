/* public/libraries/apps/people/branches.js
 *
 * Branches and regions in People (docs/architecture/branches.md). The organization has branches; a branch is in at
 * most one flat region. With the feature off, or one active branch, none of this shows anywhere except the Branches
 * button on the People overview (which is how a second branch is added).
 *
 *   FirstMatePeople.branches.open({ opener })        the Branches modal: name branches, add branches and regions, put a branch in a region
 *   FirstMatePeople.branches.filter(page, { onChange }) -> { attach(host), matches(kind, record), selection(), destroy() }
 *                                                    the header filter of a list page; kind as data.branchIdsOf
 *   FirstMatePeople.branches.manageable(keepId)      active branches the viewer manages (and keepId, so a select shows its value)
 *
 * Every write is a published organization-branches.* action; each returns the new structure.
 */
(function(){
  'use strict';
  const People = window.FirstMatePeople = window.FirstMatePeople || {};
  if (People.branches) return;
  const kit = People.kit;
  const data = People.data;
  const pageKit = People.pageKit;
  const { esc, t, tip } = kit;
  const arr = (value) => Array.isArray(value) ? value : [];
  const text = (...values) => { for (const value of values) { const clean = String(value ?? '').trim(); if (clean) return clean; } return ''; };
  const store = {
    read(key, fallback){ try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (_) { return fallback; } },
    write(key, value){ try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
  };

  function ensureStyles(){
    People.lists?.ensureStyles?.();
    if (document.getElementById('pp_branches_css')) return;
    const style = document.createElement('style');
    style.id = 'pp_branches_css';
    style.textContent = `
      .pp-branch-btn{display:inline-flex;align-items:center;gap:8px;flex:0 1 auto;min-width:0;max-width:200px;height:36px;padding:0 10px;border:1px solid var(--pp-line);border-radius:9px;background:var(--pp-panel);color:var(--pp-text);font:inherit;text-align:left;cursor:pointer}
      .pp-branch-btn:hover{background:var(--pp-hover)}
      .pp-branch-btn>i{flex:none;color:var(--pp-muted);font-size:12px}
      .pp-branch-btn>.pp-caret{font-size:9px;color:var(--pp-faint)}
      .pp-branch-text{display:grid;min-width:0;line-height:1.12}
      .pp-branch-text>b{overflow:hidden;font-size:12.5px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}
      .pp-branch-text>small{overflow:hidden;color:var(--pp-muted);font-size:10.5px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
      .pp-branch-btn.narrowed{border-color:var(--pp-accent,#3538cd)}
      @container (max-width:640px){.pp-branch-btn{max-width:none;flex:1 1 140px}}
      .pp-bf{display:grid;gap:10px;width:300px;max-width:calc(100vw - 16px);max-height:min(460px,70vh);padding:12px;overflow:auto}
      .pp-bf-quick{display:flex;gap:4px;flex-wrap:wrap}
      .pp-bf-quick>button,.pp-bf-foot>button{height:28px;padding:0 10px;border:1px solid var(--pp-line);border-radius:14px;background:var(--pp-panel);color:var(--pp-text);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
      .pp-bf-quick>button[aria-pressed="true"]{border-color:transparent;background:var(--pp-text);color:var(--pp-panel)}
      .pp-bf-foot{display:flex;gap:6px;justify-content:flex-end}
      .pp-bf-foot>button{border:0;background:transparent;color:var(--pp-muted)}
      .pp-bf-foot>button:hover{color:var(--pp-text)}
      .pp-bf-tree{display:grid;gap:4px;margin:0;padding:0;list-style:none}
      .pp-bf-rhead{display:flex;align-items:center;gap:2px}
      .pp-bf-fold{display:grid;place-items:center;flex:none;width:24px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--pp-faint);cursor:pointer}
      .pp-bf-fold>i{font-size:9.5px;transition:transform .16s ease}
      .pp-bf-fold[aria-expanded="false"]>i{transform:rotate(-90deg)}
      .pp-bf-pick,.pp-bf-branch{display:flex;align-items:center;gap:8px;flex:1;min-width:0;min-height:28px;padding:2px 6px;border:0;border-radius:7px;background:transparent;color:var(--pp-text);font:inherit;font-size:13px;text-align:left;cursor:pointer}
      .pp-bf-pick{font-weight:700}
      .pp-bf-pick:hover,.pp-bf-branch:hover{background:var(--pp-hover)}
      .pp-bf-box{display:grid;place-items:center;flex:none;width:15px;height:15px;border:1.5px solid var(--pp-faint);border-radius:4px;color:#fff;font-size:9px}
      [aria-checked="true"]>.pp-bf-box,.pp-bf-branch input:checked+.pp-bf-box{border-color:var(--pp-text);background:var(--pp-text)}
      [aria-checked="mixed"]>.pp-bf-box{border-color:var(--pp-text);background:var(--pp-text)}
      .pp-bf-branch input{position:absolute;opacity:0;pointer-events:none}
      .pp-bf-branch input:focus-visible+.pp-bf-box{outline:2px solid var(--pp-accent,#3538cd);outline-offset:2px}
      .pp-bf-branches{margin:0 0 0 26px;padding:0;list-style:none}
      .pp-bf-branches.loose{margin-left:0}
      .pp-bf-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .pp-bf-mine{color:var(--pp-muted);font-size:11px}
      .pp-bf-heading{margin:4px 0 0;color:var(--pp-muted);font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
      .pp-br{display:grid;gap:18px}
      .pp-br-section>h4{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:13px;font-weight:700}
      .pp-br-section>h4>i{color:var(--pp-faint);font-size:12px}
      .pp-br-section>h4>.pp-spacer{flex:1}
      .pp-br-section.archived{opacity:.75}
      .pp-br-unnamed{color:var(--pp-muted);font-style:italic}
      .pp-br-region{height:26px;padding:0 8px;border:1px solid var(--pp-line);border-radius:13px;background:var(--pp-panel);color:var(--pp-muted);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}
      .pp-br-region:hover{background:var(--pp-hover);color:var(--pp-text)}
      @media (prefers-reduced-motion:reduce){.pp-bf-fold>i{transition:none}}
    `;
    document.head.appendChild(style);
  }

  /* ---- reading ---- */
  const structure = () => data.structure() || {};
  const visibleIds = () => data.branches().map((entry) => String(entry.id));
  const myIds = () => { const mine = arr(structure().my_branch_ids).map(String).filter((id) => visibleIds().includes(id)); return mine.length ? mine : [text(structure().my_branch_id, 'default')]; };
  const regionIdsOf = (branchIds) => data.regions().filter((entry) => arr(entry.branch_ids).some((id) => branchIds.includes(String(id)))).map((entry) => String(entry.id));
  const myRegionIds = () => { const mine = arr(structure().my_region_ids).map(String); return mine.length ? mine : regionIdsOf(myIds()); };
  const regionBranchIds = (regionId) => arr(data.region(regionId)?.branch_ids).map(String).filter((id) => visibleIds().includes(id));
  const myRegionBranchIds = () => [...new Set([...myIds(), ...myRegionIds().flatMap(regionBranchIds)])];
  const looseBranches = () => data.branches().filter((entry) => !data.regions().some((region) => arr(region.branch_ids).map(String).includes(String(entry.id)))).sort((left, right) => data.branchName(left.id).localeCompare(data.branchName(right.id)));
  const canRename = (id) => data.allows('branches.rename') && arr(structure().access?.can_rename_branch_ids).map(String).includes(String(id));
  function manageable(keepId){
    const reach = arr(structure().access?.manageable_branch_ids).map(String);
    return data.branches().filter((entry) => reach.includes(String(entry.id)) || entry.can_manage === true || String(entry.id) === String(keepId || ''));
  }

  /* ---- writing ---- */
  const ERRORS = {
    branch_name_taken:() => t('branch_name_taken', 'There is already a branch with that name.'),
    region_name_taken:() => t('region_name_taken', 'There is already a region with that name.'),
    branch_name_required:() => t('branch_name_required', 'Give the branch a name.'),
    default_branch_required:() => t('default_branch_required', 'The main branch cannot be archived.'),
    branch_in_use:() => t('branch_in_use', 'People, groups or departments belong only to this branch. Move them first.'),
    branch_scope_denied:() => t('branch_scope_denied', 'That branch is outside the branches you manage.'),
    branch_structure_denied:() => t('branch_structure_denied', 'You cannot change branches or regions.'),
    multiple_branches_disabled:() => t('multiple_branches_disabled', 'Multiple branches is turned off for this organization.'),
    stale_branch_structure:() => t('stale_branch_structure', 'Someone else changed the branches. Try again.'),
    unknown_region:() => t('unknown_region', 'That region no longer exists.')
  };
  const codeOf = (error) => text(error?.code, error?.error?.code, error?.body?.error?.code, error?.details?.code, error?.data?.error?.code);
  function friendly(error){
    const code = codeOf(error);
    if (ERRORS[code]) { const next = new Error(ERRORS[code]()); next.code = code; return next; }
    return error instanceof Error ? error : new Error(text(error?.message, t('save_failed', 'Could not save')));
  }
  async function act(action, input){
    let result;
    try { result = await data.internal.invoke(action, input); }
    catch (error) { throw friendly(error); }
    await data.internal.reload({ type:'branches' });
    return result;
  }
  const regionRevision = () => Number(structure().catalog_revision || 0) || undefined;
  const writes = {
    addBranch:(name, regionId) => act('organization-branches.branch.add', { name:String(name || '').trim(), ...(regionId ? { region_id:regionId } : {}) }),
    renameBranch:(id, name) => act('organization-branches.branch.rename', { branch_id:String(id), name:String(name || '').trim() }),
    archiveBranch:(id, archived = true) => act('organization-branches.branch.archive', { branch_id:String(id), archived }),
    saveRegion:(input) => act('organization-branches.region.save', { ...input, ...(input.id && regionRevision() ? { expected_revision:regionRevision() } : {}) }),
    setBranchRegion:(id, regionId) => act('organization-branches.branch.region.set', { branch_id:String(id), region_id:regionId || '', ...(regionRevision() ? { expected_revision:regionRevision() } : {}) })
  };

  /* ---- the Branches modal ---- */
  function open(options = {}){
    ensureStyles();
    let host = null;
    const branchWord = () => t('branches', 'Branches');
    const nameHtml = (entry) => text(entry.name) && entry.name !== 'Default Branch'
      ? esc(entry.name)
      : `<span class="pp-br-unnamed"${tip(t('unnamed_branch_tip', 'This branch has no name yet. With one branch it needs none.'))}>${esc(data.branchName(entry.id))}</span>`;
    function branchRow(entry){
      const archived = text(entry.status, 'active') === 'archived';
      const regionLabel = data.region(entry.region_id)?.label || t('no_region', 'No region');
      const chips = [
        entry.is_mine ? kit.chip({ label:t('my_branch', 'My branch'), tone:'role' }) : '',
        entry.is_default && data.multipleBranches() ? kit.chip({ label:t('main', 'Main'), tone:'muted', tooltip:t('main_branch_tip', 'The branch everyone was in before there were others') }) : ''
      ].join('');
      const users = Number(entry.counts?.users || 0);
      const actions = [
        !archived && canRename(entry.id) ? { id:'rename', needs:'branches.rename', icon:kit.ICONS.edit, label:text(entry.name) && entry.name !== 'Default Branch' ? t('rename', 'Rename') : t('name_branch', 'Name this branch') } : null,
        entry.is_default ? null : { id:archived ? 'restore' : 'archive', needs:'branches.archive', icon:archived ? 'fa-rotate-left' : 'fa-box-archive', label:archived ? t('restore', 'Restore') : t('archive', 'Archive'), tone:archived ? '' : 'danger' }
      ];
      const regionControl = !archived && data.allows('branches.region') && data.regions().length
        ? `<button type="button" class="pp-br-region" data-br-region="${esc(entry.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('region_of', 'Region of {branch}: {region}', { branch:data.branchName(entry.id), region:regionLabel }))}"><i class="fas fa-map-location-dot" aria-hidden="true"></i> ${esc(regionLabel)}</button>` : '';
      return `<div class="pp-type" role="listitem" data-type-id="${esc(entry.id)}" data-branch-row="${esc(entry.id)}">
        <span class="pp-type-name">${nameHtml(entry)}</span>
        <div class="pp-chip-run">${chips}</div>
        ${regionControl}
        <span class="pp-type-count"${tip(t('branch_users_tip', 'Users in this branch'))}>${users.toLocaleString()}</span>
        ${data.gate(actions, 'branch-row').map((action) => `<button type="button" class="pp-icon-btn ${action.tone === 'danger' ? 'danger' : ''}" data-br-action="${esc(action.id)}" aria-label="${esc(action.label)}"${tip(action.label)}><i class="fas ${esc(action.icon)}" aria-hidden="true"></i></button>`).join('')}
      </div>`;
    }
    const section = (key, title, icon, rows, tools = '', extra = '') => `<section class="pp-br-section${extra}" data-br-section="${esc(key)}"><h4><i class="fas ${icon}" aria-hidden="true"></i><span>${esc(title)}</span><span class="pp-spacer"></span>${tools}</h4><div class="pp-types" role="list">${rows}</div></section>`;
    function draw(){
      if (!host) return;
      const all = arr(structure().branches);
      const active = all.filter((entry) => text(entry.status, 'active') !== 'archived');
      const regions = arr(structure().regions);
      const inRegion = (region) => active.filter((entry) => arr(region.branch_ids).map(String).includes(String(entry.id)) || String(entry.region_id || '') === String(region.id));
      const regionTools = (region) => data.gate([
        { id:'rename-region', needs:'regions.edit', icon:kit.ICONS.edit, label:t('rename_region', 'Rename region') },
        { id:text(region.status, 'active') === 'archived' ? 'restore-region' : 'archive-region', needs:'regions.edit', icon:text(region.status, 'active') === 'archived' ? 'fa-rotate-left' : 'fa-box-archive', label:text(region.status, 'active') === 'archived' ? t('restore', 'Restore') : t('archive_region', 'Archive region'), tone:text(region.status, 'active') === 'archived' ? '' : 'danger' }
      ], 'region').map((action) => `<button type="button" class="pp-icon-btn ${action.tone === 'danger' ? 'danger' : ''}" data-region-action="${esc(action.id)}" data-region-id="${esc(region.id)}" aria-label="${esc(`${action.label}: ${region.label}`)}"${tip(action.label)}><i class="fas ${esc(action.icon)}" aria-hidden="true"></i></button>`).join('');
      const placed = new Set();
      const regionSections = regions.map((region) => {
        const list = inRegion(region);
        list.forEach((entry) => placed.add(String(entry.id)));
        const archived = text(region.status, 'active') === 'archived';
        return section(`region:${region.id}`, region.label, 'fa-map-location-dot', list.map(branchRow).join('') || `<p class="pp-sum-empty">${esc(t('no_branches_in_region', 'No branches in this region'))}</p>`, regionTools(region), archived ? ' archived' : '');
      }).join('');
      const loose = active.filter((entry) => !placed.has(String(entry.id)));
      const archivedBranches = all.filter((entry) => text(entry.status, 'active') === 'archived');
      const newButtons = [
        data.allows('regions.edit') ? `<button type="button" class="pp-btn" data-br-new-region><i class="fas fa-map-location-dot" aria-hidden="true"></i>${esc(t('new_region', 'New region'))}</button>` : '',
        data.allows('branches.add') ? `<button type="button" class="pp-btn primary" data-br-new-branch><i class="fas fa-plus" aria-hidden="true"></i>${esc(t('new_branch', 'New branch'))}</button>` : ''
      ].join('');
      host.innerHTML = `<div class="pp-tab-bar"><strong>${esc(kit.countPhrase([[active.length, t('branch_one', 'branch'), t('branch_many', 'branches')], [regions.filter((entry) => text(entry.status, 'active') !== 'archived').length, t('region_one', 'region'), t('region_many', 'regions')]]))}</strong>${kit.info(t('branches_tip', 'Each branch has its own departments and settings, and most people see only their own. A region groups branches. With one branch none of this shows anywhere else.'))}<span class="pp-spacer"></span>${newButtons}</div>
        <div class="pp-br">${regionSections}${loose.length || !regions.length ? section('none', regions.length ? t('not_in_region', 'Not in a region') : branchWord(), 'fa-location-dot', loose.map(branchRow).join('')) : ''}${archivedBranches.length ? section('archived', t('archived', 'Archived'), 'fa-box-archive', archivedBranches.map(branchRow).join(''), '', ' archived') : ''}</div>`;
    }
    const modal = People.entityModal.open({
      label:branchWord(), opener:options.opener, footer:false,
      summary(summaryHost){ summaryHost.innerHTML = kit.summary({ kind:'list', id:'branches', name:branchWord(), icon:'fa-location-dot', color:'#0e7090', pills:[], facts:[], sections:[] }, 'panel'); },
      actions:() => [],
      tabs:[{ id:'branches', needs:'branches.view', label:branchWord(), icon:'fa-location-dot', mount(panel){ host = panel; draw(); return {}; } }],
      onClose(){ unsubscribe(); }
    });
    const unsubscribe = data.subscribe(() => draw());
    const guarded = (work, title) => Promise.resolve().then(work).catch((error) => pageKit.failed(title || t('not_saved', 'Not saved'), friendly(error)));
    const regionOptions = () => [{ value:'', label:t('no_region', 'No region') }, ...data.regions().map((entry) => ({ value:entry.id, label:entry.label }))];
    modal.el.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button || button.disabled) return;
      if (button.matches('[data-br-new-branch]')) {
        kit.form(button, { title:t('new_branch', 'New branch'), submitLabel:t('create', 'Create'), fields:[{ id:'name', label:t('name', 'Name'), required:true }, ...(data.regions().length && data.allows('branches.region') ? [{ id:'region_id', label:t('region', 'Region'), type:'select', value:'', options:regionOptions() }] : [])], submit:(values) => writes.addBranch(values.name, values.region_id) })
          .then((result) => { if (result) kit.toast(t('saved', 'Saved'), t('branch_added', 'Branch added.'), true); });
        return;
      }
      if (button.matches('[data-br-new-region]')) {
        kit.form(button, { title:t('new_region', 'New region'), submitLabel:t('create', 'Create'), fields:[{ id:'label', label:t('name', 'Name'), required:true }], submit:(values) => writes.saveRegion({ label:String(values.label || '').trim() }) });
        return;
      }
      const regionPick = button.closest('[data-br-region]');
      if (regionPick) {
        const branchId = regionPick.dataset.brRegion;
        const now = String(data.branch(branchId)?.region_id || data.regions().find((entry) => arr(entry.branch_ids).map(String).includes(branchId))?.id || '');
        kit.menu(regionPick, { align:'end', label:t('region', 'Region'), items:regionOptions().map((option) => ({ id:option.value || '__none', label:option.label, checked:option.value === now })), onSelect(item, menu){ menu.close(); guarded(() => writes.setBranchRegion(branchId, item.id === '__none' ? '' : item.id)); return false; } });
        return;
      }
      const action = button.dataset.brAction;
      const rowEl = button.closest('[data-branch-row]');
      if (action && rowEl) {
        const id = rowEl.dataset.branchRow;
        const entry = data.branch(id) || { id };
        if (action === 'rename') kit.form(button, { title:t('name_branch', 'Name this branch'), submitLabel:t('save', 'Save'), fields:[{ id:'name', label:t('name', 'Name'), value:text(entry.name) === 'Default Branch' ? '' : text(entry.name), required:!entry.is_default }], submit:(values) => writes.renameBranch(id, values.name) });
        else if (action === 'archive') { if (await kit.confirm(button, { title:t('archive_confirm', 'Archive {name}?', { name:data.branchName(id) }), confirmLabel:t('archive', 'Archive'), tone:'danger' })) guarded(() => writes.archiveBranch(id, true), t('not_archived', 'Not archived')); }
        else if (action === 'restore') guarded(() => writes.archiveBranch(id, false));
        return;
      }
      const regionAction = button.dataset.regionAction;
      if (regionAction) {
        const region = data.region(button.dataset.regionId);
        if (!region) return;
        if (regionAction === 'rename-region') kit.form(button, { title:t('rename_region', 'Rename region'), submitLabel:t('save', 'Save'), fields:[{ id:'label', label:t('name', 'Name'), value:region.label, required:true }], submit:(values) => writes.saveRegion({ id:region.id, label:String(values.label || '').trim() }) });
        else if (regionAction === 'archive-region') { if (await kit.confirm(button, { title:t('archive_confirm', 'Archive {name}?', { name:region.label }), confirmLabel:t('archive', 'Archive'), tone:'danger' })) guarded(() => writes.saveRegion({ id:region.id, label:region.label, status:'archived' }), t('not_archived', 'Not archived')); }
        else if (regionAction === 'restore-region') guarded(() => writes.saveRegion({ id:region.id, label:region.label, status:'active' }));
      }
    });
    return modal;
  }

  /* ---- the branch filter on a list page ---- */
  const MODES = ['mine', 'region', 'all', 'custom'];
  function filter(page, options = {}){
    ensureStyles();
    const key = `fm.people.branch-filter.${page}`;
    const foldKey = 'fm.people.branch-filter.folded';
    let saved = store.read(key, null);
    let selection = saved && MODES.includes(saved.mode) ? { mode:saved.mode, ids:arr(saved.ids).map(String) } : { mode:'mine', ids:[] };
    let host = null;
    let layer = null;
    const active = () => data.allows('branches.filter') && visibleIds().length > 1;
    const regionAllowed = () => data.allows('branches.filter_region') && myRegionIds().length > 0;
    function ids(){
      const visible = visibleIds();
      if (selection.mode === 'all') return visible;
      if (selection.mode === 'region') return regionAllowed() ? myRegionBranchIds() : myIds();
      if (selection.mode === 'custom') return selection.ids.filter((id) => visible.includes(id));
      return myIds();
    }
    const sameSet = (left, right) => left.length === right.length && left.every((id) => right.includes(id));
    function choose(next){
      const visible = visibleIds();
      const list = [...new Set(next.map(String))].filter((id) => visible.includes(id));
      selection = sameSet(list, myIds()) ? { mode:'mine', ids:[] } : sameSet(list, visible) ? { mode:'all', ids:[] } : regionAllowed() && sameSet(list, myRegionBranchIds()) ? { mode:'region', ids:[] } : { mode:'custom', ids:list };
      store.write(key, selection);
      paint();
      options.onChange?.(selection);
    }
    function matches(kind, record){
      if (!active()) return true;
      const chosen = new Set(ids());
      const own = data.branchIdsOf(kind, record);
      if (kind === 'company' && !own.length) return true;   // a company with no branch works in every branch
      return own.some((id) => chosen.has(String(id)));
    }
    function label(){
      const chosen = ids();
      if (selection.mode === 'mine') return { title:t('my_branch', 'My branch'), sub:myIds().map(data.branchName).join(', ') };
      if (selection.mode === 'region') return { title:t('my_region', 'My region'), sub:myRegionIds().map((id) => data.region(id)?.label || id).join(', ') };
      if (selection.mode === 'all') return { title:t('all_branches', 'All branches'), sub:kit.countPhrase([[chosen.length, t('branch_one', 'branch'), t('branch_many', 'branches')]]) };
      if (!chosen.length) return { title:t('no_branches', 'No branches'), sub:t('nothing_shown', 'Nothing shown') };
      if (chosen.length === 1) return { title:data.branchName(chosen[0]), sub:t('branch', 'Branch') };
      return { title:kit.countPhrase([[chosen.length, t('branch_one', 'branch'), t('branch_many', 'branches')]]), sub:chosen.map(data.branchName).join(', ') };
    }
    function paint(){
      if (!host) return;
      if (!active()) { layer?.close(); host.replaceChildren(); return; }
      const { title, sub } = label();
      const name = t('branches_shown', 'Branches shown: {title}, {sub}', { title, sub });
      let button = host.querySelector('[data-branch-filter]');
      if (!button) {
        host.innerHTML = `<button type="button" class="pp-branch-btn" data-branch-filter aria-haspopup="dialog" aria-expanded="false"><i class="fas fa-location-dot" aria-hidden="true"></i><span class="pp-branch-text"><b></b><small></small></span><i class="fas fa-chevron-down pp-caret" aria-hidden="true"></i></button>`;
        button = host.querySelector('[data-branch-filter]');
        button.addEventListener('click', () => (layer ? layer.close() : openPanel(button)));
      }
      button.querySelector('b').textContent = title;
      button.querySelector('small').textContent = sub;
      button.setAttribute('aria-label', name);
      button.setAttribute('data-fm-tooltip', `${title}: ${sub}`);
      button.classList.toggle('narrowed', selection.mode !== 'mine');
      if (layer) drawPanel(layer.panel);
    }
    function drawPanel(panel){
      const chosen = new Set(ids());
      const folded = new Set(arr(store.read(foldKey, [])).map(String));
      const box = '<span class="pp-bf-box" aria-hidden="true"><i class="fas fa-check"></i></span>';
      const branchItem = (entry) => `<li><label class="pp-bf-branch"><input type="checkbox" data-bf-branch="${esc(entry.id)}" ${chosen.has(String(entry.id)) ? 'checked' : ''}>${box}<span class="pp-bf-name">${esc(data.branchName(entry.id))}</span>${myIds().includes(String(entry.id)) ? `<span class="pp-bf-mine">${esc(t('mine', 'Mine'))}</span>` : ''}</label></li>`;
      const regions = data.regions().filter((region) => regionBranchIds(region.id).length);
      const regionHtml = regions.map((region) => {
        const inside = regionBranchIds(region.id);
        const picked = inside.filter((id) => chosen.has(id)).length;
        const state = picked === 0 ? 'false' : picked === inside.length ? 'true' : 'mixed';
        const open = !folded.has(String(region.id));
        const listId = `pp-bf-${String(region.id).replace(/[^a-zA-Z0-9_-]/g, '')}`;
        return `<li data-bf-region="${esc(region.id)}"><div class="pp-bf-rhead"><button type="button" class="pp-bf-fold" data-bf-fold="${esc(region.id)}" aria-expanded="${open}" aria-controls="${listId}" aria-label="${esc(t(open ? 'hide_branches_of' : 'show_branches_of', open ? 'Hide the branches of {region}' : 'Show the branches of {region}', { region:region.label }))}"><i class="fas fa-chevron-down" aria-hidden="true"></i></button><button type="button" class="pp-bf-pick" role="checkbox" aria-checked="${state}" data-bf-region-pick="${esc(region.id)}"${tip(t('region_pick_tip', 'Choose every branch in {region}', { region:region.label }))}>${box}<span class="pp-bf-name">${esc(region.label)}</span><span class="pp-bf-mine">${picked}/${inside.length}</span></button></div><ul class="pp-bf-branches" id="${listId}" ${open ? '' : 'hidden'}>${inside.map((id) => data.branch(id)).filter(Boolean).map(branchItem).join('')}</ul></li>`;
      }).join('');
      const loose = looseBranches();
      const quick = [
        { id:'mine', label:t('my_branch', 'My branch') },
        regionAllowed() ? { id:'region', label:t('my_region', 'My region') } : null,
        { id:'all', label:t('all', 'All') }
      ].filter(Boolean);
      panel.innerHTML = `<div class="pp-bf-quick" role="group" aria-label="${esc(t('quick_choices', 'Quick choices'))}">${quick.map((item) => `<button type="button" data-bf-quick="${item.id}" aria-pressed="${selection.mode === item.id}">${esc(item.label)}</button>`).join('')}</div>
        <ul class="pp-bf-tree" role="list">${regionHtml}${loose.length ? `${regions.length ? `<li class="pp-bf-heading">${esc(t('not_in_region', 'Not in a region'))}</li>` : ''}<li><ul class="pp-bf-branches loose">${loose.map(branchItem).join('')}</ul></li>` : ''}</ul>
        <div class="pp-bf-foot"><button type="button" data-bf-select-all>${esc(t('select_all', 'Select all'))}</button><button type="button" data-bf-none>${esc(t('select_none', 'None'))}</button></div>`;
    }
    function openPanel(button){
      const panel = document.createElement('div');
      panel.className = 'pp-bf';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', t('branches', 'Branches'));
      drawPanel(panel);
      layer = kit.layer(button, panel, { align:'end', onClose(){ layer = null; } });
      const refocus = (selector) => panel.querySelector(selector)?.focus();
      panel.addEventListener('click', (event) => {
        const quick = event.target.closest('[data-bf-quick]');
        if (quick) { const mode = quick.dataset.bfQuick; choose(mode === 'all' ? visibleIds() : mode === 'region' ? myRegionBranchIds() : myIds()); refocus(`[data-bf-quick="${mode}"]`); return; }
        const fold = event.target.closest('[data-bf-fold]');
        if (fold) {
          const id = fold.dataset.bfFold;
          const folded = new Set(arr(store.read(foldKey, [])).map(String));
          if (folded.has(id)) folded.delete(id); else folded.add(id);
          store.write(foldKey, [...folded]);
          drawPanel(panel);
          refocus(`[data-bf-fold="${CSS.escape(id)}"]`);
          return;
        }
        const pick = event.target.closest('[data-bf-region-pick]');
        if (pick) {
          const id = pick.dataset.bfRegionPick;
          const inside = regionBranchIds(id);
          const current = ids();
          const all = inside.every((branchId) => current.includes(branchId));
          choose(all ? current.filter((branchId) => !inside.includes(branchId)) : [...current, ...inside]);
          refocus(`[data-bf-region-pick="${CSS.escape(id)}"]`);
          return;
        }
        if (event.target.closest('[data-bf-select-all]')) { choose(visibleIds()); refocus('[data-bf-select-all]'); return; }
        if (event.target.closest('[data-bf-none]')) { choose([]); refocus('[data-bf-none]'); }
      });
      panel.addEventListener('change', (event) => {
        const box = event.target.closest('[data-bf-branch]');
        if (!box) return;
        const id = box.dataset.bfBranch;
        choose(box.checked ? [...ids(), id] : ids().filter((branchId) => branchId !== id));
        refocus(`[data-bf-branch="${CSS.escape(id)}"]`);
      });
      panel.querySelector('[aria-pressed="true"], button')?.focus();
    }
    const unsubscribe = data.subscribe(() => paint());
    return {
      attach(next){ host = next; paint(); },
      matches,
      selection:() => ({ ...selection, ids:ids() }),
      destroy(){ unsubscribe(); layer?.close(); host?.replaceChildren(); host = null; }
    };
  }

  People.branches = { open, filter, manageable, writes, friendly, ensureStyles };
})();
