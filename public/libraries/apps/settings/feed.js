(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const groups = [
    ['workflow','Scope and tasks','fa-diagram-project',type=>/^work\./.test(type)],
    ['documents','Documents and signatures','fa-file-lines',type=>/^(proposal|document|contract)\./.test(type)&&!type.includes('payment')],
    ['scheduling','Scheduling','fa-calendar',type=>/^(project\.event|recurrence\.)/.test(type)],
    ['files','Photos and notes','fa-images',type=>/^(media|note)\./.test(type)],
    ['projects','Projects','fa-briefcase',type=>/^project\./.test(type)],
    ['payments','Payments and expenses','fa-credit-card',type=>/^(payment|invoice|expense|receipt|payroll)\./.test(type)||type.includes('payment')],
    ['operations','Work and reports','fa-list-check',type=>/^(crew|material|measurement)\./.test(type)],
    ['other','Communication and other activity','fa-comment',()=>true]
  ];
  const term = (key, fallback) => window.PlatformTerminology?.get?.(key,fallback) || window.Portal?.terminology?.get?.(key,fallback) || fallback;
  const optionLabel = option => option.label.replace(/\b(Proposal|Document|Project|Scope|Stage|Invoice|Receipt|Material)\b/g,word=>term(({Proposal:'proposals.proposal',Document:'documents.document',Project:'projects.project',Scope:'scope.scope',Stage:'projects.stage',Invoice:'money.invoice',Receipt:'receipts.receipt',Material:'materials.material'})[word],word));
  async function mount(host, { orgId, api = window.ChannelsAPI.feed } = {}) {
    const model = { draft:null, scope:'company', category:'all', query:'', departments:[], options:[], defaults:[], changed:0, saved:0, saving:false, timer:null, error:'', dirty:new Map() };
    host.innerHTML = '<p role="status">Loading Feed settings…</p>';
    const status = () => {
      const target = host.querySelector('[data-feed-status]');
      if (!target) return;
      target.textContent = model.error || (model.saving || model.changed > model.saved ? 'Saving…' : 'All changes saved');
      target.classList.toggle('error', !!model.error);
      host.querySelector('[data-feed-retry]').hidden = !model.error;
    };
    const selected = () => {
      const value = model.scope === 'company' ? model.draft.company_activity_types : model.draft.department_activity_types[model.scope];
      return Array.isArray(value) ? value : model.defaults;
    };
    const save = async () => {
      clearTimeout(model.timer);
      if (model.saving || model.changed === model.saved) return;
      model.saving = true; model.error = ''; status();
      const version = model.changed, snapshot = structuredClone(model.draft), dirty = new Map(model.dirty);
      try {
        let result;
        try { result = await api.saveSettings(orgId, snapshot); }
        catch (error) {
          if (!/stale|changed|409/i.test(`${error?.code || ''} ${error?.message || ''} ${error?.status || ''}`)) throw error;
          // Preserve another manager's edits to untouched audiences on a revision conflict.
          const latest = (await api.settings(orgId)).settings;
          if (dirty.has('company')) latest.company_activity_types = snapshot.company_activity_types;
          for (const [scope] of dirty) if (scope !== 'company') latest.department_activity_types[scope] = snapshot.department_activity_types[scope];
          result = await api.saveSettings(orgId, latest);
        }
        const pending = structuredClone(model.draft);
        model.draft = structuredClone(result.settings);
        for (const [scope, changedAt] of model.dirty) if (changedAt <= version) model.dirty.delete(scope);
        if (model.changed !== version) {
          if (model.dirty.has('company')) model.draft.company_activity_types = pending.company_activity_types;
          for (const [scope] of model.dirty) if (scope !== 'company') model.draft.department_activity_types[scope] = pending.department_activity_types[scope];
        } else model.dirty.clear();
        model.saved = version;
        window.dispatchEvent(new CustomEvent('firstmate:feed-settings-saved', { detail:{orgId, settings:result.settings} }));
      } catch (error) { model.error = error?.message || 'Could not save changes. Try again.'; }
      finally {
        model.saving = false; status();
        if (!model.error && model.changed > model.saved) void save();
      }
    };
    const update = types => {
      if (model.scope === 'company') model.draft.company_activity_types = types;
      else model.draft.department_activity_types[model.scope] = types;
      model.changed++; model.dirty.set(model.scope, model.changed); model.error = '';
      clearTimeout(model.timer); model.timer = setTimeout(save, 350); status();
    };
    const render = (focusType = '') => {
      const previousSearch = host.querySelector('[data-feed-search]');
      const restoreSearch = previousSearch === document.activeElement;
      const restoreAudience = host.querySelector('[data-feed-board]') === document.activeElement;
      const restoreCategory = document.activeElement?.dataset?.feedCategory;
      const cursor = previousSearch?.selectionStart;
      const remaining = new Set(model.options.map(option => option.type)), enabled = new Set(selected());
      const query = model.query.trim().toLocaleLowerCase();
      const categories = groups.map(([id,label,icon,matches]) => {
        const options = model.options.filter(option => remaining.has(option.type) && matches(option.type));
        options.forEach(option => remaining.delete(option.type));
        if (id === 'workflow') label = `${term('scope.scope','Scope')} and tasks`;
        if (id === 'projects') label = term('projects.projects','Projects');
        if (id === 'documents') label = `${term('documents.documents','Documents')} and signatures`;
        return {id,label,icon,options};
      }).filter(category => category.options.length);
      const count = options => options.filter(option => enabled.has(option.type)).length;
      const nav = [{id:'all',label:'All activity',icon:'fa-layer-group',options:model.options},...categories];
      let visibleCount = 0;
      const cards = categories.filter(category => model.category === 'all' || category.id === model.category).map(category => {
        const options = category.options.filter(option => !query || `${optionLabel(option)} ${option.description || ''}`.toLocaleLowerCase().includes(query));
        visibleCount += options.length;
        if (!options.length) return '';
        return `<section class="cs-feed-card"><header><h4><i class="fas ${category.icon}" aria-hidden="true"></i>${escape(category.label)}</h4><span>${count(category.options)} of ${category.options.length} enabled</span></header><div class="cs-feed-rows">${options.map(option => `<label class="cs-feed-row"><span class="cs-feed-row-copy"><strong>${escape(optionLabel(option))}</strong>${option.description ? `<small>${escape(option.description)}</small>` : ''}</span><span class="li-switch"><input type="checkbox" data-feed-activity value="${escape(option.type)}" aria-label="${escape(optionLabel(option))}" ${enabled.has(option.type) ? 'checked' : ''}><span class="li-slider"></span></span></label>`).join('')}</div></section>`;
      }).join('');
      host.innerHTML = `<style>
        .cs-feed-settings{width:100%;min-width:0;display:grid;gap:20px;color:#344054;font-family:inherit;box-sizing:border-box}.cs-feed-settings *{box-sizing:border-box}.cs-feed-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.cs-feed-heading h3{font-size:18px;font-weight:900;margin:0 0 6px;color:#101828}.cs-feed-settings p{font-size:13px;line-height:1.5;color:#667085;margin:0}.cs-feed-status{display:flex;align-items:center;gap:8px;min-height:30px;font-size:12px;color:#667085}.cs-feed-status:before{content:'';width:6px;height:6px;border-radius:50%;background:#12b76a;flex:none}.cs-feed-status:has(.error):before{background:#f04438}.cs-feed-status .error{color:#b42318}.cs-feed-settings [hidden]{display:none!important}.cs-feed-controls{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;padding:16px;border:1px solid #e4e7ec;border-radius:14px;background:#f9fafb}.cs-feed-field{display:grid;gap:6px;min-width:0;font-size:11px;font-weight:800;color:#667085}.cs-feed-field:first-child{flex:0 1 270px}.cs-feed-field.cs-feed-search{flex:1 1 220px}.cs-feed-field input,.cs-feed-field select{width:100%;height:38px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;padding:0 11px;font:inherit;font-size:13px;font-weight:500;color:#101828;outline:none}.cs-feed-field input:focus,.cs-feed-field select:focus{border-color:rgba(var(--primary-rgb,217,48,37),.5);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.1)}.cs-feed-actions{display:flex;gap:6px;flex-wrap:wrap}.cs-feed-actions .cs-btn,.cs-feed-status .cs-btn{min-height:38px;font:inherit;font-size:12px;white-space:nowrap}.cs-feed-body{display:grid;grid-template-columns:210px minmax(0,1fr);gap:22px;align-items:start}.cs-feed-categories{display:grid;gap:4px;position:sticky;top:0;min-width:0}.cs-feed-category{display:flex;align-items:center;gap:10px;width:100%;padding:11px 10px;border:0;border-radius:10px;background:transparent;color:#475467;text-align:left;font:inherit;font-size:12px;font-weight:650;cursor:pointer}.cs-feed-category>i{width:16px;text-align:center;color:#98a2b3;flex:none}.cs-feed-category>span{flex:1;min-width:0;line-height:1.35}.cs-feed-category small{font-size:10px;font-weight:600;color:#667085;white-space:nowrap}.cs-feed-category:hover{background:#f2f4f7}.cs-feed-category[aria-pressed=true]{background:rgba(var(--primary-rgb,217,48,37),.08);color:rgb(var(--primary-rgb,217,48,37))}.cs-feed-category[aria-pressed=true]>i{color:inherit}.cs-feed-category:focus-visible{outline:2px solid rgba(var(--primary-rgb,217,48,37),.5);outline-offset:2px}.cs-feed-grid{display:grid;gap:16px;min-width:0}.cs-feed-card{border:1px solid #e4e7ec;border-radius:14px;background:#fff;overflow:hidden;min-width:0}.cs-feed-card header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid #e4e7ec;background:#fcfcfd}.cs-feed-card h4{display:flex;align-items:center;gap:9px;margin:0;font-size:13px;font-weight:800;color:#101828}.cs-feed-card h4 i{color:#98a2b3}.cs-feed-card header>span{font-size:11px;color:#667085;white-space:nowrap}.cs-feed-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:14px 16px;cursor:pointer}.cs-feed-row:hover{background:#fafbfc}.cs-feed-row+.cs-feed-row{border-top:1px solid #f2f4f7}.cs-feed-row-copy{min-width:0;display:grid;gap:4px;overflow-wrap:anywhere}.cs-feed-row-copy strong{font-size:13px;line-height:1.4;font-weight:650;color:#344054}.cs-feed-row-copy small{font-size:12px;line-height:1.5;color:#667085}.cs-feed-row .li-switch{flex-shrink:0}.cs-feed-row input:focus-visible+.li-slider{outline:2px solid rgba(var(--primary-rgb,217,48,37),.5);outline-offset:3px}.cs-feed-empty{padding:40px 20px;text-align:center;border:1px dashed #d0d5dd;border-radius:14px}.cs-feed-empty strong{display:block;color:#344054;font-size:14px;margin-bottom:6px}.cs-feed-empty button{margin-top:14px}.cs-feed-footer{border-top:1px solid #e4e7ec;padding-top:14px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.cs-feed-footer p{font-size:12px}.cs-feed-footer strong{font-weight:650;color:#475467}@media(max-width:900px){.cs-feed-body{grid-template-columns:170px minmax(0,1fr);gap:14px}.cs-feed-controls{gap:12px}.cs-feed-actions{width:100%}}@media(max-width:640px){.cs-feed-heading{gap:6px}.cs-feed-body{grid-template-columns:minmax(0,1fr);gap:12px}.cs-feed-categories{position:static;display:flex;overflow-x:auto;padding-bottom:4px;gap:6px}.cs-feed-category{width:auto;flex:none;border:1px solid #e4e7ec;padding:9px 11px}.cs-feed-category>span{white-space:nowrap}.cs-feed-category small{display:none}.cs-feed-category>i{display:none}.cs-feed-controls{padding:12px}.cs-feed-field:first-child,.cs-feed-field.cs-feed-search{flex:1 1 100%}.cs-feed-card header{padding:12px}.cs-feed-card h4{font-size:12px}.cs-feed-row{padding:12px;gap:12px}.cs-feed-row-copy strong{font-size:12px}.cs-feed-row-copy small{font-size:11px}.cs-feed-footer{gap:8px}}
      </style><section class="cs-feed-settings" data-settings-autosave="off">
        <div class="cs-feed-heading"><div><h3>Automatic posts</h3><p>These settings control which activity automatically appears in the posts view. List and thumbnail views always include all activity. Posts submitted manually always appear in posts view.</p></div><div class="cs-feed-status"><span role="status" aria-live="polite" data-feed-status></span><button class="cs-btn" type="button" data-feed-retry hidden>Retry</button></div></div>
        <div class="cs-feed-controls"><label class="cs-feed-field">Audience<select data-feed-board><option value="company">Everyone in the company</option>${model.departments.map(department => `<option value="${escape(department.id)}">${escape(department.label)}</option>`).join('')}</select></label><label class="cs-feed-field cs-feed-search">Find activity<input type="search" data-feed-search placeholder="Search activity…" value="${escape(model.query)}" autocomplete="off"></label><div class="cs-feed-actions"><button class="cs-btn" type="button" data-feed-defaults>Use defaults</button><button class="cs-btn" type="button" data-feed-all>Enable all</button><button class="cs-btn" type="button" data-feed-none>Disable all</button></div></div>
        <div class="cs-feed-body"><nav class="cs-feed-categories" aria-label="Activity categories">${nav.map(category=>`<button class="cs-feed-category" type="button" data-feed-category="${category.id}" aria-pressed="${model.category===category.id}"><i class="fas ${category.icon}" aria-hidden="true"></i><span>${escape(category.label)}</span><small>${count(category.options)}/${category.options.length}</small></button>`).join('')}</nav><div class="cs-feed-grid">${cards || `<div class="cs-feed-empty"><strong>No matching activity</strong><p>Try a different search or category.</p>${query ? '<button class="cs-btn" type="button" data-feed-clear>Clear search</button>' : ''}</div>`}</div></div>
        <div class="cs-feed-footer"><p><strong>${count(model.options)} of ${model.options.length} enabled</strong>${query ? ` · ${visibleCount} search results` : ''} · Changes save automatically</p><p>Feed permissions are managed in Users → Roles &amp; access.</p></div>
      </section>`;
      host.querySelector('[data-feed-board]').value = model.scope;
      host.querySelector('[data-feed-board]').onchange = event => { model.scope = event.target.value; render(); };
      host.querySelector('[data-feed-search]').oninput = event => { model.query = event.target.value; render(); };
      host.querySelectorAll('[data-feed-category]').forEach(button => { button.onclick = () => { model.category = button.dataset.feedCategory; render(); }; });
      host.querySelector('[data-feed-clear]')?.addEventListener('click', () => { model.query = ''; render(); });
      host.querySelectorAll('[data-feed-activity]').forEach(input => { input.onchange = () => {
        const next = new Set(selected());
        if (input.checked) next.add(input.value); else next.delete(input.value);
        update([...next]); render(input.value);
      }; });
      for (const [selector, types] of [['all', model.options.map(option => option.type)], ['none', []], ['defaults', model.defaults]]) host.querySelector(`[data-feed-${selector}]`).onclick = () => { update([...types]); render(); };
      host.querySelector('[data-feed-retry]').onclick = () => void save();
      status();
      if (restoreSearch) { const input = host.querySelector('[data-feed-search]'); input.focus(); if (cursor !== null) input.setSelectionRange(cursor,cursor); }
      else if (focusType) [...host.querySelectorAll('[data-feed-activity]')].find(input=>input.value===focusType)?.focus({preventScroll:true});
      else if (restoreAudience) host.querySelector('[data-feed-board]').focus({preventScroll:true});
      else if (restoreCategory) [...host.querySelectorAll('[data-feed-category]')].find(button=>button.dataset.feedCategory===restoreCategory)?.focus({preventScroll:true});
    };

    try {
      const result = await api.settings(orgId);
      model.draft = structuredClone(result.settings); model.draft.department_activity_types ||= {};
      model.departments = result.departments || []; model.options = result.activity_options || []; model.defaults = result.default_activity_types || ['media.uploaded','note.created','project.created','project.event_scheduled','crew.checklist.completed','payment.received'];
      render();
    } catch (error) { host.textContent = error?.message || 'Could not load Feed settings.'; }
    window.addEventListener('fm:terminology:updated', () => { if (host.isConnected && model.draft) render(); });
    return { flush:save };
  }
  window.FirstMateFeedSettings = { mount };
})();
