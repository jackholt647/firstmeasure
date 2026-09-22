(function (root) {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const words = (value) => String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const json = (value) => JSON.stringify(value, null, 2);
  const active = (event) => event.connections.some((entry) => entry.enabled && entry.kind !== 'timer');
  function styles() {
    if (document.getElementById('scope-events-style')) return;
    const style = document.createElement('style');
    style.id = 'scope-events-style';
    style.textContent = `
      .se-root{--se-ink:#172b35;--se-muted:#637780;--se-line:#dfe8e9;--se-accent:#087f73;color:var(--se-ink);font-size:13px;line-height:1.5;min-width:0}
      .se-root *{box-sizing:border-box}.se-root button,.se-root input{font:inherit}.se-root button{cursor:pointer}.se-root button:focus-visible,.se-root summary:focus-visible,.se-root input:focus-visible{outline:3px solid #43bca7;outline-offset:3px}
      .se-summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--se-line)}.se-stats{display:flex;align-items:center;flex-wrap:wrap;gap:10px 22px}.se-stats>div{display:flex;align-items:baseline;gap:6px}.se-stats b{font-size:14px;font-weight:750;color:var(--se-ink)}.se-stats span,.se-version{font-size:11px;color:var(--se-muted)}.se-version{white-space:nowrap}
      .se-toolbar{display:flex;gap:14px;justify-content:space-between;align-items:center;margin:12px 0 14px;flex-wrap:wrap}.se-search{display:flex;align-items:center;gap:10px;flex:1;min-width:220px;max-width:470px;padding:11px 14px;background:#fff;border:1px solid var(--se-line);border-radius:11px;color:var(--se-muted)}.se-search input{border:0;outline:none;background:transparent;width:100%;color:var(--se-ink);font-size:12px}.se-filters{display:flex;gap:3px;padding:4px;border-radius:11px;background:#edf2f3;flex-wrap:wrap}.se-filters button{border:0;background:transparent;color:#52676e;border-radius:8px;padding:8px 11px;font-size:11px;font-weight:700;transition:background .18s,box-shadow .18s}.se-filters button[aria-pressed=true]{background:#fff;color:#076e63;box-shadow:0 2px 5px #173b3910}
      .se-workspace{display:grid;grid-template-columns:minmax(240px, .8fr) minmax(0,1.6fr);border:1px solid var(--se-line);border-radius:15px;background:#fff;overflow:hidden;min-height:440px}.se-index{border-right:1px solid var(--se-line);background:#f8fafb;min-width:0}.se-count{padding:14px 17px;border-bottom:1px solid var(--se-line);font-size:10px;color:var(--se-muted);text-transform:uppercase;font-weight:800;letter-spacing:.08em}.se-list{max-height:650px;overflow:auto;padding:8px}.se-item{width:100%;display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:9px;align-items:center;border:1px solid transparent;background:transparent;padding:12px 10px;border-radius:10px;text-align:left;margin-bottom:3px;transition:background .18s,border-color .18s,transform .18s;color:var(--se-ink)}.se-item:hover{background:#edf4f3;transform:translateX(2px)}.se-item[aria-pressed=true]{background:#e9f5f1;border-color:#b9ded4}.se-dot{display:grid;place-items:center;width:28px;height:28px;border:1px solid #d7e8e3;border-radius:8px;background:#fff;color:var(--se-accent);font-size:11px}.se-item.unused .se-dot{color:#8d9da3;border-color:var(--se-line)}.se-item strong{display:block;font-size:11px;font-weight:750;overflow-wrap:anywhere}.se-item small{display:block;color:var(--se-muted);font-size:9px;margin-top:3px;overflow-wrap:anywhere}.se-number{font-size:10px;color:#42786e;font-weight:800}.se-detail{padding:25px 28px;min-width:0;max-height:700px;overflow:auto;scroll-margin-top:15px}.se-detail h4{font-size:20px;letter-spacing:-.4px;margin:8px 0;color:var(--se-ink)}.se-detail p{color:var(--se-muted);font-size:12px;line-height:1.65;margin:7px 0 15px}.se-code{font:10px/1.5 Consolas,monospace;color:#71828a;overflow-wrap:anywhere}.se-badge{display:inline-flex;align-items:center;border:1px solid #dce8e4;background:#f0f8f5;color:#287668;border-radius:6px;font-size:9px;font-weight:750;padding:3px 7px;margin:0 5px 3px 0}.se-badge.muted{color:#697b84;background:#f5f7f8;border-color:var(--se-line)}.se-flow-label{display:flex;align-items:center;gap:9px;margin:23px 0 12px;font-size:10px;text-transform:uppercase;letter-spacing:.1em;font-weight:800;color:#5b7378}.se-flow-label:after{content:'';height:1px;flex:1;background:var(--se-line)}
      .se-effect{position:relative;margin:0 0 12px 10px;padding:15px 17px;border:1px solid var(--se-line);border-radius:12px;background:#fff;box-shadow:0 2px 5px #102e3510;animation:se-arrive .28s ease both}.se-effect:before{content:'';position:absolute;left:-11px;top:22px;width:10px;border-top:2px solid #b7d9d0}.se-effects{border-left:2px solid #c8e5dc;padding-left:9px;margin-left:5px}.se-effect h5{font-size:12px;line-height:1.5;margin:6px 0;color:#1e3b41;overflow-wrap:anywhere}.se-effect p{font-size:11px;margin:5px 0 10px}.se-location{font-size:9px;color:#6e8389;overflow-wrap:anywhere}.se-conditions{display:grid;gap:5px;margin:10px 0;padding:10px 12px;background:#faf8f1;border:1px solid #ede6d0;border-radius:8px;font-size:10px;color:#776533;overflow-wrap:anywhere}.se-conditions b{font-size:9px;letter-spacing:.08em;text-transform:uppercase}.se-root details{margin-top:10px}.se-root summary{cursor:pointer;font-size:10px;color:#5d727a;padding:4px 0}.se-root pre{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f7f8;border:1px solid var(--se-line);border-radius:8px;padding:12px;font:10px/1.7 Consolas,monospace;max-height:300px;overflow:auto}.se-params{margin:8px 0;display:grid;gap:7px}.se-param{padding:8px 10px;background:#f5f8f8;border-radius:7px;overflow-wrap:anywhere;font-size:10px}.se-param strong{display:block;margin-bottom:3px;color:#47646c}.se-param small{display:block;color:var(--se-muted);margin-top:4px}.se-empty{text-align:center;padding:45px 20px;color:var(--se-muted);font-size:12px}.se-empty i{display:block;font-size:23px;color:#9cb4b5;margin-bottom:14px}.se-empty strong{display:block;color:#35545b;margin-bottom:7px}.se-foot{font-size:10px;color:#73868d;margin:12px 2px}.se-link{border:0;border-radius:7px;background:#edf7f3;color:#087366;font-size:10px;padding:7px 9px;margin-top:7px}.se-loading{padding:50px;text-align:center;color:#617b83}.se-refresh{border:1px solid #c0d6d1;border-radius:8px;background:#fff;padding:8px 12px;color:#246c62}.se-root.restoring .se-effect{animation:none}
      .se-artifact-filter{border:1px solid var(--se-line);border-radius:9px;padding:9px;background:white;color:#526b75;font-size:11px}.se-highlight{border-color:#389d8d;box-shadow:0 0 0 2px #d2ece5}
      @keyframes se-arrive{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:translateY(0)}}
      @media(prefers-reduced-motion:reduce){.se-root *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
      @media(max-width:1000px){.se-workspace{grid-template-columns:minmax(210px,.8fr) minmax(0,1.3fr)}.se-detail{padding:20px}}
      @media(max-width:650px){.se-workspace{grid-template-columns:1fr}.se-index{border-right:0;border-bottom:1px solid var(--se-line)}.se-list{max-height:230px}.se-detail{max-height:none;padding:20px}.se-search{max-width:none}.se-summary{align-items:flex-start}.se-stats{gap:6px 14px}}
    `;
    document.head.appendChild(style);
  }
  function mount(host, options) {
    styles();
    const normalizeFilter = (value) => ['all', 'connected', 'unused', 'actions', 'documents', 'todos', 'events', 'materials', 'checklists', 'notifications'].includes(value) ? value : 'all';
    const state = { data:null, selected:options.selected || '', query:options.query || '', filter:options.rule ? 'all' : normalizeFilter(options.filter) };
    const restoring = !!root.Portal?.navigation?.applying;
    const setRoute = () => options.onFilter?.({ query:state.query, filter:state.filter });
    function conditions(value) {
      const entries = Object.entries(value || {});
      if (!entries.length) return '';
      return `<div class="se-conditions"><b>${(globalThis.PlatformLanguage?.text("settings","m_333c8778fb2533","Only when all match") ?? "Only when all match")}</b>${String(entries.map(([key, val]) => `<span>${esc(words(key))} ${Array.isArray(val) ? 'is any of' : val === '' ? 'is empty or missing' : 'equals'} ${val === '' ? '' : esc(Array.isArray(val) ? val.map(String).join(' or ') : String(val))}</span>`).join(''))}</div>`;
    }
    function parameters(input, help = {}) {
      return `<div class="se-params">${Object.entries(input || {}).map(([key, value]) => {
        const content = typeof value === 'object' ? json(value) : String(value ?? '');
        return `<div class="se-param"><strong>${esc(words(key))}</strong>${content.length > 180 || typeof value === 'object' ? `<details><summary>${((v0,v1) => globalThis.PlatformLanguage?.text("settings","m_8ba04c5a558237",`Inspect ${v0}${v1}`,{v0,v1}) ?? `Inspect ${v0}${v1}`)(esc(words(key).toLowerCase()),Array.isArray(value) ? ` · ${value.length} items` : '')}</summary><pre>${String(esc(content))}</pre></details>` : esc(content)}${help[key] ? `<small>${esc(help[key])}</small>` : ''}</div>`;
      }).join('')}</div>`;
    }
    function connection(entry, index) {
      return `<article class="se-effect ${String(options.rule === entry.id ? 'se-highlight' : '')}" data-se-rule="${String(esc(entry.id))}" style="animation-delay:${String(Math.min(index, 5) * 35)}ms"><span class="se-badge ${String(entry.source === 'Organization rule' ? 'muted' : '')}">${String(esc(entry.source))}</span>${String(!entry.enabled ? '<span class="se-badge muted">Inactive</span>' : '')}${String(entry.registered === false ? '<span class="se-badge muted">Handler unavailable</span>' : '')}<span class="se-location">${String(esc(entry.location))}</span><h5>${String(esc(entry.label))}</h5><p>${String(esc(entry.description))}</p><div class="se-location">${String(esc(entry.when))}</div>${String(conditions(entry.conditions))}${String(parameters(entry.input, entry.input_help))}${String((entry.artifacts || []).map(artifact => `<button type="button" class="se-link" data-se-artifact="${esc(artifact.id)}">${esc(artifact.title)} <i class="fas fa-arrow-up-right-from-square"></i></button>`).join(' '))}${String(entry.next_event ? `<button type="button" class="se-link" data-se-jump="${esc(entry.next_event)}">Explore resulting event <i class="fas fa-arrow-right"></i></button>` : '')}<details><summary>${((v15) => globalThis.PlatformLanguage?.text("settings","m_d478b64a3abdaa",`Technical details${v15}`,{v15}) ?? `Technical details${v15}`)(entry.automation ? ` · ${esc(entry.automation)}` : '')}</summary>${String(entry.note ? `<p>${esc(entry.note)}</p>` : '')}${String(entry.kind === 'action' ? `<p>On failure: ${entry.continue_on_error ? 'continue to the next action' : 'stop this execution'}.</p>` : '')}<pre>${String(esc(json(entry.raw)))}</pre></details></article>`;
    }
    function renderDetail() {
      const target = host.querySelector('[data-se-detail]');
      const library = state.filter === 'actions';
      const selected = (library ? state.data.actions : state.data.events).find((entry) => (entry.name || entry.id) === state.selected);
      if (!selected) { target.innerHTML = `<div class="se-empty"><i class="fas fa-magnifying-glass"></i><strong>${(globalThis.PlatformLanguage?.text("settings","m_e6261fd56b82c2","No matches") ?? "No matches")}</strong>${(globalThis.PlatformLanguage?.text("settings","m_f7fa7507e17f50","Try an event, action, work item, condition, or parameter.") ?? "Try an event, action, work item, condition, or parameter.")}</div>`; return; }
      const connections = library ? state.data.events.flatMap((event) => event.connections.filter((entry) => entry.automation === selected.id).map((entry) => ({ ...entry, event }))) : selected.connections.filter(entry => ['all','connected','unused','actions'].includes(state.filter) || (entry.artifacts || []).some(a => a.type === state.filter));
      target.innerHTML = `<span class="se-badge">${library ? 'Action library' : active(selected) ? 'Connected event' : 'Unused in this scope'}</span>${!library ? `<span class="se-badge muted">${selected.visibility === 'system' ? 'System event' : 'Activity event'}</span>` : ''}<h4>${esc(selected.label)}</h4><div class="se-code">${esc(selected.name || selected.id)}</div><p>${esc(selected.description || 'No description has been registered for this action.')}</p>${!library && selected.payload ? `<details><summary>${(globalThis.PlatformLanguage?.text("settings","m_cbf3fa7572e581","Information this event carries") ?? "Information this event carries")}</summary>${String(parameters(selected.payload))}</details>` : ''}${library ? `<details open><summary>${(globalThis.PlatformLanguage?.text("settings","m_960accea84e9cf","Available parameters") ?? "Available parameters")}</summary>${String(Object.keys(selected.input || {}).length ? parameters(selected.input) : '<p>No parameters are documented for this action.</p>')}</details>` : ''}<div class="se-flow-label">${library ? 'Events that use this action' : 'What happens next'} <span>${connections.length}</span></div>${connections.length ? `<div class="se-effects">${connections.map((entry, i) => library ? `<article class="se-effect"><span class="se-badge">${String(esc(entry.source))}</span><h5>${String(esc(entry.event.label))}</h5><div class="se-location">${String(esc(entry.location))}</div><p>${String(esc(entry.when))}</p>${String(!entry.enabled ? '<span class="se-badge muted">Inactive</span>' : '')}${String(conditions(entry.conditions))}<button type="button" class="se-link" data-se-jump="${String(esc(entry.event.name))}">${(globalThis.PlatformLanguage?.text("settings","m_a7db3b01b06838","View event ") ?? "View event ")}<i class="fas fa-arrow-right"></i></button></article>` : connection(entry, i)).join('')}</div>` : `<div class="se-empty"><i class="fas fa-plug"></i><strong>${library ? 'Available to connect' : 'No actions connected'}</strong>${library ? 'This registered action is available for future scope behavior.' : 'This event has no configured responses here. It remains available for future scope behavior.'}</div>`}`;
      target.querySelectorAll('[data-se-artifact]').forEach(button => button.addEventListener('click', () => { const artifact = state.data.artifacts?.find(a => a.id === button.dataset.seArtifact); if (artifact) options.onArtifact?.(artifact); }));
      target.querySelectorAll('[data-se-jump]').forEach((button) => button.addEventListener('click', () => {
        state.filter = 'all'; state.query = ''; state.selected = button.dataset.seJump;
        host.querySelector('input').value = ''; setRoute(); renderResults();
      }));
    }
    function renderResults() {
      const library = state.filter === 'actions';
      const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
      const relevance = (entry) => {
        const title = `${entry.label} ${words(entry.name || entry.id)}`.toLowerCase();
        return terms.length && terms.every((term) => title.includes(term)) ? 1 : 0;
      };
      const entries = (library ? state.data.actions : state.data.events).filter((entry) => {
        if (!library && state.filter === 'connected' && !active(entry)) return false;
        if (!library && state.filter === 'unused' && active(entry)) return false;
        if (!['all','connected','unused','actions'].includes(state.filter) && !entry.connections.some(c => (c.artifacts || []).some(a => a.type === state.filter))) return false;
        const haystack = `${json(entry)} ${words(json(entry))}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      }).sort((a, b) => relevance(b) - relevance(a) || (!library && active(a) !== active(b) ? Number(active(b)) - Number(active(a)) : a.label.localeCompare(b.label)));
      if (!entries.some((entry) => (entry.name || entry.id) === state.selected)) state.selected = entries[0]?.name || entries[0]?.id || '';
      host.querySelector('[data-se-count]').textContent = `${entries.length} ${library ? 'available actions' : 'events'}${state.query ? ' matching search' : ''}`;
      host.querySelectorAll('[data-se-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.seFilter === state.filter)));
      host.querySelector('[data-se-list]').innerHTML = entries.map((entry) => `<button type="button" class="se-item ${!library && !active(entry) ? 'unused' : ''}" data-se-select="${esc(entry.name || entry.id)}" aria-pressed="${state.selected === (entry.name || entry.id)}"><span class="se-dot"><i class="fas ${library ? 'fa-cube' : active(entry) ? 'fa-bolt' : 'fa-circle-dot'}"></i></span><span><strong>${esc(entry.label)}</strong><small>${esc(entry.name || entry.id)}</small></span><span class="se-number">${library ? '' : entry.connections.filter((c) => c.enabled && c.kind !== 'timer').length || '—'}</span></button>`).join('') || `<div class="se-empty">${(globalThis.PlatformLanguage?.text("settings","m_f0bf92bd9e9fb2","No matching results.") ?? "No matching results.")}</div>`;
      host.querySelectorAll('[data-se-select]').forEach((button) => button.addEventListener('click', () => {
        state.selected = button.dataset.seSelect;
        host.querySelectorAll('[data-se-select]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
        renderDetail();
      }));
      const artifactFilter = host.querySelector('.se-artifact-filter');
      if (artifactFilter) artifactFilter.value = ['documents','todos','events','materials','checklists','notifications'].includes(state.filter) ? state.filter : 'all';
      renderDetail();
    }
    async function load() {
      host.innerHTML = `<div class="se-root"><div class="se-loading" role="status"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.text("settings","m_a0f63fc0fb410e"," Loading scope automations…") ?? " Loading scope automations…")}</div></div>`;
      try {
        const data = await root.PlatformAPI.scopes.eventMap(options.orgId, options.branchId, options.templateId);
        if (!host.isConnected) return;
        state.data = data;
        const connected = data.events.filter(active).length;
        host.innerHTML = `<div class="se-root ${String(restoring ? 'restoring' : '')}"><header class="se-summary" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_e81a759b743902","Automation counts") ?? "Automation counts")}"><div class="se-stats"><div><b>${String(connected)}</b><span>${(globalThis.PlatformLanguage?.text("settings","m_e4c9178df1505c","Connected triggers") ?? "Connected triggers")}</span></div><div><b>${String(data.events.length - connected)}</b><span>${(globalThis.PlatformLanguage?.text("settings","m_9a686ac46897b7","Unused triggers") ?? "Unused triggers")}</span></div><div><b>${String(data.actions.length)}</b><span>${(globalThis.PlatformLanguage?.text("settings","m_aa5bad2054c313","Available actions") ?? "Available actions")}</span></div></div><span class="se-version">${((v4) => globalThis.PlatformLanguage?.text("settings","m_ca9be6def3a22d",`Version ${v4}`,{v4}) ?? `Version ${v4}`)(esc(data.template.version))}</span></header><div class="se-toolbar"><label class="se-search"><i class="fas fa-magnifying-glass"></i><input type="search" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_2f51c5b2f71a72","Search events, triggers, actions and parameters") ?? "Search events, triggers, actions and parameters")}" placeholder="${(globalThis.PlatformLanguage?.text("settings","m_c531740518efef","Search events, triggers, actions, parameters…") ?? "Search events, triggers, actions, parameters…")}" value="${String(esc(state.query))}"></label><div class="se-filters" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_f9d59941fe9a3d","Filter event explorer") ?? "Filter event explorer")}">${String([['all','All triggers'],['connected','Connected'],['unused','Unused'],['actions','Action library']].map(([id, label]) => `<button type="button" data-se-filter="${id}" aria-pressed="${state.filter === id}">${label}</button>`).join(''))}</div><select class="se-artifact-filter" aria-label="${(globalThis.PlatformLanguage?.text("settings","m_77219b0ffd968c","Filter automations by artifact") ?? "Filter automations by artifact")}"><option value="all">${(globalThis.PlatformLanguage?.text("settings","m_0465209ce4ab24","All artifact types") ?? "All artifact types")}</option>${String(['documents','todos','events','materials','checklists','notifications'].map(type => `<option value="${type}" ${state.filter===type ? 'selected' : ''}>${type==='events' ? 'Calendar events' : type==='todos' ? 'To-dos' : words(type)}</option>`).join(''))}</select></div><div class="se-workspace"><aside class="se-index"><div class="se-count" data-se-count role="status" aria-live="polite"></div><div class="se-list" data-se-list></div></aside><section class="se-detail" data-se-detail aria-label="${(globalThis.PlatformLanguage?.text("settings","m_30ae1fe6479216","Event details") ?? "Event details")}"></section></div><p class="se-foot">${String(options.dirty ? 'Unsaved changes are not shown.' : '')}</p></div>`;
        host.querySelector('input').addEventListener('input', (event) => { state.query = event.target.value; state.selected = ''; renderResults(); });
        host.querySelectorAll('[data-se-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.seFilter; setRoute(); renderResults(); }));
        host.querySelector('.se-artifact-filter').addEventListener('change', event => { state.filter = event.target.value; setRoute(); renderResults(); });
        renderResults();
      } catch (error) {
        if (!host.isConnected) return;
        host.innerHTML = `<div class="se-root"><div class="se-empty" role="alert"><strong>${(globalThis.PlatformLanguage?.text("settings","m_b21abc27017483","Could not load scope automations") ?? "Could not load scope automations")}</strong>${String(esc(error?.message || 'Please try again.'))}<p><button type="button" class="se-refresh">${(globalThis.PlatformLanguage?.text("settings","m_ef39ad5e614a24","Try again") ?? "Try again")}</button></p></div></div>`;
        host.querySelector('button').addEventListener('click', load);
      }
    }
    root.Portal?.navigation?.registerHandler?.(`scope-events-filter-${options.orgId}-${options.branchId}-${options.templateId}`, {
      priority:1300,
      match:(route) => host.isConnected && route.sub === 'project_scopes' && route.settingsEntity === `scope:${options.templateId}` && route.scopeTemplateView === 'automations',
      apply:(route) => {
        const filter = normalizeFilter(route.scopeEventFilter);
        const selected = route.scopeEventFocus || '';
        const rule = route.scopeAutomation || '';
        if (state.filter !== filter || selected && state.selected !== selected || options.rule !== rule) { state.filter = filter; if (selected) state.selected = selected; options.rule = rule; if (state.data) renderResults(); }
      }
    });
    load();
  }
  root.FirstMateScopeEvents = { mount };
})(window);
