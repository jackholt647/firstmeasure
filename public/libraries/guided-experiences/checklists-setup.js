// The checklists setup's step (guided experience `checklists.setup`, docs/architecture/guided-experiences.md): which
// checklists to start with. A step module: the player loads it, mounts it in the standard step frame and keeps what it
// reports with change() as the setup's selections, which the completion action (checklists.setup.apply) receives.
// The checklists themselves (title, items, who completes them, signature, customer access) are the step's options in
// the library entry; this only lets the person pick and hands the picked ones back. It reads and writes nothing.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

const css = `
.gxk{display:flex;flex-direction:column;gap:12px;min-width:0;padding-bottom:6px}
.gxk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.gxk-tile{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-height:132px;padding:14px 40px 14px 14px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s;animation:gxkIn .3s cubic-bezier(.22,1,.36,1) both}
.gxk-tile:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxk-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxk-icon{width:32px;height:32px;border-radius:10px;display:grid;place-items:center;background:#f2f4f7;color:#344054;font-size:15px}
.gxk-tile strong{font-size:14px;font-weight:750;line-height:1.25}
.gxk-tile small{font-size:12px;color:#667085;line-height:1.4}
.gxk-tile em{font-style:normal;font-size:11px;font-weight:700;color:#475467}
.gxk-tile[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxk-tile[aria-pressed=true] .gxk-icon{background:var(--primary,#d93025);color:#fff}
.gxk-tick{position:absolute;top:12px;right:12px;width:22px;height:22px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxk-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-pressed=true]>.gxk-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-pressed=true]>.gxk-tick svg{opacity:1}
.gxk-note{margin:0;font-size:12.5px;color:#475467;line-height:1.45}
.gxk-all{height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:650;cursor:pointer;white-space:nowrap}
.gxk-all:hover{background:#f9fafb}
@keyframes gxkIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media(max-width:560px){.gxk-grid{grid-template-columns:1fr}.gxk-tile{min-height:0}}
@media(prefers-reduced-motion:reduce){.gxk *{animation:none!important;transition:none!important}}
`;
const tick = '<span class="gxk-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';

export function mount(el, ctx){
  const { L, esc, change, actions } = ctx;
  const text = (copy, fallback = '') => { const value = object(copy); return value.key ? L(value.key, clean(value.text) || fallback) : clean(copy) || fallback; };
  if (!document.getElementById('gxk-css')) {
    const style = document.createElement('style');
    style.id = 'gxk-css';
    style.textContent = css;
    document.head.appendChild(style);
  }
  const useCases = array(ctx.options?.use_cases).map(object).filter((entry) => clean(entry.id) && Object.keys(object(entry.checklist)).length);
  const known = new Set(useCases.map((entry) => entry.id));
  const previous = array(ctx.selections?.checklist_use_cases).filter((id) => known.has(id));
  // Everything starts picked: most companies want all three, and taking one out is a single press.
  const picked = new Set(previous.length ? previous : useCases.map((entry) => entry.id));
  const summary = () => useCases.filter((entry) => picked.has(entry.id)).map((entry) => text(entry.label)).join(', ');
  const report = () => change({
    checklist_use_cases: useCases.filter((entry) => picked.has(entry.id)).map((entry) => entry.id),
    checklist_definitions: useCases.filter((entry) => picked.has(entry.id)).map((entry) => ({ ...object(entry.checklist), use_case: entry.id }))
  }, summary());
  el.innerHTML = `<div class="gxk">
    <div class="gxk-grid" role="group">${useCases.map((entry, index) => `<button type="button" class="gxk-tile" data-use-case="${esc(entry.id)}" aria-pressed="false" style="animation-delay:${index * 40}ms">
      <span class="gxk-icon" aria-hidden="true"><i class="fas ${esc(clean(entry.icon) || 'fa-list-check')}"></i></span>
      <strong>${esc(text(entry.label))}</strong>
      <small>${esc(text(entry.description))}</small>
      ${array(object(entry.checklist).items).length ? `<em>${esc(L('gx_cl_setup_items', '{count} items to start', { count: array(object(entry.checklist).items).length }).replace('{count}', String(array(object(entry.checklist).items).length)))}</em>` : ''}
      ${tick}</button>`).join('')}</div>
    <p class="gxk-note">${esc(text(ctx.options?.note, 'They go on this project, and you can change every one of them afterwards, by typing or by voice.'))}</p>
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
export default mount;
