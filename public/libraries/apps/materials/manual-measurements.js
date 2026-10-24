// Measurements entered by hand, in the Project tab rail's Measurements view, for a project with no completed report.
// The fields are the dictionary measurements the project's scope schemas ask for (measurement-schemas.manual); values
// are written by the measurements.manual.save action and become the project's measurements while no report is
// selected. Once a completed report is in use this shows the person's earlier entries beside the report's numbers
// until they are cleared. See docs/architecture/measurement-schemas.md.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// The fallback is filled in here, as the generated calls do; a catalog message uses the same {names}.
const L = (key, fallback, vars) => { const filled = vars ? fallback.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : fallback; return globalThis.PlatformLanguage?.text('materials', key, filled, vars) ?? filled; };
const UNITS = { roofing_square: ['mm_unit_squares', 'sq'], ft: ['mm_unit_feet', 'ft'], ft2: ['mm_unit_square_feet', 'sq ft'] };
const unitText = unit => UNITS[unit] ? L(UNITS[unit][0], UNITS[unit][1]) : unit;
const shown = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '';
const parse = raw => { const text = String(raw ?? '').replace(/,/g, '').trim(); if (!text) return null; const n = Number(text); return Number.isFinite(n) && n >= 0 ? n : NaN; };

let styled = false;
export function ensureStyles() {
  if (styled || document.getElementById('smm-styles')) { styled = true; return; }
  styled = true;
  const style = document.createElement('style');
  style.id = 'smm-styles';
  style.textContent = `
  .smm{position:absolute;inset:0;overflow:auto;container-type:inline-size;box-sizing:border-box;padding:14px 14px 18px;background:#f7f9fc;color:#263349;font-size:12px}
  .smm[hidden]{display:none}
  .smm-head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
  .smm-head h2{margin:0;font-size:15px;line-height:1.3;color:#172f50}
  .smm-head p{margin:4px 0 0;max-width:46ch;color:#52647e;line-height:1.5}
  .smm-chips{display:flex;gap:4px;flex-wrap:wrap}
  .smm-chip{padding:2px 8px;border-radius:999px;background:#e9eef6;color:#3b4f6b;font-size:10.5px;font-weight:600;white-space:nowrap}
  .smm-note{margin-top:10px;padding:8px 10px;border-radius:8px;border:1px solid #cbd8ec;background:#fff;color:#3b4f6b;line-height:1.45}
  .smm-progress{margin:14px 0 4px;display:flex;align-items:center;gap:10px}
  .smm-bar{flex:1;height:4px;border-radius:2px;background:#e4e9ef;overflow:hidden}
  .smm-bar>span{display:block;height:100%;width:var(--done,0%);background:var(--primary,#d93025);border-radius:inherit;transition:width .35s cubic-bezier(.22,1,.36,1)}
  .smm-progress small{color:#52647e;white-space:nowrap}
  .smm-group{margin-top:14px;border:1px solid #e4e9ef;border-radius:8px;background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.04);overflow:hidden}
  .smm-group h3{margin:0;padding:8px 12px;font-size:11px;letter-spacing:.03em;text-transform:uppercase;color:#667085;background:#fbfcfe;border-bottom:1px solid #eef2f6}
  .smm-row{display:flex;align-items:center;gap:10px;padding:7px 12px;min-height:40px;box-sizing:border-box;border-top:1px solid #f1f4f8;animation:smm-in .24s cubic-bezier(.22,1,.36,1) both}
  .smm-group h3+.smm-row{border-top:0}
  .smm-label{flex:1;min-width:0;display:flex;align-items:center;gap:6px;line-height:1.35}
  .smm-derived{flex-basis:100%;color:#667085;font-size:10.5px;line-height:1.2}
  .smm-derived:empty{display:none}
  .smm-label{flex-wrap:wrap}
  .smm-label em{font-style:normal;font-size:10px;font-weight:600;color:var(--primary-readable,var(--primary,#d93025))}
  .smm-field{display:inline-flex;align-items:center;flex:0 0 auto;width:132px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;transition:border-color .15s,box-shadow .15s}
  .smm-field:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
  .smm-field.invalid{border-color:#d92d20;box-shadow:0 0 0 3px rgba(217,45,32,.12)}
  .smm-field input{flex:1;min-width:0;width:100%;border:0;background:none;padding:6px 8px;font:inherit;font-size:12.5px;text-align:right;color:#172f50;outline:none}
  .smm-field span{padding:0 8px 0 2px;color:#667085;font-size:11px;white-space:nowrap}
  .smm-state{flex:0 0 14px;width:14px;text-align:center;color:#12b76a;opacity:0;transform:scale(.6);transition:opacity .2s,transform .2s}
  .smm-row.saving .smm-state{opacity:.6;transform:none;color:#98a2b3}
  .smm-row.saved .smm-state{opacity:1;transform:none}
  .smm-more{margin-top:12px;width:100%;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px;border:1px dashed #cbd5e1;border-radius:8px;background:transparent;color:#3b4f6b;font:inherit;cursor:pointer}
  .smm-more:hover{background:#fff;border-color:#98a2b3}
  .smm-more i{transition:transform .2s}
  .smm-more[aria-expanded=true] i{transform:rotate(180deg)}
  .smm-foot{margin-top:14px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
  .smm-status{min-height:16px;color:#52647e}
  .smm-status.error{color:#b42318}
  .smm-btn{border:1px solid #cbd5e1;background:#fff;border-radius:7px;padding:6px 12px;font:inherit;color:#263349;cursor:pointer;transition:background .15s,border-color .15s}
  .smm-btn:hover{border-color:#98a2b3}
  .smm-btn.primary{background:var(--primary,#d93025);border-color:var(--primary,#d93025);color:#fff}
  .smm-btn:disabled{opacity:.55;cursor:default}
  .smm-btn:focus-visible,.smm-more:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
  .smm-compare{width:100%;border-collapse:collapse}
  .smm-compare th{padding:7px 12px;text-align:right;font-size:10.5px;font-weight:600;color:#667085;background:#fbfcfe;border-bottom:1px solid #eef2f6}
  .smm-compare th:first-child,.smm-compare td:first-child{text-align:left}
  .smm-compare td{padding:7px 12px;text-align:right;border-top:1px solid #f1f4f8;white-space:nowrap}
  .smm-compare td:first-child{white-space:normal}
  .smm-compare td.differs{color:#b54708;font-weight:600}
  .smm-compare tr{animation:smm-in .24s cubic-bezier(.22,1,.36,1) both}
  .smm-flip{position:absolute;left:10px;bottom:10px;z-index:3;display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #cbd8ec;border-radius:999px;background:rgba(255,255,255,.96);box-shadow:0 2px 8px rgba(16,24,40,.12);color:#243956;font:inherit;font-size:11px;cursor:pointer;animation:smm-in .24s cubic-bezier(.22,1,.36,1) both}
  .smm-flip[hidden]{display:none}
  .smm-flip:hover{border-color:#98a2b3}
  .smm-flip:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
  @keyframes smm-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  /* A narrow rail puts each value under its name; the rail's width decides, not the window's. */
  @container (max-width:330px){.smm-row{flex-wrap:wrap;gap:6px}.smm-label{flex-basis:100%}.smm-field{flex:1;width:auto}}
  @media (max-width:520px){.smm{padding:12px 12px 16px}}
  @media (prefers-reduced-motion:reduce){.smm-row,.smm-compare tr,.smm-flip{animation:none}.smm-bar>span,.smm-state,.smm-more i,.smm-field{transition:none}}
  `;
  document.head.append(style);
}

export function mount(root, options) {
  ensureStyles();
  const state = { form: options.form, mode: options.mode, expanded: false, pending: new Map(), inflight: {}, saving: false, timer: 0, message: '', error: false, revision: options.form?.manual?.store_revision || 0 };
  root.classList.add('smm');
  const target = { scope: 'project', organizationId: options.orgId, projectId: options.projectId };
  const api = () => window.PlatformAPI;
  const values = () => ({ ...(state.form?.manual?.values || {}) });
  const fieldOf = key => (state.form?.fields || []).find(field => field.key === key);
  // What the person sees: the saved entries, then anything on its way to the server, then anything typed and not yet
  // sent. A redraw (More measurements, a background refresh) therefore never blanks a value that was typed.
  const display = () => { const shownValues = { ...values(), ...state.inflight }; for (const [key, value] of state.pending) shownValues[key] = value; for (const [key, value] of Object.entries(shownValues)) if (value === null) delete shownValues[key]; return shownValues; };
  // Equivalents (roof area for roof squares) are stored beside the entered value; they are never entered themselves.
  const derivedKeys = () => new Set((state.form?.fields || []).flatMap(field => (field.derives || []).map(other => other.key)));
  // The keys a person entered. An equivalent stored beside an entry is the same number in another unit; it counts only
  // when it stands alone (an older entry made before the two were joined).
  const entryKeys = () => { const entered = values(), derived = derivedKeys(); return Object.keys(entered).filter(key => !derived.has(key) || !(state.form?.fields || []).some(field => (field.derives || []).some(other => other.key === key) && entered[field.key] != null)); };
  const fieldValue = (field, entered) => {
    if (entered[field.key] != null) return entered[field.key];
    const other = (field.derives || []).find(item => typeof entered[item.key] === 'number');
    return other ? Math.round(entered[other.key] / other.factor * 1e6) / 1e6 : undefined;
  };
  const derivedText = (field, value) => typeof value === 'number' && field.derives?.length ? field.derives.map(other => L('mm_equivalent', '= {value} {unit}', { value: shown(Math.round(value * other.factor * 100) / 100), unit: unitText(other.unit) })).join(' · ') : '';

  function groups(fields) {
    const order = [], byGroup = new Map();
    for (const field of fields) {
      if (!byGroup.has(field.group)) { byGroup.set(field.group, []); order.push(field.group); }
      byGroup.get(field.group).push(field);
    }
    const title = (group, sample) => group === 'area' ? L('mm_group_area', 'Area') : group === 'length' ? L('mm_group_lengths', 'Lengths') : (sample.group_label || L('mm_group_parts', 'Parts'));
    // Areas first, then their parts, then lengths.
    const rank = group => group === 'area' ? 0 : group === 'length' ? 2 : 1;
    return order.sort((a, b) => rank(a) - rank(b)).map(group => ({ group, title: title(group, byGroup.get(group)[0]), fields: byGroup.get(group) }));
  }
  function row(field, entered) {
    const value = fieldValue(field, entered);
    return `<label class="smm-row" data-smm-row="${esc(field.key)}"><span class="smm-label">${esc(field.label)}${field.required ? `<em>${esc(L('mm_required', 'Required'))}</em>` : ''}${field.derives?.length ? `<small class="smm-derived" data-smm-derived>${esc(derivedText(field, value))}</small>` : ''}</span><span class="smm-field"><input type="text" inputmode="decimal" autocomplete="off" data-smm-key="${esc(field.key)}" value="${esc(shown(value))}" placeholder="—" aria-label="${esc(`${field.label} (${unitText(field.unit)})`)}"><span>${esc(unitText(field.unit))}</span></span><i class="fas fa-check smm-state" aria-hidden="true"></i></label>`;
  }
  function editHtml() {
    const fields = state.form.fields || [], entered = display();
    const primary = fields.filter(field => field.required || fieldValue(field, entered) != null);
    const rest = fields.filter(field => !primary.includes(field));
    const visible = state.expanded ? fields : primary;
    const required = fields.filter(field => field.required), done = required.filter(field => fieldValue(field, entered) != null).length;
    const pct = required.length ? Math.round(done / required.length * 100) : 0;
    const note = options.reportLinked
      ? L('mm_report_on_order', 'A measurement report is linked to this project. When it is complete its numbers replace these.')
      : '';
    return `<header class="smm-head"><div><h2 tabindex="-1">${esc(L('mm_title', 'Measurements'))}</h2><p>${esc(L('mm_intro', 'There is no completed measurement report. Enter the measurements this work uses; materials, labor and pay read them the same way they read a report.'))}</p></div><div class="smm-chips">${(state.form.schemas || []).map(schema => `<span class="smm-chip">${esc(schema.title)}</span>`).join('')}</div></header>
      ${note ? `<div class="smm-note" role="note">${esc(note)}</div>` : ''}
      ${required.length ? `<div class="smm-progress"><div class="smm-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${required.length}" aria-valuenow="${done}" aria-label="${esc(L('mm_required_progress_label', 'Required measurements entered'))}"><span style="--done:${pct}%"></span></div><small>${esc(L('mm_required_progress', '{done} of {total} required entered', { done, total: required.length }))}</small></div>` : ''}
      ${groups(visible).map(group => `<section class="smm-group"><h3>${esc(group.title)}</h3>${group.fields.map(field => row(field, entered)).join('')}</section>`).join('')}
      ${rest.length ? `<button type="button" class="smm-more" data-smm-more aria-expanded="${state.expanded}"><span>${esc(state.expanded ? L('mm_fewer', 'Show fewer') : L('mm_more', 'More measurements ({count})', { count: rest.length }))}</span><i class="fas fa-chevron-down" aria-hidden="true"></i></button>` : ''}
      <footer class="smm-foot"><span class="smm-status${state.error ? ' error' : ''}" role="status" aria-live="polite">${esc(state.message)}</span>${Object.keys(entered).length ? `<button type="button" class="smm-btn" data-smm-clear>${esc(L('mm_clear_all', 'Clear all'))}</button>` : ''}</footer>`;
  }
  function compareHtml() {
    const entered = values(), used = state.form.in_use?.values || {}, keys = entryKeys();
    const label = key => fieldOf(key)?.label || key, unit = key => unitText(fieldOf(key)?.unit || '');
    return `<header class="smm-head"><div><h2 tabindex="-1">${esc(L('mm_compare_title', 'Your entries'))}</h2><p>${esc(L('mm_compare_intro', "The completed report's numbers are used now. What you entered by hand is kept here until you clear it."))}</p></div></header>
      <section class="smm-group"><table class="smm-compare"><thead><tr><th scope="col">${esc(L('mm_compare_measurement', 'Measurement'))}</th><th scope="col">${esc(L('mm_compare_report', 'Report'))}</th><th scope="col">${esc(L('mm_compare_yours', 'Your entry'))}</th></tr></thead><tbody>${keys.map(key => `<tr><td>${esc(label(key))}</td><td>${used[key] == null ? '—' : `${esc(shown(used[key]))} ${esc(unit(key))}`}</td><td class="${used[key] != null && used[key] !== entered[key] ? 'differs' : ''}">${esc(shown(entered[key]))} ${esc(unit(key))}</td></tr>`).join('')}</tbody></table></section>
      <footer class="smm-foot"><button type="button" class="smm-btn" data-smm-back>${esc(L('mm_back_to_model', 'Back to 3D model'))}</button><span class="smm-status${state.error ? ' error' : ''}" role="status" aria-live="polite">${esc(state.message)}</span><button type="button" class="smm-btn primary" data-smm-clear>${esc(L('mm_clear_entries', 'Clear my entries'))}</button></footer>`;
  }
  function render() {
    root.dataset.mode = state.mode;
    root.innerHTML = state.mode === 'compare' ? compareHtml() : editHtml();
    root.querySelectorAll('[data-smm-key]').forEach(input => {
      const key = input.dataset.smmKey;
      input.addEventListener('focus', () => input.select?.());
      input.addEventListener('input', () => { queue(key, input); const hint = input.closest('.smm-row')?.querySelector('[data-smm-derived]'); const field = fieldOf(key); if (hint && field) { const value = parse(input.value); hint.textContent = derivedText(field, Number.isNaN(value) || value === null ? undefined : value); } });
      input.addEventListener('change', () => { queue(key, input); flush(); });
      input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); queue(key, input); flush(); input.blur(); } if (event.key === 'Escape') { input.value = shown(values()[key]); state.pending.delete(key); input.closest('.smm-field')?.classList.remove('invalid'); input.blur(); } });
    });
    root.querySelector('[data-smm-more]')?.addEventListener('click', () => { state.expanded = !state.expanded; render(); root.querySelector('[data-smm-more]')?.focus(); });
    root.querySelector('[data-smm-clear]')?.addEventListener('click', clearAll);
    root.querySelector('[data-smm-back]')?.addEventListener('click', () => options.onBack?.());
  }
  function queue(key, input) {
    const value = parse(input.value);
    const field = input.closest('.smm-field');
    if (Number.isNaN(value)) { field?.classList.add('invalid'); state.pending.delete(key); return; }
    field?.classList.remove('invalid');
    // A value already on its way counts as the current one, so a blur after Enter does not save it twice.
    const current = key in state.inflight ? state.inflight[key] : values()[key] ?? null;
    if (value === current) state.pending.delete(key); else state.pending.set(key, value);
    clearTimeout(state.timer);
    state.timer = setTimeout(flush, 900);
  }
  function mark(keys, cls) {
    for (const key of keys) {
      const el = root.querySelector(`[data-smm-row="${CSS.escape(key)}"]`);
      if (!el) continue;
      el.classList.remove('saving', 'saved');
      if (cls) { void el.offsetWidth; el.classList.add(cls); }
    }
  }
  function status(message, error = false) {
    state.message = message; state.error = error;
    const el = root.querySelector('.smm-status');
    if (el) { el.textContent = message; el.classList.toggle('error', error); }
  }
  async function save(changes) {
    if (state.saving) { for (const [key, value] of Object.entries(changes)) if (!state.pending.has(key)) state.pending.set(key, value); return; }
    state.saving = true; state.inflight = { ...changes };
    const keys = Object.keys(changes);
    mark(keys, 'saving');
    status(L('mm_saving', 'Saving…'));
    try {
      const response = await api().publication.invoke(options.orgId, 'measurements.manual.save', target, { values: changes, ...(state.revision ? { expectedRevision: state.revision } : {}) }, { idempotencyKey: `manual-measurements:${options.projectId}:${Date.now()}:${Math.random().toString(36).slice(2)}` });
      const result = response?.value || response?.result?.value || response;
      state.revision = result.storeRevision || state.revision;
      const inUse = result.inUse === 'manual' ? 'manual' : result.inUse === 'none' ? 'none' : state.form.in_use?.source;
      state.form = { ...state.form, manual: { ...(state.form.manual || {}), dataset_id: result.datasetId, store_revision: state.revision, values: result.values }, in_use: { ...(state.form.in_use || {}), source: inUse, values: inUse === 'manual' ? result.values : state.form.in_use?.values || {} } };
      mark(keys, 'saved');
      status(L('mm_saved', 'Saved. Materials, labor and pay use these numbers.'));
      options.onSaved?.(state.form);
      const focused = root.contains(document.activeElement);
      if (!focused || state.mode === 'compare' || !Object.keys(result.values || {}).length) { render(); }
      else updateProgress();
    } catch (error) {
      mark(keys, null);
      const conflicted = error?.status === 409 || error?.code === 'revision_conflict' || /revision/i.test(error?.message || '');
      status(conflicted ? L('mm_conflict', 'Someone else changed these measurements. The latest values are shown; enter yours again.') : (error?.message || L('mm_save_failed', 'The measurements could not be saved.')), true);
      if (conflicted) await reload();
    } finally {
      state.saving = false; state.inflight = {};
      if (state.pending.size) flush();
    }
  }
  function updateProgress() {
    const fields = state.form.fields || [], entered = display();
    const required = fields.filter(field => field.required), done = required.filter(field => fieldValue(field, entered) != null).length;
    const bar = root.querySelector('.smm-bar');
    if (!bar) return;
    bar.setAttribute('aria-valuenow', String(done));
    bar.firstElementChild?.style.setProperty('--done', `${required.length ? Math.round(done / required.length * 100) : 0}%`);
    const small = root.querySelector('.smm-progress small');
    if (small) small.textContent = L('mm_required_progress', '{done} of {total} required entered', { done, total: required.length });
  }
  function flush() {
    clearTimeout(state.timer);
    if (!state.pending.size) return;
    const changes = Object.fromEntries(state.pending);
    state.pending.clear();
    save(changes);
  }
  async function reload() {
    try {
      const read = await api().publication.read(options.orgId, { provider: 'measurement-schemas', export: 'manual', target });
      if (read?.status === 'ready') { state.form = read.value; state.revision = read.value.manual?.store_revision || 0; render(); options.onSaved?.(state.form); }
    } catch { /* The message already says what went wrong. */ }
  }
  function clearAll() {
    const keys = entryKeys();
    if (!keys.length) return;
    const message = state.mode === 'compare' ? L('mm_clear_entries_confirm', 'Clear the measurements you entered by hand? The report is not changed.') : L('mm_clear_all_confirm', 'Clear every measurement entered by hand for this project?');
    if (!window.confirm(message)) return;
    state.pending.clear();
    save(Object.fromEntries(keys.map(key => [key, null]))).then(() => { if (state.mode === 'compare' && !Object.keys(values()).length) options.onBack?.(); });
  }
  render();
  return {
    /** A background refresh brings a newer form. Someone typing keeps their field; nothing is redrawn under them. */
    update(form, mode, reportLinked) {
      options.reportLinked = reportLinked;
      const modeChanged = mode !== state.mode;
      if (!modeChanged && (state.saving || state.pending.size || root.contains(document.activeElement))) return;
      if (!modeChanged && JSON.stringify(form) === JSON.stringify(state.form)) return;
      // A read that started before our last save can land after it. Never go back to an older revision of the entries:
      // that is what blanked a value that had just been saved while the status still said Saved.
      if (!modeChanged && Number(form?.manual?.store_revision || 0) < state.revision) return;
      state.form = form; state.mode = mode; state.revision = form?.manual?.store_revision || state.revision;
      render();
    },
    focus() { root.querySelector('h2')?.focus({ preventScroll: true }); },
    destroy() { clearTimeout(state.timer); flush(); root.innerHTML = ''; root.classList.remove('smm'); }
  };
}
