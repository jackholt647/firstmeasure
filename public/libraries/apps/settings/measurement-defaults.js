/* Settings > Reports > Default materials and labor.
 * What a roof needs, worked out from its measurement report alone, for a project no document has defined yet. The
 * Project tab's Generate materials uses these when nothing is signed; a signed document's scope always replaces them.
 * Each material rule adds roof measurements, adds a waste allowance and says how the product is bought. Labor is the
 * work the job includes; how anyone is paid for it stays on their pay sheet. Stored server side
 * (public/v1/materials/measurement-defaults.ts).
 */
(function(root){
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const text = (value) => String(value ?? '').trim();
  const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (match, name) => (values && name in values ? String(values[name]) : match));
  const t = (key, fallback, values) => { const text = fill(fallback, values); return globalThis.PlatformLanguage?.text?.('settings', key, text, values) ?? text; };
  const num = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
  const round = (value, places = 4) => String(Math.round(num(value) * 10 ** places) / 10 ** places);
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function csrf(){
    try {
      const name = text(window.__APP?.platformSessionCookieName || 'fm_platform_session');
      const found = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${encodeURIComponent(`${name}_csrf`)}=`));
      return found ? decodeURIComponent(found.split('=').slice(1).join('=')) : '';
    } catch (_) { return ''; }
  }
  async function request(path, options = {}){
    if (window.MaterialsAPI?.request) return window.MaterialsAPI.request(path, options);
    const base = text(window.__APP?.materialsApiBase) || `${location.origin}/v1/materials`;
    const method = text(options.method || 'GET').toUpperCase();
    const response = await fetch(`${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`, { method, credentials:'include', cache:'no-store', headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}), ...(method !== 'GET' && csrf() ? { 'X-Platform-CSRF':csrf() } : {}) }, ...(options.body ? { body:JSON.stringify(options.body) } : {}) });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!response.ok || data?.ok === false) { const error = new Error(text(data?.message || data?.error) || `Request failed (${response.status})`); error.status = response.status; error.data = data; throw error; }
    return data;
  }
  async function products(orgId){
    const read = window.PlatformAPI?.publication?.read;
    if (typeof read !== 'function') return [];
    try {
      const result = await read.call(window.PlatformAPI.publication, orgId, { provider:'materials-inputs', export:'products', target:{ scope:'organization', organizationId:orgId } });
      return Array.isArray(result?.value) ? result.value : [];
    } catch (_) { return []; }
  }

  function injectStyles(){
    if (document.getElementById('fm-measurement-defaults-style')) return;
    const style = document.createElement('style');
    style.id = 'fm-measurement-defaults-style';
    style.textContent = `
      .md-wrap{display:flex;flex-direction:column;gap:14px;font-size:12px;color:#344054;max-width:1180px}
      .md-card{border:1px solid #e4e7ec;border-radius:12px;background:#fff;padding:14px 16px}
      .md-head{display:flex;align-items:flex-start;gap:12px;justify-content:space-between;flex-wrap:wrap}
      .md-head h3{margin:0;font-size:15px;color:#101828}.md-head p{margin:4px 0 0;color:#667085;max-width:720px;line-height:1.45}
      .md-actions{display:flex;gap:8px;align-items:center}
      .md-btn{height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}
      .md-btn:hover:not(:disabled){border-color:#98a2b3}.md-btn:disabled{opacity:.5;cursor:default}
      .md-btn.primary{border-color:var(--primary,#d93025);background:var(--primary,#d93025);color:var(--on-primary,#fff)}
      .md-btn.small{height:26px;padding:0 9px;font-size:11px}
      .md-status{min-height:16px;font-size:11px;color:#667085}.md-status.error{color:#b42318}.md-status.ok{color:#067647}
      .md-section-head{display:flex;align-items:center;gap:10px;justify-content:space-between;margin-bottom:10px}
      .md-section-head h4{margin:0;font-size:13px;color:#101828}.md-section-head small{display:block;color:#667085;font-weight:400;margin-top:2px}
      .md-switch{display:inline-flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;user-select:none}
      .md-switch input{width:34px;height:20px;appearance:none;border-radius:999px;background:#d0d5dd;position:relative;cursor:pointer;margin:0;transition:background .15s}
      .md-switch input::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
      .md-switch input:checked{background:var(--primary,#d93025)}.md-switch input:checked::after{left:16px}
      .md-off{opacity:.55}
      .md-waste{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:10px 12px;border:1px solid #eaecf0;border-radius:10px;background:#f9fafb;margin-bottom:12px}
      .md-waste label{display:flex;flex-direction:column;gap:3px;font-size:10px;font-weight:600;color:#667085;max-width:190px}
      .md-waste input{height:28px;width:90px;padding:0 8px;border:1px solid #d0d5dd;border-radius:7px;font-size:12px}
      .md-waste .md-waste-note{flex:1 1 240px;font-size:11px;color:#667085;line-height:1.4;font-weight:400}
      .md-table{width:100%;border-collapse:collapse}
      .md-table th{position:sticky;top:0;background:#f9fafb;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#667085;padding:6px 8px;border-bottom:1px solid #eaecf0}
      .md-table td{padding:6px 8px;border-bottom:1px solid #f0f2f5;vertical-align:top}
      .md-table tr.md-disabled td:not(.md-on){opacity:.5}
      .md-table input[type=text],.md-table input[type=number],.md-table select{height:28px;box-sizing:border-box;padding:0 6px;border:1px solid #d0d5dd;border-radius:6px;font-size:12px;background:#fff;color:#101828;min-width:0}
      .md-name input{width:100%;font-weight:600}.md-name .md-group{margin-top:4px;width:100%;font-size:11px;color:#475467}
      .md-terms{display:flex;flex-direction:column;gap:4px}.md-term{display:flex;gap:4px;align-items:center}
      .md-term select.md-op{width:44px}.md-term input.md-factor{width:58px}.md-term select.md-measure{flex:1;min-width:150px}
      .md-x{border:0;background:transparent;color:#98a2b3;cursor:pointer;font-size:14px;padding:0 4px}.md-x:hover{color:#b42318}
      .md-add-term{border:0;background:transparent;color:#475467;font-size:11px;cursor:pointer;text-decoration:underline;padding:2px 0;text-align:left}
      .md-waste-cell select{width:110px}.md-waste-cell input{width:64px;margin-top:4px}
      .md-pack{display:flex;flex-direction:column;gap:4px}.md-pack div{display:flex;gap:4px;align-items:center}.md-pack input.md-pack-unit{width:70px}.md-pack input.md-pack-cover{width:70px}
      .md-product input{width:100%}.md-product small{display:block;margin-top:3px;color:#667085;font-size:10px;line-height:1.3}
      .md-sentence{margin-top:4px;color:#667085;font-size:11px;line-height:1.35}
      .md-labor{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}
      .md-labor label{display:flex;gap:8px;align-items:flex-start;padding:9px 10px;border:1px solid #eaecf0;border-radius:9px;cursor:pointer;background:#fff}
      .md-labor label input{margin-top:2px}.md-labor strong{display:block;color:#101828;font-size:12px}.md-labor small{display:block;color:#667085;font-size:11px;line-height:1.35;margin-top:2px}
      .md-note{margin-top:10px;font-size:11px;color:#667085;line-height:1.45}
      @media(max-width:860px){.md-table thead{display:none}.md-table tr{display:block;border-bottom:1px solid #eaecf0;padding:6px 0}.md-table td{display:block;border:0;padding:4px 0}}
    `;
    document.head.append(style);
  }

  function mount(host, options = {}){
    injectStyles();
    const orgId = () => text(typeof options.orgId === 'function' ? options.orgId() : options.orgId);
    // Like every settings page this saves as it is changed; the page's own Save-button autosave is switched off here
    // because adding or removing a rule is a click, not a field change.
    host.dataset.settingsAutosave = 'off';
    let saveTimer = null;
    const state = { loading:true, saving:false, dirty:false, settings:null, industry:null, catalog:{ measurements:[], work_items:[] }, revision:0, stored:false, products:[], status:'', statusKind:'' };
    const measurement = (id) => state.catalog.measurements.find((entry) => entry.id === id);
    const unitOf = (rule) => measurement(rule.terms?.[0]?.measurement)?.unit || '';
    const setStatus = (message, kind = '') => { state.status = message; state.statusKind = kind; const el = host.querySelector('[data-md-status]'); if (el) { el.textContent = message; el.className = `md-status ${kind}`; } };

    function sentence(rule){
      const parts = (rule.terms || []).map((term, index) => `${term.factor < 0 ? '− ' : index ? '+ ' : ''}${Math.abs(term.factor) !== 1 ? `${round(Math.abs(term.factor), 2)} × ` : ''}${measurement(term.measurement)?.label || term.measurement}`);
      const waste = rule.waste === 'roof' ? t('md_waste_roof_short', 'roof waste') : num(rule.waste) ? `${round(rule.waste, 2)}% waste` : '';
      const pack = rule.package ? t('md_bought_by', 'bought by the {unit} of {coverage} {lineUnit}', { unit:rule.package.unit, coverage:round(rule.package.coverage, 3), lineUnit:unitOf(rule) }) : '';
      return [parts.join(' '), waste ? `+ ${waste}` : '', pack ? `· ${pack}` : ''].filter(Boolean).join(' ');
    }
    function productNote(rule){
      const found = (rule.product_id && state.products.find((item) => item.id === rule.product_id)) || (rule.product_type && state.products.find((item) => text(item.type).toLowerCase() === text(rule.product_type).toLowerCase()));
      if (!state.products.length) return '';
      if (found) return t('md_product_found', 'Price book: {name}', { name:found.name });
      return t('md_product_missing', 'Not in your price book; the line uses this rule’s name.');
    }

    // Products by name, grouped by item type. A product the price book no longer has stays selectable, marked as missing.
    function productSelect(rule){
      const groups = new Map();
      state.products.forEach((item) => { const type = text(item.type) || t('md_other', 'Other'); if (!groups.has(type)) groups.set(type, []); groups.get(type).push(item); });
      const known = !rule.product_id || state.products.some((item) => item.id === rule.product_id);
      return `<select data-md-field="product_id" aria-label="${esc(t('md_product_id', 'Price book item'))}" style="width:100%">
        <option value="">${esc(t('md_product_by_type', 'Any item of the type below'))}</option>
        ${known ? '' : `<option value="${esc(rule.product_id)}" selected>${esc(t('md_product_gone', 'Not in your price book'))}</option>`}
        ${[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, items]) => `<optgroup label="${esc(type)}">${items.map((item) => `<option value="${esc(item.id)}" ${item.id === rule.product_id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</optgroup>`).join('')}
      </select>`;
    }
    function rulesRows(){
      const measures = state.catalog.measurements;
      return state.settings.materials.rules.map((rule, index) => `
        <tr data-md-rule="${index}" class="${rule.enabled === false ? 'md-disabled' : ''}">
          <td class="md-on"><input type="checkbox" data-md-field="enabled" ${rule.enabled === false ? '' : 'checked'} aria-label="${esc(t('md_rule_on', 'Generate {name}', { name:rule.label }))}"></td>
          <td class="md-name"><input type="text" data-md-field="label" value="${esc(rule.label)}" aria-label="${esc(t('md_rule_name', 'Name'))}"><input type="text" class="md-group" data-md-field="group" value="${esc(rule.group || '')}" placeholder="${esc(t('md_group', 'Group'))}" aria-label="${esc(t('md_group', 'Group'))}"><div class="md-sentence">${esc(sentence(rule))}</div></td>
          <td><div class="md-terms">${(rule.terms || []).map((term, termIndex) => `
            <div class="md-term" data-md-term="${termIndex}">
              <select class="md-op" data-md-term-field="op" aria-label="${esc(t('md_add_or_subtract', 'Add or take away'))}"><option value="+" ${term.factor >= 0 ? 'selected' : ''}>+</option><option value="-" ${term.factor < 0 ? 'selected' : ''}>−</option></select>
              <input type="number" class="md-factor" data-md-term-field="factor" min="0" step="0.01" value="${esc(round(Math.abs(term.factor), 4))}" title="${esc(t('md_factor_tip', 'Times this much. 1 is the measurement as it is.'))}" aria-label="${esc(t('md_factor', 'Factor'))}">
              <select class="md-measure" data-md-term-field="measurement" aria-label="${esc(t('md_measurement', 'Measurement'))}">${measures.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === term.measurement ? 'selected' : ''}>${esc(entry.label)} (${esc(entry.unit)})</option>`).join('')}</select>
              ${rule.terms.length > 1 ? `<button type="button" class="md-x" data-md-remove-term="${termIndex}" aria-label="${esc(t('md_remove_measurement', 'Remove this measurement'))}">×</button>` : ''}
            </div>`).join('')}
            <button type="button" class="md-add-term" data-md-add-term>${esc(t('md_add_measurement', '+ Add a measurement'))}</button></div></td>
          <td class="md-waste-cell"><select data-md-field="waste_kind" aria-label="${esc(t('md_waste', 'Waste'))}"><option value="roof" ${rule.waste === 'roof' ? 'selected' : ''}>${esc(t('md_roof_waste', 'Roof waste'))}</option><option value="fixed" ${rule.waste === 'roof' ? '' : 'selected'}>${esc(t('md_fixed_waste', 'Fixed %'))}</option></select>${rule.waste === 'roof' ? '' : `<input type="number" data-md-field="waste" min="0" max="100" step="0.5" value="${esc(round(rule.waste, 2))}" aria-label="${esc(t('md_waste_percent', 'Waste percent'))}">`}</td>
          <td><div class="md-pack"><div><span>${esc(t('md_one', 'One'))}</span><input type="text" class="md-pack-unit" data-md-field="package_unit" value="${esc(rule.package?.unit || '')}" placeholder="${esc(t('md_package', 'bundle'))}" aria-label="${esc(t('md_package_unit', 'Package'))}"></div><div><span>${esc(t('md_covers', 'covers'))}</span><input type="number" class="md-pack-cover" data-md-field="package_coverage" min="0" step="0.0001" value="${rule.package ? esc(round(rule.package.coverage, 4)) : ''}" aria-label="${esc(t('md_package_coverage', 'What one package covers'))}"><span>${esc(unitOf(rule))}</span></div></div></td>
          <td class="md-product">${productSelect(rule)}<input type="text" data-md-field="product_type" value="${esc(rule.product_type || '')}" placeholder="${esc(t('md_product_type', 'or item type'))}" style="margin-top:4px" aria-label="${esc(t('md_product_type_label', 'Item type'))}"><small>${esc(productNote(rule))}</small></td>
          <td><button type="button" class="md-x" data-md-remove-rule aria-label="${esc(t('md_remove_rule', 'Remove {name}', { name:rule.label }))}">×</button></td>
        </tr>`).join('');
    }

    function render(){
      if (state.loading) { host.innerHTML = `<div class="md-wrap"><div class="md-card">${esc(t('md_loading', 'Loading default materials and labor…'))}</div></div>`; return; }
      if (!state.settings) { host.innerHTML = `<div class="md-wrap"><div class="md-card"><div class="md-status error">${esc(state.status || t('md_load_failed', 'The defaults could not load.'))}</div></div></div>`; return; }
      const s = state.settings, w = s.materials.waste;
      host.innerHTML = `
        <div class="md-wrap">
          <div class="md-card">
            <div class="md-head">
              <div><h3>${esc(t('md_title', 'Default materials and labor'))}</h3>
                <p>${esc(t('md_intro', 'When a project has a measurement report but no signed document, Generate materials in the Project tab uses these to build its materials, and the work the job includes when default labor is on. A signed document’s scope always replaces them.'))}</p></div>
              <div class="md-actions"><button type="button" class="md-btn" data-md-reset>${esc(t('md_reset', 'Reset to industry defaults'))}</button></div>
            </div>
            <div class="md-status ${state.statusKind}" data-md-status role="status">${esc(state.status || (state.stored ? t('md_autosave', 'Changes save as you make them.') : t('md_not_saved', 'These are the industry defaults. Any change you make is saved as your own.')))}</div>
          </div>
          <div class="md-card ${s.materials.enabled ? '' : 'md-off'}">
            <div class="md-section-head"><h4>${esc(t('md_materials', 'Default materials'))}<small>${esc(t('md_materials_sub', 'Each line adds roof measurements together, adds waste, and is ordered in whole packages.'))}</small></h4>
              <label class="md-switch"><input type="checkbox" data-md-switch="materials" ${s.materials.enabled ? 'checked' : ''}>${esc(s.materials.enabled ? t('md_on', 'On') : t('md_off', 'Off'))}</label></div>
            <div class="md-waste">
              <label>${esc(t('md_waste_base', 'Base waste %'))}<input type="number" min="0" max="100" step="0.5" data-md-waste="base_percent" value="${esc(round(w.base_percent, 2))}"></label>
              <label>${esc(t('md_waste_cut', '+ % per ft of hip and valley per square'))}<input type="number" min="0" max="10" step="0.1" data-md-waste="per_cut_foot_percent" value="${esc(round(w.per_cut_foot_percent, 2))}"></label>
              <label>${esc(t('md_waste_steep', '+ % for a roof all over 8/12'))}<input type="number" min="0" max="100" step="0.5" data-md-waste="steep_percent" value="${esc(round(w.steep_percent, 2))}"></label>
              <label>${esc(t('md_waste_min', 'Lowest %'))}<input type="number" min="0" max="100" step="0.5" data-md-waste="min_percent" value="${esc(round(w.min_percent, 2))}"></label>
              <label>${esc(t('md_waste_max', 'Highest %'))}<input type="number" min="0" max="100" step="0.5" data-md-waste="max_percent" value="${esc(round(w.max_percent, 2))}"></label>
              <span class="md-waste-note">${esc(t('md_waste_note', 'Roof waste grows with how cut up the roof is and how steep it is: a plain gable gets the base, a hip roof with valleys a few points more. Steep squares add their share of the steep allowance. Rounded to the half percent.'))}</span>
            </div>
            <div style="overflow:auto"><table class="md-table">
              <thead><tr><th></th><th>${esc(t('md_col_material', 'Material'))}</th><th>${esc(t('md_col_from', 'Measured from'))}</th><th>${esc(t('md_col_waste', 'Waste'))}</th><th>${esc(t('md_col_package', 'Bought as'))}</th><th>${esc(t('md_col_product', 'Product'))}</th><th></th></tr></thead>
              <tbody>${rulesRows()}</tbody>
            </table></div>
            <div style="margin-top:10px"><button type="button" class="md-btn small" data-md-add-rule>${esc(t('md_add_rule', '+ Add a material'))}</button></div>
            <p class="md-note">${esc(t('md_materials_note', 'Pipe boots, vents and other penetrations are not in a measurement report, so they are not generated. A line with nothing measured (a roof with no valleys) is left out.'))}</p>
          </div>
          <div class="md-card ${s.labor.enabled ? '' : 'md-off'}">
            <div class="md-section-head"><h4>${esc(t('md_labor', 'Default labor'))}<small>${esc(t('md_labor_sub', 'The work the job includes, each sized from the same measurements. Off, nothing is required of a work order until a document says so.'))}</small></h4>
              <label class="md-switch"><input type="checkbox" data-md-switch="labor" ${s.labor.enabled ? 'checked' : ''}>${esc(s.labor.enabled ? t('md_on', 'On') : t('md_off', 'Off'))}</label></div>
            <div class="md-labor">${state.catalog.work_items.map((item) => { const entry = s.labor.items.find((row) => row.item === item.id); return `
              <label><input type="checkbox" data-md-work="${esc(item.id)}" ${entry && entry.enabled !== false ? 'checked' : ''}><span><strong>${esc(item.label)}</strong><small>${esc(item.description)}${item.optional ? ` ${t('md_work_optional', 'Only where the roof has some.')}` : ''}</small></span></label>`; }).join('')}</div>
            <p class="md-note">${esc(t('md_labor_note', 'How each assignee is paid for this work, including pitch and story adders, is on their pay sheet (People › Pay sheets). Generating a work order prices it there.'))}</p>
          </div>
        </div>`;
      bind();
    }

    // Redrawn after the event has finished bubbling, so the page's autosave still sees the field inside this opted-out editor.
    function changed(){ setTimeout(render, 0); clearTimeout(saveTimer); saveTimer = setTimeout(save, 600); }
    function ruleAt(element){ return state.settings.materials.rules[Number(element.closest('[data-md-rule]')?.dataset.mdRule)]; }
    function bind(){
      host.querySelectorAll('[data-md-switch]').forEach((input) => input.addEventListener('change', () => { state.settings[input.dataset.mdSwitch].enabled = input.checked; changed(); }));
      host.querySelectorAll('[data-md-waste]').forEach((input) => input.addEventListener('change', () => { state.settings.materials.waste[input.dataset.mdWaste] = num(input.value); changed(); }));
      host.querySelectorAll('[data-md-work]').forEach((input) => input.addEventListener('change', () => {
        const items = state.settings.labor.items, found = items.find((row) => row.item === input.dataset.mdWork);
        if (found) found.enabled = input.checked; else items.push({ item:input.dataset.mdWork, enabled:input.checked });
        changed();
      }));
      host.querySelectorAll('[data-md-field]').forEach((input) => input.addEventListener('change', () => {
        const rule = ruleAt(input), field = input.dataset.mdField;
        if (!rule) return;
        if (field === 'enabled') rule.enabled = input.checked;
        else if (field === 'waste_kind') rule.waste = input.value === 'roof' ? 'roof' : 5;
        else if (field === 'waste') rule.waste = num(input.value);
        else if (field === 'package_unit' || field === 'package_coverage') {
          const unit = text(field === 'package_unit' ? input.value : rule.package?.unit), coverage = field === 'package_coverage' ? num(input.value) : num(rule.package?.coverage);
          if (unit && coverage > 0) rule.package = { unit, coverage }; else if (!unit && !(coverage > 0)) delete rule.package; else rule.package = { unit:unit || 'each', coverage:coverage > 0 ? coverage : 1 };
        } else rule[field] = input.value;
        changed();
      }));
      host.querySelectorAll('[data-md-term-field]').forEach((input) => input.addEventListener('change', () => {
        const rule = ruleAt(input), term = rule?.terms[Number(input.closest('[data-md-term]').dataset.mdTerm)];
        if (!term) return;
        const field = input.dataset.mdTermField;
        if (field === 'measurement') term.measurement = input.value;
        else if (field === 'op') term.factor = Math.abs(term.factor) * (input.value === '-' ? -1 : 1);
        else term.factor = Math.abs(num(input.value, 1)) * (term.factor < 0 ? -1 : 1);
        changed();
      }));
      host.querySelectorAll('[data-md-add-term]').forEach((button) => button.addEventListener('click', () => {
        const rule = ruleAt(button), first = measurement(rule.terms[0]?.measurement);
        const next = state.catalog.measurements.find((entry) => entry.unit === first?.unit && !rule.terms.some((term) => term.measurement === entry.id)) || state.catalog.measurements[0];
        rule.terms.push({ measurement:next.id, factor:1 }); changed();
      }));
      host.querySelectorAll('[data-md-remove-term]').forEach((button) => button.addEventListener('click', () => { const rule = ruleAt(button); rule.terms.splice(Number(button.dataset.mdRemoveTerm), 1); changed(); }));
      host.querySelectorAll('[data-md-remove-rule]').forEach((button) => button.addEventListener('click', () => { state.settings.materials.rules.splice(Number(button.closest('[data-md-rule]').dataset.mdRule), 1); changed(); }));
      host.querySelector('[data-md-add-rule]')?.addEventListener('click', () => {
        const keys = new Set(state.settings.materials.rules.map((rule) => rule.key));
        let n = state.settings.materials.rules.length + 1; while (keys.has(`material_${n}`)) n += 1;
        state.settings.materials.rules.push({ key:`material_${n}`, enabled:true, label:t('md_new_material', 'New material'), group:'Materials', terms:[{ measurement:'roof.squares', factor:1 }], waste:0, product_id:'', product_type:'' });
        changed();
      });
      host.querySelector('[data-md-reset]')?.addEventListener('click', () => { state.settings = clone(state.industry); changed(); });
    }

    async function save(){
      if (state.saving) { state.dirty = true; return; }
      state.saving = true; state.dirty = false; setStatus(t('md_saving', 'Saving…'));
      try {
        const result = await request(`/organizations/${encodeURIComponent(orgId())}/measurement-defaults`, { method:'PUT', body:{ settings:state.settings, expected_revision:state.revision } });
        Object.assign(state, { revision:result.revision, stored:true });
        if (!state.dirty) state.settings = result.settings;
        setStatus(t('md_saved', 'Saved. Generating materials uses these defaults from now on.'), 'ok');
      } catch (error) {
        setStatus(error?.message || t('md_save_failed', 'The defaults could not be saved.'), 'error');
      } finally { state.saving = false; if (state.dirty) save(); }
    }

    async function load(){
      state.loading = true; render();
      try {
        const [result, items] = await Promise.all([request(`/organizations/${encodeURIComponent(orgId())}/measurement-defaults`), products(orgId())]);
        Object.assign(state, { settings:result.settings, industry:result.industry, catalog:result.catalog || state.catalog, revision:result.revision || 0, stored:!!result.stored, products:items });
      } catch (error) {
        Object.assign(state, { settings:null, status:error?.status === 403 ? t('md_forbidden', 'Changing default materials needs permission to manage company settings.') : (error?.message || t('md_load_failed', 'The defaults could not load.')), statusKind:'error' });
      } finally { state.loading = false; render(); }
    }
    load();
    return { reload:load };
  }

  root.FirstMateMeasurementDefaults = { mount };
})(window);
