// The checklists setup's step (guided experience `checklists.setup`, docs/architecture/guided-experiences.md): which
// checklists to start with. A step module: the player loads it, mounts it in the standard step frame and keeps what it
// reports with change() as the setup's selections, which the completion action (checklists.setup.apply) receives.
// The checklists themselves (title, items, who completes them, signature, customer access) are the step's options in
// the library entry; this only lets the person pick and hands the picked ones back. It reads and writes nothing.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

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
.gxk-tile small+em::before{content:"\u00a0\u00b7\u00a0";color:#98a2b3}
.gxk-tile[aria-pressed=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.05);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxk-tile[aria-pressed=true] .gxk-icon{background:var(--primary,#d93025);color:#fff}
.gxk-tick{position:absolute;top:50%;right:16px;width:22px;height:22px;margin-top:-11px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxk-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-pressed=true]>.gxk-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-pressed=true]>.gxk-tick svg{opacity:1}
.gxk-note{margin:2px 0 0;font-size:13px;color:#667085;line-height:1.45}
.gxk-all{height:32px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:13px;font-weight:650;cursor:pointer;white-space:nowrap}
.gxk-all:hover{background:#f9fafb}
@media(max-width:640px){.gxk{gap:20px;padding-top:8px}.gxk-grid{grid-template-columns:minmax(0,1fr);gap:14px}.gxk-tile{min-height:92px}}
@keyframes gxkIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
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
  // What starts picked is data: every use case unless its entry says `selected: false` (the customer punch list, which
  // only matters once the customer portal is in use). Picks from an earlier play win.
  const picked = new Set(previous.length ? previous : useCases.filter((entry) => entry.selected !== false).map((entry) => entry.id));
  // A list with no items starts empty, for the person to fill in (the punch list is what they walk with their customer).
  const count = (entry) => {
    const items = array(object(entry.checklist).items).length;
    return items ? L('gx_cl_setup_items', '{count} items to start', { count: items }).replace('{count}', String(items)) : L('gx_cl_setup_empty', 'Starts empty');
  };
  const summary = () => useCases.filter((entry) => picked.has(entry.id)).map((entry) => text(entry.label)).join(', ');
  const report = () => change({
    checklist_use_cases: useCases.filter((entry) => picked.has(entry.id)).map((entry) => entry.id),
    checklist_definitions: useCases.filter((entry) => picked.has(entry.id)).map((entry) => ({ ...object(entry.checklist), use_case: entry.id }))
  }, summary());
  el.innerHTML = `<div class="gxk">
    <div class="gxk-grid" role="group">${useCases.map((entry, index) => `<button type="button" class="gxk-tile" data-use-case="${esc(entry.id)}" aria-pressed="false" style="animation-delay:${index * 40}ms">
      <span class="gxk-icon" aria-hidden="true"><i class="fas ${esc(clean(entry.icon) || 'fa-list-check')}"></i></span>
      <span class="gxk-text"><strong>${esc(text(entry.label))}</strong><small>${esc(text(entry.description))}</small><em>${esc(count(entry))}</em></span>
      ${tick}</button>`).join('')}</div>
    <p class="gxk-note">${esc(text(ctx.options?.note, 'You can change them any time, by typing or by voice.'))}</p>
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
