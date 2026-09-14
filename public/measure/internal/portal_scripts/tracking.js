/* Staff Tracking pilot: collection is universal; these permissions control viewing. */
(function () {
  let root, access, next, sequence = 0, mode = 'history';
  const cfg = () => window.Portal?.cfg || window.PORTAL_CFG || {};
  const esc = value => Portal.escapeHtml(String(value ?? ''));
  const base = () => String(cfg().endpoints.firstmeasure).replace(/\/firstmeasure\/?$/, '/staff-tracking');
  async function api(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (body !== undefined) {
      const session = await fetch(String(cfg().endpoints.platform).replace(/\/$/, '') + '/auth/session', { credentials: 'include', cache: 'no-store' });
      const data = await session.json();
      if (!session.ok || !data.csrf_token) throw new Error('Session expired. Sign in again.');
      headers['X-Platform-CSRF'] = data.csrf_token;
    }
    const response = await fetch(base() + '/' + path, { method: body === undefined ? 'GET' : 'POST', headers, credentials: 'include', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status) && root) root.querySelector('[data-results]').replaceChildren();
      throw new Error(typeof data.error === 'string' ? data.error : 'Tracking is unavailable.');
    }
    return data;
  }
  const notice = text => { root.querySelector('[data-notice]').textContent = text; };
  const time = value => new Date(value).toLocaleString('en-US', { timeZone: root.querySelector('[name=zone]').value });
  const kinds = { activity: 'Activity sample', session_seen: 'Session observed', training_start: 'Training opened', exam_start: 'Exam opened', training_submit: 'Training submitted', exam_submit: 'Exam submitted' };
  function eventMarkup(e) {
    return `<article class="tracking-event"><div class="tracking-event-head"><div><strong>${esc(e.name || e.email)}</strong><small>${esc(e.email)}</small></div><div><b>${esc(kinds[e.kind] || e.kind)}</b><small>${esc(time(e.at))}</small></div><code>${esc(e.ip || 'IP unavailable')}</code></div>
      <div class="tracking-meta">${esc(e.browser)} · session ${esc(e.session_ref.slice(0, 10))} · ${e.established ? 'Established staff at observation' : 'Training status'}${e.impersonated ? ' · Support / impersonated session; excluded from signals' : ''}</div>
      ${e.course || e.attempt || e.project ? `<div class="tracking-meta">Course ${esc(e.course || '—')} · Attempt ${esc(e.attempt || '—')} · Project ${esc(e.project || '—')}</div>` : ''}
      ${e.history_limited ? '<p class="tracking-warning">Comparison limit reached. Narrow the history; this is not a complete assessment.</p>' : ''}
      ${e.signals.map(s => `<details class="tracking-signal ${s.priority === 'high' ? 'tracking-high' : ''}"><summary>${s.priority === 'high' ? 'Priority review · ' : 'Review · '}${esc(s.reason)}</summary><p>${esc(s.match_count)} matching observations; showing up to 20. Shared offices, carrier NAT and VPN exits can explain matches.</p>${s.matches.map(m => `<div>${esc(m.email)} · ${esc(m.ip)} · ${esc(time(m.at))} · ${esc(kinds[m.kind] || m.kind)}</div>`).join('')}</details>`).join('')}
      <details class="tracking-review"><summary>${e.review ? esc(e.review.status.replaceAll('_', ' ')) + ' · ' + esc(e.review.reviewer) : 'Add review / explanation'}</summary><form data-review="${esc(e.id)}"><label>Disposition <select name="status">${[['needs_review','Needs review'],['explained','Explained / shared network'],['dismissed','Dismissed']].map(([v,l]) => `<option value="${v}" ${e.review?.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label>Review note <textarea name="note" maxlength="1000" rows="2">${esc(e.review?.note || '')}</textarea></label><button>Save review</button>${e.review ? `<small>Last reviewed ${esc(time(e.review.at))}</small>` : ''}</form></details></article>`;
  }
  async function load(append = false) {
    const current = ++sequence;
    notice('Loading…');
    root.querySelector('[data-next]').disabled = true;
    try {
      access = await api('access'); // Recheck revocation and Admin role on every refresh.
      if (mode === 'access') { await loadAccess(current); return; }
      const params = new URLSearchParams({ days: root.querySelector('[name=days]').value });
      for (const name of ['email', 'ip']) { const value = root.querySelector(`[name=${name}]`).value.trim(); if (value) params.set(name, value); }
      if (mode === 'training') params.set('training', '1');
      if (append && next) { params.set('before', next.before); params.set('cursor', next.cursor); }
      const data = await api('events?' + params);
      if (current !== sequence) return;
      next = data.next;
      const events = mode === 'flags' ? data.events.filter(e => e.signals.length).sort((a,b) => Number(b.signals.some(s=>s.priority==='high')) - Number(a.signals.some(s=>s.priority==='high'))) : data.events;
      const results = root.querySelector('[data-results]');
      if (!append) results.replaceChildren();
      if (events.length) results.insertAdjacentHTML('beforeend', events.map(eventMarkup).join(''));
      else if (!append) results.textContent = mode === 'flags' ? 'No signals on this page. Continue to older observations to review more history.' : 'No observations match these filters. Missing history does not mean there was no activity.';
      notice(`${mode === 'flags' ? 'Signals from this 50-observation page, priority first. ' : ''}${data.coverage} Retention: ${data.retention_days} days. Collection errors/drops on this API process: ${data.collection.failures}/${data.collection.dropped}.`);
      root.querySelector('[data-next]').disabled = !next;
    } catch (error) { if (current === sequence) { root.querySelector('[data-results]').replaceChildren(); notice(error.message); } }
  }
  async function loadAccess(current) {
    if (!access.admin) throw new Error('Only full internal Admins may manage viewing access.');
    const data = await api('access-list');
    if (current !== sequence) return;
    const grants = new Set(data.grants.map(g => g.email));
    const term = root.querySelector('[name=email]').value.trim().toLowerCase();
    root.querySelector('[data-results]').innerHTML = `<div class="tracking-access"><h2>Who can view Tracking</h2><p>Activity is collected for all staff. These switches only grant viewing access. Admin access is automatic.</p>${data.users.filter(u => !term || (u.email + ' ' + u.name).toLowerCase().includes(term)).map(u => `<label><span><strong>${esc(u.name || u.email)}</strong><small>${esc(u.email)}</small></span><span>${u.admin ? 'Admin · automatic' : `<input type="checkbox" data-grant="${esc(u.email)}" aria-label="Allow ${esc(u.email)} to view Tracking" ${grants.has(u.email) ? 'checked' : ''}> May view`}</span></label>`).join('')}</div>`;
    notice('Only Admins can grant or revoke viewing. Revocation is enforced on every API request.');
  }
  async function init() {
    if (!window.Portal || !cfg().endpoints?.firstmeasure) return;
    try { access = await api('access'); } catch { return; }
    const host = document.getElementById('portalPluginViews'); if (!host) return;
    const style = document.createElement('style');
    style.textContent = `.tracking-page{max-width:1200px;margin:auto;padding:28px;color:#17263b}.tracking-page h1{margin:0;font-size:30px}.tracking-page p,.tracking-meta{color:#52627a;line-height:1.5}.tracking-page button,.tracking-page input,.tracking-page select,.tracking-page textarea{font:inherit;color:#17263b;border:1px solid #bac8db;border-radius:8px;padding:9px;background:#fff}.tracking-page button{cursor:pointer;font-weight:600}.tracking-page button:disabled{opacity:.45;cursor:default}.tracking-page button[aria-pressed=true]{background:#245de3;color:#fff;border-color:#245de3}.tracking-tabs,.tracking-filters{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.tracking-filters label{display:grid;gap:6px;font-size:12px;font-weight:600}.tracking-filters input{max-width:230px}.tracking-page [data-notice]{padding:14px;border-radius:10px;background:#edf3fb;line-height:1.6;font-size:13px}.tracking-event,.tracking-access{background:white;border:1px solid #dce3ed;border-radius:14px;padding:20px;margin:14px 0;overflow-wrap:anywhere}.tracking-event-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}.tracking-page small{display:block;font-size:12px;color:#52627a;margin-top:5px}.tracking-meta{font-size:12px;margin-top:12px}.tracking-signal{background:#f4f7fb;border-left:3px solid #8199bd;padding:12px;margin-top:12px;font-size:13px;line-height:1.6}.tracking-high{background:#fff7e7;border-color:#c48611}.tracking-page summary{cursor:pointer;font-weight:600}.tracking-review{margin-top:16px;font-size:13px}.tracking-review form{display:grid;gap:12px;margin-top:12px}.tracking-review label{display:grid;gap:6px}.tracking-review button{justify-self:start}.tracking-access>label{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid #e3eaf3;gap:12px}.tracking-warning{color:#805500!important}@media(max-width:600px){.tracking-page{padding:16px}.tracking-filters label{flex:1;min-width:120px}.tracking-filters input{width:100%;box-sizing:border-box}}`;
    document.head.appendChild(style);
    style.textContent += '.tracking-filters select{min-width:0;max-width:100%}@media(max-width:600px){.tracking-filters>button{flex-basis:100%}}';
    root = document.createElement('section'); root.id = 'view-tracking'; root.style.display = 'none';
    root.innerHTML = `<div class="tracking-page"><h1>Tracking <small>Staff activity · restricted-view pilot</small></h1><p>Compare observed networks and training attempts. An IP match is a reason to review, never proof of impersonation.</p><nav class="tracking-tabs" aria-label="Tracking views">${[['history','Activity history'],['training','Training & exams'],['flags','Review signals'],...(access.admin ? [['access','Viewing access']] : [])].map(([id,label]) => `<button type="button" data-mode="${id}" aria-pressed="${id==='history'}">${label}</button>`).join('')}</nav><form class="tracking-filters"><label>Staff email / access search<input name="email" placeholder="name@example.com"></label><label>Exact IP<input name="ip" placeholder="IPv4 or IPv6"></label><label>History<select name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option></select></label><label>Display timezone<select name="zone"><option value="Asia/Manila">Manila (Philippines)</option><option value="America/Los_Angeles">Pacific</option><option value="UTC">UTC</option></select></label><button>Refresh</button></form><p data-notice role="status"></p><div data-results></div><button data-next type="button" disabled>Older observations</button></div>`;
    host.appendChild(root); Portal.registerPlugin({ id: 'tracking', title: 'Tracking', iconClass: 'fas fa-user-shield' });
    root.querySelector('.tracking-filters').onsubmit = e => { e.preventDefault(); next = null; void load(); };
    root.querySelector('[data-next]').onclick = () => void load(true);
    root.querySelectorAll('[data-mode]').forEach(button => { button.onclick = () => { mode = button.dataset.mode; root.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); next = null; void load(); }; });
    root.addEventListener('submit', async e => {
      const form = e.target.closest('[data-review]'); if (!form) return; e.preventDefault();
      const button = form.querySelector('button'); button.disabled = true;
      try { await api('review', { id: form.dataset.review, status: form.elements.status.value, note: form.elements.note.value }); await load(); } catch (error) { notice(error.message); } finally { button.disabled = false; }
    });
    root.addEventListener('change', async e => {
      const input = e.target.closest('[data-grant]'); if (!input) return; input.disabled = true;
      try { await api('access-list', { email: input.dataset.grant, allow: input.checked }); notice('Viewing permission saved. Collection is unchanged.'); } catch (error) { input.checked = !input.checked; notice(error.message); } finally { input.disabled = false; }
    });
    const original = Portal.switchView.bind(Portal);
    Portal.switchView = async function (id, button) { await original(id, button); if (id === 'tracking') await load(); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init()); else void init();
})();
