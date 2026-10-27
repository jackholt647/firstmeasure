/*
 * Dev push queue (docs/architecture/dev-lanes.md, "The router"): what each lane is merging, testing and rolling out.
 * A placeholder until the dev push router publishes its status; then this section reads it.
 */
export function mount(root, { T, esc }) {
  root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_push_intro', 'Submissions to the platform and measure-internal lanes, and what each lane last released to dev.'))}</p>
    <p class="fm-dc-note">${esc(T('dc_push_later', 'The dev push router is being built. Its queue shows here once it reports status.'))}</p>
    <h3 class="fm-dc-h">${esc(T('dc_push_lanes', 'Lanes'))}</h3>
    <ul class="fm-dc-list">${[['platform', T('dc_push_platform', 'Platform')], ['measure-internal', T('dc_push_measure', 'Measure editor')], ['live', T('dc_push_live', 'Live layer')], ['config', T('dc_push_config', 'Config library')]].map(([id, label]) => `<li class="fm-dc-row"><span><strong>${esc(label)}</strong><small>${esc(id)}</small></span><span class="fm-dc-badge">—</span></li>`).join('')}</ul>`;
}
