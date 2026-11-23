// The checklists setup's steps (guided experience `checklists.setup`, docs/architecture/guided-experiences.md). One
// step module in three modes, named by the step's options:
//
// - `pick` (the default): which checklists to start with. Starts from the checklists in the step's options (data in
//   the library entry), or the ones made in an earlier play.
// - `edit` (`use_case`): one page per picked checklist (FM-600): the default checklist as it will be, to change by
//   typing or by dictating, with how to dictate shown on the page itself the first time.
// - `review`: the picked defaults side by side before they are saved.
//
// Everything stays in the setup's selections (`checklist_use_cases`, `checklist_definitions`), which the completion
// action (checklists.setup.apply) saves as the organization's default checklists. Dictation only asks the server what
// to add (`/checklists/voice`, mode `draft`); nothing is written before the setup finishes.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();
// Selections are plain values with a size limit (guided-experiences/contracts.ts `selectionsSchema`).
const plain = (value, max) => clean(value).replace(/[<>]/g, '').replace(/data:/gi, 'data ').slice(0, max);
const MAX_ITEMS = 40;
const SELECTIONS_LIMIT = 15500;
const AUDIO_SCRIPTS = [
  ['FirstMateAudioNotes', '/libraries/audio-notes/audio-notes.js?v=20260929-presence-controls-v3'],
  ['FirstMateAudioStructure', '/libraries/audio-structure/audio-structure.js?v=20260725-checklist-voice-v1']
];
const voiceIcon = '<span class="gxk-mic" aria-hidden="true"></span>';

const css = `
.gxk{display:flex;flex-direction:column;gap:18px;min-width:0;padding:4px 0 8px}
.gxk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
/* A card is the icon beside its text: the name, then a one-line description with the item count on the same line. */
.gxk-tile{position:relative;display:flex;align-items:center;gap:14px;min-height:84px;padding:18px 48px 18px 16px;border:1px solid #e4e7ec;border-radius:16px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s;animation:gxkIn .3s cubic-bezier(.22,1,.36,1) both}
.gxk-tile:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxk-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxk-icon{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:#f2f4f7;color:#344054;font-size:17px}
.gxk-text{display:block;min-width:0}
.gxk-tile strong{display:block;margin:0 0 4px;font-size:15px;font-weight:750;line-height:1.25}
.gxk-tile small{font-size:13px;color:#667085;line-height:1.4}
.gxk-tile em{font-style:normal;font-size:12px;font-weight:650;color:#475467;line-height:1.4;white-space:nowrap}
.gxk-tile small+em::before{content:" · ";color:#98a2b3}
.gxk-tile[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxk-tile[aria-pressed=true] .gxk-icon{background:var(--primary,#d93025);color:#fff}
.gxk-tick{position:absolute;top:50%;right:16px;width:22px;height:22px;margin-top:-11px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxk-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-pressed=true]>.gxk-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-pressed=true]>.gxk-tick svg{opacity:1}
.gxk-note{margin:2px 0 0;font-size:13px;color:#667085;line-height:1.45}
.gxk-all{height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:650;cursor:pointer;white-space:nowrap}
.gxk-all:hover{background:#f9fafb}
/* A default checklist being made: the list as the Checklists tab shows it, with Dictate beside it. */
.gxk-lead{margin:0;font-size:14px;color:#475467;line-height:1.5}
.gxk-tag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:11px;font-weight:700;letter-spacing:.01em;vertical-align:2px}
.gxk-tag i{font-size:10px;color:#98a2b3}
.gxk-list{border:1px solid #e4e7ec;border-radius:16px;background:#fff;overflow:hidden}
.gxk-list-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #f2f4f7}
.gxk-list-head .gxk-icon{width:36px;height:36px;border-radius:11px;background:var(--primary,#d93025);color:#fff;font-size:15px}
.gxk-list-name{flex:1;min-width:0}
.gxk-list-name strong{display:block;font-size:15px;font-weight:750;line-height:1.3}
.gxk-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.gxk-chip{font-size:11px;font-weight:650;color:#667085;background:#f9fafb;border:1px solid #eaecf0;border-radius:999px;padding:1px 8px}
.gxk-dictate-wrap{position:relative;flex:none}
.gxk-dictate{display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 14px;border:0;border-radius:11px;background:var(--primary,#d93025);color:var(--on-primary,#fff);font:inherit;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap}
.gxk-dictate:disabled{opacity:.55;cursor:default}
.gxk-dictate.gxk-pulse{animation:gxkPulse 1.8s ease-out infinite}
.gxk-mic{display:inline-block;width:16px;height:16px;flex:none;background:currentColor;mask:url(/libraries/voice-icons/dictation.svg) center/contain no-repeat;-webkit-mask:url(/libraries/voice-icons/dictation.svg) center/contain no-repeat}
.gxk-items{list-style:none;margin:0;padding:6px 8px;max-height:min(300px,38vh);overflow:auto}
.gxk-item{display:flex;align-items:center;gap:10px;padding:2px 8px;border-radius:9px}
.gxk-item:hover{background:#f9fafb}
.gxk-box{flex:none;width:16px;height:16px;border:1.5px solid #d0d5dd;border-radius:5px}
.gxk-item input{flex:1;min-width:0;height:34px;border:0;background:transparent;font:inherit;font-size:14px;color:#101828;padding:0}
.gxk-item input:focus{outline:none}
.gxk-item.gxk-new{animation:gxkNew 1.6s ease-out}
.gxk-remove{flex:none;width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:#98a2b3;font-size:16px;line-height:1;cursor:pointer;opacity:0;transition:opacity .15s}
.gxk-item:hover .gxk-remove,.gxk-remove:focus-visible{opacity:1}
.gxk-remove:hover{color:#b42318;background:#fef3f2}
.gxk-empty{margin:0;padding:14px 16px;font-size:13px;color:#667085}
.gxk-add{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #f2f4f7;background:#fcfcfd}
.gxk-add input{flex:1;min-width:0;height:36px;border:1px solid #d0d5dd;border-radius:10px;padding:0 12px;font:inherit;font-size:14px;background:#fff}
.gxk-add input:focus{outline:2px solid rgba(var(--primary-rgb,217,48,37),.25);border-color:var(--primary,#d93025)}
.gxk-add button{flex:none;height:36px;padding:0 14px;border:1px solid #d0d5dd;border-radius:10px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:650;cursor:pointer}
.gxk-voice:empty{display:none}
.gxk-voice{padding:10px 12px;border-top:1px solid #f2f4f7}
/* How to dictate, on the page itself: numbered, beside the list, pointing at Dictate. */
.gxk-tip{position:relative;display:flex;gap:12px;padding:14px 16px;border-radius:14px;background:#101828;color:#fff;font-size:13px;line-height:1.45}
.gxk-tip::before{content:"";position:absolute;bottom:-6px;right:66px;width:12px;height:12px;background:#101828;transform:rotate(45deg)}
.gxk-tip strong{display:block;font-size:14px;margin-bottom:6px}
.gxk-tip ol{margin:0;padding-left:18px}
.gxk-tip li{margin:2px 0}
.gxk-tip q{color:#fecdca}
.gxk-tip.gxk-tip-done{background:#ecfdf3;color:#05603a}
.gxk-tip.gxk-tip-done::before{display:none}
.gxk-hint{margin:0;font-size:13px;color:#667085}
.gxk-hint .gxk-mic{width:13px;height:13px;vertical-align:-2px;margin:0 2px;color:var(--primary,#d93025)}
.gxk-error{margin:0;font-size:13px;color:#b42318}
/* The defaults side by side. */
.gxk-review{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;align-items:start}
.gxk-review .gxk-list{animation:gxkIn .3s cubic-bezier(.22,1,.36,1) both}
.gxk-review .gxk-items{max-height:min(260px,34vh)}
.gxk-review .gxk-item{padding:6px 8px;font-size:13px;color:#344054}
@media(max-width:640px){.gxk{gap:20px;padding-top:8px}.gxk-grid{grid-template-columns:minmax(0,1fr);gap:14px}.gxk-tile{min-height:92px}.gxk-remove{opacity:1}.gxk-list-head{flex-wrap:wrap}.gxk-tip::before{display:none}}
@keyframes gxkIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes gxkNew{from{background:rgba(var(--primary-rgb,217,48,37),.12)}to{background:transparent}}
@keyframes gxkPulse{0%{box-shadow:0 0 0 0 rgba(var(--primary-rgb,217,48,37),.45)}70%{box-shadow:0 0 0 10px rgba(var(--primary-rgb,217,48,37),0)}100%{box-shadow:0 0 0 0 rgba(var(--primary-rgb,217,48,37),0)}}
@media(prefers-reduced-motion:reduce){.gxk *{animation:none!important;transition:none!important}}
`;
const tick = '<span class="gxk-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';

function injectCss(){
  // Replaced when this file changes (a new version of the module carries new rules).
  let style = document.getElementById('gxk-css');
  if (!style) { style = document.createElement('style'); style.id = 'gxk-css'; document.head.appendChild(style); }
  if (style.textContent !== css) style.textContent = css;
}

function loadScript(src){
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src; script.async = true;
    script.onload = resolve; script.onerror = () => reject(new Error('The recorder did not load.'));
    document.head.appendChild(script);
  });
}
/** The recorder (audio notes + structured audio), loaded here when the page has not loaded it already. */
async function audioReady(){
  for (const [name, src] of AUDIO_SCRIPTS) if (!window[name]) await loadScript(src);
  return window.FirstMateAudioStructure;
}

export function mount(el, ctx){
  injectCss();
  const mode = clean(ctx.options?.mode) || 'pick';
  // Where this setup is, for a live redraw and for an issue filed from it (guided-setup.js ctx.place). Every answer is
  // the setup's selections (kept by the player), so the place only names the page.
  ctx.place?.keep?.(() => ({ page: mode === 'edit' ? `edit:${clean(ctx.options?.use_case)}` : mode }));
  if (mode === 'edit') return mountEdit(el, ctx);
  if (mode === 'review') return mountReview(el, ctx);
  return mountPick(el, ctx);
}

function copyText(L, copy, fallback = ''){
  const value = object(copy);
  return value.key ? L(value, clean(value.text) || fallback) : clean(copy) || fallback;
}

/** The picked checklists as the setup holds them: edited ones as they were left, the rest as the library has them. */
function definitionsFor(useCases, picked, selections){
  const edited = new Map(array(selections?.checklist_definitions).map(object).filter((entry) => clean(entry.use_case)).map((entry) => [entry.use_case, entry]));
  return useCases.filter((entry) => picked.has(entry.id)).map((entry) => edited.get(entry.id) || { ...object(entry.checklist), use_case: entry.id, icon: clean(entry.icon) || 'fa-list-check' });
}

function mountPick(el, ctx){
  const { L, esc, change, actions } = ctx;
  const text = (copy, fallback) => copyText(L, copy, fallback);
  const useCases = array(ctx.options?.use_cases).map(object).filter((entry) => clean(entry.id) && Object.keys(object(entry.checklist)).length);
  const known = new Set(useCases.map((entry) => entry.id));
  const previous = array(ctx.selections?.checklist_use_cases).filter((id) => known.has(id));
  // What starts picked is data: every use case unless its entry says `selected: false` (the customer punch list, which
  // only matters once the customer portal is in use). Picks from an earlier play win.
  const picked = new Set(previous.length ? previous : useCases.filter((entry) => entry.selected !== false).map((entry) => entry.id));
  // A list with no items starts empty, for the person to fill in (the punch list is what they walk with their customer).
  const count = (entry) => {
    const items = array(object(entry.checklist).items).length;
    return items ? L('gx_cl_setup_items', '{count} items to start').replace('{count}', String(items)) : L('gx_cl_setup_empty', 'Starts empty');
  };
  const summary = () => useCases.filter((entry) => picked.has(entry.id)).map((entry) => text(entry.label)).join(', ');
  // Going back to this page and on again keeps what was changed on a checklist's own page.
  const report = () => change({
    checklist_use_cases: useCases.filter((entry) => picked.has(entry.id)).map((entry) => entry.id),
    checklist_definitions: definitionsFor(useCases, picked, ctx.selections)
  }, summary());
  el.innerHTML = `<div class="gxk">
    <div class="gxk-grid" role="group">${useCases.map((entry, index) => `<button type="button" class="gxk-tile" data-use-case="${esc(entry.id)}" aria-pressed="false" style="animation-delay:${index * 40}ms">
      <span class="gxk-icon" aria-hidden="true"><i class="fas ${esc(clean(entry.icon) || 'fa-list-check')}"></i></span>
      <span class="gxk-text"><strong>${esc(text(entry.label))}</strong><small>${esc(text(entry.description))}</small><em>${esc(count(entry))}</em></span>
      ${tick}</button>`).join('')}</div>
    <p class="gxk-note">${esc(text(ctx.options?.note, 'Next, you’ll see each one and make it yours.'))}</p>
  </div>`;
  const sync = () => {
    el.querySelectorAll('[data-use-case]').forEach((tile) => tile.setAttribute('aria-pressed', String(picked.has(tile.dataset.useCase))));
    report();
  };
  const onClick = (event) => {
    const id = event.target.closest('[data-use-case]')?.dataset.useCase;
    if (!id) return;
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    sync();
  };
  el.addEventListener('click', onClick);
  let allButton = null;
  if (actions && useCases.length > 1) {
    allButton = document.createElement('button');
    allButton.type = 'button';
    allButton.className = 'gxk-all';
    allButton.textContent = L('gx_cl_setup_all', 'Select all');
    allButton.addEventListener('click', () => { useCases.forEach((entry) => picked.add(entry.id)); sync(); });
    actions.appendChild(allButton);
  }
  sync();
  return {
    valid: () => picked.size > 0,
    hint: () => L('gx_cl_setup_hint', 'Pick at least one checklist to start with.'),
    summary,
    destroy(){ el.removeEventListener('click', onClick); allButton?.remove(); }
  };
}

function chips(L, esc, definition){
  const list = [];
  if (definition.signature_required) list.push(L('gx_cl_setup_chip_signed', 'Signed when finished'));
  if (definition.customer === 'complete') list.push(L('gx_cl_setup_chip_customer', 'Your customer ticks it off'));
  else if (definition.customer === 'view') list.push(L('gx_cl_setup_chip_customer_view', 'Your customer sees it'));
  if (definition.audience === 'supervisor') list.push(L('gx_cl_setup_chip_supervisor', 'Supervisors complete it'));
  return list.length ? `<span class="gxk-chips">${list.map((chip) => `<span class="gxk-chip">${esc(chip)}</span>`).join('')}</span>` : '';
}

function mountEdit(el, ctx){
  const { L, esc, change } = ctx;
  const text = (copy, fallback) => copyText(L, copy, fallback);
  const useCase = clean(ctx.options?.use_case);
  const selections = ctx.selections || {};
  const all = array(selections.checklist_definitions).map(object);
  const found = all.find((entry) => entry.use_case === useCase);
  // Reached without the checklist picked (it should not be: the step before branches past it): nothing to change.
  if (!found) {
    el.innerHTML = `<div class="gxk"><p class="gxk-lead">${esc(L('gx_cl_setup_not_picked', 'This checklist wasn’t picked. Continue to go on.'))}</p></div>`;
    return { valid: () => true, summary: () => '' };
  }
  const definition = { ...found, items: array(found.items).map(object).map((item) => ({ ...item, title: plain(item.title, 300) })).filter((item) => item.title) };
  const first = array(selections.checklist_use_cases)[0] === useCase;
  const projectId = clean(ctx.where?.projectId);
  const orgId = clean(ctx.orgId || window.__APP?.userOrgId);
  const canDictate = !!(projectId && orgId && window.CrewAPI?.projects?.voiceChecklistUrl);
  let dictated = 0, recording = false, error = '', fresh = new Set();

  const report = () => {
    const next = array(selections.checklist_definitions).map(object).map((entry) => entry.use_case === useCase ? { ...definition, items: definition.items.map((item) => ({ ...item })) } : entry);
    change({ checklist_definitions: next }, L('gx_cl_setup_edit_summary', '{count} items').replace('{count}', String(definition.items.length)));
  };
  const tooBig = () => JSON.stringify(selections).length > SELECTIONS_LIMIT;
  const tipHtml = () => {
    if (!canDictate) return '';
    if (dictated) return `<div class="gxk-tip gxk-tip-done" role="status"><div><strong>${esc(L('gx_cl_setup_tip_done_title', 'Added by voice'))}</strong>${esc(text(ctx.options?.tip_done, 'Change any item by typing on it, or dictate again to add more.'))}</div></div>`;
    // The first checklist teaches dictation on the page; later ones just remind.
    if (!first) return `<p class="gxk-hint">${esc(text(ctx.options?.hint_next, 'Press Dictate and say what to add, or type below.')).replace('Dictate', `${voiceIcon}Dictate`)}</p>`;
    return `<div class="gxk-tip" data-gxk-tip><div><strong>${esc(L('gx_cl_setup_tip_title', 'Add items by talking'))}</strong><ol>
      <li>${esc(L('gx_cl_setup_tip_1', 'Press Dictate.'))}</li>
      <li>${esc(text(ctx.options?.tip_say, 'Say what to add, like “check the gutters and take a photo of the driveway”.'))}</li>
      <li>${esc(L('gx_cl_setup_tip_3', 'Press the arrow. We’ll add the items to this list.'))}</li></ol></div></div>`;
  };
  const itemsHtml = () => definition.items.length
    ? `<ul class="gxk-items">${definition.items.map((item, index) => `<li class="gxk-item${fresh.has(item) ? ' gxk-new' : ''}"><span class="gxk-box" aria-hidden="true"></span><input data-gxk-item="${index}" value="${esc(item.title)}" maxlength="300" aria-label="${esc(L('gx_cl_setup_item_label', 'Checklist item'))}"><button type="button" class="gxk-remove" data-gxk-remove="${index}" aria-label="${esc(L('gx_cl_setup_remove', 'Remove item'))}" title="${esc(L('gx_cl_setup_remove', 'Remove item'))}">&times;</button></li>`).join('')}</ul>`
    : `<p class="gxk-empty">${esc(text(ctx.options?.empty, 'No items yet. Add them by typing or by voice, or leave it empty and fill it in on each job.'))}</p>`;
  // The page is drawn once; the items, the tip and Dictate are redrawn in place, so the recorder under Dictate keeps
  // running while items are typed.
  el.innerHTML = `<div class="gxk" data-gxk-edit="${esc(useCase)}">
    <p class="gxk-lead">${esc(first ? text(ctx.options?.lead_first, 'This is a default checklist: every new project starts with it. Make it fit how you work.') : text(ctx.options?.lead_next, 'Set up your next default checklist. Change what you need, then continue.'))}</p>
    <div data-gxk-tip-slot></div>
    <div class="gxk-list">
      <div class="gxk-list-head"><span class="gxk-icon" aria-hidden="true"><i class="fas ${esc(clean(definition.icon) || 'fa-list-check')}"></i></span>
        <span class="gxk-list-name"><strong>${esc(definition.title)} <span class="gxk-tag" title="${esc(L('gx_cl_setup_default_tip', 'Every new project starts with this checklist.'))}"><i class="fas fa-thumbtack" aria-hidden="true"></i>${esc(L('gx_cl_setup_default', 'Default'))}</span></strong>${chips(L, esc, definition)}</span>
        ${canDictate ? `<span class="gxk-dictate-wrap"><button type="button" class="gxk-dictate" data-gxk-dictate>${voiceIcon}${esc(L('gx_cl_setup_dictate', 'Dictate'))}</button></span>` : ''}
      </div>
      <div class="gxk-voice" data-gxk-voice></div>
      <div data-gxk-items></div>
      <div class="gxk-add"><input data-gxk-new maxlength="300" placeholder="${esc(L('gx_cl_setup_add_placeholder', 'Add an item…'))}" aria-label="${esc(L('gx_cl_setup_add_placeholder', 'Add an item…'))}"><button type="button" data-gxk-add>${esc(L('gx_cl_setup_add', 'Add'))}</button></div>
    </div>
    <p class="gxk-error" role="alert" data-gxk-error hidden></p>
  </div>`;
  const render = () => {
    el.querySelector('[data-gxk-items]').innerHTML = itemsHtml();
    el.querySelector('[data-gxk-tip-slot]').innerHTML = tipHtml();
    const button = el.querySelector('[data-gxk-dictate]');
    if (button) { button.disabled = recording; button.classList.toggle('gxk-pulse', first && !dictated && !recording); }
    const message = el.querySelector('[data-gxk-error]');
    message.textContent = error; message.hidden = !error;
    fresh = new Set();
  };
  const add = (titles, focus = true) => {
    const known = new Set(definition.items.map((item) => item.title.toLowerCase()));
    let added = 0;
    for (const entry of titles) {
      const title = plain(entry.title, 300);
      if (!title || known.has(title.toLowerCase()) || definition.items.length >= MAX_ITEMS) continue;
      const item = { title, item_type: entry.item_type === 'rating' ? 'rating' : 'todo' };
      definition.items.push(item); fresh.add(item); known.add(title.toLowerCase()); added += 1;
    }
    report(); render();
    const list = el.querySelector('.gxk-items'); if (list) list.scrollTop = list.scrollHeight;
    if (focus) el.querySelector('[data-gxk-new]')?.focus();
    return added;
  };
  const typed = () => {
    const input = el.querySelector('[data-gxk-new]');
    const title = plain(input?.value, 300);
    if (!title) return;
    error = definition.items.length >= MAX_ITEMS ? L('gx_cl_setup_full', 'A checklist holds up to 40 items.') : '';
    if (add([{ title }])) input.value = '';
  };
  const dictate = async () => {
    if (recording) return;
    recording = true; error = ''; report(); render();
    const mountEl = el.querySelector('[data-gxk-voice]');
    try {
      const audio = await audioReady();
      if (!audio?.recordAndProcess) throw new Error(L('gx_cl_setup_no_recorder', 'Dictation isn’t available here. Type the items instead.'));
      const result = await audio.recordAndProcess({
        mount: mountEl,
        url: window.CrewAPI.projects.voiceChecklistUrl(orgId, projectId),
        processingLabel: L('gx_cl_setup_listening', 'Adding what you said…'),
        fields: { mode: 'draft', title: definition.title, items: JSON.stringify(definition.items.map((item) => ({ title: item.title, item_type: item.item_type }))) }
      });
      recording = false;
      const heard = array(result?.data?.added).map(object);
      const known = new Set(definition.items.map((item) => item.title.toLowerCase()));
      // Counted before the list is redrawn, so the tip turns into what was added.
      const count = heard.filter((entry) => plain(entry.title, 300) && !known.has(plain(entry.title, 300).toLowerCase())).length;
      dictated += count;
      if (!count) error = L('gx_cl_setup_nothing_added', 'Nothing new was heard to add. Try again, or type it.');
      add(heard, false);
    } catch (failure) {
      recording = false; report();
      if (!/cancel/i.test(clean(failure?.message))) error = clean(failure?.message) || L('gx_cl_setup_dictate_failed', 'That didn’t work. Try again, or type it.');
      render();
    }
  };
  const onClick = (event) => {
    if (event.target.closest('[data-gxk-dictate]')) return void dictate();
    if (event.target.closest('[data-gxk-add]')) return typed();
    const remove = event.target.closest('[data-gxk-remove]');
    if (remove) { definition.items.splice(Number(remove.dataset.gxkRemove), 1); error = ''; report(); render(); }
  };
  const onKey = (event) => {
    if (event.key === 'Enter' && event.target.matches('[data-gxk-new]')) { event.preventDefault(); typed(); }
    else if (event.key === 'Enter' && event.target.matches('[data-gxk-item]')) { event.preventDefault(); event.target.blur(); }
  };
  const onInput = (event) => {
    const input = event.target.closest('[data-gxk-item]');
    if (!input) return;
    const item = definition.items[Number(input.dataset.gxkItem)];
    if (item) { item.title = plain(input.value, 300); report(); }
  };
  // An item emptied by typing goes when the field is left.
  const onBlur = (event) => {
    if (!event.target.matches?.('[data-gxk-item]') || clean(event.target.value)) return;
    definition.items.splice(Number(event.target.dataset.gxkItem), 1); report(); render();
  };
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKey);
  el.addEventListener('input', onInput);
  el.addEventListener('focusout', onBlur);
  render();
  report();
  return {
    valid: () => !recording && !tooBig(),
    hint: () => recording ? L('gx_cl_setup_hint_recording', 'Finish dictating first.') : L('gx_cl_setup_hint_size', 'These checklists are too long to save. Shorten some items.'),
    summary: () => L('gx_cl_setup_edit_summary', '{count} items').replace('{count}', String(definition.items.length)),
    destroy(){ el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey); el.removeEventListener('input', onInput); el.removeEventListener('focusout', onBlur); }
  };
}

function mountReview(el, ctx){
  const { L, esc } = ctx;
  const text = (copy, fallback) => copyText(L, copy, fallback);
  const picked = new Set(array(ctx.selections?.checklist_use_cases));
  const lists = array(ctx.selections?.checklist_definitions).map(object).filter((entry) => picked.has(entry.use_case));
  const note = text(ctx.options?.note, 'Going forward, every new project starts with these {count} checklists. Lists you make on a project are just for that project.')
    .replace('{count}', String(lists.length));
  el.innerHTML = `<div class="gxk">
    <div class="gxk-review">${lists.map((definition, index) => `<section class="gxk-list" data-gxk-review="${esc(definition.use_case)}" style="animation-delay:${index * 60}ms">
      <div class="gxk-list-head"><span class="gxk-icon" aria-hidden="true"><i class="fas ${esc(clean(definition.icon) || 'fa-list-check')}"></i></span>
        <span class="gxk-list-name"><strong>${esc(definition.title)}</strong>${chips(L, esc, definition)}</span></div>
      ${array(definition.items).length ? `<ul class="gxk-items">${array(definition.items).map((item) => `<li class="gxk-item"><span class="gxk-box" aria-hidden="true"></span>${esc(object(item).title)}</li>`).join('')}</ul>` : `<p class="gxk-empty">${esc(L('gx_cl_setup_review_empty', 'Starts empty: fill it in on each job.'))}</p>`}
    </section>`).join('')}</div>
    <p class="gxk-note">${esc(note)}</p>
  </div>`;
  return {
    valid: () => lists.length > 0,
    hint: () => L('gx_cl_setup_hint', 'Pick at least one checklist to start with.'),
    summary: () => lists.map((definition) => clean(definition.title)).join(', ')
  };
}
export default mount;
