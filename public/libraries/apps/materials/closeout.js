/* Paying out a work order and closing out a project, from the Project tab.
 *
 * Both use the same two platform widgets: work.completion (confirm what is done) and project.photos.review (the
 * photos to look at beside it). Paying out finalizes one work order (labor.list.finalize); closing out walks through
 * the project-closeout.checks steps, which warn and never block, then finalizes every remaining work order and
 * records the project's finances as finished (project-closeout.close). Everything is read and invoked through the
 * published data layer; the Project tab passes in a small host object (see `host` below). */
const base = new URL('./', import.meta.url);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (iso) => { const date = new Date(iso); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''; };
const key = (prefix) => `${prefix}:${globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)}`;
const STEP_LETTERS = 'abcdefg';
const STEP_ICONS = { change_orders: 'fa-file-signature', signatures: 'fa-pen-nib', payments: 'fa-money-bill-wave', requirements: 'fa-list-check', receipts: 'fa-receipt', expenses: 'fa-scale-balanced', work_orders: 'fa-flag-checkered' };

function loadScript(url) {
  return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = url; script.onload = resolve; script.onerror = () => reject(Error('A widget could not load.')); document.head.append(script); });
}
let widgetsReady = null;
/** The widget runtime and the completion widgets. Their definitions come from catalog.json; a page that cached an older catalog registers the two from a fresh copy. */
export function ensureWidgets() {
  return widgetsReady ||= (async () => {
    if (!window.FirstMateWidgets) await loadScript(new URL('../../platform-widgets/runtime.js?v=20261014-completion', base).href);
    const W = window.FirstMateWidgets;
    await W.ready;
    const wanted = ['work.completion', 'project.photos.review'];
    const missing = (await Promise.all(wanted.map((id) => W.describe(id)))).some((def) => !def);
    if (missing) {
      const rows = await fetch(new URL('../../platform-widgets/catalog.json?v=20261014-completion', base), { credentials: 'same-origin' }).then((response) => response.json());
      for (const def of rows.filter((row) => wanted.includes(row.id))) { if (!(await W.describe(def.id, def.version))) W.register(def); }
    }
    if (!window.FirstMateCompletionWidgets) await loadScript(new URL('../../platform-widgets/completion-widgets.js?v=20261014-completion', base).href);
    return W;
  })().catch((error) => { widgetsReady = null; throw error; });
}

function styles() {
  if (document.getElementById('fmco-styles')) return;
  const el = document.createElement('style'); el.id = 'fmco-styles';
  el.textContent = `
  .fmco-shell{width:min(1080px,calc(100vw - 28px));height:min(760px,calc(100vh - 28px));display:grid;grid-template-rows:auto minmax(0,1fr) auto;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#101828}
  .fmco-shell.is-small{width:min(460px,calc(100vw - 28px));height:auto}
  .fmco-shell.is-fit{height:auto;max-height:min(760px,calc(100vh - 28px))}
  .fmco-body{min-height:0;overflow:auto;padding:16px}
  .fmco-split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:16px;align-items:start}
  .fmco-pane{border:1px solid #eaecf0;border-radius:12px;padding:12px;background:#fff;min-width:0}
  .fmco-pane.is-photos{background:#fcfcfd}
  .fmco-foot-info{display:flex;align-items:center;gap:10px;min-width:0;font-size:11px;color:#475467}
  .fmco-foot-info input{width:min(320px,40vw);height:34px;border:1px solid #d0d5dd;border-radius:8px;padding:0 10px;font:inherit;font-size:12px}
  .fmco-actions{display:flex;align-items:center;gap:8px}
  .fmco-btn{height:34px;padding:0 14px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#344054;font:inherit;font-size:12px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
  .fmco-btn:hover:not(:disabled){background:#f2f4f7}.fmco-btn:disabled{opacity:.45;cursor:not-allowed}
  .fmco-btn.is-primary{border-color:#079455;background:#079455;color:#fff}.fmco-btn.is-primary:hover:not(:disabled){background:#067647}
  .fmco-btn.is-danger{border-color:#fda29b;color:#b42318}
  .fmco-layout{display:grid;grid-template-columns:230px minmax(0,1fr);min-height:0;height:100%}
  .fmco-rail{border-right:1px solid #eaecf0;background:#f8fafc;padding:10px;overflow:auto;display:flex;flex-direction:column;gap:3px}
  .fmco-rail button{display:grid;grid-template-columns:22px minmax(0,1fr) 16px;align-items:center;gap:8px;width:100%;padding:8px;border:0;border-radius:9px;background:transparent;color:#344054;font:inherit;font-size:12px;font-weight:700;text-align:left;cursor:pointer}
  .fmco-rail button:hover{background:#eef1f5}.fmco-rail button[aria-current=step]{background:#fff;box-shadow:0 1px 2px rgba(16,24,40,.08),inset 0 0 0 1px #e4e7ec;color:#101828}
  .fmco-rail .fmco-letter{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:10px;font-weight:900;background:#eaecf0;color:#475467;text-transform:uppercase}
  .fmco-rail [data-status=ok] .fmco-letter{background:#dcfae6;color:#067647}.fmco-rail [data-status=warning] .fmco-letter{background:#fef0c7;color:#b54708}.fmco-rail [data-status=unavailable] .fmco-letter{background:#f2f4f7;color:#98a2b3}
  .fmco-rail .fmco-state{font-size:11px}.fmco-rail [data-status=ok] .fmco-state{color:#079455}.fmco-rail [data-status=warning] .fmco-state{color:#dc6803}.fmco-rail [data-status=unavailable] .fmco-state{color:#98a2b3}
  .fmco-rail span.fmco-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .fmco-main{min-height:0;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:12px}
  .fmco-step-head{display:flex;align-items:flex-start;gap:12px}.fmco-step-head>i{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.09);color:var(--primary-readable,var(--primary,#d93025))}
  .fmco-step-head small{display:block;font-size:10px;font-weight:850;color:#667085;text-transform:uppercase;letter-spacing:.04em}.fmco-step-head h3{margin:2px 0 0;font-size:16px;font-weight:900}
  .fmco-banner{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border-radius:10px;font-size:12px;font-weight:600;line-height:1.45}
  .fmco-banner[data-status=ok]{background:#ecfdf3;color:#067647}.fmco-banner[data-status=warning]{background:#fffaeb;color:#93370d}.fmco-banner[data-status=unavailable]{background:#f2f4f7;color:#475467}.fmco-banner[data-status=closed]{background:#ecfdf3;color:#067647;border:1px solid #abefc6}
  .fmco-banner i{margin-top:2px}
  .fmco-rows{border:1px solid #eaecf0;border-radius:10px;overflow:hidden}
  .fmco-row{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:9px;padding:9px 12px;border-top:1px solid #f0f2f5;font-size:12px}
  .fmco-row:first-child{border-top:0}.fmco-row strong{font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.fmco-row span{color:#475467;text-align:right;font-variant-numeric:tabular-nums}
  .fmco-row i{font-size:12px}.fmco-row[data-status=ok] i{color:#079455}.fmco-row[data-status=warning] i{color:#dc6803}.fmco-row[data-status=info] i{color:#98a2b3}
  .fmco-note{margin:0;font-size:11px;color:#667085;line-height:1.5}.fmco-note strong{color:#475467}
  .fmco-card{border:1px solid #eaecf0;border-radius:12px;padding:12px;background:#fff}
  .fmco-card>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:12px;font-weight:800}.fmco-card>header em{font-style:normal;font-weight:700;color:#079455}
  .fmco-final{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);gap:14px;align-items:start}.fmco-final>div{display:flex;flex-direction:column;gap:12px;min-width:0}
  .fmco-menu{position:fixed;z-index:2147482602;min-width:210px;padding:6px;border:1px solid rgba(15,23,42,.12);border-radius:10px;background:#fff;box-shadow:0 16px 38px rgba(15,23,42,.2);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
  .fmco-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:#344054;font:inherit;font-size:12px;font-weight:650;text-align:left;cursor:pointer}
  .fmco-menu button:hover:not(:disabled){background:#f2f4f7}.fmco-menu button:disabled{cursor:default;color:#067647}.fmco-menu button i{width:14px;text-align:center;color:#667085}.fmco-menu button:disabled i{color:#079455}
  .fmco-menu hr{border:0;border-top:1px solid #eaecf0;margin:4px 2px}
  .fmco-reason{display:grid;gap:8px;padding:16px}.fmco-reason p{margin:0;font-size:12px;color:#475467;line-height:1.5}.fmco-reason textarea{min-height:84px;border:1px solid #d0d5dd;border-radius:9px;padding:9px;font:inherit;font-size:12px;resize:vertical}
  .fmco-error{color:#b42318;font-size:11px;font-weight:650}
  @media (max-width:760px){.fmco-split,.fmco-final{grid-template-columns:1fr}.fmco-layout{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}.fmco-rail{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid #eaecf0}.fmco-rail button{width:auto;grid-template-columns:22px auto}.fmco-rail .fmco-state{display:none}.fmco-foot-info input{width:40vw}}
  `;
  document.head.append(el);
}

/**
 * host: { orgId, projectId, projectTitle, portal (element dialogs are added to), lists() (the project's lists),
 * listItems(list), completions() (labor-completion.project rows), refresh() (reload lists, completions and the
 * requirements tray), toast(title, body, ok) }.
 */
function target(host) { return { scope: 'project', organizationId: host.orgId, projectId: host.projectId }; }
function api() { const publication = window.PlatformAPI?.publication; if (!publication) throw Error('The platform API is unavailable.'); return publication; }
function assigneeName(list) { return String(list?.assignment?.work_resource_ref?.name || '').trim() || String(list?.title || '').trim() || 'Work order'; }
export function completionFor(host, listId) { return (host.completions() || []).find((entry) => entry.list_id === listId && entry.state === 'finalized') || null; }

function dialog(host, { title, subtitle = '', icon = 'fa-money-check-dollar', small = false, fit = false, body = '', foot = '' }) {
  styles();
  const node = document.createElement('dialog');
  node.className = 'mt-modal fmco-dialog';
  node.innerHTML = `<div class="mt-modal-backdrop-hit" data-fmco-close aria-hidden="true"></div><div class="mt-modal-shell fmco-shell${small ? ' is-small' : ''}${fit ? ' is-fit' : ''}" role="document"><div class="mt-modal-head"><div class="mt-modal-title"><i class="fas ${esc(icon)}" aria-hidden="true"></i><div><strong>${esc(title)}</strong>${subtitle ? `<span>${esc(subtitle)}</span>` : ''}</div></div><button type="button" class="mt-modal-close" data-fmco-close aria-label="Close"><i class="fas fa-xmark" aria-hidden="true"></i></button></div><div class="fmco-body" data-fmco-body>${body}</div><div class="mt-modal-foot" data-fmco-foot>${foot}</div></div>`;
  (host.portal || document.body).append(node);
  const widgets = [];
  const close = () => { widgets.forEach((widget) => widget.destroy?.()); node.close?.(); node.remove(); };
  node.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  node.querySelectorAll('[data-fmco-close]').forEach((button) => button.addEventListener('click', close));
  if (node.showModal) node.showModal(); else node.setAttribute('open', '');
  return { node, body: node.querySelector('[data-fmco-body]'), foot: node.querySelector('[data-fmco-foot]'), close, widgets };
}
function mount(W, el, host, id, config, onSelect) {
  return W.mount(el, { id, version: '1', target: target(host), config }, { surface: 'project', target: target(host), onSelect });
}

/** Asks for a reason before a manager reopens something. Resolves to the reason, or '' when cancelled. */
function askReason(host, { title, body, confirm }) {
  return new Promise((resolve) => {
    const view = dialog(host, { title, icon: 'fa-unlock', small: true, body: `<div class="fmco-reason"><p>${esc(body)}</p><textarea data-fmco-reason placeholder="Why is this being reopened?" aria-label="Reason"></textarea><span class="fmco-error" data-fmco-error></span></div>`, foot: `<span></span><div class="fmco-actions"><button type="button" class="fmco-btn" data-fmco-cancel>Cancel</button><button type="button" class="fmco-btn is-danger" data-fmco-ok>${esc(confirm)}</button></div>` });
    const input = view.node.querySelector('[data-fmco-reason]');
    let done = false;
    const finish = (value) => { if (done) return; done = true; view.close(); resolve(value); };
    view.node.querySelectorAll('[data-fmco-close]').forEach((button) => button.addEventListener('click', () => finish('')));
    view.node.querySelector('[data-fmco-cancel]').onclick = () => finish('');
    view.node.querySelector('[data-fmco-ok]').onclick = () => { const reason = input.value.trim(); if (reason.length < 3) { view.node.querySelector('[data-fmco-error]').textContent = 'Say why, so the reopening is recorded with a reason.'; return; } finish(reason); };
    setTimeout(() => input.focus(), 30);
  });
}

/** The work order's More menu: Pay out, or, once paid out, when it was finalized and Reopen. */
export function openListMenu(host, listId, anchor) {
  styles();
  document.querySelectorAll('[data-fmco-menu]').forEach((node) => node.remove());
  const done = completionFor(host, listId);
  const menu = document.createElement('div');
  menu.className = 'fmco-menu'; menu.dataset.fmcoMenu = ''; menu.setAttribute('role', 'menu');
  menu.innerHTML = done
    ? `<button type="button" role="menuitem" disabled><i class="fas fa-circle-check" aria-hidden="true"></i>Paid out ${esc(when(done.finalized_at))} · ${esc(money(done.total_cents))}</button><hr><button type="button" role="menuitem" data-fmco-reopen><i class="fas fa-unlock" aria-hidden="true"></i>Reopen…</button>`
    : `<button type="button" role="menuitem" data-fmco-payout><i class="fas fa-money-check-dollar" aria-hidden="true"></i>Pay out</button>`;
  (host.portal || document.body).append(menu);
  const rect = anchor.getBoundingClientRect(), width = menu.offsetWidth || 220;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const dismiss = (event) => { if (event.type === 'keydown' ? event.key !== 'Escape' : menu.contains(event.target) || anchor.contains(event.target)) return; close(); };
  const close = () => { menu.remove(); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', dismiss, true); };
  document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', dismiss, true);
  menu.querySelector('[data-fmco-payout]')?.addEventListener('click', () => { close(); openPayOut(host, listId); });
  menu.querySelector('[data-fmco-reopen]')?.addEventListener('click', async () => {
    close();
    const reason = await askReason(host, { title: 'Reopen this work order?', body: `${assigneeName(host.lists().find((list) => list.id === listId))}'s work order was finalized to be paid. Reopening lets it change again; pay already earned on it is reversed at the next pay refresh. This is recorded with your reason.`, confirm: 'Reopen work order' });
    if (!reason) return;
    try { await api().invoke(host.orgId, 'labor.list.reopen', target(host), { list_id: listId, reason }, { idempotencyKey: key('labor-reopen') }); host.toast('Work order reopened', 'It can be changed again.', true); await host.refresh(); }
    catch (error) { host.toast('Could not reopen', error?.message || 'Please try again.', false); }
  });
  return { close };
}

/** Pay out one work order: confirm its items, look at the photos, then mark it completed and to be paid. */
export async function openPayOut(host, listId, options = {}) {
  const list = host.lists().find((entry) => entry.id === listId);
  if (!list) return null;
  const items = host.listItems(list), total = items.reduce((sum, item) => sum + Math.round(Number(item.projected_total ?? (Number(item.quantity) || 0) * (Number(item.projected_unit_price) || 0)) * 100 || 0), 0);
  const view = dialog(host, { fit: true, title: `Pay out ${assigneeName(list)}`, subtitle: `${host.projectTitle || 'This project'} · ${items.length} line item${items.length === 1 ? '' : 's'} · ${money(total)}`,
    body: `<div class="fmco-split"><section class="fmco-pane" data-fmco-completion></section><section class="fmco-pane is-photos" data-fmco-photos></section></div>`,
    foot: `<div class="fmco-foot-info"><input type="text" data-fmco-note maxlength="2000" placeholder="Note for the record (optional)" aria-label="Note"><span data-fmco-summary></span></div><div class="fmco-actions"><span class="fmco-error" data-fmco-error></span><button type="button" class="fmco-btn" data-fmco-cancel>Cancel</button><button type="button" class="fmco-btn is-primary" data-fmco-confirm disabled><i class="fas fa-lock" aria-hidden="true"></i>Mark completed · to be paid</button></div>` });
  view.node.querySelector('[data-fmco-cancel]').onclick = view.close;
  const button = view.node.querySelector('[data-fmco-confirm]'), summary = view.node.querySelector('[data-fmco-summary]'), error = view.node.querySelector('[data-fmco-error]');
  let picked = null, photos = { media_ids: [] };
  try {
    const W = await ensureWidgets();
    view.widgets.push(mount(W, view.node.querySelector('[data-fmco-completion]'), host, 'work.completion', { list_id: listId, method: options.method || 'select_all', prompt: 'Confirm the work is done' }, (value) => { picked = value; button.disabled = !value?.complete; summary.textContent = value ? `${value.confirmed_item_ids.length} of ${items.length} confirmed${photos.media_ids.length ? ` · ${photos.media_ids.length} photo${photos.media_ids.length === 1 ? '' : 's'} reviewed` : ''}` : ''; }));
    view.widgets.push(mount(W, view.node.querySelector('[data-fmco-photos]'), host, 'project.photos.review', { prompt: 'Photos of the work', limit: 60 }, (value) => { photos = value || { media_ids: [] }; if (picked) summary.textContent = `${picked.confirmed_item_ids.length} of ${items.length} confirmed${photos.media_ids.length ? ` · ${photos.media_ids.length} photo${photos.media_ids.length === 1 ? '' : 's'} reviewed` : ''}`; }));
  } catch (failure) { error.textContent = failure?.message || 'The confirmation could not load.'; }
  button.onclick = async () => {
    if (!picked?.complete) return;
    button.disabled = true; error.textContent = '';
    try {
      await api().invoke(host.orgId, 'labor.list.finalize', target(host), { list_id: listId, method: picked.method, ...(picked.method === 'approve' ? {} : { confirmed_item_ids: picked.confirmed_item_ids }), ...(photos.media_ids.length ? { evidence_media_ids: photos.media_ids } : {}), ...(view.node.querySelector('[data-fmco-note]').value.trim() ? { note: view.node.querySelector('[data-fmco-note]').value.trim() } : {}) }, { idempotencyKey: key('labor-finalize') });
      view.close();
      host.toast('Marked to be paid', `${assigneeName(list)}'s work order is completed and locked.`, true);
      await host.refresh();
    } catch (failure) { error.textContent = failure?.message || 'It could not be finalized.'; button.disabled = false; }
  };
  return view;
}

function stepRows(step) {
  const icon = { ok: 'fa-circle-check', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
  return step.rows.length ? `<div class="fmco-rows">${step.rows.map((row) => `<div class="fmco-row" data-status="${esc(row.status)}"><i class="fas ${icon[row.status] || icon.info}" aria-hidden="true"></i><strong title="${esc(row.label)}">${esc(row.label)}</strong><span>${esc(row.detail)}</span></div>`).join('')}</div>` : '';
}
const STATE_LABEL = { ok: 'fa-check', warning: 'fa-triangle-exclamation', unavailable: 'fa-minus' };

/** Close out the project: the checks one step at a time, then the remaining work orders confirmed and finalized. */
export async function openCloseout(host) {
  const view = dialog(host, { title: 'Close out project', subtitle: host.projectTitle || '', icon: 'fa-flag-checkered', body: '<div class="fmco-note" style="padding:20px">Checking the project…</div>', foot: '' });
  view.body.style.padding = '0';
  let checks;
  try {
    const result = await api().read(host.orgId, { provider: 'project-closeout', export: 'checks', target: target(host) });
    if (result.status !== 'ready') throw Error(result.message || 'The closeout checks are unavailable.');
    checks = result.value;
  } catch (failure) { view.body.innerHTML = `<div class="fmco-banner" data-status="unavailable" style="margin:16px"><i class="fas fa-circle-info"></i><span>${esc(failure?.message || 'The closeout checks are unavailable.')}</span></div>`; return view; }
  const steps = checks.steps, record = checks.closeout;
  let current = record?.state === 'closed' ? steps.length - 1 : 0;
  const picks = new Map(), photos = { media_ids: [] };
  const remaining = () => (checks.open_work_orders || []).map((id) => host.lists().find((list) => list.id === id)).filter(Boolean);
  const ready = () => record?.state !== 'closed' && remaining().every((list) => picks.get(list.id)?.complete);
  function rail() {
    return `<nav class="fmco-rail" aria-label="Closeout steps">${steps.map((step, index) => `<button type="button" data-fmco-step="${index}" data-status="${esc(step.status)}" ${index === current ? 'aria-current="step"' : ''}><span class="fmco-letter">${STEP_LETTERS[index]}</span><span class="fmco-name">${esc(step.title)}</span><i class="fas ${STATE_LABEL[step.status] || 'fa-minus'} fmco-state" aria-hidden="true"></i></button>`).join('')}</nav>`;
  }
  async function render() {
    view.widgets.splice(0).forEach((widget) => widget.destroy?.());
    const step = steps[current], last = current === steps.length - 1;
    const banner = (status, iconName, text) => `<div class="fmco-banner" data-status="${status}"><i class="fas ${iconName}" aria-hidden="true"></i><span>${esc(text)}</span></div>`;
    let main = `<div class="fmco-step-head"><i class="fas ${STEP_ICONS[step.id] || 'fa-circle'}" aria-hidden="true"></i><div><small>Step ${STEP_LETTERS[current].toUpperCase()} of ${STEP_LETTERS[steps.length - 1].toUpperCase()}</small><h3>${esc(step.title)}</h3></div></div>`;
    if (last && record?.state === 'closed') main += banner('closed', 'fa-lock', `Closed out ${when(record.closed_at)}. ${record.lists.length} work order${record.lists.length === 1 ? '' : 's'} finalized to be paid, ${money(record.lists.reduce((sum, entry) => sum + entry.total_cents, 0))} in all. Only a manager can reopen it.`);
    else main += banner(step.status, step.status === 'ok' ? 'fa-circle-check' : step.status === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info', step.summary);
    if (last && record?.state === 'closed') main += stepRows({ rows: record.lists.map((entry) => ({ id: entry.list_id, label: entry.title, detail: `Finalized · ${money(entry.total_cents)}`, status: 'ok' })) });
    else if (!last) main += stepRows(step);
    else if (remaining().length) main += `<p class="fmco-note">Confirm each remaining work order as done. Closing out marks every one completed and to be paid, locks them, and records the project's finances as finished.</p><div class="fmco-final"><div data-fmco-orders>${remaining().map((list) => `<section class="fmco-card" data-fmco-order="${esc(list.id)}"></section>`).join('')}</div><div><section class="fmco-card" data-fmco-closeout-photos></section></div></div>`;
    else main += `${stepRows(step)}<p class="fmco-note">Every work order is already finalized. Closing out records the project's finances as finished.</p>`;
    if (step.missing?.length) main += `<p class="fmco-note"><strong>Not published yet:</strong> ${step.missing.map(esc).join(' ')}</p>`;
    if (step.status !== 'ok' && !last) main += '<p class="fmco-note">This is a check, not a requirement: you can go on and close out anyway.</p>';
    view.body.innerHTML = `<div class="fmco-layout">${rail()}<div class="fmco-main">${main}</div></div>`;
    const closed = record?.state === 'closed';
    view.foot.innerHTML = `<div class="fmco-foot-info">${closed ? '' : last ? '<input type="text" data-fmco-note maxlength="2000" placeholder="Note for the record (optional)" aria-label="Note">' : `<span>${steps.filter((entry) => entry.status === 'warning').length} of ${steps.length} checks have something to look at</span>`}</div><div class="fmco-actions"><span class="fmco-error" data-fmco-error></span>${current ? '<button type="button" class="fmco-btn" data-fmco-back><i class="fas fa-arrow-left" aria-hidden="true"></i>Back</button>' : ''}${last ? (closed ? '<button type="button" class="fmco-btn is-danger" data-fmco-reopen-closeout><i class="fas fa-unlock" aria-hidden="true"></i>Reopen closeout…</button>' : `<button type="button" class="fmco-btn is-primary" data-fmco-close-out ${ready() ? '' : 'disabled'}><i class="fas fa-flag-checkered" aria-hidden="true"></i>Close out project</button>`) : '<button type="button" class="fmco-btn is-primary" data-fmco-next>Next<i class="fas fa-arrow-right" aria-hidden="true"></i></button>'}</div>`;
    view.body.querySelectorAll('[data-fmco-step]').forEach((button) => button.onclick = () => { current = Number(button.dataset.fmcoStep); render(); });
    view.foot.querySelector('[data-fmco-back]')?.addEventListener('click', () => { current -= 1; render(); });
    view.foot.querySelector('[data-fmco-next]')?.addEventListener('click', () => { current += 1; render(); });
    view.foot.querySelector('[data-fmco-reopen-closeout]')?.addEventListener('click', reopen);
    const closeButton = view.foot.querySelector('[data-fmco-close-out]');
    closeButton?.addEventListener('click', closeOut);
    if (last && !closed && remaining().length) {
      const W = await ensureWidgets();
      for (const list of remaining()) view.widgets.push(mount(W, view.body.querySelector(`[data-fmco-order="${CSS.escape(list.id)}"]`), host, 'work.completion', { list_id: list.id, method: 'select_all', prompt: `Confirm ${assigneeName(list)}'s work is done` }, (value) => {
        picks.set(list.id, value);
        if (closeButton) closeButton.disabled = !ready();
      }));
      view.widgets.push(mount(W, view.body.querySelector('[data-fmco-closeout-photos]'), host, 'project.photos.review', { prompt: 'Photos of the work', limit: 60 }, (value) => { photos.media_ids = value?.media_ids || []; }));
    }
  }
  async function closeOut() {
    const error = view.foot.querySelector('[data-fmco-error]'), button = view.foot.querySelector('[data-fmco-close-out]');
    if (!ready()) return;
    button.disabled = true; error.textContent = '';
    const note = view.foot.querySelector('[data-fmco-note]')?.value.trim() || '';
    const finalize = remaining().map((list) => { const pick = picks.get(list.id); return { list_id: list.id, method: pick.method, ...(pick.method === 'approve' ? {} : { confirmed_item_ids: pick.confirmed_item_ids }), ...(photos.media_ids.length ? { evidence_media_ids: photos.media_ids } : {}) }; });
    try {
      await api().invoke(host.orgId, 'project-closeout.close', target(host), { finalize, ...(note ? { note } : {}) }, { idempotencyKey: key('closeout') });
      view.close();
      host.toast('Project closed out', 'Every work order is finalized to be paid and the finances are marked finished.', true);
      await host.refresh();
    } catch (failure) { error.textContent = failure?.message || 'The project could not be closed out.'; button.disabled = false; }
  }
  async function reopen() {
    const reason = await askReason(host, { title: 'Reopen the closeout?', body: "The project's finances will no longer be marked finished. The work orders stay finalized; reopen each one separately if it has to change. This is recorded with your reason.", confirm: 'Reopen closeout' });
    if (!reason) return;
    try { await api().invoke(host.orgId, 'project-closeout.reopen', target(host), { reason }, { idempotencyKey: key('closeout-reopen') }); view.close(); host.toast('Closeout reopened', 'The finances are open again.', true); await host.refresh(); }
    catch (failure) { const error = view.foot.querySelector('[data-fmco-error]'); if (error) error.textContent = failure?.message || 'It could not be reopened.'; }
  }
  await render();
  return view;
}
