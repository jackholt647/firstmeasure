// The price book setup's steps (guided experience `materials.pricebook_setup.roofing`, docs/architecture/guided-experiences.md):
// roof types, manufacturers, the default materials, a default material, suppliers and their columns, and who does the
// labor. One step module like every setup's (FLOW_MODULES in guided-setup.js): loaded through the player's loader,
// swapped in place by a live edit, `mountWidget(id, el, ctx)` per step. Each step is one page and every answer is the
// setup's selections (held by the player), so each only names its place (ctx.place). Moved out of guided-setup.js
// on 2026-11-23 so no setup is drawn by code outside the one loader.
const root = window;
const G = () => root.FirstMateGuides;
const clean = (value) => String(value ?? '').trim();
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const L = (copy, fallback) => G()?.L ? G().L(copy, fallback) : (copy?.text ?? fallback);
/** Visible copy: escaped, and editable in place for a development editor (guided-experiences.js `copyHtml`). */
const H = (copy, fallback) => G()?.copyHtml ? G().copyHtml(copy, fallback) : esc(L(copy, fallback));
const widgets = new Map();
const registerWidget = (id, widget) => widgets.set(id, widget);

  const widgetCss = `
    /* The grid takes the step's height from the top; its rows stay a tile's shape and leftover space falls below. */
    .gxs-logos{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:minmax(108px,150px);align-content:start;gap:12px;flex:1 1 auto;min-height:0;padding-bottom:24px}
    .gxs-logo-tile{position:relative;display:grid;place-items:center;min-height:0;padding:14px;container-type:inline-size;border:0;border-radius:14px;background:#f9fafb;cursor:pointer;transition:background .2s,box-shadow .25s,transform .2s;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-logo-tile:hover{background:#f2f4f7;transform:translateY(-1px)}
    .gxs-logo-tile img{display:block;width:60%;height:50%;max-width:none;max-height:none;object-fit:contain;transition:transform .25s cubic-bezier(.34,1.56,.64,1),filter .2s}
    .gxs-logo-tile .gxs-wordmark{min-height:0;padding:0;font-size:clamp(13px,11cqi,24px);line-height:1.1;max-width:100%;white-space:nowrap;justify-content:center;text-align:center}
    .gxs-logo-tile[aria-pressed=true]{background:color-mix(in srgb,var(--brand,#d93025) 7%,#fff);box-shadow:0 0 0 2px var(--brand,#d93025)}
    .gxs-logo-tile[aria-pressed=true] img{transform:scale(1.04)}
    .gxs-logo-tile[aria-pressed=false] img{filter:saturate(.85)}
    .gxs-badge-check{position:absolute;top:8px;right:8px;width:22px;height:22px;border-radius:50%;background:var(--brand,#d93025);color:#fff;display:grid;place-items:center;font-size:12px;line-height:1;transform:scale(0);opacity:0;transition:transform .3s cubic-bezier(.34,1.56,.64,1),opacity .2s}
    .gxs-logo-tile[aria-pressed=true] .gxs-badge-check{transform:scale(1);opacity:1}
    .gxs-tools{display:flex;align-items:center;gap:8px;margin:0 0 10px;flex-wrap:wrap}
    .gxs-search{flex:1 1 200px;min-width:0;height:34px;border:1px solid #d0d5dd;border-radius:9px;padding:0 10px;font:inherit}
    .gxs-search:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
    .gxs-form{display:grid;gap:6px}
    .gxs-frow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;min-height:30px}
    .gxs-frow>span:first-child{width:62px;flex:none;font-weight:650;color:#344054}
    .gxs-frow em{font-style:normal;color:#475467}
    .gxs-seg{display:inline-flex;border:1px solid #d0d5dd;border-radius:9px;padding:2px;background:#f2f4f7;gap:2px}
    .gxs-seg button{border:0;background:transparent;border-radius:7px;padding:3px 10px;font:inherit;font-size:12px;font-weight:650;color:#475467;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s}
    .gxs-seg button[aria-checked=true]{background:#fff;color:#101828;box-shadow:0 1px 3px rgba(16,24,40,.14)}
    .gxs-seg button:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:1px}
    .gxs-num{display:inline-flex;align-items:center;height:30px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding-right:8px}
    .gxs-num:focus-within{border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
    .gxs-num input{width:52px;height:28px;border:0;background:transparent;padding:0 4px 0 8px;text-align:right;font:inherit;outline:none;-moz-appearance:textfield;appearance:textfield}
    .gxs-num input::-webkit-outer-spin-button,.gxs-num input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    .gxs-num i{font-style:normal;color:#667085;padding-left:2px}
    .gxs-tip{position:fixed;z-index:2147483700;max-width:300px;background:#101828;color:#fff;font-size:12.5px;line-height:1.45;border-radius:10px;padding:8px 11px;box-shadow:0 12px 30px rgba(16,24,40,.3);pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .15s,transform .15s}
    .gxs-tip[data-show=true]{opacity:1;transform:none}
    .gxs-supplier-picks{gap:6px}
    .gxs-supplier-pill .gxs-dot{width:8px;height:8px;border-radius:50%;background:var(--brand);display:inline-block;margin-right:6px}
    .gxs-supplier-pill[aria-pressed=true]{border-color:var(--brand);background:var(--brand);color:#fff}
    .gxs-supplier-pill[aria-pressed=true] .gxs-dot{background:#fff}
    .gxs-supplier-custom{display:contents}
    .gxs-supplier-tag button{border:0;background:transparent;margin-left:4px;cursor:pointer;font-size:14px;line-height:1;color:#667085;padding:0}
    .gxs-supplier-input{flex:1 1 220px}
    .gxs-supplier-cols{margin-top:8px;flex:1 1 auto;min-height:260px}
    .gxs-supplier-empty{flex:1 1 auto;min-height:220px;margin:8px 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border:1.5px dashed #e4e7ec;border-radius:14px;background:#fcfcfd;color:#667085;font-size:13.5px;text-align:center;padding:24px}
    .gxs-supplier-empty[hidden]{display:none}
    .gxs-supplier-empty .gxs-empty-icon{width:48px;height:48px;border-radius:14px;background:#f2f4f7;display:grid;place-items:center;color:#98a2b3;font-size:20px}
    /* Roof types and the default material: a drawing and a name per tile, ticked like the logos. */
    .gxs-types{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));grid-auto-rows:minmax(104px,1fr);gap:12px;flex:1 1 auto;min-height:0;padding-bottom:20px}
    .gxs-types.gxs-materials{grid-auto-rows:minmax(104px,170px);align-content:start}
    .gxs-type{position:relative;display:flex;flex-direction:column;min-height:0;padding:0;border:0;border-radius:14px;background:#f9fafb;cursor:pointer;overflow:hidden;text-align:left;font:inherit;color:inherit;transition:box-shadow .25s,transform .2s,background .2s;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-type:hover{transform:translateY(-1px);background:#f2f4f7}
    .gxs-swatch{display:block;width:100%;flex:1 1 auto;min-height:0;filter:saturate(.75) brightness(1.03);transition:filter .25s}
    .gxs-type:hover .gxs-swatch,.gxs-type[aria-pressed=true] .gxs-swatch{filter:none}
    .gxs-type-name{flex:none;padding:8px 12px 9px;font-weight:700;font-size:13.5px;line-height:1.25;color:#101828;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .gxs-type-meta{position:absolute;left:8px;top:8px;font-size:11px;font-weight:700;color:#344054;background:rgba(255,255,255,.9);border-radius:999px;padding:2px 8px;box-shadow:0 1px 2px rgba(16,24,40,.12)}
    .gxs-type[aria-pressed=true]{background:color-mix(in srgb,var(--primary,#d93025) 6%,#fff);box-shadow:0 0 0 2px var(--primary,#d93025)}
    .gxs-type .gxs-badge-check{background:var(--primary,#d93025);box-shadow:0 2px 6px rgba(16,24,40,.2)}
    .gxs-type[aria-pressed=true] .gxs-badge-check{transform:scale(1);opacity:1}
    .gxs-badge-check{font-weight:800;font-variant-numeric:tabular-nums}
    /* Default materials: four groups in two columns, one compact row each. */
    .gxs-pd{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;align-items:start}
    .gxs-pd-col{display:flex;flex-direction:column;gap:12px;min-width:0}
    .gxs-pd-section{border:1px solid #eaecf0;border-radius:14px;background:#fff;padding:4px 14px 6px;animation:gxsMsg .4s cubic-bezier(.22,1,.36,1) both}
    .gxs-pd-col:last-child .gxs-pd-section{animation-delay:60ms}
    .gxs-pd-section h3{display:flex;align-items:center;gap:8px;margin:6px 0 2px;font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:.06em;color:#667085}
    .gxs-pd-section h3 i{color:var(--primary,#d93025);font-size:11.5px;width:14px;text-align:center}
    .gxs-pd-row{display:flex;flex-direction:column;gap:4px;padding:7px 0 8px;border-top:1px solid #f2f4f7}
    .gxs-pd-section h3+.gxs-pd-row{border-top:0;padding-top:4px}
    .gxs-pd-label{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:650;color:#344054;min-width:0;white-space:nowrap}
    .gxs-pd-label .gxs-pd-hand{margin-left:auto}
    .gxs-pd-info{flex:none;width:16px;height:16px;border-radius:50%;border:1px solid #d0d5dd;background:#fff;color:#667085;font:italic 700 9.5px/1 Georgia,serif;cursor:help;display:inline-grid;place-items:center}
    .gxs-pd-info:hover,.gxs-pd-info:focus-visible{border-color:#98a2b3;color:#344054;outline:none}
    .gxs-pd-control{min-width:0;display:flex}
    .gxs-pd-select{width:100%;min-width:0;height:32px;border:1px solid #d0d5dd;border-radius:9px;background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23667085' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center/10px 6px;padding:0 28px 0 10px;font:inherit;font-size:13px;color:#101828;-webkit-appearance:none;appearance:none;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;cursor:pointer;transition:border-color .15s,box-shadow .15s}
    .gxs-pd-select:hover{border-color:#98a2b3}
    .gxs-pd-select:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.12)}
    .gxs-pd-select:disabled{color:#98a2b3;background-color:#f9fafb;cursor:default}
    .gxs-pd-hand{font-size:10.5px;font-weight:700;color:#b54708;background:#fffaeb;border-radius:999px;padding:2px 8px;white-space:nowrap;cursor:help}
    .gxs-pd-note{display:flex;align-items:center;gap:7px;margin:12px 2px 0;color:#667085;font-size:12.5px}
    .gxs-pd-note i{color:#12b76a}
    .gxs-lab-add{gap:8px}
    .gxs-lab-toggle{display:inline-flex;gap:4px}
    .gxs-lab-name{flex:1 1 180px}
    .gxs-labs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:start}
    .gxs-lab{position:relative;border:1px solid #eaecf0;border-radius:12px;background:#fff;padding:10px 12px;display:flex;flex-direction:column;gap:8px}
    .gxs-lab-in{animation:gxsMsg .35s cubic-bezier(.22,1,.36,1) both}
    .gxs-lab header{display:flex;align-items:center;gap:8px;min-width:0}
    .gxs-lab header strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px}
    .gxs-lab-kind{flex:none;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:999px;padding:3px 8px;background:#eff8ff;color:#175cd3}
    .gxs-lab-kind[data-kind=organization_connection]{background:#fdf2fa;color:#c11574}
    .gxs-lab-remove{border:0;background:transparent;color:#98a2b3;font-size:16px;cursor:pointer;padding:0 2px}
    .gxs-lab-methods{align-self:flex-start}
    .gxs-lab-rate{display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-height:0;opacity:0;overflow:hidden;transition:max-height .3s cubic-bezier(.22,1,.36,1),opacity .2s}
    .gxs-lab-rate[data-open=true]{max-height:60px;opacity:1}
    .gxs-lab-rate label{display:inline-flex;align-items:center;gap:4px;color:#475467}
    .gxs-lab-rate .gxs-num{padding-right:6px}
    .gxs-lab-rate select,.gxs-lab select{height:28px;border:1px solid #d0d5dd;border-radius:7px;padding:0 6px;font:inherit;font-size:12.5px;max-width:100%}
    .gxs-lab-rate em{font-style:normal;color:#475467;font-size:12.5px}
    .gxs-lab-note{margin:0;color:#475467;font-size:12.5px}
    .gxs-lab .gxs-lab-sheet{display:inline-flex;align-items:center;gap:6px;width:auto;align-self:flex-start;height:30px;padding:0 12px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer}
    .gxs-lab .gxs-lab-sheet:hover{background:#f9fafb;border-color:#98a2b3}
    .gxs-lab .gxs-frow>span:first-child{width:auto;min-width:40px}
    .gxs-lab-empty{grid-column:1/-1;color:#667085;margin:8px 0}
    @media(max-width:760px){.gxs-labs{grid-template-columns:minmax(0,1fr)}}
    @media(max-width:760px){.gxs-logos{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(84px,1fr);max-height:none}.gxs-logo-tile{padding:10px 12px}.gxs-types{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(96px,1fr)}.gxs-pd{grid-template-columns:minmax(0,1fr)}}
  `;
  const injectWidgetCss = () => G()?.injectCss?.('gx-setup-widgets-css', widgetCss);
  /** One shared tooltip: plain text, positioned beside the element it explains. */
  function tooltip(){
    let tip = document.querySelector('.gxs-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'gxs-tip'; tip.setAttribute('role', 'tooltip'); tip.setAttribute('data-fmr-ignore', ''); document.body.appendChild(tip); }
    return {
      show(anchor, text){ if (!text) return; tip.textContent = text; tip.dataset.show = 'true'; const r = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect(); tip.style.left = `${Math.max(8, Math.min(r.left, root.innerWidth - t.width - 8))}px`; tip.style.top = `${r.bottom + 8 + t.height > root.innerHeight ? r.top - t.height - 8 : r.bottom + 8}px`; },
      hide(){ tip.dataset.show = 'false'; }
    };
  }

  // Manufacturers: logos only, a check badge on the chosen ones; "Use all" in the title row. Each logo is sized by its
  // area, not its height, so a square mark and a wide wordmark look equally weighted; the wordmark text only when a
  // logo is missing. The grid grows to fill the step.
  function fitLogos(el){
    el.querySelectorAll('.gxs-logo-tile').forEach((tile) => {
      const img = tile.querySelector('img'); if (!img || !img.naturalWidth || !img.naturalHeight) return;
      const style = getComputedStyle(tile);
      const innerW = tile.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const innerH = tile.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (innerW <= 0 || innerH <= 0) return;
      const aspect = img.naturalWidth / img.naturalHeight;
      const area = innerW * innerH * 0.5;
      let width = Math.sqrt(area * aspect), height = width / aspect;
      if (width > innerW * 0.92) { width = innerW * 0.92; height = width / aspect; }
      if (height > innerH * 0.8) { height = innerH * 0.8; width = height * aspect; }
      img.style.width = `${Math.round(width)}px`; img.style.height = `${Math.round(height)}px`;
    });
  }
  registerWidget('brand-cards', {
    fill: true,
    render(el, { options, selections, change, L, actions }){
      injectWidgetCss();
      const brands = array(options.brands);
      // In the order picked: defaults come from the first one that makes each thing, so its badge says 1.
      const picked = new Set(array(selections.brands).filter((id) => brands.some((brand) => brand.id === id)));
      const named = () => [...picked].map((id) => brands.find((brand) => brand.id === id)?.name).filter(Boolean);
      const summary = () => picked.size === brands.length ? L('gx_ui_all_brands', 'All of them') : named().join(', ');
      const report = () => change({ brands: [...picked], region: clean(options.region?.id) }, summary());
      const order = () => [...picked];
      const sync = () => { el.querySelectorAll('[data-brand]').forEach((tile) => { const at = order().indexOf(tile.dataset.brand); tile.setAttribute('aria-pressed', String(at >= 0)); const badge = tile.querySelector('.gxs-badge-check'); if (badge) badge.textContent = at >= 0 ? String(at + 1) : ''; if (at === 0) tile.title = `${tile.getAttribute('aria-label')}: ${L('gx_ui_first_brand', 'your defaults come from this one first')}`; else tile.title = tile.getAttribute('aria-label'); }); actions?.querySelector('[data-all]')?.setAttribute('aria-pressed', String(picked.size === brands.length)); report(); };
      if (actions && options.allow_all !== false) {
        actions.innerHTML = `<button type="button" class="gxs-chip" data-all aria-pressed="false">${H('gx_ui_use_all', 'Use all')}</button>`;
        actions.querySelector('[data-all]').addEventListener('click', () => { if (picked.size === brands.length) picked.clear(); else brands.forEach((brand) => picked.add(brand.id)); sync(); });
      }
      el.innerHTML = `<div class="gxs-logos">${brands.map((brand, i) => `<button type="button" class="gxs-logo-tile" style="--brand:${esc(brand.color)};animation-delay:${i * 40}ms" aria-pressed="false" aria-label="${esc(brand.name)}" title="${esc(brand.name)}" data-brand="${esc(brand.id)}">${brand.logo ? `<img src="${esc(brand.logo)}" alt="${esc(brand.name)}" decoding="async" data-gxs-logo>` : `<span class="gxs-wordmark">${esc(brand.name)}</span>`}<span class="gxs-badge-check" aria-hidden="true">&#10003;</span></button>`).join('')}</div>`;
      el.querySelectorAll('img[data-gxs-logo]').forEach((img) => {
        img.addEventListener('error', () => { const mark = document.createElement('span'); mark.className = 'gxs-wordmark'; mark.textContent = img.alt; img.replaceWith(mark); }, { once: true });
        img.addEventListener('load', () => fitLogos(el), { once: true });
      });
      const resize = root.ResizeObserver ? new root.ResizeObserver(() => fitLogos(el)) : null;
      resize?.observe(el);
      el.addEventListener('click', (event) => {
        const id = event.target.closest('[data-brand]')?.dataset.brand;
        if (!id) return;
        if (picked.has(id)) picked.delete(id); else picked.add(id);
        sync();
      });
      sync();
      requestAnimationFrame(() => fitLogos(el));
      setTimeout(() => el.classList.add('gxs-settled'), 900);
      return { valid: () => picked.size > 0, summary, hint: () => L('gx_ui_hint_brand', 'Pick at least one manufacturer to continue.'), destroy(){ resize?.disconnect(); } };
    }
  });

  // ── Roof types, defaults and the default material ─────────────────────
  /**
   * A small drawing of each kind of roof, so the choice reads at a glance. Plain shapes in the material's colours;
   * a kind the drawings do not know gets a neutral swatch.
   */
  const SWATCH = {
    shingle: '<rect width="96" height="56" fill="#4b5563"/>' + [0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4, 5].map((c) => `<rect x="${c * 18 - (r % 2) * 9 + 1}" y="${r * 14 + 1}" width="16" height="12" rx="1.5" fill="${['#6b7280', '#5f6672', '#727a87'][(r + c) % 3]}"/>`).join('')).join(''),
    shake: '<rect width="96" height="56" fill="#7a5530"/>' + [0, 1, 2].map((r) => [0, 1, 2, 3, 4, 5, 6, 7].map((c) => { const w = [10, 13, 9, 12, 11, 14, 10, 12][(c + r * 3) % 8]; return `<rect x="${c * 12.5 - (r % 2) * 6 + 0.5}" y="${r * 19 + 0.5}" width="${w}" height="18" rx="1" fill="${['#b07d4b', '#a26f3f', '#bd8a57'][(r + c) % 3]}"/>`; }).join('')).join(''),
    metal: '<rect width="96" height="56" fill="#5d7189"/>' + [0, 1, 2, 3, 4, 5, 6].map((c) => `<rect x="${c * 14 + 4}" y="0" width="2.5" height="56" fill="#8ea3bb"/><rect x="${c * 14 + 6.5}" y="0" width="1.2" height="56" fill="#45566b"/>`).join(''),
    tile: '<rect width="96" height="56" fill="#9a4a2c"/>' + [0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4, 5, 6].map((c) => `<path d="M${c * 15 - (r % 2) * 7} ${r * 14 + 13} q7.5 -12 15 0" fill="${['#c8673f', '#d17549', '#bd5d37'][(r + c) % 3]}" stroke="#8a3f24" stroke-width="1"/>`).join('')).join(''),
    slate: '<rect width="96" height="56" fill="#2e3742"/>' + [0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4, 5, 6, 7].map((c) => `<rect x="${c * 12.5 - (r % 2) * 6 + 0.6}" y="${r * 14 + 0.6}" width="11.4" height="12.8" rx="0.8" fill="${['#48525e', '#3e4752', '#545f6c'][(r + c * 2) % 3]}"/>`).join('')).join(''),
    tpo: '<rect width="96" height="56" fill="#eef2f6"/>' + [14, 28, 42].map((y) => `<rect x="0" y="${y}" width="96" height="1.6" fill="#cbd3dd"/>`).join('') + '<rect x="0" y="0" width="96" height="56" fill="url(#gxsSheen)" opacity=".5"/>',
    pvc: '<rect width="96" height="56" fill="#e3ebf3"/>' + [18, 38].map((y) => `<rect x="0" y="${y}" width="96" height="2" fill="#b9c6d4"/>` + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((c) => `<circle cx="${c * 8 + 4}" cy="${y + 4.5}" r="0.9" fill="#9aabbe"/>`).join('')).join(''),
    metal_exposed_fastener: '<rect width="96" height="56" fill="#7d8b99"/>' + [...Array(16)].map((_, c) => `<rect x="${c * 6}" y="0" width="3" height="56" fill="${c % 4 === 0 ? '#aebbc8' : '#95a3b1'}"/>`).join(''),
    stone_coated_steel: '<rect width="96" height="56" fill="#5a3d2b"/>' + [0, 1, 2, 3].map((r) => [0, 1, 2, 3, 4, 5].map((c) => `<path d="M${c * 18 - (r % 2) * 9} ${r * 14} h17 v11 q-8.5 4 -17 0z" fill="${['#7b5640', '#6f4c37', '#86604a'][(r + c) % 3]}"/>`).join('')).join('') + [...Array(50)].map((_, i) => `<circle cx="${(i * 41) % 96}" cy="${(i * 29) % 56}" r="0.6" fill="#a98468"/>`).join(''),
    epdm: '<rect width="96" height="56" fill="#23272e"/><rect x="0" y="27" width="96" height="2" fill="#3b414b"/><rect x="0" y="0" width="96" height="56" fill="url(#gxsSheen)" opacity=".18"/>',
    mod_bit: '<rect width="96" height="56" fill="#55524c"/>' + [0, 1, 2, 3].map((r) => `<rect x="-4" y="${r * 15 - 2}" width="104" height="13" fill="${['#6f6b63', '#67635b'][r % 2]}"/><rect x="-4" y="${r * 15 + 10}" width="104" height="1.4" fill="#45423d"/>`).join('') + [...Array(40)].map((_, i) => `<circle cx="${(i * 37) % 96}" cy="${(i * 23) % 56}" r="0.7" fill="#8d887e"/>`).join('')
  };
  const swatch = (id) => `<svg class="gxs-swatch" viewBox="0 0 96 56" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><linearGradient id="gxsSheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>${SWATCH[id] || '<rect width="96" height="56" fill="#98a2b3"/>'}</svg>`;
  const ROOF_WORDS = { shingle: ['gx_rt_shingle', 'Shingle'], shake: ['gx_rt_shake', 'Shake'], metal: ['gx_rt_metal', 'Metal'], tile: ['gx_rt_tile', 'Tile'], slate: ['gx_rt_slate', 'Slate'], tpo: ['gx_rt_tpo', 'TPO'], pvc: ['gx_rt_pvc', 'PVC'], epdm: ['gx_rt_epdm', 'EPDM'], mod_bit: ['gx_rt_mod_bit', 'Torch-down / mod-bit'] };
  const ROOF_TIPS = { shingle: ['gx_rt_shingle_tip', 'Asphalt shingles, from the manufacturers you pick next'], shake: ['gx_rt_shake_tip', 'Cedar shakes'], metal: ['gx_rt_metal_tip', 'Standing seam, exposed-fastener panels and stone-coated steel'], tile: ['gx_rt_tile_tip', 'Concrete and clay tile'], slate: ['gx_rt_slate_tip', 'Natural slate'], tpo: ['gx_rt_tpo_tip', 'Single-ply TPO membrane for low-slope roofs'], pvc: ['gx_rt_pvc_tip', 'Single-ply PVC membrane, welded like TPO but a different material'], epdm: ['gx_rt_epdm_tip', 'Single-ply EPDM rubber membrane'], mod_bit: ['gx_rt_mod_bit_tip', 'Modified bitumen base and cap sheets, torched or self-adhered'] };
  const roofWord = (type) => ROOF_WORDS[type.id] ? L(ROOF_WORDS[type.id][0], ROOF_WORDS[type.id][1]) : clean(type.label);
  const roofWordHtml = (type) => ROOF_WORDS[type.id] ? H(ROOF_WORDS[type.id][0], ROOF_WORDS[type.id][1]) : esc(type.label);
  const roofTip = (type) => ROOF_TIPS[type.id] ? L(ROOF_TIPS[type.id][0], ROOF_TIPS[type.id][1]) : clean(type.label);

  // What kinds of roof: one tile each, a drawing and a name, ticked like the manufacturers' logos.
  registerWidget('roof-types', {
    fill: true,
    render(el, { options, selections, change, L }){
      injectWidgetCss();
      const types = array(options.roof_types);
      const picked = new Set(array(selections.roof_types).filter((id) => types.some((type) => type.id === id)));
      const summary = () => types.filter((type) => picked.has(type.id)).map(roofWord).join(', ');
      const report = () => change({ roof_types: types.filter((type) => picked.has(type.id)).map((type) => type.id), region: clean(options.region?.id) }, summary());
      el.innerHTML = `<div class="gxs-types">${types.map((type, i) => `<button type="button" class="gxs-type" data-type="${esc(type.id)}" aria-pressed="false" title="${esc(roofTip(type))}" style="animation-delay:${i * 35}ms">${swatch(type.id)}<span class="gxs-type-name">${roofWordHtml(type)}</span><span class="gxs-badge-check" aria-hidden="true">&#10003;</span></button>`).join('')}</div>`;
      const sync = () => { el.querySelectorAll('[data-type]').forEach((tile) => tile.setAttribute('aria-pressed', String(picked.has(tile.dataset.type)))); report(); };
      el.addEventListener('click', (event) => { const id = event.target.closest('[data-type]')?.dataset.type; if (!id) return; if (picked.has(id)) picked.delete(id); else picked.add(id); sync(); });
      sync();
      return { valid: () => picked.size > 0, summary, hint: () => L('gx_ui_hint_type', 'Pick at least one kind of roof to continue.') };
    }
  });

  /**
   * The picked brands in the order they were picked, and what each default slot can be: the picked brands' products of
   * its role, then the generic ones of its rule. The server resolves the same way (pricebook/setups/roofing.ts).
   */
  const SLOTS = { underlayment: { role: 'underlayment', rule: 'underlayment' }, ice_water: { role: 'ice_water', rule: 'ice_water' }, pipe_boot: { role: 'pipe_boot', rule: 'pipe_boots', genericFirst: true }, ridge_vent: { role: 'ridge_vent', rule: 'ridge_vent' }, intake_vent: { role: 'intake_vent', rule: 'intake_vent' }, box_vent: { role: 'box_vent', rule: 'box_vents' } };
  function pickedBrands(options, selections){ const brands = array(options.brands); return array(selections.brands).map((id) => brands.find((brand) => brand.id === id)).filter(Boolean); }
  const plainOf = (entry) => !entry.colored_starter;
  function slotOptions(options, brands, slot){
    const { role, rule, genericFirst } = SLOTS[slot];
    const branded = brands.flatMap((brand) => array(brand.accessories).filter((entry) => entry.role === role && plainOf(entry)).map((entry) => ({ ...entry, brandName: brand.name })));
    const generic = array(options.generic).filter((entry) => entry.rule === rule);
    return genericFirst ? [...generic, ...branded] : [...branded, ...generic];
  }
  function slotDefault(options, brands, slot){
    const { role, rule, genericFirst } = SLOTS[slot];
    const generic = array(options.generic).filter((entry) => entry.rule === rule);
    if (genericFirst && generic.length) return generic.find((entry) => entry.setup_default) || generic[0];
    for (const brand of brands) { const own = array(brand.accessories).filter((entry) => entry.role === role && plainOf(entry)); if (own.length) return own.find((entry) => entry.setup_default) || own[0]; }
    return generic.find((entry) => entry.setup_default) || generic[0] || null;
  }
  const flagship = (brand) => array(brand?.lines).find((line) => line.flagship) || array(brand?.lines).find((line) => line.visibility === 'default') || array(brand?.lines)[0] || null;
  function lowSlopeOptions(options, brands, system){
    const branded = brands.flatMap((brand) => array(brand.accessories).filter((entry) => entry.system === system && (entry.role === 'low_slope_membrane' || entry.role === 'low_slope_cap')).map((entry) => ({ ...entry, brandName: brand.name })));
    const generic = object(object(options.low_slope)[system]).cap;
    return [...branded, ...(generic ? [generic] : [])];
  }
  const shortName = (entry, brandName) => brandName && String(entry.name).startsWith(brandName + ' ') ? String(entry.name).slice(brandName.length + 1) : String(entry.name);

  /**
   * The defaults generation uses, on one page: each a compact row with the product preselected and a dropdown to
   * change it, in four groups across two columns. No waste or formulas; how each is worked out is in its tooltip.
   */
  registerWidget('material-defaults', {
    render(el, { options, selections, change, L }){
      injectWidgetCss();
      const brands = pickedBrands(options, selections);
      const chosen = { ...object(selections.defaults) };
      const types = array(selections.roof_types);
      const membranes = array(options.roof_types).filter((type) => type.low_slope).map((type) => type.id);
      const installed = types.filter((id) => membranes.includes(id));
      const startSystem = installed.length && !installed.includes('tpo') ? installed[0] : 'tpo';
      const lines = brands.flatMap((brand) => array(brand.lines).map((line) => ({ ...line, brandName: brand.name })));
      const value = {
        shingle: lines.find((line) => line.id === chosen.shingle)?.id || flagship(brands[0])?.id || '',
        ice_coverage: object(options.ice_coverage).options?.includes?.(chosen.ice_coverage) ? chosen.ice_coverage : clean(object(options.ice_coverage).default) || 'perimeter_18_valleys',
        low_slope_system: ['tpo', 'pvc', 'epdm', 'mod_bit', 'none'].includes(chosen.low_slope_system) ? chosen.low_slope_system : startSystem
      };
      for (const slot of Object.keys(SLOTS)) { const offered = slotOptions(options, brands, slot); value[slot] = offered.find((entry) => entry.id === chosen[slot])?.id || slotDefault(options, brands, slot)?.id || ''; }
      const lowOffered = () => value.low_slope_system === 'none' ? [] : lowSlopeOptions(options, brands, value.low_slope_system);
      value.low_slope = lowOffered().find((entry) => entry.id === chosen.low_slope)?.id || lowOffered()[0]?.id || '';
      const ICE = [['perimeter_18_valleys', 'gx_pd_ice_perimeter', '18 in at eaves and rakes, plus valleys'], ['eaves_36_valleys', 'gx_pd_ice_36', '36 in at the eaves, plus valleys'], ['eaves_72_valleys', 'gx_pd_ice_72', '72 in at the eaves, plus valleys'], ['eaves_36', 'gx_pd_ice_36_only', '36 in at the eaves only'], ['valleys', 'gx_pd_ice_valleys', 'Valleys only'], ['none', 'gx_pd_ice_none', 'None']];
      const SYSTEMS = [['tpo', 'gx_rt_tpo', 'TPO'], ['pvc', 'gx_rt_pvc', 'PVC'], ['epdm', 'gx_rt_epdm', 'EPDM'], ['mod_bit', 'gx_rt_mod_bit', 'Torch-down / mod-bit'], ['none', 'gx_pd_low_none', 'None']];
      // A select of products grouped by maker, each named without its maker's name; generic items under their own heading.
      const productSelect = (key, entries, label) => {
        const groups = new Map();
        for (const entry of entries) { const group = entry.brandName || L('gx_pd_generic', 'Any brand'); if (!groups.has(group)) groups.set(group, []); groups.get(group).push(entry); }
        const optionsHtml = [...groups].map(([group, rows]) => `<optgroup label="${esc(group)}">${rows.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === value[key] ? 'selected' : ''}>${esc(shortName(entry, entry.brandName))}</option>`).join('')}</optgroup>`).join('');
        return `<select class="gxs-pd-select" data-slot="${esc(key)}" aria-label="${esc(label)}" ${entries.length ? '' : 'disabled'}>${optionsHtml || `<option value="">${esc(L('gx_pd_none_offered', 'None from these brands'))}</option>`}</select>`;
      };
      const choiceSelect = (key, choices, label) => `<select class="gxs-pd-select" data-slot="${esc(key)}" aria-label="${esc(label)}">${choices.map(([id, copy, text]) => `<option value="${esc(id)}" ${id === value[key] ? 'selected' : ''}>${esc(L(copy, text))}</option>`).join('')}</select>`;
      // How each is worked out, in the shared tooltip (fixed to the page, so a column's edge never clips it).
      const tipIcon = (text) => `<span class="gxs-pd-info" role="img" tabindex="0" aria-label="${esc(text)}" data-tip="${esc(text)}">i</span>`;
      const hand = `<span class="gxs-pd-hand" tabindex="0" data-tip="${esc(L('gx_pd_hand_tip', 'The roof report doesn’t count these, so you enter how many on each job.'))}">${H('gx_pd_hand', 'By hand')}</span>`;
      const tip = tooltip();
      const row = (label, tip, control, extra = '') => `<div class="gxs-pd-row"><span class="gxs-pd-label">${esc(label)}${tip ? tipIcon(tip) : ''}${extra}</span><span class="gxs-pd-control">${control}</span></div>`;
      const section = (icon, title, rows) => `<section class="gxs-pd-section"><h3><i class="fas ${icon}" aria-hidden="true"></i>${esc(title)}</h3>${rows.join('')}</section>`;
      const draw = () => {
        const shingleLabel = L('gx_pd_shingle', 'Shingle'), lowLabel = value.low_slope_system === 'mod_bit' ? L('gx_pd_cap_sheet', 'Cap sheet') : L('gx_pd_membrane', 'Membrane');
        el.innerHTML = `<div class="gxs-pd">
          <div class="gxs-pd-col">
            ${section('fa-house-chimney', L('gx_pd_group_shingle', 'Shingle roof'), [
              row(shingleLabel, L('gx_pd_shingle_tip', 'Every square of roof steeper than 2/12, plus waste worked out from the roof.'), productSelect('shingle', lines, shingleLabel)),
              row(L('gx_pd_underlayment', 'Underlayment'), L('gx_pd_underlayment_tip', 'Covers the whole shingled deck.'), productSelect('underlayment', slotOptions(options, brands, 'underlayment'), L('gx_pd_underlayment', 'Underlayment'))),
              row(L('gx_pd_ice', 'Ice and water'), L('gx_pd_ice_tip', 'A self-adhered leak barrier at the roof’s edges and down every valley.'), productSelect('ice_water', slotOptions(options, brands, 'ice_water'), L('gx_pd_ice', 'Ice and water'))),
              row(L('gx_pd_ice_where', 'Runs along'), L('gx_pd_ice_where_tip', 'How far up from each edge it goes. The amount ordered follows this.'), choiceSelect('ice_coverage', ICE, L('gx_pd_ice_where', 'Runs along')))
            ])}
            ${section('fa-toolbox', L('gx_pd_group_accessories', 'Accessories'), [
              row(L('gx_pd_pipe', 'Pipe boot'), '', productSelect('pipe_boot', slotOptions(options, brands, 'pipe_boot'), L('gx_pd_pipe', 'Pipe boot')), hand)
            ])}
          </div>
          <div class="gxs-pd-col">
            ${section('fa-wind', L('gx_pd_group_vent', 'Ventilation'), [
              row(L('gx_pd_ridge', 'Ridge vent'), L('gx_pd_ridge_tip', 'Runs along the ridges, under the ridge cap.'), productSelect('ridge_vent', slotOptions(options, brands, 'ridge_vent'), L('gx_pd_ridge', 'Ridge vent'))),
              row(L('gx_pd_intake', 'Intake vent'), L('gx_pd_intake_tip', 'Runs along the eaves, so air comes in low and leaves at the ridge.'), productSelect('intake_vent', slotOptions(options, brands, 'intake_vent'), L('gx_pd_intake', 'Intake vent'))),
              row(L('gx_pd_box', 'Box vents'), '', productSelect('box_vent', slotOptions(options, brands, 'box_vent'), L('gx_pd_box', 'Box vents')), hand)
            ])}
            ${section('fa-layer-group', L('gx_pd_group_low', 'Low slope'), [
              row(L('gx_pd_system', 'System'), L('gx_pd_system_tip', 'For the parts of a roof at 2/12 or flatter. Modified bitumen uses a base and a cap sheet from the same company.'), choiceSelect('low_slope_system', SYSTEMS, L('gx_pd_system', 'System'))),
              ...(value.low_slope_system === 'none' ? [] : [row(lowLabel, '', productSelect('low_slope', lowOffered(), lowLabel))])
            ])}
          </div>
        </div>
        <p class="gxs-pd-note"><i class="fas fa-circle-check" aria-hidden="true"></i>${H('gx_pd_note', 'Starter strip, drip edge and hip and ridge cap follow your shingle.')}</p>`;
      };
      const nameOf = (id) => { for (const entry of [...lines, ...Object.keys(SLOTS).flatMap((slot) => slotOptions(options, brands, slot)), ...lowOffered()]) if (entry.id === id) return shortName(entry, entry.brandName); return ''; };
      const baseline = { ...value };
      // What changed, as someone would say it; the defaults as they stand when nothing did.
      const ORDER = ['shingle', 'underlayment', 'ice_water', 'ice_coverage', 'pipe_boot', 'ridge_vent', 'intake_vent', 'box_vent', 'low_slope_system', 'low_slope'];
      const summary = () => {
        const changed = ORDER.filter((key) => value[key] !== baseline[key]);
        if (!changed.length) return '';
        return changed.map((key) => key === 'ice_coverage' ? `${L('gx_pd_ice', 'Ice and water')}: ${L(...ICE.find(([id]) => id === value[key]).slice(1))}` : key === 'low_slope_system' ? `${L('gx_pd_group_low', 'Low slope')}: ${L(...SYSTEMS.find(([id]) => id === value[key]).slice(1))}` : nameOf(value[key])).filter(Boolean).join(', ');
      };
      const report = () => change({ defaults: { ...value } }, summary());
      el.addEventListener('change', (event) => {
        const select = event.target.closest('[data-slot]'); if (!select) return;
        value[select.dataset.slot] = select.value;
        if (select.dataset.slot === 'low_slope_system') { value.low_slope = lowOffered()[0]?.id || ''; draw(); el.querySelector('[data-slot=low_slope_system]')?.focus(); }
        report();
      });
      el.addEventListener('pointerover', (event) => { const at = event.target.closest('[data-tip]'); if (at) tip.show(at, at.dataset.tip); });
      el.addEventListener('pointerout', (event) => { if (event.target.closest('[data-tip]') && !event.relatedTarget?.closest?.('[data-tip]')) tip.hide(); });
      el.addEventListener('focusin', (event) => { const at = event.target.closest('[data-tip]'); if (at) tip.show(at, at.dataset.tip); else tip.hide(); });
      el.addEventListener('focusout', () => tip.hide());
      draw(); report();
      return { valid: () => true, summary, destroy(){ tip.hide(); } };
    }
  });

  // The default material where shingle is not installed: one of the systems of the kinds picked (metal has three).
  registerWidget('default-material', {
    fill: true,
    render(el, { options, selections, change, L }){
      injectWidgetCss();
      const types = array(options.roof_types).filter((type) => array(selections.roof_types).includes(type.id) && !type.catalog);
      const systems = types.flatMap((type) => array(type.systems).map((system) => ({ ...system, type })));
      let picked = systems.find((system) => system.id === selections.default_material)?.id || systems[0]?.id || '';
      const label = (system) => array(system.type.systems).length > 1 ? clean(system.label).replace(/\s*\(.*\)\s*$/, '') : roofWord(system.type);
      const summary = () => { const system = systems.find((entry) => entry.id === picked); return system ? label(system) : ''; };
      const partsTip = (system) => `${L('gx_dm_parts_tip', 'What a new materials list includes')}: ${array(system.parts).slice(0, 12).join(', ')}${array(system.parts).length > 12 ? '…' : ''}`;
      el.innerHTML = `<div class="gxs-types gxs-materials" role="radiogroup" aria-label="${esc(L('gx_dm_aria', 'Default roofing material'))}">${systems.map((system, i) => `<button type="button" class="gxs-type" role="radio" data-system="${esc(system.id)}" aria-checked="false" aria-pressed="false" title="${esc(`${clean(system.label)}. ${partsTip(system)}`)}" style="animation-delay:${i * 35}ms">${swatch(SWATCH[system.id] ? system.id : system.type.id)}<span class="gxs-type-name">${esc(label(system))}</span><span class="gxs-type-meta">${esc(String(system.standard || 0))} ${H('gx_dm_parts', 'parts')}</span><span class="gxs-badge-check" aria-hidden="true">&#10003;</span></button>`).join('')}</div>`;
      const sync = () => { el.querySelectorAll('[data-system]').forEach((tile) => { const on = tile.dataset.system === picked; tile.setAttribute('aria-pressed', String(on)); tile.setAttribute('aria-checked', String(on)); }); change({ default_material: picked }, summary()); };
      el.addEventListener('click', (event) => { const id = event.target.closest('[data-system]')?.dataset.system; if (!id) return; picked = id; sync(); });
      sync();
      return { valid: () => !!picked, summary, hint: () => L('gx_ui_hint_material', 'Pick your default roofing material to continue.') };
    }
  });

  /**
   * What the suppliers can carry: with shingle, every product of the picked brands (grouped by brand) and the common
   * items. Without, nothing is suggested: there is no catalog to suggest from, and a supplier's price sheet says what it sells.
   */
  function supplierItems(options, selections, L){
    const shingle = array(selections.roof_types).length ? array(options.roof_types).some((type) => type.catalog && array(selections.roof_types).includes(type.id)) : true;
    if (!shingle) return { shingle, items: [] };
    const brands = pickedBrands(options, selections);
    const items = [];
    for (const brand of brands) for (const entry of [...array(brand.lines), ...array(brand.accessories)]) items.push({ id: entry.id, name: entry.name, label: shortName(entry, brand.name), unit: entry.unit, price: entry.price, group: brand.name, kind: entry.kind === 'line' ? 'line' : 'accessory', brand: brand.id, visibility: entry.visibility, colored: !!entry.colored_starter });
    for (const entry of array(options.generic)) items.push({ id: entry.id, name: entry.name, label: entry.name, unit: entry.unit, price: entry.price, group: L('gx_ui_group_common', 'Common items'), kind: 'generic', brand: '' });
    return { shingle, items };
  }

  /**
   * Who provides the materials: the researched suppliers as pills and any typed one as a tag; the chosen ones as
   * columns (supplier-columns.js) with what each carries and costs. A researched supplier starts with the picked
   * brands' products it stocks (a big-box store only the mainstream lines and plain accessories) at the prices seen
   * there; a typed one starts empty. Without shingle only typed suppliers are offered, each with its own price sheet.
   */
  registerWidget('supplier-columns', {
    fill: true,
    render(el, { options, selections, change, L, priceSheet }){
      injectWidgetCss();
      const { shingle, items } = supplierItems(options, selections, L);
      const presets = shingle ? array(options.suppliers) : [];
      const carriedBy = (preset) => items.filter((item) => {
        if (item.kind === 'generic') return true;
        if (!array(preset.manufacturers).includes(item.brand)) return false;
        if (preset.line_scope !== 'retail_core') return true;
        return item.kind === 'line' ? (item.visibility || 'default') === 'default' : !item.colored;
      }).map((item) => item.id);
      const slug = (name) => clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'supplier';
      const known = new Set(items.map((item) => item.id));
      let chosen = array(selections.suppliers).map((entry) => {
        const preset = presets.find((candidate) => candidate.id === entry.preset);
        return { key: preset ? preset.id : `custom:${slug(entry.name)}`, preset: preset?.id, name: clean(entry.name) || preset?.name, color: preset?.color || '#475467', kind: preset?.kind || 'custom', item_ids: array(entry.item_ids).filter((id) => known.has(id)), prices: { ...object(entry.prices) }, base_prices: object(preset?.prices) };
      }).filter((entry) => entry.name && (shingle || !entry.preset));
      const typePlaceholder = shingle ? L('gx_sup_type_own', 'Another supplier? Type it and press Enter') : L('gx_sup_type_first', 'Type your supplier’s name and press Enter');
      const emptyText = shingle ? H('gx_sup_none_2', 'Pick the suppliers you buy from above, and each one’s products appear here.') : H('gx_sup_none_custom', 'Add the suppliers you buy from. Each one can take a price sheet, and the agent turns it into price book items.');
      el.innerHTML = `<div class="gxs-tools gxs-supplier-picks">${presets.map((preset) => `<button type="button" class="gxs-chip gxs-supplier-pill" data-preset="${esc(preset.id)}" style="--brand:${esc(preset.color)}" aria-pressed="false" title="${esc(preset.regions || '')}"><span class="gxs-dot" aria-hidden="true"></span>${esc(preset.name)}</button>`).join('')}<span class="gxs-supplier-custom"></span><input type="text" class="gxs-search gxs-supplier-input" maxlength="200" placeholder="${esc(typePlaceholder)}" aria-label="${esc(typePlaceholder)}">${shingle ? '' : `<button type="button" class="gxs-chip" data-add-supplier>${H('gx_sup_add', 'Add')}</button>`}</div><div class="gxs-supplier-cols"></div><div class="gxs-supplier-empty"><span class="gxs-empty-icon" aria-hidden="true"><i class="fas fa-truck-ramp-box"></i></span><span>${emptyText}</span></div>`;
      const colsEl = el.querySelector('.gxs-supplier-cols');
      let columns = null;
      const summary = () => chosen.map((entry) => entry.name).join(', ');
      const report = () => change({ suppliers: chosen.map((entry) => ({ ...(entry.preset ? { preset: entry.preset } : {}), name: entry.name, item_ids: entry.item_ids, prices: entry.prices })) }, summary());
      const sync = () => {
        el.querySelectorAll('[data-preset]').forEach((pill) => pill.setAttribute('aria-pressed', String(chosen.some((entry) => entry.preset === pill.dataset.preset))));
        el.querySelector('.gxs-supplier-custom').innerHTML = chosen.filter((entry) => !entry.preset).map((entry) => `<span class="gxs-chip gxs-supplier-tag" aria-pressed="true">${esc(entry.name)}<button type="button" data-remove="${esc(entry.key)}" aria-label="${esc(L('gx_sup_remove', 'Remove'))} ${esc(entry.name)}">&times;</button></span>`).join('');
        el.querySelector('.gxs-supplier-empty').hidden = chosen.length > 0;
        colsEl.hidden = !chosen.length;
        // The columns fill the sheet; with none yet, the step is as tall as its empty state.
        el.closest('.gxs-step')?.toggleAttribute('data-fill', chosen.length > 0);
        if (!root.FirstMateSupplierColumns) { colsEl.textContent = ''; report(); return; }
        // With one supplier the agent's own upload line covers its price sheet, so the column does not repeat it;
        // without a catalog every column keeps its own upload, as that is how its items arrive.
        if (!columns) columns = root.FirstMateSupplierColumns.mount(colsEl, { suppliers: chosen, items, singleSheetElsewhere: shingle, emptyText: shingle ? '' : L('gx_sc_no_items_sheet', 'Upload this supplier’s price sheet and the agent adds what it sells to your price book.'), onChange: (next) => { chosen = next; report(); }, ...(priceSheet ? { onPriceSheet: (supplier) => priceSheet(supplier) } : {}) });
        else columns.update(chosen);
        report();
      };
      const add = (entry) => { if (chosen.some((existing) => existing.key === entry.key || existing.name.toLowerCase() === entry.name.toLowerCase()) || chosen.length >= 12) return; chosen.push(entry); sync(); };
      const addTyped = () => {
        const input = el.querySelector('.gxs-supplier-input');
        const name = clean(input.value); if (!name) return;
        input.value = '';
        const preset = presets.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        if (preset) { if (!chosen.some((entry) => entry.preset === preset.id)) el.querySelector(`[data-preset="${CSS.escape(preset.id)}"]`)?.click(); return; }
        add({ key: `custom:${slug(name)}`, name, color: '#475467', kind: 'custom', item_ids: [], prices: {}, base_prices: {} });
      };
      el.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-remove]')?.dataset.remove;
        if (remove) { chosen = chosen.filter((entry) => entry.key !== remove); sync(); return; }
        if (event.target.closest('[data-add-supplier]')) { addTyped(); return; }
        const id = event.target.closest('[data-preset]')?.dataset.preset; if (!id) return;
        if (chosen.some((entry) => entry.preset === id)) { chosen = chosen.filter((entry) => entry.preset !== id); sync(); return; }
        const preset = presets.find((candidate) => candidate.id === id);
        add({ key: preset.id, preset: preset.id, name: preset.name, color: preset.color, kind: preset.kind, item_ids: carriedBy(preset), prices: {}, base_prices: object(preset.prices) });
      });
      el.querySelector('.gxs-supplier-input').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ',') return;
        event.preventDefault();
        addTyped();
      });
      sync();
      return { valid: () => true, summary, destroy(){ columns?.destroy?.(); } };
    }
  });

  /**
   * Who does the labor: the organization's groups of users and outside companies as cards in two columns, each with how
   * it is paid (a piece rate on a roofing measurement, hourly, or per job) and a pay sheet upload for the agent. New
   * ones are added by name as employees (a group) or a subcontractor (an outside company). What a group or company is
   * called comes from the terminology system. Saved by labor.setup.apply when the setup finishes.
   */
  registerWidget('labor-assignees', {
    render(el, { options, selections, change, L, paySheet }){
      injectWidgetCss();
      const word = (path, fallback) => clean(root.PlatformTerminology?.get?.(path, fallback)) || fallback;
      const groupWord = word('workforce.resource_group_singular', 'Group'), companyWord = word('workforce.organization_connection_singular', 'Subcontractor');
      const measurements = array(options.measurements);
      const typesOf = (kind) => array(kind === 'resource_group' ? options.group_types : options.company_types);
      const saved = new Map(array(object(selections.labor).assignees).map((entry) => [`${entry.kind}:${clean(entry.ref?.id) || clean(entry.name).toLowerCase()}`, entry]));
      const keyOf = (entry) => `${entry.kind}:${clean(entry.ref?.id) || clean(entry.name).toLowerCase()}`;
      let rows = array(options.assignees).map((entry) => {
        const simple = entry.pay?.simple || null;
        const before = saved.get(keyOf(entry));
        return { key: keyOf(entry), ref: entry.ref, kind: entry.kind, name: entry.name, type_id: before?.type_id || entry.type_id || '', existing: true, locked: !!entry.pay && !simple, lines: Number(entry.pay?.lines || 0), original: simple, pay: before?.pay || (simple ? { ...simple } : null) };
      });
      for (const entry of saved.values()) if (!entry.ref && !rows.some((row) => row.key === keyOf(entry))) rows.push({ key: keyOf(entry), kind: entry.kind, name: entry.name, type_id: entry.type_id || '', existing: false, pay: entry.pay || null });
      let addKind = 'resource_group', firstDraw = true;
      const fresh = new Set();
      const unitOf = (pay) => pay?.method === 'hourly' ? L('gx_lab_per_hour', 'per hour') : pay?.method === 'per_job' ? L('gx_lab_per_job', 'per job') : String(pay?.measurement || 'roof.squares').startsWith('roof.squares') || pay?.measurement === 'roof.flat_squares' ? L('gx_lab_per_square', 'per square') : L('gx_lab_per_foot', 'per foot');
      const kindLabel = (kind) => kind === 'resource_group' ? `${groupWord} · ${L('gx_lab_employees', 'employees')}` : companyWord;
      const changed = (row) => !row.existing || (!!row.pay && JSON.stringify(row.pay) !== JSON.stringify(row.original)) || false;
      const summary = () => rows.length ? rows.map((row) => `${row.name}${row.pay ? ` (${row.pay.rate ? `$${row.pay.rate} ` : ''}${unitOf(row.pay)})` : ''}`).join(', ') : L('gx_lab_nobody', 'Nobody yet');
      const report = () => change({ include_labor: true, labor: { assignees: rows.filter((row) => changed(row) || (row.existing && row.type_id && row.type_id !== array(options.assignees).find((entry) => keyOf(entry) === row.key)?.type_id)).map((row) => ({ ...(row.ref ? { ref: row.ref } : {}), kind: row.kind, name: row.name, ...(row.type_id ? { type_id: row.type_id } : {}), ...(row.pay && row.pay.rate > 0 && changed(row) ? { pay: row.pay } : {}) })) } }, summary());
      const methodChip = (row, method, label) => `<button type="button" role="radio" data-method="${method}" aria-checked="${row.pay?.method === method}">${label}</button>`;
      const card = (row, i) => {
        const types = typesOf(row.kind);
        const pay = row.pay;
        // Only the first drawing and a card just added come in; redrawing after a change does not animate.
        return `<article class="gxs-lab${firstDraw || fresh.has(row.key) ? ' gxs-lab-in' : ''}" data-lab="${esc(row.key)}" style="animation-delay:${firstDraw ? i * 40 : 0}ms">
          <header><span class="gxs-lab-kind" data-kind="${row.kind}" title="${esc(row.kind === 'resource_group' ? L('gx_lab_group_tip', 'People who work for you, paid through you') : L('gx_lab_company_tip', 'Another company that does the work and bills you'))}">${esc(kindLabel(row.kind))}</span><strong title="${esc(row.name)}">${esc(row.name)}</strong>${!row.existing ? `<button type="button" class="gxs-lab-remove" data-remove aria-label="${esc(L('gx_lab_remove', 'Remove'))} ${esc(row.name)}">&times;</button>` : ''}</header>
          ${types.length > 1 ? `<label class="gxs-frow"><span>${H('gx_lab_type', 'Type')}</span><select data-type>${types.map((type) => `<option value="${esc(type.id)}" ${type.id === row.type_id ? 'selected' : ''}>${esc(type.name)}</option>`).join('')}</select></label>` : ''}
          ${row.locked ? `<p class="gxs-lab-note">${H('gx_lab_locked', 'Paid by its own pay sheet')} (${row.lines} ${L('gx_lab_lines', 'lines')}). ${H('gx_lab_locked_where', 'Change it in People.')}</p>` : `
          <div class="gxs-seg gxs-lab-methods" role="radiogroup" aria-label="${esc(L('gx_lab_how_paid', 'How they are paid'))}">${methodChip(row, 'per_measurement', L('gx_lab_piece', 'Piece rate'))}${methodChip(row, 'hourly', L('gx_lab_hourly', 'Hourly'))}${methodChip(row, 'per_job', L('gx_lab_job', 'Per job'))}</div>
          <div class="gxs-lab-rate" data-open="${!!pay}">${pay ? `<label class="gxs-num"><i>&nbsp;$</i><input type="number" min="0" step="0.01" inputmode="decimal" data-rate value="${esc(pay.rate ?? '')}" aria-label="${esc(L('gx_lab_rate', 'Rate'))}"></label>${pay.method === 'per_measurement' ? `<select data-measurement aria-label="${esc(L('gx_lab_paid_on', 'Paid on'))}">${measurements.map((entry) => `<option value="${esc(entry.id)}" ${entry.id === (pay.measurement || 'roof.squares') ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select>` : `<em>${esc(unitOf(pay))}</em>`}` : ''}</div>`}
          ${paySheet ? `<button type="button" class="gxs-lab-sheet" data-sheet title="${esc(L('gx_lab_sheet_tip', 'Upload their pay sheet or rate card and the agent sets up their pay from it'))}"><i class="fas fa-file-arrow-up" aria-hidden="true"></i>${H('gx_lab_sheet_upload', 'Upload pay sheet')}</button>` : ''}
        </article>`;
      };
      el.innerHTML = `<div class="gxs-tools gxs-lab-add"><div class="gxs-lab-toggle" role="group" aria-label="${esc(L('gx_lab_add_as', 'Add as'))}"><button type="button" class="gxs-chip" data-add-kind="resource_group" aria-pressed="true" title="${esc(L('gx_lab_group_tip', 'People who work for you, paid through you'))}">${esc(groupWord)}</button><button type="button" class="gxs-chip" data-add-kind="organization_connection" aria-pressed="false" title="${esc(L('gx_lab_company_tip', 'Another company that does the work and bills you'))}">${esc(companyWord)}</button></div><input type="text" class="gxs-search gxs-lab-name" maxlength="300" placeholder="${esc(L('gx_lab_add_placeholder', 'Name, then Enter'))}" aria-label="${esc(L('gx_lab_add_placeholder', 'Name, then Enter'))}"><button type="button" class="gxs-chip" data-add>${H('gx_lab_add', 'Add')}</button></div><div class="gxs-labs"></div>`;
      const list = el.querySelector('.gxs-labs');
      const draw = () => { list.innerHTML = rows.length ? rows.map(card).join('') : `<p class="gxs-lab-empty">${H('gx_lab_empty', 'Nobody yet. Add the groups and subcontractors who install your roofs.')}</p>`; firstDraw = false; fresh.clear(); report(); };
      const rowOf = (node) => rows.find((row) => row.key === node.closest('[data-lab]')?.dataset.lab);
      const add = () => {
        const input = el.querySelector('.gxs-lab-name'); const name = clean(input.value); if (!name) return;
        const key = `${addKind}:${name.toLowerCase()}`;
        if (!rows.some((row) => row.key === key || (row.kind === addKind && row.name.toLowerCase() === name.toLowerCase()))) rows.push({ key, kind: addKind, name, type_id: typesOf(addKind)[0]?.id || '', existing: false, pay: { method: addKind === 'resource_group' ? 'hourly' : 'per_measurement', rate: 0, ...(addKind === 'resource_group' ? {} : { measurement: 'roof.squares' }) } }) && fresh.add(key);
        input.value = ''; draw();
      };
      el.addEventListener('click', (event) => {
        const kind = event.target.closest('[data-add-kind]')?.dataset.addKind;
        if (kind) { addKind = kind; el.querySelectorAll('[data-add-kind]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.addKind === kind))); return; }
        if (event.target.closest('[data-add]')) return add();
        const row = rowOf(event.target); if (!row) return;
        if (event.target.closest('[data-remove]')) { rows = rows.filter((entry) => entry !== row); draw(); return; }
        if (event.target.closest('[data-sheet]')) { paySheet?.(row); return; }
        const method = event.target.closest('[data-method]')?.dataset.method;
        if (method) { row.pay = { method, rate: row.pay?.method === method ? row.pay.rate : 0, ...(method === 'per_measurement' ? { measurement: row.pay?.measurement || 'roof.squares' } : {}) }; draw(); el.querySelector(`[data-lab="${CSS.escape(row.key)}"] [data-rate]`)?.focus(); }
      });
      el.addEventListener('keydown', (event) => { if (event.target.closest('.gxs-lab-name') && event.key === 'Enter') { event.preventDefault(); add(); } });
      el.addEventListener('change', (event) => {
        const row = rowOf(event.target); if (!row) return;
        if (event.target.matches('[data-type]')) row.type_id = event.target.value;
        if (event.target.matches('[data-measurement]') && row.pay) row.pay = { ...row.pay, measurement: event.target.value };
        if (event.target.matches('[data-rate]') && row.pay) { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) row.pay = { ...row.pay, rate: value }; }
        report();
      });
      draw();
      return { valid: () => true, summary };
    }
  });


/** Draws one of the price book steps; its place is the step itself (all its answers are the player's selections). */
export function mountWidget(id, el, ctx){
  const widget = widgets.get(id);
  ctx.place?.keep?.(() => ({ page: id }));
  if (!widget) { el.textContent = L('gx_ui_widget_missing', 'This step cannot be shown here.'); return { valid: () => false }; }
  return widget.render(el, ctx) || {};
}
export const steps = () => [...widgets.keys()];
