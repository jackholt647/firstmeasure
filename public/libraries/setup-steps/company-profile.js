// The company setup steps' own code (docs/architecture/setup-steps.md): "What kind of company are you?" (part `type`)
// and "What kind of work do you do?" (part `services`). A setup-step module: the player loads it, mounts it in the
// standard step frame and saves `answer()` with the step's action (company-profile.save). Everything it shows is read
// through the publication layer: the catalog (company-profile.catalog) and what was answered before
// (company-profile.profile). It writes nothing itself.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
const fold = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const OTHER = 'other';
// Offered when the kind of company has no suggestions of its own (Other): the most common kinds of work.
const COMMON = ['roof_replacement', 'siding', 'gutters', 'windows', 'painting_exterior', 'remodeling', 'hvac_install', 'plumbing_repair', 'electrical_repair', 'landscape_design'];

const css = `
.gxc{display:flex;flex-direction:column;gap:14px;min-width:0;padding-bottom:6px}
.gxc-search{position:relative;display:flex;align-items:center}
.gxc-search svg{position:absolute;left:13px;width:17px;height:17px;stroke:#667085;fill:none;stroke-width:2;pointer-events:none}
.gxc-input{width:100%;height:46px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;padding:0 14px 0 40px;font:inherit;font-size:15px;color:#101828;outline:none;transition:border-color .15s,box-shadow .15s}
.gxc-input.plain{padding-left:14px}
.gxc-input::placeholder{color:#98a2b3}
.gxc-input:focus{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxc-input::-webkit-search-cancel-button{display:none}
.gxc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
.gxc-tile{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:3px;min-height:72px;padding:12px 40px 12px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s;animation:gxcIn .3s cubic-bezier(.22,1,.36,1) both}
.gxc-tile:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxc-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxc-tile strong{font-size:14px;font-weight:700;line-height:1.25}
.gxc-tile small{font-size:12px;color:#667085;line-height:1.35}
.gxc-tile[aria-selected=true],.gxc-tile[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxc-tick{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxc-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-selected=true]>.gxc-tick,[aria-pressed=true]>.gxc-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-selected=true]>.gxc-tick svg,[aria-pressed=true]>.gxc-tick svg{opacity:1}
.gxc-tile.gxc-other-tile{border-style:dashed}
.gxc-tile.gxc-service{min-height:54px;justify-content:center}
.gxc-other{display:flex;flex-direction:column;gap:6px;animation:gxcIn .25s ease both}
.gxc-other label,.gxc-lead{font-size:13px;font-weight:650;color:#344054}
.gxc-lead{margin:0}
.gxc-empty{margin:0;color:#667085;font-size:13px}
.gxc-combo{position:relative}
.gxc-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:30;margin:0;padding:6px;list-style:none;background:#fff;border:1px solid #e4e7ec;border-radius:12px;box-shadow:0 16px 40px rgba(16,24,40,.16);max-height:260px;overflow:auto}
.gxc-menu li{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;border-radius:8px;font-size:14px;color:#101828;cursor:pointer}
.gxc-menu li small{color:#667085;font-size:12px}
.gxc-menu li[aria-selected=true]{background:rgba(var(--primary-rgb,217,48,37),.08)}
.gxc-menu li.gxc-add{color:var(--primary-readable,var(--primary,#d93025));font-weight:650}
.gxc-tags{display:flex;flex-wrap:wrap;gap:8px}
.gxc-tag{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 6px 0 12px;border-radius:999px;border:1px solid var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);font-size:13px;font-weight:650;color:#101828}
.gxc-tag button{width:22px;height:22px;border:0;border-radius:50%;background:transparent;color:#475467;font-size:16px;line-height:1;cursor:pointer}
.gxc-tag button:hover{background:rgba(16,24,40,.06)}
.gxc-all{height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:650;cursor:pointer;white-space:nowrap}
.gxc-all:hover{background:#f9fafb}
.gxc-all:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxc-loading{display:grid;place-items:center;min-height:160px}
.gxc-error{color:#b42318;font-size:13px;margin:0}
@keyframes gxcIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media(max-width:560px){.gxc-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.gxc-tile{min-height:64px;padding:10px 34px 10px 12px}.gxc-tile.gxc-service{min-height:56px}.gxc-tile small{display:none}.gxc-tick{top:8px;right:8px;width:20px;height:20px}}
@media(prefers-reduced-motion:reduce){.gxc *{animation:none!important;transition:none!important}}
`;
const searchIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const tick = '<span class="gxc-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';

function installStyle(){
  if (document.getElementById('gx-company-profile-style')) return;
  const style = document.createElement('style'); style.id = 'gx-company-profile-style'; style.textContent = css; document.head.append(style);
}

/** How well an entry matches what was typed: its label first, then the words people use for it. 0 is no match. */
export function score(entry, label, query){
  const q = fold(query); if (!q) return 1;
  const name = fold(label), terms = array(entry.terms).map(fold);
  if (name === q || terms.includes(q)) return 100;
  if (name.startsWith(q)) return 80;
  if (terms.some((term) => term.startsWith(q))) return 70;
  if (name.split(' ').some((word) => word.startsWith(q))) return 60;
  const words = [name, ...terms].join(' ').split(' ');
  const tokens = q.split(' ');
  if (tokens.every((token) => words.some((word) => word.startsWith(token)))) return 40;
  if (terms.some((term) => q.includes(term) && term.length > 3)) return 30;
  return 0;
}

export function mount(el, ctx){
  installStyle();
  const L = ctx.L, esc = ctx.esc;
  const t = (key, fallback) => esc(L(`gx_step_${key}`, fallback));
  const label = (entry) => L(entry.label);
  const part = ctx.options.part === 'services' ? 'services' : 'type';
  const answer = object(ctx.answer);
  let alive = true, catalog = null, profile = null, ui = null;
  el.innerHTML = '<div class="gxc-loading"><span class="gxs-spin" aria-hidden="true"></span></div>';

  Promise.all([ctx.read('company-profile', 'catalog'), ctx.read('company-profile', 'profile').catch(() => null)]).then(([read, current]) => {
    if (!alive) return;
    catalog = object(read); profile = object(current);
    ui = part === 'type' ? typePart() : servicesPart();
    ctx.change({}, ui.summary());
  }).catch((error) => {
    if (!alive) return;
    el.innerHTML = `<p class="gxc-error" role="alert">${esc(error?.message || L('gx_step_load_failed', 'This didn’t load. Close the setup and try again.'))}</p>`;
  });

  // ── What kind of company are you? ─────────────────────────────────────
  function typePart(){
    const types = array(catalog.company_types);
    const services = new Map(array(catalog.services).map((entry) => [entry.id, entry]));
    let chosen = clean(answer.company_type) || clean(profile.company_type);
    let other = clean(answer.company_type_other) || clean(profile.company_type_other);
    el.innerHTML = `<div class="gxc"><div class="gxc-search">${searchIcon}<input type="search" class="gxc-input" data-search autocomplete="off" spellcheck="false" placeholder="${t('company_type_search', 'Search, for example “roofer”')}" aria-label="${t('company_type_search_label', 'Search kinds of company')}"></div>
      <div class="gxc-grid" role="listbox" aria-label="${t('company_type_list', 'Kinds of company')}" data-list></div>
      <div class="gxc-other" data-other-box hidden><label for="gxc-other-input">${t('company_type_other_label', 'What kind of company are you?')}</label><input id="gxc-other-input" class="gxc-input plain" data-other maxlength="120" autocomplete="off" placeholder="${t('company_type_other_placeholder', 'For example, chimney sweep')}"></div></div>`;
    const search = el.querySelector('[data-search]'), list = el.querySelector('[data-list]'), box = el.querySelector('[data-other-box]'), otherInput = el.querySelector('[data-other]');
    otherInput.value = other;
    const hint = (entry) => entry.services.slice(0, 3).map((id) => services.get(id)).filter(Boolean).map(label).join(', ');
    function draw(){
      const query = search.value;
      const found = types.map((entry) => ({ entry, score: score(entry, label(entry), query) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || 0);
      const otherText = clean(query) && !found.length ? clean(query) : '';
      list.innerHTML = found.map(({ entry }) => `<button type="button" class="gxc-tile" role="option" data-type="${esc(entry.id)}" aria-selected="${chosen === entry.id}"><strong>${esc(label(entry))}</strong><small>${esc(hint(entry))}</small>${tick}</button>`).join('')
        + `<button type="button" class="gxc-tile gxc-other-tile" role="option" data-type="${OTHER}" ${otherText ? `data-words="${esc(otherText)}"` : ''} aria-selected="${chosen === OTHER}"><strong>${otherText ? `${t('company_type_other_named', 'Other:')} “${esc(otherText)}”` : t('company_type_other', 'Other')}</strong><small>${t('company_type_other_hint', 'Something else? Tell us in your own words.')}</small>${tick}</button>`;
      box.hidden = chosen !== OTHER;
    }
    /** Marks the choice on the tiles already drawn. A click never redraws the tile it landed on. */
    function sync(){
      list.querySelectorAll('[data-type]').forEach((tile) => tile.setAttribute('aria-selected', String(tile.dataset.type === chosen)));
      box.hidden = chosen !== OTHER;
    }
    function report(){
      const type = types.find((entry) => entry.id === chosen);
      ctx.change(chosen === OTHER ? { company_type: OTHER, company_type_other: clean(otherInput.value) } : { company_type: chosen, company_type_other: '' }, summary());
      if (type) other = '';
    }
    function choose(id, words){
      chosen = id;
      if (id === OTHER && words && !clean(otherInput.value)) otherInput.value = words;
      sync(); report();
      if (id === OTHER) otherInput.focus();
    }
    function summary(){
      if (chosen === OTHER) return clean(otherInput.value);
      const type = types.find((entry) => entry.id === chosen);
      return type ? label(type) : '';
    }
    const onClick = (event) => { const tile = event.target.closest('[data-type]'); if (tile) choose(tile.dataset.type, tile.dataset.words || ''); };
    const onInput = (event) => { if (event.target === search) draw(); if (event.target === otherInput) report(); };
    const onKey = (event) => {
      // Enter in the search picks the best match (or Other with the words typed).
      if (event.target === search && event.key === 'Enter') { event.preventDefault(); const first = list.querySelector('[data-type]'); if (first && clean(search.value)) choose(first.dataset.type, first.dataset.words || ''); }
      if (event.target === otherInput && event.key === 'Enter' && clean(otherInput.value)) { event.preventDefault(); ctx.advance(); }
    };
    el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('keydown', onKey);
    draw();
    if (chosen) report();
    setTimeout(() => { if (alive && !chosen) search.focus({ preventScroll: true }); }, 480);
    return {
      summary,
      valid: () => chosen === OTHER ? !!clean(otherInput.value) : !!types.find((entry) => entry.id === chosen),
      hint: () => chosen === OTHER ? L('gx_step_company_type_other_hint_required', 'Say what kind of company you are.') : L('gx_step_company_type_hint', 'Choose the kind of company you are.'),
      answer: () => chosen === OTHER ? { company_type: OTHER, company_type_other: clean(otherInput.value) } : { company_type: chosen },
      destroy(){ el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); el.removeEventListener('keydown', onKey); }
    };
  }

  // ── What kind of work do you do? ──────────────────────────────────────
  function servicesPart(){
    const all = array(catalog.services);
    const byId = new Map(all.map((entry) => [entry.id, entry]));
    const type = array(catalog.company_types).find((entry) => entry.id === clean(profile.company_type));
    const suggested = (type ? type.services : COMMON).filter((id) => byId.has(id));
    const savedIds = array(profile.services).map((entry) => entry.id);
    const picked = new Set(array(answer.services).length || array(answer.services_other).length ? array(answer.services) : savedIds);
    const others = [...new Set(array(answer.services).length || array(answer.services_other).length ? array(answer.services_other) : array(profile.services_other))];
    // Shown as tiles: the suggestions for this kind of company, then anything else picked (found in the search).
    const shown = [...suggested, ...[...picked].filter((id) => !suggested.includes(id))];
    const lead = type ? L('gx_step_company_services_lead', 'Common for a {type}').replace('{type}', label(type).toLowerCase()) : L('gx_step_company_services_lead_other', 'Common kinds of work');
    el.innerHTML = `<div class="gxc"><p class="gxc-lead">${esc(lead)}</p><div class="gxc-grid" role="group" aria-label="${t('company_services_list', 'Kinds of work')}" data-list></div>
      <div class="gxc-tags" data-tags></div>
      <div class="gxc-combo"><div class="gxc-search">${searchIcon}<input type="search" class="gxc-input" data-search role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="gxc-service-menu" autocomplete="off" spellcheck="false" placeholder="${t('company_services_search_more', 'Search for something else')}" aria-label="${t('company_services_search_label', 'Search all kinds of work')}"></div><ul class="gxc-menu" id="gxc-service-menu" role="listbox" data-menu hidden></ul></div></div>`;
    const list = el.querySelector('[data-list]'), tags = el.querySelector('[data-tags]'), search = el.querySelector('[data-search]'), menu = el.querySelector('[data-menu]');
    let results = [], active = 0;
    if (ctx.actions) {
      ctx.actions.innerHTML = `<button type="button" class="gxc-all" data-all>${t('company_services_all', 'Select all')}</button>`;
    }
    function draw(){
      list.innerHTML = shown.map((id) => byId.get(id)).filter(Boolean).map((entry) => `<button type="button" class="gxc-tile gxc-service" data-service="${esc(entry.id)}" aria-pressed="${picked.has(entry.id)}"><strong>${esc(label(entry))}</strong>${tick}</button>`).join('');
      tags.innerHTML = others.map((words, i) => `<span class="gxc-tag">${esc(words)}<button type="button" data-remove="${i}" aria-label="${t('company_services_remove', 'Remove')} ${esc(words)}">×</button></span>`).join('');
      tags.hidden = !others.length;
      sync();
    }
    /** The pressed state of the tiles already drawn, and the title row's button. A press never redraws its own tile. */
    function sync(){
      list.querySelectorAll('[data-service]').forEach((tile) => tile.setAttribute('aria-pressed', String(picked.has(tile.dataset.service))));
      const allButton = ctx.actions?.querySelector('[data-all]');
      if (allButton) allButton.textContent = suggested.every((id) => picked.has(id)) ? L('gx_step_company_services_none', 'Clear') : L('gx_step_company_services_all', 'Select all');
      report();
    }
    function summary(){ return [...[...picked].map((id) => byId.get(id)).filter(Boolean).map(label), ...others].join(', '); }
    function report(){ ctx.change({ services: [...picked], services_other: [...others] }, summary()); }
    function openMenu(){
      const query = clean(search.value);
      if (!query) { closeMenu(); return; }
      results = all.map((entry) => ({ entry, score: score(entry, label(entry), query) })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map((row) => row.entry);
      const exact = results.some((entry) => fold(label(entry)) === fold(query));
      const rows = results.map((entry, i) => `<li role="option" id="gxc-opt-${i}" data-pick="${esc(entry.id)}" aria-selected="${i === active}"><span>${esc(label(entry))}</span>${picked.has(entry.id) ? `<small>${t('company_services_added', 'Added')}</small>` : ''}</li>`);
      if (!exact) rows.push(`<li role="option" id="gxc-opt-${results.length}" class="gxc-add" data-add aria-selected="${active === results.length}">${t('company_services_add', 'Add')} “${esc(query)}”</li>`);
      menu.innerHTML = rows.join('');
      menu.hidden = false; search.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-activedescendant', `gxc-opt-${active}`);
    }
    function closeMenu(){ menu.hidden = true; active = 0; search.setAttribute('aria-expanded', 'false'); search.removeAttribute('aria-activedescendant'); }
    function pick(node){
      if (!node) return;
      if (node.dataset.pick) { const id = node.dataset.pick; picked.add(id); if (!shown.includes(id)) shown.push(id); }
      else if (node.hasAttribute('data-add')) { const words = clean(search.value).slice(0, 120); if (words && !others.some((entry) => fold(entry) === fold(words))) others.push(words); }
      search.value = ''; closeMenu(); draw(); search.focus();
    }
    const onClick = (event) => {
      const tile = event.target.closest('[data-service]');
      if (tile) { const id = tile.dataset.service; if (picked.has(id)) picked.delete(id); else picked.add(id); sync(); return; }
      const remove = event.target.closest('[data-remove]');
      // Removing a tag redraws the tags after this click has finished.
      if (remove) { const at = Number(remove.dataset.remove); setTimeout(() => { if (!alive) return; others.splice(at, 1); draw(); }, 0); return; }
      const option = event.target.closest('[data-pick],[data-add]');
      if (option) pick(option);
    };
    const onAll = (event) => { if (!event.target.closest('[data-all]')) return; const every = suggested.every((id) => picked.has(id)); suggested.forEach((id) => every ? picked.delete(id) : picked.add(id)); sync(); };
    const onInput = (event) => { if (event.target === search) { active = 0; openMenu(); } };
    const onKey = (event) => {
      if (event.target !== search) return;
      const count = menu.querySelectorAll('[role=option]').length;
      if (event.key === 'ArrowDown' && count) { event.preventDefault(); active = (active + 1) % count; openMenu(); }
      else if (event.key === 'ArrowUp' && count) { event.preventDefault(); active = (active - 1 + count) % count; openMenu(); }
      else if (event.key === 'Enter' && !menu.hidden) { event.preventDefault(); pick(menu.querySelectorAll('[role=option]')[active]); }
    };
    const onOutside = (event) => { if (!event.target.closest?.('.gxc-combo')) closeMenu(); };
    el.addEventListener('click', onClick); el.addEventListener('input', onInput); el.addEventListener('keydown', onKey, true);
    ctx.actions?.addEventListener('click', onAll);
    document.addEventListener('pointerdown', onOutside, true);
    draw();
    return {
      summary,
      valid: () => picked.size + others.length > 0,
      hint: () => L('gx_step_company_services_hint', 'Pick at least one kind of work.'),
      answer: () => ({ services: [...picked], services_other: [...others] }),
      // The player hands Escape here first: an open dropdown closes, and the setup stays.
      escape: () => { if (menu.hidden) return false; closeMenu(); search.focus(); return true; },
      destroy(){ el.removeEventListener('click', onClick); el.removeEventListener('input', onInput); el.removeEventListener('keydown', onKey, true); ctx.actions?.removeEventListener('click', onAll); document.removeEventListener('pointerdown', onOutside, true); if (ctx.actions) ctx.actions.innerHTML = ''; }
    };
  }

  return {
    valid: () => !!ui && ui.valid(),
    hint: () => ui?.hint() || '',
    summary: () => ui?.summary() || '',
    answer: () => ui?.answer(),
    escape: () => ui?.escape?.() === true,
    destroy(){ alive = false; ui?.destroy(); }
  };
}
