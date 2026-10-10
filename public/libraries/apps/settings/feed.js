(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const milestones = ['proposal.signed', 'contract.signed', 'project.event.completed'];
  const groups = [
    ['Common milestones', type => milestones.includes(type)],
    ['Photos and notes', type => /^(media|note)\./.test(type)],
    ['Projects and jobs', type => /^(project|crew|material|work|measurement)\./.test(type)],
    ['Proposals and documents', type => /^(proposal|document|contract)\./.test(type) && !type.includes('payment')],
    ['Payments and expenses', type => /^(payment|invoice|expense|receipt)\./.test(type) || type.includes('payment')],
    ['Communication and other activity', () => true]
  ];
  async function mount(host, { orgId, api = window.ChannelsAPI.feed } = {}) {
    const model = { draft:null, scope:'company', departments:[], options:[], defaults:[], changed:0, saved:0, saving:false, timer:null, error:'', dirty:new Map() };
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
    const render = () => {
      const remaining = new Set(model.options.map(option => option.type)), enabled = new Set(selected());
      const cards = groups.map(([label, matches]) => {
        const options = model.options.filter(option => remaining.has(option.type) && matches(option.type));
        options.forEach(option => remaining.delete(option.type));
        if (label === 'Common milestones') options.sort((a,b) => milestones.indexOf(a.type) - milestones.indexOf(b.type));
        if (!options.length) return '';
        return `<section class="cs-feed-card"><header><h4>${label}</h4>${label === 'Common milestones' ? '<p>Off by default. Turn on the milestones you want to share as posts.</p>' : ''}</header><div class="cs-feed-rows">${options.map(option => `<label class="cs-feed-row"><span>${escape(option.label)}</span><span class="li-switch"><input type="checkbox" data-feed-activity value="${escape(option.type)}" ${enabled.has(option.type) ? 'checked' : ''}><span class="li-slider"></span></span></label>`).join('')}</div></section>`;
      }).join('');
      host.innerHTML = `<style>
        .cs-feed-settings{max-width:1080px;display:grid;gap:16px;color:#344054}.cs-feed-settings h3{font-size:16px;margin:0 0 6px;color:#101828}.cs-feed-settings p{font-size:12px;line-height:1.5;color:#667085;margin:0}.cs-feed-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}.cs-feed-audience{display:grid;gap:6px;font-size:12px;font-weight:700}.cs-feed-audience select{min-width:250px;max-width:100%;padding:9px 12px;border:1px solid #d0d5dd;border-radius:8px;color:#344054;background:#fff;font:inherit}.cs-feed-actions{display:flex;gap:8px;flex-wrap:wrap}.cs-feed-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}.cs-feed-card{border:1px solid #e4e7ec;border-radius:12px;background:#fff;overflow:hidden}.cs-feed-card:first-child{grid-column:1/-1}.cs-feed-card header{padding:14px 16px;background:#f9fafb;border-bottom:1px solid #e4e7ec}.cs-feed-card h4{margin:0;font-size:13px;color:#101828}.cs-feed-card header p{margin-top:4px}.cs-feed-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;font-size:12px;cursor:pointer}.cs-feed-row+.cs-feed-row{border-top:1px solid #f2f4f7}.cs-feed-row>span:first-child{overflow-wrap:anywhere}.cs-feed-row .li-switch{flex-shrink:0}.cs-feed-status{display:flex;align-items:center;gap:10px;min-height:24px;font-size:12px;color:#667085}.cs-feed-status .error{color:#b42318}.cs-feed-settings [hidden]{display:none!important}.cs-feed-permissions{padding:12px 16px;border:1px solid #e4e7ec;border-radius:10px;background:#f9fafb}@media(max-width:700px){.cs-feed-grid{grid-template-columns:1fr}.cs-feed-card:first-child{grid-column:auto}.cs-feed-toolbar{align-items:stretch}.cs-feed-audience{width:100%}.cs-feed-audience select{min-width:0;width:100%}}
      </style><section class="cs-feed-settings" data-settings-autosave="off">
        <div><h3>Automatic posts</h3><p>Choose which activities appear in Posts for the company or a department. Changes save automatically. Team posts always appear.</p></div>
        <div class="cs-feed-toolbar"><label class="cs-feed-audience">Audience<select data-feed-board><option value="company">Everyone in the company</option>${model.departments.map(department => `<option value="${escape(department.id)}">${escape(department.label)}</option>`).join('')}</select></label><div class="cs-feed-actions"><button class="cs-btn" type="button" data-feed-defaults>Use defaults</button><button class="cs-btn" type="button" data-feed-all>Show all</button><button class="cs-btn" type="button" data-feed-none>Hide all</button></div></div>
        <div class="cs-feed-status"><span role="status" aria-live="polite" data-feed-status></span><button class="cs-btn" type="button" data-feed-retry hidden>Retry</button></div>
        <div class="cs-feed-grid">${cards}</div>
        <p class="cs-feed-permissions">Manage Feed, Activity, Posts, and All Departments permissions in Users → Roles &amp; access. Feed content always respects existing project and document access.</p>
      </section>`;
      host.querySelector('[data-feed-board]').value = model.scope;
      host.querySelector('[data-feed-board]').onchange = event => { model.scope = event.target.value; render(); };
      host.querySelectorAll('[data-feed-activity]').forEach(input => { input.onchange = () => update([...host.querySelectorAll('[data-feed-activity]:checked')].map(node => node.value)); });
      for (const [selector, types] of [['all', model.options.map(option => option.type)], ['none', []], ['defaults', model.defaults]]) host.querySelector(`[data-feed-${selector}]`).onclick = () => { update([...types]); render(); };
      host.querySelector('[data-feed-retry]').onclick = () => void save();
      status();
    };
    try {
      const result = await api.settings(orgId);
      model.draft = structuredClone(result.settings); model.draft.department_activity_types ||= {};
      model.departments = result.departments || []; model.options = result.activity_options || []; model.defaults = result.default_activity_types || ['media.uploaded','note.created','project.created','project.event_scheduled','crew.checklist.completed','payment.received'];
      render();
    } catch (error) { host.textContent = error?.message || 'Could not load Feed settings.'; }
    return { flush:save };
  }
  window.FirstMateFeedSettings = { mount };
})();
