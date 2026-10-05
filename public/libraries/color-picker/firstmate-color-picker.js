/* Shared color control. Existing color inputs retain their value and event contract. */
(function (root) {
  'use strict';
  if (root.FirstMateColorPicker) return;
  const clamp = (n, max = 1) => Math.max(0, Math.min(max, Number(n) || 0));
  function normalize(value) {
    const text = String(value || '').trim();
    if (/^#?[a-f\d]{6}$/i.test(text)) return '#' + text.replace('#', '').toLowerCase();
    if (/^#?[a-f\d]{3}$/i.test(text)) return '#' + text.replace('#', '').split('').map(c => c + c).join('').toLowerCase();
    return null;
  }
  function rgbToHex(rgb) { return '#' + rgb.map(n => Math.round(clamp(n, 255)).toString(16).padStart(2, '0')).join(''); }
  function hexToRgb(hex) { return (normalize(hex) || '#000000').slice(1).match(/../g).map(n => parseInt(n, 16)); }
  function rgbToHsv(rgb) {
    const [r, g, b] = rgb.map(n => clamp(n, 255) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
  }
  function hsvToRgb({ h, s, v }) {
    h = ((Number(h) || 0) % 360 + 360) % 360; s = clamp(s); v = clamp(v);
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map(n => Math.round((n + m) * 255));
  }
  let active = null, panel = null, hsv = null, initial = '', recent = [], observer = null, anchor = null, identity = null;
  const enhanced = new WeakSet();
  function enhance(input) {
    if (!input || enhanced.has(input)) return;
    enhanced.add(input);
    input.classList.add('fm-color-input');
    input.setAttribute('aria-haspopup', 'dialog');
    input.setAttribute('aria-expanded', 'false');
    // Route callers using showPicker() through the same control as clicks.
    try { input.showPicker = () => open(input); } catch (_) {}
  }
  function refresh(scope = document) {
    if (scope.matches?.('input[type="color"]')) enhance(scope);
    scope.querySelectorAll?.('input[type="color"]').forEach(enhance);
  }
  function injectStyle() {
    if (document.getElementById('fm-color-picker-style')) return;
    const style = document.createElement('style'); style.id = 'fm-color-picker-style';
    style.textContent = `
      .fm-color-input{cursor:pointer;font:inherit}.fm-color-input:focus-visible{outline:2px solid var(--primary,var(--fm-primary,#2563eb));outline-offset:3px}
      .fm-color-picker{position:fixed;z-index:2147483590;width:282px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 20px);overflow:auto;box-sizing:border-box;padding:14px;border:1px solid var(--fm-border,#d0d5dd);border-radius:14px;background:var(--fm-surface,#fff);color:var(--fm-text,#101828);box-shadow:0 16px 48px #10182830;font:500 12px/1.4 var(--fm-font-family,Montserrat,Inter,system-ui,sans-serif)}
      .fm-color-picker *{box-sizing:border-box}.fm-color-picker button,.fm-color-picker input{font:inherit}.fm-color-picker button{cursor:pointer}.fm-color-picker-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px}.fm-color-picker-head strong{font-size:13px}.fm-color-close{border:0;border-radius:6px;background:transparent;color:inherit;font-size:20px!important;line-height:1;width:26px;height:26px}
      .fm-color-plane{height:144px;position:relative;touch-action:none;border-radius:8px;background:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,transparent),var(--hue);cursor:crosshair;outline-offset:3px}.fm-color-plane:focus-visible{outline:2px solid var(--primary,var(--fm-primary,#2563eb))}.fm-color-plane-dot{position:absolute;width:12px;height:12px;border:2px solid var(--on-primary,#fff);box-shadow:0 0 0 1px var(--primary,var(--fm-primary,#10182880));border-radius:50%;transform:translate(-50%,-50%);pointer-events:none}
      .fm-color-picker label{display:grid;gap:4px;font-size:11px}.fm-color-picker input:not([type=range]){width:100%;min-width:0;height:32px;padding:5px 7px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#101828}.fm-color-picker input:focus-visible,.fm-color-picker button:focus-visible{outline:2px solid var(--primary,var(--fm-primary,#2563eb));outline-offset:2px}
      .fm-color-hue{width:100%;margin:12px 0 8px;appearance:none;height:12px;background:linear-gradient(to right,red,#ff0,#0f0,#0ff,#00f,#f0f,red);border-radius:8px;cursor:pointer}.fm-color-hue::-webkit-slider-thumb{appearance:none;width:16px;height:16px;background:transparent;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px #10182880}.fm-color-hue::-moz-range-thumb{width:12px;height:12px;background:transparent;border:2px solid #fff;border-radius:50%;box-shadow:0 0 0 1px #10182880}
      .fm-color-fields{display:grid;grid-template-columns:1.55fr repeat(3,1fr);gap:6px}.fm-color-presets{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}.fm-color-preset{width:23px;height:23px;border:1px solid #10182825;border-radius:6px;background:var(--color)}.fm-color-status{min-height:16px;margin:6px 0 0;font-size:11px;color:#b42318}.fm-color-actions{display:flex;justify-content:flex-end;gap:7px;margin-top:8px}.fm-color-actions button{padding:6px 10px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#344054}.fm-color-actions .fm-color-done{background:var(--primary,var(--fm-primary,#2563eb));border-color:transparent;color:var(--on-primary,#fff)}
    `;
    document.head.appendChild(style);
  }
  function close(restoreFocus = true) {
    if (!active) return;
    const input = active; active = null;
    input.setAttribute('aria-expanded', 'false');
    panel?.remove(); panel = null;
    if (restoreFocus && input.isConnected) input.focus({ preventScroll: true });
  }
  function position() {
    if (!active || !panel) return;
    const rect = active.getBoundingClientRect(), height = panel.offsetHeight;
    panel.style.left = Math.max(10, Math.min(rect.left, innerWidth - panel.offsetWidth - 10)) + 'px';
    panel.style.top = Math.max(10, Math.min(rect.bottom + 6, innerHeight - height - 10)) + 'px';
  }
  function sync() {
    if (!panel || !active) return;
    const hex = active.value, rgb = hexToRgb(hex);
    panel.style.setProperty('--hue', rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 })));
    const plane = panel.querySelector('.fm-color-plane');
    plane.setAttribute('aria-valuenow', String(Math.round(hsv.s * 100)));
    plane.setAttribute('aria-valuetext', `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    const dot = plane.firstElementChild; dot.style.left = (hsv.s * 100) + '%'; dot.style.top = ((1 - hsv.v) * 100) + '%';
    if (document.activeElement !== panel.querySelector('[data-hex]')) panel.querySelector('[data-hex]').value = hex;
    panel.querySelector('[data-hue]').value = hsv.h;
    panel.querySelectorAll('[data-rgb]').forEach((input, index) => { if (document.activeElement !== input) input.value = rgb[index]; });
    panel.querySelector('[role=status]').textContent = '';
  }
  function rebind(hex) {
    if (active && !active.isConnected && identity) {
      const candidates = identity.id ? [document.getElementById(identity.id)] : [...(anchor?.isConnected ? anchor : document).querySelectorAll('input[type="color"]')];
      const replacement = candidates.find(candidate => candidate && candidate.type === 'color' && identity.attributes.every(([name, value]) => candidate.getAttribute(name) === value));
      if (replacement) { active = replacement; enhance(replacement); replacement.value = hex; replacement.setAttribute('aria-expanded', 'true'); }
    }
  }
  function choose(hex, preserveHsv = false) {
    hex = normalize(hex); if (!hex || !active) return;
    const input = active; const changed = input.value.toLowerCase() !== hex;
    input.value = hex;
    if (!preserveHsv) hsv = rgbToHsv(hexToRgb(hex));
    sync();
    if (changed) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // A consumer may rerender its field from an input event. Keep subsequent
      // changes attached to the replacement so delegated application listeners work.
      rebind(hex);
      (active || input).dispatchEvent(new Event('change', { bubbles: true }));
      rebind(hex);
    }
  }
  function open(input) {
    if (!input || input.disabled || input.closest('[inert]')) return;
    if (active === input) return;
    close(false); enhance(input); injectStyle(); active = input; initial = input.value;
    anchor = input.parentElement;
    identity = { id: input.id, attributes: [...input.attributes].filter(attribute => attribute.name.startsWith('data-') && attribute.name !== 'data-fm-color-picker').map(attribute => [attribute.name, attribute.value]) };
    if (!identity.id && !identity.attributes.length) identity = null;
    hsv = rgbToHsv(hexToRgb(input.value)); input.setAttribute('aria-expanded', 'true');
    panel = document.createElement('section'); panel.className = 'fm-color-picker'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Choose color');
    panel.style.fontFamily = root.getComputedStyle(input).fontFamily;
    panel.innerHTML = `<div class="fm-color-picker-head"><strong>Choose color</strong><button type="button" class="fm-color-close" aria-label="Close color picker">×</button></div><div class="fm-color-plane" role="slider" tabindex="0" aria-label="Saturation and brightness" aria-valuemin="0" aria-valuemax="100"><span class="fm-color-plane-dot"></span></div><input class="fm-color-hue" data-hue type="range" min="0" max="360" step="1" aria-label="Hue"><div class="fm-color-fields"><label>HEX<input data-hex spellcheck="false" maxlength="7" autocomplete="off"></label><label>R<input data-rgb type="number" min="0" max="255" aria-label="Red"></label><label>G<input data-rgb type="number" min="0" max="255" aria-label="Green"></label><label>B<input data-rgb type="number" min="0" max="255" aria-label="Blue"></label></div><div class="fm-color-presets" aria-label="Color palette"></div><p class="fm-color-status" role="status" aria-live="polite"></p><div class="fm-color-actions"><button type="button" data-reset>Reset</button><button type="button" class="fm-color-done">Done</button></div>`;
    const brand = root.__APP?.branding || root.APP?.branding || {};
    const presets = [...new Set([...(Array.isArray(brand.palette) ? brand.palette : []), brand.primaryColor, brand.secondaryColor, ...recent, '#111827', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6'].map(normalize).filter(Boolean))].slice(0, 16);
    const grid = panel.querySelector('.fm-color-presets');
    presets.forEach(hex => { const button = document.createElement('button'); button.type = 'button'; button.className = 'fm-color-preset'; button.style.setProperty('--color', hex); button.setAttribute('aria-label', 'Choose ' + hex); button.title = hex; button.addEventListener('click', () => choose(hex)); grid.appendChild(button); });
    panel.addEventListener('pointerdown', event => event.stopPropagation());
    panel.addEventListener('click', event => event.stopPropagation());
    panel.querySelector('.fm-color-close').addEventListener('click', () => close());
    panel.querySelector('.fm-color-done').addEventListener('click', () => { recent = [active.value, ...recent.filter(hex => hex !== active.value)].slice(0, 8); close(); });
    panel.querySelector('[data-reset]').addEventListener('click', () => choose(initial));
    panel.querySelector('[data-hex]').addEventListener('input', event => { const hex = normalize(event.target.value); if (/^#?[a-f\d]{6}$/i.test(event.target.value.trim()) && hex) choose(hex); });
    panel.querySelector('[data-hex]').addEventListener('change', event => { const hex = normalize(event.target.value); if (!hex) { panel.querySelector('[role=status]').textContent = 'Enter a 3 or 6 digit hex color.'; event.target.setAttribute('aria-invalid', 'true'); } else { event.target.removeAttribute('aria-invalid'); choose(hex); event.target.value = hex; } });
    panel.querySelectorAll('[data-rgb]').forEach(input => input.addEventListener('input', () => { const values = [...panel.querySelectorAll('[data-rgb]')].map(el => el.value); if (values.every(value => value !== '' && Number(value) >= 0 && Number(value) <= 255)) choose(rgbToHex(values)); }));
    panel.querySelector('[data-hue]').addEventListener('input', event => { hsv.h = Number(event.target.value); choose(rgbToHex(hsvToRgb(hsv)), true); });
    const plane = panel.querySelector('.fm-color-plane');
    const move = event => { const box = plane.getBoundingClientRect(); hsv.s = clamp((event.clientX - box.left) / box.width); hsv.v = 1 - clamp((event.clientY - box.top) / box.height); choose(rgbToHex(hsvToRgb(hsv)), true); };
    plane.addEventListener('pointerdown', event => { event.preventDefault(); plane.focus({ preventScroll: true }); plane.setPointerCapture(event.pointerId); move(event); });
    plane.addEventListener('pointermove', event => { if (plane.hasPointerCapture(event.pointerId)) move(event); });
    plane.addEventListener('keydown', event => { const step = event.shiftKey ? .1 : .01; if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return; event.preventDefault(); hsv.s = clamp(hsv.s + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)); hsv.v = clamp(hsv.v + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)); choose(rgbToHex(hsvToRgb(hsv)), true); });
    document.body.appendChild(panel); sync(); position(); panel.querySelector('[data-hex]').focus({ preventScroll: true });
  }
  function colorTarget(target) {
    if (target?.matches?.('input[type="color"]')) return target;
    if (target?.closest?.('input,button,select,textarea,a')) return null;
    const label = target?.closest?.('label'); return label?.control?.matches?.('input[type="color"]') ? label.control : null;
  }
  function install() {
    refresh();
    // Dismiss where a gesture starts, not where its synthesized click ends.
    // Dragging and consumer rerenders can retarget the final click outside the panel.
    document.addEventListener('pointerdown', event => { if (panel && !panel.contains(event.target) && event.target !== active) close(false); }, true);
    document.addEventListener('click', event => { if (panel?.contains(event.target)) return; const input = colorTarget(event.target); if (input) { event.preventDefault(); event.stopPropagation(); open(input); } }, true);
    document.addEventListener('keydown', event => {
      const input = colorTarget(event.target);
      if (input && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); open(input); }
      if (!panel) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab' && panel.contains(document.activeElement)) {
        const nodes = [...panel.querySelectorAll('button,input,[tabindex="0"]')], first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }, true);
    root.addEventListener('resize', position);
    root.addEventListener('scroll', position, true);
    observer = new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) refresh(node); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  root.FirstMateColorPicker = { open, close, refresh, normalize, rgbToHex, hexToRgb, rgbToHsv, hsvToRgb };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
  }
})(typeof window !== 'undefined' ? window : globalThis);
