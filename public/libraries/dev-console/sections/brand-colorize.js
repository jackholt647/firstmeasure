/*
 * Brand colour (GP-77): how Forward's merchant portal (Settings › Money › Manage, and the other embedded Forward
 * views) is recoloured from Forward's colour to an organization's brand colour by brand-colorize.js. Pick any colour
 * to see it on a sample of the portal and on every preset at once. "On the open portal" sets what the real portal
 * frames in this page show (FirstMateBrandColorize.preview) until changed back or the page reloads: the
 * organization's colour (what everyone sees), the picked colour, or Forward's own colours, so flipping between the
 * last two compares before and after on the live portal (GP-118). Nothing is saved.
 */
const PRESETS = ['#d93025', '#2563eb', '#7c3aed', '#db2777', '#f97316', '#facc15', '#16a34a', '#0891b2', '#111827', '#93c5fd'];

// A small copy of Forward's portal in its own colour: the side menu with the active item, a chart, buttons, a link,
// greys, and the status colours that sit near (green, blue) and opposite (red, amber) Forward's teal.
function sample(base) {
  return `<div class="fm-dc-bc-portal" style="--fwd:${base}">
    <div class="fm-dc-bc-side">
      <b>FirstMate</b><small>Merchant Portal</small>
      <span class="on">Dashboard</span><span class="hover">Applications</span><span>Payments</span><span>Payouts</span>
    </div>
    <div class="fm-dc-bc-main">
      <strong>Dashboard</strong>
      <div class="fm-dc-bc-seg"><span>1d</span><span class="on">7d</span><span>30d</span></div>
      <svg viewBox="0 0 120 34" aria-hidden="true"><path d="M0 30 L20 22 L40 26 L60 12 L80 16 L100 6 L120 9 L120 34 L0 34Z" fill="${base}" fill-opacity=".14"/><path d="M0 30 L20 22 L40 26 L60 12 L80 16 L100 6 L120 9" fill="none" stroke="${base}" stroke-width="2"/></svg>
      <div class="fm-dc-bc-row"><span class="btn">Export</span><span class="ghost">Filter</span><a>View all</a></div>
      <div class="fm-dc-bc-row"><span class="pill ok">Succeeded</span><span class="pill info">Processing</span><span class="pill bad">Failed</span><span class="pill warn">Pending</span></div>
    </div>
  </div>`;
}

export function mount(root, { T, esc, toast }) {
  const B = window.FirstMateBrandColorize;
  if (!B) { root.innerHTML = `<p class="fm-dc-empty">${esc(T('dc_bc_unavailable', 'The brand colour library is not on this page.'))}</p>`; return; }
  const org = B.brandColor() || '#d93025';
  const active = B.previewing();
  // show: 'org' (no preview), 'color' (the picked colour) or 'forward' (Forward's own colours, no recolouring).
  const state = { color: active?.color || org, mode: (active?.mode !== 'off' && active?.mode) || 'family', show: active ? (active.mode === 'off' ? 'forward' : 'color') : 'org' };

  const swatches = () => [org, ...PRESETS.filter((c) => c !== org)];
  // The controls are drawn once per change of mode; dragging the colour picker only redraws what it shows, so the
  // picker stays open. Picking a colour shows it on the open portal at once.
  function draw() {
    root.innerHTML = `<p class="fm-dc-intro">${esc(T('dc_bc_intro', 'Forward draws its merchant portal in one colour. Settings › Money (Manage, Accounts, Disputes) shows it in the organization\'s brand colour: greys, white and black stay as they are, Forward\'s colour and its tints become the brand colour and its tints. Pick a colour to see how it would look.'))}</p>
      <div class="fm-dc-bc-pick">
        <input type="color" value="${esc(B.toHex(B.parseColor(state.color)))}" data-dc-bc-color aria-label="${esc(T('dc_bc_color', 'Colour'))}">
        <input type="text" value="${esc(state.color)}" data-dc-bc-hex spellcheck="false" aria-label="${esc(T('dc_bc_hex', 'Hex colour'))}">
        <button type="button" class="fm-dc-btn" data-dc-bc-org>${esc(T('dc_bc_org', 'This organization'))}</button>
      </div>
      <div class="fm-dc-bc-swatches">${swatches().map((c) => `<button type="button" data-dc-bc-swatch="${esc(c)}" style="background:${esc(c)}" title="${esc(c)}" aria-label="${esc(c)}"></button>`).join('')}</div>
      <div class="fm-dc-bc-modes" role="radiogroup" aria-label="${esc(T('dc_bc_mode', 'What changes'))}">
        <label><input type="radio" name="fm-dc-bc-mode" value="family" ${state.mode === 'family' ? 'checked' : ''}> ${esc(T('dc_bc_family', 'Forward\'s colour only'))}</label>
        <label><input type="radio" name="fm-dc-bc-mode" value="all" ${state.mode === 'all' ? 'checked' : ''}> ${esc(T('dc_bc_all', 'Every colour'))}</label>
      </div>
      <p class="fm-dc-sub">${esc(state.mode === 'family'
        ? T('dc_bc_family_note2', 'Colours leaning towards Forward\'s teal (its greens and blues too) take the brand colour; near-greys and colours on the other side (red, amber) keep theirs.')
        : T('dc_bc_all_note2', 'Every colour turns by the same amount as Forward\'s teal, so a red error, an amber warning and Forward\'s faintly blue greys change colour too.'))}</p>
      <div data-dc-bc-out></div>
      <h3 class="fm-dc-h">${esc(T('dc_bc_presets', 'Every preset'))}</h3>
      <div class="fm-dc-bc-grid">${swatches().map((c) => {
        const t = B.readableOnWhite(c) || c;
        return `<button type="button" data-dc-bc-swatch="${esc(c)}" title="${esc(c)}"><span style="filter:${esc(B.filterFor(t, { mode: state.mode }))}">${sample(B.FORWARD_BASE)}</span><small>${esc(c)}</small></button>`;
      }).join('')}</div>`;
    out();
  }
  function out() {
    const host = root.querySelector('[data-dc-bc-out]');
    if (!host) return;
    const target = B.readableOnWhite(state.color) || state.color;
    const frames = B.frames().length;
    const m = B.matrix(B.FORWARD_BASE, target);
    root.querySelectorAll('.fm-dc-bc-swatches [data-dc-bc-swatch]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.dcBcSwatch === state.color)));
    const show = (value, label) => `<label><input type="radio" name="fm-dc-bc-show" value="${value}" ${state.show === value ? 'checked' : ''}> ${esc(label)}</label>`;
    host.innerHTML = `<div class="fm-dc-row"><span><strong>${esc(T('dc_bc_on_portal', 'On the open portal'))}</strong><small>${esc(frames
        ? T('dc_bc_frames', 'Portal frames open in this page: ') + frames
        : T('dc_bc_no_frames', 'No portal open in this page: open Settings › Money › Manage.'))}</small></span>
        ${frames ? '' : `<button type="button" class="fm-dc-btn" data-dc-bc-open>${esc(T('dc_bc_open', 'Open Manage'))}</button>`}</div>
      <div class="fm-dc-bc-modes fm-dc-bc-show" role="radiogroup" aria-label="${esc(T('dc_bc_on_portal', 'On the open portal'))}">
        ${show('org', T('dc_bc_show_org', 'Organization colour'))}${show('color', T('dc_bc_show_color', 'This colour'))}${show('forward', T('dc_bc_show_forward', 'Forward\'s own colours'))}
      </div>
      <p class="fm-dc-sub">${esc(T('dc_bc_compare', 'Flip between this colour and Forward\'s own colours to compare after and before. Organization colour is what everyone sees.'))}</p>
      <h3 class="fm-dc-h">${esc(T('dc_bc_forward', 'Forward'))} · ${esc(B.FORWARD_BASE)}</h3>
      ${sample(B.FORWARD_BASE)}
      <h3 class="fm-dc-h">${esc(T('dc_bc_recoloured', 'Recoloured'))} · ${esc(target)}${target !== B.toHex(B.parseColor(state.color)) ? ` <span class="fm-dc-badge fm-dc-changed" title="${esc(T('dc_bc_readable_tip', 'Darkened until text on white is readable, as the portal does for --primary-readable'))}">${esc(T('dc_bc_readable', 'readable on white'))}</span>` : ''}</h3>
      <div data-dc-bc-recoloured style="filter:${esc(B.filterFor(target, { mode: state.mode }))}">${sample(B.FORWARD_BASE)}</div>
      <details class="fm-dc-bc-matrix"><summary>${esc(T('dc_bc_matrix', 'Colour matrix'))}</summary><pre>${esc(m.map((row) => row.map((v) => v.toFixed(3).padStart(7)).join(' ')).join('\n'))}</pre></details>`;
  }

  function sync() {
    if (state.show === 'color') B.preview(B.readableOnWhite(state.color) || state.color, { mode: state.mode });
    else if (state.show === 'forward') B.preview(null, { mode: 'off' });
    else if (B.previewing()) B.preview(null);
  }
  function set(patch, redraw = draw) {
    Object.assign(state, patch);
    sync();
    redraw();
  }
  root.oninput = (event) => {
    if (!event.target.matches('[data-dc-bc-color]')) return;
    const hex = root.querySelector('[data-dc-bc-hex]');
    if (hex) hex.value = event.target.value;
    set({ color: event.target.value, show: 'color' }, out);
  };
  root.onchange = (event) => {
    const t = event.target;
    if (t.matches('[data-dc-bc-color]')) return;
    if (t.matches('[data-dc-bc-hex]')) {
      const rgb = B.parseColor(t.value);
      if (rgb) set({ color: B.toHex(rgb), show: 'color' }); else toast(T('dc_bc_bad_hex', 'Type a colour like #d93025.'));
    } else if (t.name === 'fm-dc-bc-mode') set({ mode: t.value });
    else if (t.name === 'fm-dc-bc-show') set({ show: t.value }, out);
  };
  root.onclick = (event) => {
    const swatch = event.target.closest('[data-dc-bc-swatch]');
    if (swatch) set({ color: swatch.dataset.dcBcSwatch, show: 'color' });
    if (event.target.closest('[data-dc-bc-org]')) set({ color: B.brandColor() || org, show: 'org' });
    if (event.target.closest('[data-dc-bc-open]')) {
      window.Portal?.navigation?.navigate?.(
        { tab: 'company_settings', sub: 'money', settingsView: 'manage', settingsEntity: '' },
        { source: 'dev-console-brand-colour', ownedKeys: ['tab', 'sub', 'settingsView', 'settingsEntity'] }
      );
    }
  };
  // A portal frame opened or closed while the section is open (Manage loading after "Open Manage").
  const onFrames = () => { if (!root.isConnected) window.removeEventListener('fm:brand-colorize-frames', onFrames); else out(); };
  window.addEventListener('fm:brand-colorize-frames', onFrames);
  draw();
  return { shown: out };
}
