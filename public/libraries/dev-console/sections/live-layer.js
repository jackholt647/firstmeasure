/*
 * Live layer (docs/architecture/live-layer.md): the browser files dev serves ahead of its release, which checkout put
 * each one there and when, and what recently left. Redraws on each change the platform stream brings
 * (libraries/live-assets dispatches fm:live-assets); no stream of its own.
 */
export function mount(root, { api, T, esc }) {
  let token = 0;
  const when = (seconds) => seconds ? new Date(Number(seconds) * 1000).toLocaleString() : '';
  const reasons = { released: T('dc_live_released', 'released'), conflict: T('dc_live_conflict', 'conflict'), reverted: T('dc_live_reverted', 'reverted') };
  async function render() {
    const mine = ++token;
    let data = null;
    try { data = await api('/v1/signup-sandbox/development/console/live'); }
    catch (_) {
      // Until the console endpoint is on dev: the paths this page knows, without owners.
      const files = window.FirstMateLiveAssets?.files?.() || {};
      data = { files: Object.entries(files).map(([path, sha]) => ({ path, sha })), retired: [], owners_unknown: true };
    }
    if (mine !== token) return;
    const files = [...(data.files || [])].sort((a, b) => a.path.localeCompare(b.path));
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_live_intro', 'Browser files dev serves ahead of its release. A rollout that includes a file retires it within 20 seconds.'))}</p>
      ${data.owners_unknown ? `<p class="fm-dc-note">${esc(T('dc_live_owners_later', 'Owners show once the dev console endpoint is on dev.'))}</p>` : ''}
      <h3 class="fm-dc-h">${esc(T('dc_live_now', 'Live now'))} · ${files.length}</h3>
      ${files.length ? `<ul class="fm-dc-list">${files.map((file) => `<li class="fm-dc-row"><span><a href="/${esc(file.path)}" target="_blank" rel="noopener"><strong>${esc(file.path)}</strong></a><small>${esc(file.source || '')}${file.at ? ' · ' + esc(when(file.at)) : ''}${file.sha ? ' · ' + esc(String(file.sha).slice(0, 10)) : ''}</small></span></li>`).join('')}</ul>` : `<p class="fm-dc-empty">${esc(T('dc_live_empty', 'Nothing is live: dev serves its release.'))}</p>`}
      ${(data.retired || []).length ? `<h3 class="fm-dc-h">${esc(T('dc_live_recent', 'Recently left'))}</h3><ul class="fm-dc-list">${data.retired.map((file) => `<li class="fm-dc-row"><span><strong>${esc(file.path)}</strong></span><span class="fm-dc-badge${file.reason === 'conflict' ? ' fm-dc-changed' : ''}">${esc(reasons[file.reason] || file.reason)}</span></li>`).join('')}</ul>` : ''}
      <p class="fm-dc-sub">${esc(T('dc_live_how', 'Start a sync from your checkout with node tools/live-layer/live-sync.mjs.'))}</p>`;
  }
  window.addEventListener('fm:live-assets', () => { if (root.isConnected) render(); });
  render();
  return { shown: render };
}
