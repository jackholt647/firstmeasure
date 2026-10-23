/* libraries/session-replay/session-replay-agent-access.js
 * "Agent access" in the replay viewer: platform administrators create and revoke the keys a coding agent (Claude
 * Code, Codex, any MCP client) uses to search session replays remotely. The agent talks to the server directly;
 * nothing here runs a model. See docs/architecture/session-replay-search.md, "Access for coding agents".
 */
(function () {
  'use strict';
  const API = location.origin + '/v1/platform';
  const MCP_URL = API + '/session-replay/mcp';
  let csrf = '';
  let overlay = null;
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = (t) => (t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

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

  function snippets(key) {
    const k = key || '<key>';
    return [
      { title: 'Claude Code', code: 'claude mcp add --transport http firstmate-replay ' + MCP_URL + ' --header "Authorization: Bearer ' + k + '"' },
      { title: 'Codex (~/.codex/config.toml, then set FIRSTMATE_REPLAY_KEY to the key)', code: '[mcp_servers.firstmate_replay]\nurl = "' + MCP_URL + '"\nbearer_token_env_var = "FIRSTMATE_REPLAY_KEY"' },
      { title: 'Any HTTP client', code: 'curl -H "Authorization: Bearer ' + k + '" ' + API + '/session-replay/insights/tools\n'
        + 'curl -H "Authorization: Bearer ' + k + '" -H "Content-Type: application/json" -d \'{"tool":"replay_overview","input":{}}\' ' + API + '/session-replay/insights/call' }
    ];
  }

  function codeBlock(snippet) {
    return '<div class="aa-snippet"><div class="aa-snippet-head"><span>' + esc(snippet.title) + '</span><button type="button" class="aa-copy">Copy</button></div><pre>' + esc(snippet.code) + '</pre></div>';
  }

  async function render(created) {
    const body = overlay.querySelector('.aa-body');
    let keys = [];
    try { keys = (await api('/session-replay/insights/keys')).keys || []; } catch (error) { body.innerHTML = '<p class="aa-error">' + esc(error.message) + '</p>'; return; }
    body.innerHTML = '<p class="aa-lead">Give a key to Claude Code, Codex or any MCP client and it can search every recording with the replay tools '
      + '(overview, screens, elements, flows, friction, finding sessions, timelines, what was on screen). A key can only search: it cannot play recordings, switch recording on or manage keys.</p>'
      + (created ? '<div class="aa-created"><div class="aa-created-head">Key for “' + esc(created.access_key.name) + '”. Copy it now: it is not shown again.</div>'
        + '<div class="aa-key"><code>' + esc(created.key) + '</code><button type="button" class="aa-copy" data-copy="' + esc(created.key) + '">Copy key</button></div>'
        + snippets(created.key).map(codeBlock).join('') + '</div>' : '')
      + '<form class="aa-form"><input name="name" maxlength="120" placeholder="Who or what gets it, e.g. Jack’s Claude Code" required>'
      + '<select name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="365">1 year</option></select>'
      + '<button type="submit" class="aa-primary">Create key</button></form>'
      + '<h3>Keys</h3>' + (keys.length ? '<table class="aa-table"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>'
        + keys.map((k) => '<tr class="' + (k.active ? '' : 'aa-inactive') + '"><td>' + esc(k.name) + '<div class="aa-muted">' + esc(k.created_by) + '</div></td><td><code>' + esc(k.prefix) + '…</code></td>'
          + '<td>' + day(k.created_at) + '</td><td>' + (k.revoked_at ? 'revoked' : day(k.expires_at)) + '</td><td>' + (k.last_used_at ? day(k.last_used_at) : 'never') + '</td>'
          + '<td>' + (k.active ? '<button type="button" class="aa-revoke" data-id="' + esc(k.id) + '">Revoke</button>' : '') + '</td></tr>').join('') + '</tbody></table>'
        : '<p class="aa-muted">No keys yet.</p>')
      + '<h3>Connecting</h3>' + snippets('').map(codeBlock).join('')
      + '<p class="aa-muted">The MCP endpoint answers POST requests with JSON (Streamable HTTP without an event stream). Tool descriptions and a short guide come with the connection.</p>';
  }

  function close() { if (overlay) { overlay.remove(); overlay = null; } }

  function open() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'aa-overlay';
    overlay.innerHTML = '<div class="aa-dialog" role="dialog" aria-modal="true" aria-label="Agent access"><div class="aa-head"><h2>Agent access</h2>'
      + '<button type="button" class="aa-close" aria-label="Close">×</button></div><div class="aa-body"><p class="aa-muted">Loading…</p></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', async (event) => {
      const target = event.target;
      if (target === overlay || target.classList.contains('aa-close')) { close(); return; }
      if (target.classList.contains('aa-copy')) {
        const text = target.dataset.copy || target.closest('.aa-snippet').querySelector('pre').textContent;
        try { await navigator.clipboard.writeText(text); target.textContent = 'Copied'; setTimeout(() => { target.textContent = target.dataset.copy ? 'Copy key' : 'Copy'; }, 1500); } catch (error) { target.textContent = 'Select and copy'; }
      }
      if (target.classList.contains('aa-revoke')) {
        if (!window.confirm('Revoke this key? Agents using it stop working at once.')) return;
        try { await api('/session-replay/insights/keys/' + encodeURIComponent(target.dataset.id), { method: 'DELETE' }); await render(null); } catch (error) { window.alert(error.message); }
      }
    });
    overlay.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.target;
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const created = await api('/session-replay/insights/keys', { method: 'POST', body: { name: form.name.value.trim(), days: Number(form.days.value) } });
        await render(created);
      } catch (error) { window.alert(error.message); button.disabled = false; }
    });
    document.addEventListener('keydown', function onKey(event) { if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } });
    render(null);
  }

  async function init() {
    let me;
    try { me = await api('/session-replay/admin/me'); } catch (error) { return; }
    csrf = me.csrf || '';
    const brand = document.querySelector('.brand');
    if (!brand) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-access-button';
    button.textContent = 'Agent access';
    button.title = 'Keys for Claude Code, Codex or any MCP client';
    button.addEventListener('click', open);
    brand.appendChild(button);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
