/*
 * Dev push queue (docs/architecture/dev-lanes.md, "The router"): each lane's state and last release, and every
 * submission's state (queued, merging, testing, rolling-out, live, rejected with the reason). The router writes
 * /__dev-push/status.json on dev web; this reads it when the section opens and every 15 seconds while it is showing
 * (a small static file, not a stream).
 */
const STATUS = '/__dev-push/status.json';
const EVERY = 15000;

export function mount(root, { T, esc }) {
  let timer = 0;
  const when = (iso) => iso ? new Date(iso).toLocaleString() : '';
  const tones = { live: 'fm-dc-ok', rejected: 'fm-dc-changed' };
  const lanes = { platform: T('dc_push_platform', 'Platform'), 'measure-internal': T('dc_push_measure', 'Measure editor') };
  const short = (sha) => String(sha || '').slice(0, 8);

  async function render() {
    let status;
    try {
      const response = await fetch(STATUS, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error(String(response.status));
      status = await response.json();
    } catch (_) {
      root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_push_intro', 'Submissions to the platform and measure-internal lanes, and what each lane last released to dev.'))}</p><p class="fm-dc-note">${esc(T('dc_push_later', 'The dev push router is not reporting on this host yet.'))}</p>`;
      return;
    }
    const router = status.router || {};
    const laneRows = Object.entries(status.lanes || {});
    const submissions = [...(status.submissions || [])].sort((a, b) => String(b.updated_at || b.submitted_at).localeCompare(String(a.updated_at || a.submitted_at)));
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_push_intro', 'Submissions to the platform and measure-internal lanes, and what each lane last released to dev.'))}</p>
      ${router.paused ? `<p class="fm-dc-note fm-dc-warn">${esc(T('dc_push_paused', 'The router is paused.'))}${router.note ? ' ' + esc(router.note) : ''}</p>` : ''}
      <h3 class="fm-dc-h">${esc(T('dc_push_lanes', 'Lanes'))}</h3>
      ${laneRows.length ? `<ul class="fm-dc-list">${laneRows.map(([id, lane]) => `<li class="fm-dc-row"><span><strong>${esc(lanes[id] || id)}</strong><small>${esc(lane.branch || '')} · ${esc(short(lane.tip))}${lane.release ? ` · ${esc(T('dc_push_released', 'released'))} ${esc(short(lane.release.sha))} ${esc(when(lane.release.at))}` : ''}${lane.note ? ' · ' + esc(lane.note) : ''}</small></span><span class="fm-dc-badge${lane.state === 'idle' ? ' fm-dc-ok' : ''}">${esc(lane.state || '')}</span></li>`).join('')}</ul>` : `<p class="fm-dc-empty">${esc(T('dc_push_no_lanes', 'No lanes reported yet.'))}</p>`}
      <h3 class="fm-dc-h">${esc(T('dc_push_submissions', 'Submissions'))} · ${submissions.length}</h3>
      ${submissions.length ? `<ul class="fm-dc-list">${submissions.map((s) => `<li class="fm-dc-row"><span><strong>${esc(s.title || s.ref)}</strong><small>${esc(lanes[s.lane] || s.lane || '')} · ${esc(s.agent || '')} · ${esc(when(s.updated_at || s.submitted_at))}${s.release ? ' · ' + esc(s.release) : ''}</small>${s.state === 'rejected' && (s.reason || s.details) ? `<details><summary class="fm-dc-sub">${esc(s.reason || T('dc_push_why', 'Why'))}</summary><pre class="fm-dc-code" style="min-height:0;white-space:pre-wrap">${esc(s.details || '')}</pre></details>` : ''}</span><span class="fm-dc-badge ${tones[s.state] || ''}">${esc(s.state || '')}</span></li>`).join('')}</ul>` : `<p class="fm-dc-empty">${esc(T('dc_push_empty', 'Nothing queued.'))}</p>`}
      <p class="fm-dc-sub">${esc(T('dc_push_updated', 'Updated'))} ${esc(when(status.updated_at))} · node tools/dev-push/submit.mjs</p>`;
  }
  // Read again while the section is showing; stop when the tray folds or another section opens.
  const tick = () => { clearTimeout(timer); timer = setTimeout(async () => { if (root.isConnected && !root.hidden && root.closest('.fm-dc:not([hidden])')) await render(); tick(); }, EVERY); };
  render(); tick();
  return { shown: render };
}
