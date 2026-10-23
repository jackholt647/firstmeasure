/* libraries/session-replay/session-replay-recording.js
 * "Who is recorded" in the replay viewer: platform administrators set the platform-wide mode (off for everyone,
 * only those listed, everyone) and rules for people and organizations, each optionally for a limited time, with a
 * reason that goes into the change log. People and organizations are found by a server-side search; nothing loads
 * the whole list. See docs/architecture/session-replay.md, "Who is recorded".
 */
(function () {
  'use strict';
  const API = location.origin + '/v1/platform';
  const base = '/session-replay/admin/targeting';
  let csrf = '';
  let overlay = null;
  let filter = { state: 'recording', kind: '' };
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (t) => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const MODES = {
    off: { title: 'Off for everyone', hint: 'Nobody is recorded, whatever the rules below say.' },
    listed: { title: 'Only those listed', hint: 'Only people and organizations set to record below.' },
    everyone: { title: 'Everyone', hint: 'Everybody in every organization, except those set not to record.' }
  };

  async function api(path, options = {}) {
    const method = options.method || 'GET';
    const headers = { Accept: 'application/json' };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-Platform-CSRF'] = csrf;
    const response = await fetch(API + path, { method, credentials: 'include', cache: 'no-store', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const data = await response.json().catch(() => null);
    if (!response.ok || (data && data.ok === false)) throw new Error((data && (data.message || data.error)) || 'Request failed (' + response.status + ')');
    return data;
  }

  function ruleState(rule, now) {
    if (!rule) return { cls: '', text: 'No rule' };
    if (rule.expires_at && rule.expires_at <= now) return { cls: 'rr-expired', text: 'Expired ' + when(rule.expires_at) };
    const until = rule.expires_at ? ' until ' + when(rule.expires_at) : '';
    return rule.enabled ? { cls: 'rr-on', text: 'Recording' + until } : { cls: 'rr-off', text: 'Not recorded' + until };
  }

  // ---------------------------------------------------------------------------
  // Sidebar summary
  // ---------------------------------------------------------------------------
  async function renderSummary() {
    const panel = document.getElementById('recording-panel');
    if (!panel) return;
    let data;
    try { data = await api(base + '?limit=1'); } catch (error) { panel.querySelector('.rr-summary').textContent = error.message; return; }
    const c = data.counts;
    const mode = data.mode.mode;
    const listed = [c.people_recording && c.people_recording + (c.people_recording === 1 ? ' person' : ' people'),
      c.organizations_recording && c.organizations_recording + (c.organizations_recording === 1 ? ' organization' : ' organizations')].filter(Boolean).join(', ');
    const excluded = c.people_excluded + c.organizations_excluded;
    panel.querySelector('.rr-mode').textContent = MODES[mode].title;
    panel.querySelector('.rr-mode').className = 'rr-mode rr-mode-' + mode;
    panel.querySelector('.rr-summary').textContent = mode === 'off' ? 'Nothing is being recorded.'
      : mode === 'everyone' ? 'Recording everyone' + (excluded ? ', ' + excluded + ' excluded.' : '.')
      : (listed ? 'Recording ' + listed + '.' : 'Nobody is listed, so nothing is being recorded.');
  }

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------
  function durationSelect() {
    return '<select class="rr-days" title="For how long"><option value="1">1 day</option><option value="7" selected>7 days</option>'
      + '<option value="30">30 days</option><option value="0">Until removed</option></select>';
  }

  function resultRow(item, kind, now) {
    const rule = item.rule;
    const state = ruleState(rule, now);
    const target = kind === 'person' ? item.identity_id : item.organization_id;
    const title = kind === 'person' ? (item.name ? esc(item.name) + ' <span class="aa-muted">' + esc(item.email) + '</span>' : esc(item.email)) : esc(item.name);
    const sub = kind === 'person'
      ? (item.organizations.map((o) => esc(o.name)).join(', ') + (item.total > item.organizations.length ? ' and ' + (item.total - item.organizations.length) + ' more' : '')) || 'No organization'
      : esc(item.organization_id);
    return '<div class="rr-result" data-kind="' + kind + '" data-target="' + esc(target) + '"><div class="rr-who"><div>' + title + '</div><div class="aa-muted">' + sub + '</div></div>'
      + '<span class="rr-state ' + state.cls + '">' + esc(state.text) + '</span>'
      + '<div class="rr-actions">' + durationSelect() + '<button type="button" class="aa-primary rr-record">Record</button>'
      + '<button type="button" class="aa-copy rr-exclude" title="Never record, even when recording everyone">Don’t record</button>'
      + (rule ? '<button type="button" class="aa-revoke rr-remove">Remove rule</button>' : '') + '</div></div>';
  }

  async function runSearch() {
    const box = overlay.querySelector('.rr-results');
    const q = overlay.querySelector('.rr-search').value.trim();
    if (q.length < 2) { box.innerHTML = '<p class="aa-muted">Type at least two letters of an email, a name or an id.</p>'; return; }
    box.innerHTML = '<p class="aa-muted">Searching…</p>';
    try {
      const data = await api(base + '/search?limit=10&q=' + encodeURIComponent(q));
      const people = data.people.map((p) => resultRow(p, 'person', data.now)).join('');
      const orgs = data.organizations.map((o) => resultRow(o, 'organization', data.now)).join('');
      box.innerHTML = (people ? '<h4>People</h4>' + people : '') + (orgs ? '<h4>Organizations</h4>' + orgs : '')
        || '<p class="aa-muted">Nobody matches. Search finds sign-in emails, names and organization ids.</p>';
    } catch (error) { box.innerHTML = '<p class="aa-error">' + esc(error.message) + '</p>'; }
  }

  async function renderRules(append) {
    const box = overlay.querySelector('.rr-rules');
    const cursor = append ? box.dataset.next : '';
    const params = new URLSearchParams({ limit: '50' });
    if (filter.state) params.set('state', filter.state);
    if (filter.kind) params.set('kind', filter.kind);
    if (cursor) params.set('cursor', cursor);
    let data;
    try { data = await api(base + '?' + params.toString()); } catch (error) { box.innerHTML = '<p class="aa-error">' + esc(error.message) + '</p>'; return; }
    const rows = data.rules.map((rule) => {
      const state = ruleState(rule, data.now);
      return '<tr data-kind="' + rule.kind + '" data-target="' + esc(rule.target_id) + '"><td>' + esc(rule.label || rule.target_id)
        + '<div class="aa-muted">' + esc(rule.kind === 'person' ? rule.detail : rule.target_id) + '</div></td>'
        + '<td>' + (rule.kind === 'person' ? 'Person' : 'Organization') + '</td><td><span class="rr-state ' + state.cls + '">' + esc(state.text) + '</span></td>'
        + '<td>' + esc(rule.reason || '') + '<div class="aa-muted">' + esc(rule.updated_by) + ' · ' + when(rule.updated_at) + '</div></td>'
        + '<td><button type="button" class="aa-revoke rr-remove">Remove</button></td></tr>';
    }).join('');
    const table = box.querySelector('tbody');
    if (append && table) table.insertAdjacentHTML('beforeend', rows);
    else box.innerHTML = rows ? '<table class="aa-table"><thead><tr><th>Who</th><th>Kind</th><th>State</th><th>Why, by whom</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p class="aa-muted">No rules here.</p>';
    box.dataset.next = data.next || '';
    overlay.querySelector('.rr-more').hidden = !data.next;
  }

  async function renderLog() {
    const box = overlay.querySelector('.rr-log');
    try {
      const entries = (await api(base + '/log?limit=50')).entries;
      const describe = (e) => {
        if (e.kind === 'mode') return 'Mode: ' + (MODES[e.before] ? MODES[e.before].title : e.before) + ' → ' + (MODES[e.after] ? MODES[e.after].title : e.after);
        if (!e.after) return 'Removed the rule for ' + e.label;
        return (e.after.enabled ? 'Record ' : 'Don’t record ') + e.label + (e.after.expires_at ? ' until ' + when(e.after.expires_at) : '');
      };
      box.innerHTML = entries.length ? '<table class="aa-table"><tbody>' + entries.map((e) => '<tr><td>' + when(e.at) + '</td><td>' + esc(describe(e))
        + (e.reason ? '<div class="aa-muted">' + esc(e.reason) + '</div>' : '') + '</td><td class="aa-muted">' + esc(e.actor) + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="aa-muted">No changes yet.</p>';
    } catch (error) { box.innerHTML = '<p class="aa-error">' + esc(error.message) + '</p>'; }
  }

  async function renderMode() {
    const data = await api(base + '?limit=1');
    const mode = data.mode.mode;
    overlay.querySelectorAll('input[name="rr-mode"]').forEach((input) => { input.checked = input.value === mode; });
    overlay.querySelector('.rr-mode-meta').textContent = data.mode.updated_by ? 'Set by ' + data.mode.updated_by + ' ' + when(data.mode.updated_at) + (data.mode.reason ? ': ' + data.mode.reason : '') : '';
  }

  function reason() { return overlay.querySelector('.rr-reason').value.trim(); }

  async function refreshAll() {
    await Promise.all([renderMode(), renderRules(false), renderSummary(), overlay.querySelector('.rr-search').value.trim().length >= 2 ? runSearch() : null]);
    if (!overlay.querySelector('.rr-log').hidden) await renderLog();
  }

  async function act(button) {
    const row = button.closest('[data-kind]');
    const kind = row.dataset.kind, target = row.dataset.target;
    button.disabled = true;
    try {
      if (button.classList.contains('rr-remove')) {
        await api(base + '/rules/' + kind + '/' + encodeURIComponent(target) + (reason() ? '?reason=' + encodeURIComponent(reason()) : ''), { method: 'DELETE' });
      } else {
        const select = row.querySelector('.rr-days');
        const days = select ? Number(select.value) : 0;
        await api(base + '/rules', { method: 'PUT', body: { rules: [{ kind, target, enabled: button.classList.contains('rr-record'), days: days || null, reason: reason() || undefined }] } });
      }
      await refreshAll();
    } catch (error) { window.alert(error.message); button.disabled = false; }
  }

  function close() { if (overlay) { overlay.remove(); overlay = null; } }

  function open() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'aa-overlay';
    overlay.innerHTML = '<div class="aa-dialog rr-dialog" role="dialog" aria-modal="true" aria-label="Who is recorded"><div class="aa-head"><h2>Who is recorded</h2>'
      + '<button type="button" class="aa-close" aria-label="Close">×</button></div><div class="aa-body">'
      + '<div class="rr-modes">' + Object.keys(MODES).map((mode) => '<label class="rr-mode-option"><input type="radio" name="rr-mode" value="' + mode + '"><span><strong>'
        + esc(MODES[mode].title) + '</strong><span class="aa-muted">' + esc(MODES[mode].hint) + '</span></span></label>').join('') + '</div>'
      + '<div class="aa-muted rr-mode-meta"></div>'
      + '<p class="aa-muted">A person’s rule follows them into every organization they belong to and wins over their organization’s rule. '
      + 'A page starts or stops recording when it next loads or uploads (within about 20 seconds).</p>'
      + '<h3>Find people and organizations</h3>'
      + '<div class="aa-form"><input type="search" class="rr-search" placeholder="Email, name or organization id" autocomplete="off">'
      + '<input class="rr-reason" maxlength="500" placeholder="Reason, kept in the change log (optional)"></div>'
      + '<div class="rr-results"><p class="aa-muted">Type at least two letters of an email, a name or an id.</p></div>'
      + '<h3>Rules</h3><div class="aa-form"><select class="rr-filter-state"><option value="recording">Recording</option><option value="excluded">Not recorded</option>'
      + '<option value="expired">Expired</option><option value="">All</option></select><select class="rr-filter-kind"><option value="">People and organizations</option>'
      + '<option value="person">People</option><option value="organization">Organizations</option></select></div>'
      + '<div class="rr-rules"></div><button type="button" class="aa-copy rr-more" hidden>Load more</button>'
      + '<h3>Changes</h3><button type="button" class="aa-copy rr-show-log">Show the change log</button><div class="rr-log" hidden></div>'
      + '<p class="aa-muted">Scripts can do the same with <code>PUT /v1/platform/session-replay/admin/targeting/rules</code> (up to 500 rules at once, people by email) '
      + 'and <code>GET …/targeting/explain?person=&lt;email&gt;</code> to see why someone is or is not recorded.</p>'
      + '</div></div>';
    document.body.appendChild(overlay);
    let timer = 0;
    overlay.addEventListener('input', (event) => {
      if (!event.target.classList.contains('rr-search')) return;
      clearTimeout(timer);
      timer = setTimeout(runSearch, 250);
    });
    overlay.addEventListener('change', async (event) => {
      const target = event.target;
      if (target.name === 'rr-mode') {
        const mode = target.value;
        if (mode === 'everyone' && !window.confirm('Record everyone in every organization? Storage grows with every active person.')) { await renderMode(); return; }
        try { await api(base + '/mode', { method: 'PUT', body: { mode, reason: reason() || undefined } }); await refreshAll(); }
        catch (error) { window.alert(error.message); await renderMode(); }
      }
      if (target.classList.contains('rr-filter-state')) { filter.state = target.value; renderRules(false); }
      if (target.classList.contains('rr-filter-kind')) { filter.kind = target.value; renderRules(false); }
    });
    overlay.addEventListener('click', async (event) => {
      const target = event.target;
      if (target === overlay || target.classList.contains('aa-close')) { close(); return; }
      if (target.classList.contains('rr-record') || target.classList.contains('rr-exclude') || target.classList.contains('rr-remove')) { await act(target); return; }
      if (target.classList.contains('rr-more')) { await renderRules(true); return; }
      if (target.classList.contains('rr-show-log')) {
        const log = overlay.querySelector('.rr-log');
        log.hidden = !log.hidden;
        target.textContent = log.hidden ? 'Show the change log' : 'Hide the change log';
        if (!log.hidden) await renderLog();
      }
    });
    document.addEventListener('keydown', function onKey(event) { if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    overlay.querySelector('.rr-filter-state').value = filter.state;
    overlay.querySelector('.rr-filter-kind').value = filter.kind;
    refreshAll().catch((error) => window.alert(error.message));
    overlay.querySelector('.rr-search').focus();
  }

  async function init() {
    let me;
    try { me = await api('/session-replay/admin/me'); } catch (error) { return; }
    csrf = me.csrf || '';
    const panel = document.getElementById('recording-panel');
    if (!panel) return;
    panel.hidden = false;
    panel.querySelector('.rr-manage').addEventListener('click', open);
    renderSummary();
    // Another administrator's changes show when this tab is looked at again; nothing polls in the background.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) renderSummary(); });
  }

  window.FMReplayRecording = { open, refresh: renderSummary };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
