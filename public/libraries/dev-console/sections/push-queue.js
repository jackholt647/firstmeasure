/*
 * Dev push queue (docs/architecture/dev-lanes.md, "The router"): each lane's state and last release, and every
 * submission's state (queued, merging, testing, rolling-out, live, rejected with the reason) and recent releases.
 * The status arrives on the `dev-push` channel of the platform stream (development/dev-push-status.ts) whenever the
 * router rewrites it. Where that channel is not available yet, the section reads the router's file
 * /__dev-push/status.json when it opens and every 15 seconds while it is showing.
 */
const STATUS = '/__dev-push/status.json';
const EVERY = 15000;

export function mount(root, { T, esc, orgId }) {
  let timer = 0, live = false;
  const when = (iso) => iso ? new Date(iso).toLocaleString() : '';
  const tones = { live: 'fm-dc-ok', rejected: 'fm-dc-changed' };
  const lanes = { platform: T('dc_push_platform', 'Platform'), 'measure-internal': T('dc_push_measure', 'Measure editor') };
  const short = (sha) => String(sha || '').slice(0, 8);

  async function load() {
    let status = null;
    try {
      const response = await fetch(STATUS, { cache: 'no-store', credentials: 'omit' });
      if (response.ok) status = await response.json();
    } catch (_) { status = null; }
    render(status);
  }
  function render(status) {
    if (!status || status.unavailable) {
      root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_push_intro', 'Submissions to the platform and measure-internal lanes, and what each lane last released to dev.'))}</p><p class="fm-dc-note fm-dc-warn">${esc(T('dc_push_unavailable', 'The dev push router is unavailable: it is not reporting its status on this host right now. This section fills in by itself when it does.'))}</p>`;
      return;
    }
    const router = status.router || {};
    const laneRows = Object.entries(status.lanes || {});
    const releases = [...(status.releases || [])].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 10);
    const submissions = [...(status.submissions || [])].sort((a, b) => String(b.updated_at || b.submitted_at).localeCompare(String(a.updated_at || a.submitted_at)));
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_push_intro', 'Submissions to the platform and measure-internal lanes, and what each lane last released to dev.'))}</p>
      ${router.paused ? `<p class="fm-dc-note fm-dc-warn">${esc(T('dc_push_paused', 'The router is paused.'))}${router.note ? ' ' + esc(router.note) : ''}</p>` : ''}
      <h3 class="fm-dc-h">${esc(T('dc_push_lanes', 'Lanes'))}</h3>
      ${laneRows.length ? `<ul class="fm-dc-list">${laneRows.map(([id, lane]) => `<li class="fm-dc-row"><span><strong>${esc(lanes[id] || id)}</strong><small>${esc(lane.branch || '')} · ${esc(short(lane.tip))}${lane.release ? ` · ${esc(T('dc_push_released', 'released'))} ${esc(short(lane.release.sha))} ${esc(when(lane.release.at))}` : ''}${lane.note ? ' · ' + esc(lane.note) : ''}</small></span><span class="fm-dc-badge${lane.state === 'idle' ? ' fm-dc-ok' : ''}">${esc(lane.state || '')}</span></li>`).join('')}</ul>` : `<p class="fm-dc-empty">${esc(T('dc_push_no_lanes', 'No lanes reported yet.'))}</p>`}
      <h3 class="fm-dc-h">${esc(T('dc_push_submissions', 'Submissions'))} · ${submissions.length}</h3>
      ${submissions.length ? `<ul class="fm-dc-list">${submissions.map((s) => `<li class="fm-dc-row"><span><strong>${esc(s.title || s.ref)}</strong><small>${esc(lanes[s.lane] || s.lane || '')} · ${esc(s.agent || '')} · ${esc(when(s.updated_at || s.submitted_at))}${s.release ? ' · ' + esc(s.release) : ''}</small>${s.state === 'rejected' && (s.reason || s.details) ? `<details><summary class="fm-dc-sub">${esc(s.reason || T('dc_push_why', 'Why'))}</summary><pre class="fm-dc-code" style="min-height:0;white-space:pre-wrap">${esc(s.details || '')}</pre></details>` : ''}</span><span class="fm-dc-badge ${tones[s.state] || ''}">${esc(s.state || '')}</span></li>`).join('')}</ul>` : `<p class="fm-dc-empty">${esc(T('dc_push_empty', 'Nothing queued.'))}</p>`}
      ${releases.length ? `<h3 class="fm-dc-h">${esc(T('dc_push_releases', 'Recent releases'))}</h3><ul class="fm-dc-list">${releases.map((r) => `<li class="fm-dc-row"><span><strong>${esc(r.id)}</strong><small>${esc(lanes[r.lane] || r.lane || '')} · ${esc(short(r.sha))} · ${esc(when(r.at))} · ${Number(r.submissions?.length) || 0} ${esc(T('dc_push_release_submissions', 'submissions'))}${r.overlays?.length ? ` · ${Number(r.overlays.length)} ${esc(T('dc_push_release_overlays', 'live overlays'))}` : ''}</small></span></li>`).join('')}</ul>` : ''}
      <p class="fm-dc-sub">${esc(T('dc_push_updated', 'Updated'))} ${esc(when(status.updated_at))} · node tools/dev-push/submit.mjs</p>`;
  }
  // Without the channel: read again while the section is showing; stop when the tray folds or another section opens.
  const tick = () => { clearTimeout(timer); if (live) return; timer = setTimeout(async () => { if (!live && root.isConnected && !root.hidden && root.closest('.fm-dc:not([hidden])')) await load(); tick(); }, EVERY); };
  const org = orgId();
  if (org && window.PlatformRealtime?.watchChannel) {
    window.PlatformRealtime.watchChannel(org, 'dev-push', {
      onEvent(event, data) { if (event !== 'status') return; live = true; clearTimeout(timer); render(data); },
      onDown() { live = false; tick(); }
    });
  }
  load(); tick();
  return { shown: () => { if (!live) load(); } };
}
