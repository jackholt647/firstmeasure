/* Form widgets: the live form preview and the submissions view.
 *
 * Both are registered platform widgets, so the assistant can place them beside
 * a conversation, and both are what the form editor itself mounts: the editor's
 * preview and Submissions tab are these same renderers, fed the open draft.
 *
 *   FirstMateFormsWidgets.mountPreview(el, { orgId, formId })                 // follows the saved draft
 *   FirstMateFormsWidgets.mountPreview(el, { orgId, definition, name })       // driven by an editor
 *   FirstMateFormsWidgets.mountSubmissions(el, { orgId, formId, openProject })
 */
(function(global){
  'use strict';
  if (global.FirstMateFormsWidgets) return;
  const base = new URL('./', document.currentScript.src);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clean = (value) => String(value ?? '').trim();
  const STATUS = { live: ['Live', 'ok'], draft: ['Draft', 'muted'], paused: ['Paused', 'warn'] };

  function styles(){
    if (document.getElementById('fmFormsWidgetsCss')) return;
    const style = document.createElement('style');
    style.id = 'fmFormsWidgetsCss';
    style.textContent = `
      .ffw,.ffw *{box-sizing:border-box}
      .ffw{height:100%;min-height:0;display:flex;flex-direction:column;border:1px solid #e4e7ec;border-radius:16px;background:#f3f5f8;overflow:hidden;color:#17212b;font-size:13px}
      .ffw-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;background:#fff;border-bottom:1px solid #e4e7ec;font-size:11.5px;font-weight:850;color:#475467;flex:0 0 auto}
      .ffw-title{display:flex;align-items:center;gap:8px;min-width:0}.ffw-title b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#101828;font-size:12.5px}
      .ffw-tools{display:flex;gap:8px;align-items:center;flex:0 0 auto}
      .ffw-seg{display:inline-flex;border:1px solid #e4e7ec;border-radius:9px;overflow:hidden}.ffw-seg button{appearance:none;border:0;background:#fff;padding:6px 11px;font:850 11.5px/1 inherit;color:#667085;cursor:pointer;transition:background .15s,color .15s}.ffw-seg button.on{background:#101828;color:#fff}
      .ffw-btn{appearance:none;border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:9px;height:30px;padding:0 10px;font:850 11.5px/1 inherit;display:inline-flex;align-items:center;gap:6px;cursor:pointer}.ffw-btn:hover{background:#f9fafb}
      .ffw-stage{flex:1;min-height:0;overflow-y:auto;padding:20px 16px 32px}.ffw-stage>div{transition:max-width .25s ease;margin:0 auto}.ffw-stage.phone>div{max-width:390px}
      .ffw-pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:10.5px;font-weight:850;white-space:nowrap}
      .ffw-pill.ok{background:#ecfdf3;color:#067647}.ffw-pill.muted{background:#f2f4f7;color:#475467}.ffw-pill.warn{background:#fffaeb;color:#b54708}.ffw-pill.info{background:#eff8ff;color:#175cd3}
      .ffw-note{padding:28px 20px;text-align:center;color:#667085;font-weight:700;line-height:1.5}
      .ffw-pick{display:grid;gap:8px;padding:16px}.ffw-pick button{appearance:none;text-align:left;border:1px solid #e4e7ec;border-radius:11px;background:#fff;padding:11px 13px;font:inherit;cursor:pointer;display:flex;justify-content:space-between;gap:10px;align-items:center}.ffw-pick button:hover{border-color:#98a2b3}
      .ffs{background:#fff;border:1px solid #e4e7ec;border-radius:16px;padding:16px;display:grid;gap:16px;color:#17212b;font-size:13px;min-width:0}
      .ffs,.ffs *{box-sizing:border-box}
      .ffs-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.ffs-head h4{margin:0;font-size:14px}
      .ffs-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
      .ffs-tile{border:1px solid #eaecf0;border-radius:12px;padding:12px;background:#fcfcfd}.ffs-tile small{display:block;font-size:10.5px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#667085}.ffs-tile strong{display:block;margin-top:5px;font-size:21px;line-height:1.1}.ffs-tile span{display:block;margin-top:3px;font-size:11.5px;color:#667085}
      .ffs h5{margin:0 0 8px;font-size:11px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#667085}
      .ffs-days{display:flex;align-items:flex-end;gap:3px;height:74px}.ffs-days i{flex:1;min-width:2px;border-radius:3px 3px 0 0;background:#d0d5dd;position:relative;transition:height .3s ease}.ffs-days i b{position:absolute;left:0;right:0;bottom:0;border-radius:3px 3px 0 0;background:var(--primary-readable,var(--primary,#d93025))}
      .ffs-axis{display:flex;justify-content:space-between;font-size:10.5px;color:#98a2b3;margin-top:4px}
      .ffs-legend{display:flex;gap:12px;font-size:11px;color:#667085;margin-top:6px}.ffs-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;background:#d0d5dd}.ffs-legend i.s{background:var(--primary-readable,var(--primary,#d93025))}
      .ffs-bars{display:grid;gap:7px}.ffs-bar{display:grid;grid-template-columns:minmax(90px,34%) minmax(0,1fr) 44px;gap:10px;align-items:center;font-size:12px}
      .ffs-bar span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ffs-bar div{height:9px;border-radius:99px;background:#f2f4f7;overflow:hidden}.ffs-bar div i{display:block;height:100%;border-radius:99px;background:var(--primary-readable,var(--primary,#d93025));transition:width .35s ease}.ffs-bar b{text-align:right;font-weight:800}
      .ffs-q{border:1px solid #eaecf0;border-radius:12px;padding:12px}.ffs-q>b{display:block;font-size:12.5px;margin-bottom:8px}.ffs-q>small{color:#667085}
      .ffs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
      .ffs-table{width:100%;border-collapse:collapse;font-size:12.5px}.ffs-table th{font-size:10.5px;font-weight:900;letter-spacing:.05em;text-transform:uppercase;color:#667085;text-align:left;padding:8px 10px;border-bottom:1px solid #e4e7ec}.ffs-table td{padding:10px;border-bottom:1px solid #f0f2f5;vertical-align:top}.ffs-table td small{display:block;color:#667085;margin-top:2px}
      .ffs-scroll{overflow-x:auto}
    `;
    document.head.append(style);
  }

  let embedLoading = null;
  function ensureEmbed(){
    if (global.FirstMateForms) return Promise.resolve();
    return embedLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('../forms-embed/firstmate-forms-embed.js', base).href;
      script.dataset.auto = 'false';
      script.onload = resolve;
      script.onerror = () => { embedLoading = null; script.remove(); reject(new Error('Could not load the form preview.')); };
      document.head.append(script);
    });
  }
  const api = () => {
    if (!global.FormsAPI) throw new Error('Forms are unavailable in this session.');
    return global.FormsAPI;
  };

  /**
   * The real public form, running a draft through the authenticated preview routes.
   * Given a definition it is driven by its host; given a form id it follows the saved draft.
   */
  function mountPreview(root, options = {}){
    styles();
    const orgId = clean(options.orgId || (global.__APP || {}).userOrgId);
    const follow = !options.definition;
    let definition = options.definition || null;
    let name = options.name || '';
    let form = null;
    let embed = null;
    let alive = true;
    let timer = 0;
    root.innerHTML = `<div class="ffw"><div class="ffw-bar"><span class="ffw-title" data-title><i aria-hidden="true" class="fas fa-eye"></i> <b>Live preview</b></span>
      <span class="ffw-tools"><span class="ffw-seg"><button type="button" data-device="desktop" class="on">Desktop</button><button type="button" data-device="phone">Phone</button></span>
      <button type="button" class="ffw-btn" data-restart><i aria-hidden="true" class="fas fa-rotate-left"></i> Restart</button></span></div>
      <div class="ffw-stage" data-stage><div data-form><div class="ffw-note">Loading preview\u2026</div></div></div></div>`;
    const stage = root.querySelector('[data-stage]');
    const target = root.querySelector('[data-form]');
    root.querySelectorAll('[data-device]').forEach((button) => button.addEventListener('click', () => {
      root.querySelectorAll('[data-device]').forEach((entry) => entry.classList.toggle('on', entry === button));
      stage.classList.toggle('phone', button.dataset.device === 'phone');
    }));
    root.querySelector('[data-restart]').addEventListener('click', () => embed?.reset());

    function title(){
      if (!follow || !form) return;
      const [label, tone] = STATUS[form.status] || STATUS.draft;
      root.querySelector('[data-title]').innerHTML = `<i aria-hidden="true" class="fas fa-eye"></i> <b>${esc(form.name)}</b><span class="ffw-pill ${tone}">${label}</span>${form.has_unpublished_changes ? '<span class="ffw-pill info">Unpublished changes</span>' : ''}`;
    }
    async function show(){
      await ensureEmbed();
      if (!alive) return;
      if (embed) return embed.update(definition, name);
      target.innerHTML = '';
      embed = global.FirstMateForms.render({
        definition,
        name,
        target,
        transport: {
          availability: (item, date, address) => api().preview.availability(orgId, { item: { preset_id: item.preset_id, min_notice_hours: item.min_notice_hours, horizon_days: item.horizon_days }, date, address }),
          measure: (item, address) => api().preview.measurement(orgId, { source: item.source, address, tint: definition.presentation.style.primary_color }),
          submit: (payload) => api().preview.submit(orgId, { definition, answers: payload.answers, measurements: payload.measurements })
        }
      });
    }
    async function refresh(){
      if (!alive || !follow) return;
      try {
        const next = await api().get(orgId, options.formId);
        if (!alive) return;
        const changed = !form || next.revision !== form.revision;
        form = next;
        title();
        if (changed) { definition = next.definition; name = next.name; await show(); }
      } catch (error) {
        if(alive){embed?.destroy();embed=null;form=null;root.querySelector('[data-title]').textContent='Live preview';}
        if (alive) target.innerHTML = `<div class="ffw-note">${esc(error.message || 'This form could not be loaded.')}</div>`;
      }
    }
    // A followed draft is edited elsewhere (the assistant, another tab), so check for a newer save while on screen.
    function poll(){
      clearTimeout(timer);
      if (!alive || !follow) return;
      timer = setTimeout(async () => { if (document.visibilityState === 'visible' && root.getClientRects().length) await refresh(); poll(); }, 4000);
    }
    const ready = (follow ? refresh() : show()).catch((error) => { if (alive) target.innerHTML = `<div class="ffw-note">${esc(error.message || 'Could not load the form preview.')}</div>`; });
    poll();
    return {
      ready,
      update(nextDefinition, nextName){ definition = nextDefinition; name = nextName ?? name; if (embed) embed.update(definition, name); },
      goToStep(stepId){ embed?.goToStep(stepId); },
      reset(){ embed?.reset(); },
      refresh,
      destroy(){ alive = false; clearTimeout(timer); embed?.destroy(); root.innerHTML = ''; }
    };
  }

  const number = (value) => Number(value || 0).toLocaleString();
  const percent = (value) => value === null || value === undefined ? '\u2014' : `${value}%`;
  function money(estimate){
    try { const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: estimate.currency || 'USD', maximumFractionDigits: 0 }); return `${format.format(estimate.low)} \u2013 ${format.format(estimate.high)}`; }
    catch { return ''; }
  }
  const bars = (rows, total) => `<div class="ffs-bars">${rows.map((row) => `<div class="ffs-bar"><span title="${esc(row.label)}">${esc(row.label)}</span><div><i style="width:${total > 0 ? Math.round(row.count / total * 100) : 0}%"></i></div><b>${number(row.count)}</b></div>`).join('')}</div>`;

  /** Who reached the form, how far they got, how they answered, and what they sent. */
  function mountSubmissions(root, options = {}){
    styles();
    const orgId = clean(options.orgId || (global.__APP || {}).userOrgId);
    let alive = true;
    root.innerHTML = '<div class="ffs"><div class="ffw-note">Loading submissions\u2026</div></div>';
    const host = root.firstElementChild;

    function draw(data){
      const totals = data.totals;
      const peak = Math.max(1, ...data.daily.map((entry) => Math.max(entry.views, entry.submissions)));
      const reached = Math.max(1, ...data.steps.map((step) => step.reached));
      const tracked = totals.views > 0;
      const html = `
        <div class="ffs-head"><h4>${options.heading === false ? '' : esc(data.form.name)}</h4><button type="button" class="ffw-btn" data-refresh><i aria-hidden="true" class="fas fa-rotate"></i> Refresh</button></div>
        <div class="ffs-tiles">
          <div class="ffs-tile" data-id="metric-0"><small>Views</small><strong>${number(totals.views)}</strong><span>times the form was opened</span></div>
          <div class="ffs-tile" data-id="metric-1"><small>Started</small><strong>${number(totals.starts)}</strong><span>${percent(totals.start_rate)} of views</span></div>
          <div class="ffs-tile" data-id="metric-2"><small>Submitted</small><strong>${number(totals.submissions)}</strong><span>${percent(totals.completion_rate)} of those who started</span></div>
          ${data.estimates ? `<div class="ffs-tile" data-id="metric-3"><small>Average estimate</small><strong style="font-size:16px">${esc(money({ low: data.estimates.average_low, high: data.estimates.average_high, currency: data.estimates.currency }))}</strong><span>across ${number(data.estimates.count)} estimates</span></div>` : ''}
          ${data.appointments ? `<div class="ffs-tile" data-id="metric-4"><small>Appointments</small><strong>${number(data.appointments.booked)}</strong><span>booked${data.appointments.requested ? `, ${number(data.appointments.requested)} to confirm` : ''}</span></div>` : ''}
        </div>
        <div><h5>Last ${data.period_days} days</h5>
          <div class="ffs-days" role="img" aria-label="Daily views and submissions">${data.daily.map((entry) => `<i data-id="day-${esc(entry.day)}" title="${esc(entry.day)}: ${entry.views} views, ${entry.submissions} submitted" style="height:${Math.max(3, Math.round(Math.max(entry.views, entry.submissions) / peak * 100))}%"><b style="height:${Math.max(entry.views, entry.submissions) ? Math.round(entry.submissions / Math.max(entry.views, entry.submissions) * 100) : 0}%"></b></i>`).join('')}</div>
          <div class="ffs-axis"><span>${esc(data.daily[0]?.day || '')}</span><span>Today</span></div>
          <div class="ffs-legend"><span><i></i>Views</span><span><i class="s"></i>Submitted</span></div>
        </div>
        ${data.steps.length > 1 && tracked ? `<div><h5>How far visitors get</h5>${bars(data.steps.map((step) => ({ label: step.title, count: step.reached })), reached)}</div>` : ''}
        ${data.questions.length ? `<div><h5>How people answer</h5><div class="ffs-grid">${data.questions.map((question) => `<div class="ffs-q"><b>${esc(question.label)}</b>${question.options
          ? bars(question.options, Math.max(1, question.answered))
          : `<small>${question.answered ? `Average ${number(question.average)}${question.unit ? ` ${esc(question.unit)}` : ''} \u00b7 from ${number(question.min)} to ${number(question.max)}` : 'No answers yet'}</small>`}</div>`).join('')}</div></div>` : ''}
        <div><h5>Recent submissions</h5>${data.recent.length ? `<div class="ffs-scroll"><table class="ffs-table"><thead><tr><th>Received</th><th>Contact</th><th>Details</th><th></th></tr></thead><tbody>${data.recent.map((row) => `<tr data-id="submission-${esc(row.id||row.created_at)}">
          <td>${esc(new Date(row.created_at).toLocaleDateString())}<small>${esc(new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}</small></td>
          <td><b>${esc(row.contact?.name || 'No name')}</b><small>${esc([row.contact?.phone, row.contact?.email].filter(Boolean).join(' \u00b7 '))}</small>${row.address ? `<small>${esc(row.address)}</small>` : ''}</td>
          <td>${row.estimate ? `<b>${esc(money(row.estimate))}</b>` : ''}${row.appointment ? `<small>${esc(row.appointment.status === 'booked' ? 'Booked' : 'Requested')}: ${esc(row.appointment.label)}</small>` : ''}${(row.summary || []).slice(0, 4).map((entry) => `<small>${esc(entry.label)}: ${esc(entry.value)}</small>`).join('')}</td>
          <td>${row.project_id && options.openProject ? `<button type="button" class="ffw-btn" data-project="${esc(row.project_id)}">Open lead</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>` : `<div class="ffw-note" style="padding:14px 0;text-align:left">${data.form.status === 'draft' ? 'Publish and share the form to start collecting responses.' : 'No submissions yet. Each one appears here and as a new lead.'}</div>`}</div>
        ${tracked ? '' : '<div class="ffw-note" style="padding:0;text-align:left;font-weight:500;font-size:12px">Views and starts are counted from when the form is next opened by a visitor.</div>'}`;
      if(global.FirstMateWidgets?.reconcile)global.FirstMateWidgets.reconcile(host,html,'.ffs-tile,.ffs-days>i,.ffs-table tbody tr');else host.innerHTML=html;
      host.querySelector('[data-refresh]').addEventListener('click', load);
      host.querySelectorAll('[data-project]').forEach((button) => button.onclick=() => options.openProject(button.dataset.project));
    }
    async function load(){
      try {
        const data = await api().insights(orgId, options.formId);
        if (alive) draw(data);
      } catch (error) {
        if (alive) host.innerHTML = `<div class="ffw-note">${esc(error.message || 'Submissions could not be loaded.')}</div>`;
      }
    }
    const ready = load();
    return { ready, refresh: load, destroy(){ alive = false; root.innerHTML = ''; } };
  }

  /** In a conversation a widget may be asked for without naming a form: offer the company's forms. */
  function withForm(root, data, config, reference, mountOne){
    styles();
    const orgId = reference?.target?.organizationId;
    let current = null;
    const open = (formId) => { current?.destroy(); current = mountOne(root, { orgId, formId }); };
    if (clean(config.form_id)) open(clean(config.form_id));
    else showPicker(data);
    function showPicker(data){
      const forms = data?.forms || [];
      root.innerHTML = forms.length ? `<div class="ffw"><div class="ffw-pick">${forms.map((form) => `<button type="button" data-form="${esc(form.id)}"><b>${esc(form.name)}</b><span class="ffw-pill ${(STATUS[form.status] || STATUS.draft)[1]}">${(STATUS[form.status] || STATUS.draft)[0]}</span></button>`).join('')}</div></div>` : '<div class="ffw"><div class="ffw-note">There are no forms yet.</div></div>';
      root.querySelectorAll('[data-form]').forEach((button) => button.addEventListener('click', () => open(button.dataset.form)));
    }
    return { async refresh({loadData}={}){if(current){await current.ready;return current.refresh?.();}if(loadData)showPicker(await loadData());}, destroy(){ current?.destroy(); root.innerHTML = ''; } };
  }

  function registerRenderers(){
    const widgets = global.FirstMateWidgets;
    if (!widgets?.attachRenderer) return false;
    widgets.attachRenderer('forms.preview', '1', (root, { data, config, reference }) => withForm(root, data, config, reference, mountPreview));
    widgets.attachRenderer('forms.submissions', '1', (root, { data, config, reference }) => withForm(root, data, config, reference, (el, options) => mountSubmissions(el, { ...options, openProject: global.FirstMateProjectWindows?.open ? (projectId) => global.FirstMateProjectWindows.open(projectId) : null })));
    return true;
  }
  if (!registerRenderers()) global.addEventListener('load', registerRenderers, { once: true });

  global.FirstMateFormsWidgets = { mountPreview, mountSubmissions };
})(window);
