/* public/libraries/guided-experiences/supplier-columns.js
 * Supplier columns: one thin column per supplier, side by side, showing the price book items it carries and what
 * they cost from it. Two show at a time in a native horizontal scroller (scrollbar,
 * trackpad, shift-wheel) snapping to a column; an arrow on each side scrolls one column, shown while there is more. Used by the price
 * book setup's "Who provides your materials?" step and mountable anywhere (the Materials settings).
 *
 *   window.FirstMateSupplierColumns.mount(el, { suppliers, items, onChange, onPriceSheet, labels })
 *     suppliers: [{ key, name, color, kind, item_ids: [], prices: { [item_id]: dollars }, base_prices }]
 *                prices are the ones typed here; base_prices (shown until one is typed) are what the supplier usually charges
 *     items:     [{ id, name, unit, price, group }]   price book items a supplier can carry
 *     onChange(suppliers)       after a supplier gains or drops an item, or a price is typed
 *     onPriceSheet(supplier)    the column's "Price sheet" button
 *   -> { update(suppliers), destroy() }
 *
 *   window.FirstMateSupplierTools.mount(host, { orgId, pricebook, toast, reload, colors })
 *     The organization's saved suppliers as columns, for the Materials settings: what each carries from the price
 *     book (untick to drop an item), its cost per item (saved through the suppliers writer) and a price sheet per
 *     supplier for the agent. -> { reload(), destroy() }
 *
 *   window.FirstMateSupplierColumns.priceSheet({ supplier: { id, name }, assistant, accept })
 *     Asks for a supplier's price sheet file and hands it to the assistant (an instance, or the global one) with the
 *     supplier named, so the agent sets that supplier's costs (suppliers.prices.update). Re-runnable any time.
 *
 * Suppliers are the organization's existing supplier records (materials/suppliers.ts); this draws and edits them,
 * it stores nothing itself. Copy goes through PlatformLanguage (`guided-experiences` namespace).
 */
(function(root){
  'use strict';
  if (root.FirstMateSupplierColumns) return;
  const document = root.document;
  const NS = 'guided-experiences';
  const clean = (value) => String(value ?? '').trim();
  const array = (value) => Array.isArray(value) ? value : [];
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const L = (key, fallback) => root.FirstMateGuides?.L ? root.FirstMateGuides.L(key, fallback) : (root.PlatformLanguage?.text?.(NS, key, fallback) ?? fallback);
  const H = (key, fallback) => root.FirstMateGuides?.copyHtml ? root.FirstMateGuides.copyHtml(key, fallback) : esc(L(key, fallback));
  const reduced = () => !!root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const initials = (name) => clean(name).split(/\s+/).filter((word) => /^[A-Za-z0-9]/.test(word)).slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';

  const css = `
    .gxsc{position:relative;--gxsc-gap:12px;display:flex;flex-direction:column;height:100%;min-height:0}
    .gxsc-viewport{flex:1 1 auto;min-height:0;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scroll-behavior:smooth;overscroll-behavior-x:contain;padding-bottom:8px;scrollbar-width:thin;scrollbar-color:#c4c9d2 transparent}
    .gxsc-viewport::-webkit-scrollbar{height:6px}
    .gxsc-viewport::-webkit-scrollbar-track{background:transparent}
    .gxsc-viewport::-webkit-scrollbar-thumb{background:#c4c9d2;border-radius:999px}
    .gxsc-viewport::-webkit-scrollbar-thumb:hover{background:#98a2b3}
    .gxsc-track{display:flex;gap:var(--gxsc-gap);height:100%}
    .gxsc-col{flex:0 0 calc((100% - var(--gxsc-gap)) / 2);min-width:0;height:100%;scroll-snap-align:start;border:1px solid #eaecf0;border-top:4px solid var(--supplier,#344054);border-radius:12px;background:#fff;display:flex;flex-direction:column}
    .gxsc-head{display:flex;align-items:center;gap:8px;padding:9px 10px 8px;border-bottom:1px solid #f2f4f7}
    .gxsc-badge{flex:none;width:26px;height:26px;border-radius:7px;background:var(--supplier,#344054);color:#fff;display:grid;place-items:center;font:800 11px/1 system-ui,sans-serif;letter-spacing:.02em}
    .gxsc-badge img{width:100%;height:100%;object-fit:contain;background:#fff;border-radius:7px}
    .gxsc-head strong{flex:1;min-width:0;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .gxsc-body{flex:1 1 auto;overflow:auto;padding:2px 8px 8px;min-height:0}
    .gxsc-foot{flex:none;padding:8px 10px;border-top:1px solid #f2f4f7}
    .gxsc-sheet{width:100%;height:32px;display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
    .gxsc-sheet:hover{background:#f9fafb;border-color:#98a2b3}
    .gxsc-group{position:sticky;top:0;z-index:1;background:#fff;margin:0 -2px;padding:7px 4px 3px;font-size:11px;font-weight:750;color:#344054;letter-spacing:.01em}
    .gxsc-item{display:flex;align-items:center;gap:7px;padding:3px 2px;font-size:12.5px;border-radius:6px}
    .gxsc-item:hover{background:#f9fafb}
    .gxsc-item input[type=checkbox]{accent-color:var(--supplier,#344054);margin:0;flex:none}
    .gxsc-item>span:first-of-type{flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-height:1.25;white-space:normal;overflow-wrap:anywhere}
    .gxsc-item[data-carried=false]>span:first-of-type{color:#98a2b3}
    .gxsc-price{flex:none;display:inline-flex;align-items:center;height:26px;border:1px solid #e4e7ec;border-radius:7px;background:#fff;padding:0 5px;font-size:12px;color:#667085;gap:1px}
    .gxsc-price:focus-within{border-color:var(--supplier,#344054)}
    .gxsc-price input{width:6ch!important;min-width:0;border:0;padding:0;text-align:right;font:inherit;font-size:12px;color:#101828;background:transparent;outline:none;-moz-appearance:textfield;appearance:textfield}
    .gxsc-price input::-webkit-outer-spin-button,.gxsc-price input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    .gxsc-price small{font-size:10.5px;color:#98a2b3;white-space:nowrap;padding-left:2px}
    .gxsc-item[data-carried=false] .gxsc-price{visibility:hidden}
    .gxsc-tools-head{display:flex;flex-direction:column;gap:2px;margin:0 0 8px}
    .gxsc-tools-head strong{font-size:13px;color:#101828}.gxsc-tools-head small{font-size:11.5px;color:#667085}
    .gxsc-tools-cols{height:min(60vh,520px);padding:0 30px}
    .gxsc-empty{color:#98a2b3;font-size:12px;padding:10px 4px}
    /* Side controls in the gutter beside the columns, never over them. */
    .gxsc-arrow{position:absolute;top:calc(50% - 4px);transform:translateY(-50%);width:24px;height:64px;border-radius:9px;border:1px solid #d0d5dd;background:#fff;box-shadow:0 4px 12px rgba(16,24,40,.12);cursor:pointer;display:grid;place-items:center;font-size:14px;color:#344054;z-index:2;transition:opacity .2s,transform .2s,background .15s}
    .gxsc-arrow[data-dir=prev]{left:-28px}
    .gxsc-arrow[data-dir=next]{right:-28px}
    .gxsc-arrow:hover{background:#f9fafb}
    .gxsc-arrow[data-off=true]{opacity:0;pointer-events:none}
    .gxsc-arrow{flex-direction:column;gap:2px}
    .gxsc-arrow b{font:700 10px/1 system-ui,sans-serif;color:#475467}
    .gxsc-arrow b:empty{display:none}
    .gxsc-arrow.gxsc-nudge{animation:gxscNudge .6s cubic-bezier(.22,1,.36,1)}
    @keyframes gxscNudge{0%,100%{transform:translateY(-50%)}40%{transform:translateY(-50%) translateX(3px);background:#eff8ff;border-color:#84caff}}
    .gxsc-arrow:focus-visible,.gxsc-sheet:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
    @media(max-width:560px){.gxsc-arrow[data-dir=prev]{left:-14px}.gxsc-arrow[data-dir=next]{right:-14px}.gxsc-arrow{width:20px}}
    @media(prefers-reduced-motion:reduce){.gxsc-viewport{scroll-behavior:auto}.gxsc-arrow{transition:none}}
  `;
  function injectCss(doc){
    if (doc.getElementById('gx-supplier-columns-css')) return;
    const style = doc.createElement('style'); style.id = 'gx-supplier-columns-css'; style.textContent = css; doc.head.appendChild(style);
  }

  function mount(el, options = {}){
    const doc = el.ownerDocument || document;
    injectCss(doc);
    let suppliers = array(options.suppliers).map((supplier) => ({ ...supplier, item_ids: [...new Set(array(supplier.item_ids))], prices: { ...(supplier.prices || {}) } }));
    const items = array(options.items);
    el.classList.add('gxsc');
    el.innerHTML = `<div class="gxsc-viewport" tabindex="-1"><div class="gxsc-track"></div></div><button type="button" class="gxsc-arrow" data-dir="prev" data-off="true" aria-label="${esc(L('gx_sc_prev', 'Previous supplier'))}">&#8592;<b></b></button><button type="button" class="gxsc-arrow" data-dir="next" data-off="true" aria-label="${esc(L('gx_sc_next', 'Next supplier'))}">&#8594;<b></b></button>`;
    const viewport = el.querySelector('.gxsc-viewport'), track = el.querySelector('.gxsc-track');
    const prev = el.querySelector('[data-dir=prev]'), next = el.querySelector('[data-dir=next]');
    const groups = () => { const out = new Map(); for (const item of items) { const key = clean(item.group) || L('gx_sc_items', 'Items'); if (!out.has(key)) out.set(key, []); out.get(key).push(item); } return [...out]; };
    const column = (supplier) => {
      const carried = new Set(supplier.item_ids);
      return `<section class="gxsc-col" data-supplier="${esc(supplier.key)}" style="--supplier:${esc(supplier.color || '#344054')}" aria-label="${esc(supplier.name)}">
        <header class="gxsc-head"><span class="gxsc-badge" aria-hidden="true">${supplier.logo && /^(data:image\/|https?:|\/)/.test(String(supplier.logo)) ? `<img src="${esc(supplier.logo)}" alt="">` : esc(initials(supplier.name))}</span><strong title="${esc(supplier.name)}">${esc(supplier.name)}</strong></header>
        <div class="gxsc-body">${items.length ? groups().map(([group, entries]) => `<div class="gxsc-group">${esc(group)}</div>${entries.map((item) => `<label class="gxsc-item" data-carried="${carried.has(item.id)}"><input type="checkbox" data-carry="${esc(item.id)}" ${carried.has(item.id) ? 'checked' : ''} aria-label="${esc(supplier.name)}: ${esc(item.name)}"><span title="${esc(item.name)}">${esc(item.label || item.name)}</span><span class="gxsc-price"><span aria-hidden="true">$</span><input type="number" min="0" step="0.01" inputmode="decimal" data-cost="${esc(item.id)}" value="${esc(supplier.prices[item.id] ?? supplier.base_prices?.[item.id] ?? item.price ?? '')}" aria-label="${esc(L('gx_sc_cost', 'Cost'))}: ${esc(item.name)}${item.unit ? ` / ${esc(item.unit)}` : ''}">${item.unit ? `<small>/ ${esc(item.unit)}</small>` : ''}</span></label>`).join('')}`).join('') : `<div class="gxsc-empty">${H('gx_sc_no_items', 'No products yet.')}</div>`}</div>
        ${options.onPriceSheet && !(options.singleSheetElsewhere && suppliers.length === 1) ? `<div class="gxsc-foot"><button type="button" class="gxsc-sheet" data-sheet="${esc(supplier.key)}" title="${esc(L('gx_sc_sheet_title', 'Do you have a supplier price sheet?'))}"><i class="fas fa-file-arrow-up" aria-hidden="true"></i>${H('gx_sc_sheet_upload', 'Upload price sheet')}</button></div>` : ''}
      </section>`;
    };
    /** The arrows follow the scroll position, however it got there: each shows while there is more that way. */
    function syncArrow(){
      const max = viewport.scrollWidth - viewport.clientWidth;
      const set = (arrow, off) => { arrow.dataset.off = String(off); arrow.tabIndex = off ? -1 : 0; arrow.setAttribute('aria-hidden', String(off)); };
      set(prev, viewport.scrollLeft <= 1);
      set(next, viewport.scrollLeft >= max - 1);
      // How many columns are out of sight each way, on the arrow: "+1".
      const view = viewport.getBoundingClientRect();
      const cols = [...track.querySelectorAll('.gxsc-col')].map((col) => col.getBoundingClientRect());
      const left = cols.filter((box) => box.left < view.left - 2).length, right = cols.filter((box) => box.right > view.right + 2).length;
      prev.querySelector('b').textContent = left ? `+${left}` : ''; next.querySelector('b').textContent = right ? `+${right}` : '';
      prev.setAttribute('aria-label', left ? `${L('gx_sc_prev', 'Previous supplier')} (${left} ${L('gx_sc_more', 'more')})` : L('gx_sc_prev', 'Previous supplier'));
      next.setAttribute('aria-label', right ? `${L('gx_sc_next', 'Next supplier')} (${right} ${L('gx_sc_more', 'more')})` : L('gx_sc_next', 'Next supplier'));
    }
    const columnStep = () => { const col = track.querySelector('.gxsc-col'); return col ? col.getBoundingClientRect().width + (parseFloat(getComputedStyle(track).columnGap) || 12) : viewport.clientWidth / 2; };
    const scrollColumns = (count) => viewport.scrollBy({ left: count * columnStep(), behavior: reduced() ? 'auto' : 'smooth' });
    viewport.addEventListener('scroll', syncArrow, { passive: true });
    function draw(){ track.innerHTML = suppliers.map(column).join(''); syncArrow(); }
    const notify = () => options.onChange?.(suppliers.map((supplier) => ({ ...supplier, item_ids: [...supplier.item_ids], prices: { ...supplier.prices } })));
    el.addEventListener('change', (event) => {
      const col = event.target.closest('[data-supplier]'); if (!col) return;
      const supplier = suppliers.find((entry) => entry.key === col.dataset.supplier); if (!supplier) return;
      const carry = event.target.closest('[data-carry]');
      if (carry) {
        const set = new Set(supplier.item_ids);
        if (carry.checked) set.add(carry.dataset.carry); else set.delete(carry.dataset.carry);
        supplier.item_ids = [...set];
        carry.closest('.gxsc-item').dataset.carried = String(carry.checked);
      }
      const cost = event.target.closest('[data-cost]');
      if (cost) { const value = Number(cost.value); if (Number.isFinite(value) && value >= 0) supplier.prices[cost.dataset.cost] = value; }
      notify();
    });
    el.addEventListener('click', (event) => {
      const arrow = event.target.closest('.gxsc-arrow');
      if (arrow) { scrollColumns(arrow.dataset.dir === 'prev' ? -1 : 1); return; }
      const sheet = event.target.closest('[data-sheet]');
      if (sheet) options.onPriceSheet?.(suppliers.find((entry) => entry.key === sheet.dataset.sheet));
    });
    const resize = doc.defaultView?.ResizeObserver ? new doc.defaultView.ResizeObserver(() => syncArrow()) : null;
    resize?.observe(el);
    draw();
    return {
      // The row stays where it was, so the first supplier stays in view. A supplier added out of sight is counted on
      // its arrow ("+1"), which nudges, rather than scrolling the first one away.
      update(list){
        const keys = new Set(suppliers.map((supplier) => supplier.key));
        suppliers = array(list).map((supplier) => ({ ...supplier, item_ids: [...new Set(array(supplier.item_ids))], prices: { ...(supplier.prices || {}) } }));
        const left = viewport.scrollLeft; draw(); viewport.scrollLeft = left;
        syncArrow();
        const added = suppliers.find((supplier) => !keys.has(supplier.key));
        const col = added && track.querySelector(`[data-supplier="${CSS.escape(added.key)}"]`);
        if (col && !reduced()) {
          const box = col.getBoundingClientRect(), view = viewport.getBoundingClientRect();
          const arrow = box.left >= view.right - 2 ? next : box.right <= view.left + 2 ? prev : null;
          if (arrow) { arrow.classList.remove('gxsc-nudge'); void arrow.offsetWidth; arrow.classList.add('gxsc-nudge'); }
        }
      },
      suppliers: () => suppliers,
      destroy(){ resize?.disconnect(); el.innerHTML = ''; el.classList.remove('gxsc'); }
    };
  }

  /**
   * A supplier's price sheet to the agent: pick the file, then send it with the supplier named (and its id when it is
   * saved) so the agent sets that supplier's costs. `assistant` is an assistant instance; without one the global
   * assistant opens. `before(files)` runs first (the setup saves the supplier so it has an id).
   */
  function priceSheet({ supplier, assistant, accept = '.csv,.xlsx,.xls,.pdf,.txt', before } = {}){
    return new Promise((resolve) => {
      const picker = document.createElement('input'); picker.type = 'file'; picker.accept = accept;
      picker.addEventListener('change', async () => {
        const files = [...(picker.files || [])];
        if (!files.length) return resolve(null);
        let saved = supplier;
        try { saved = (await before?.(files, supplier)) || supplier; } catch (error) { console.warn('Supplier could not be saved before its price sheet.', error); }
        const name = clean(saved?.name) || L('gx_sc_this_supplier', 'this supplier');
        const id = clean(saved?.id);
        const message = sheetMessage({ id, name });
        const target = assistant || root.PlatformAssistant;
        if (!assistant) root.PlatformAssistant?.open?.();
        resolve(await target?.sendWithFiles?.(message, files));
      }, { once: true });
      picker.click();
    });
  }

  /** What is said to the agent with a supplier's price sheet: the supplier, its id when it is saved, and that these are costs. */
  function sheetMessage({ id, name }){
    return `${L('gx_sc_sheet_message', 'Here is my price sheet from')} ${clean(name) || L('gx_sc_this_supplier', 'this supplier')}${clean(id) ? ` (supplier id ${clean(id)})` : ''}. ${L('gx_sc_sheet_ask', 'Please set this supplier\u2019s costs from it. These are costs, not sell prices, so no markup.')}`;
  }
  root.FirstMateSupplierColumns = { mount, priceSheet, sheetMessage };

  // Column accents for well-known suppliers (the brand colours in materials/roofing-research/roofing-suppliers-2026.json).
  const KNOWN_COLORS = { 'abc supply': '#C8102E', 'srs distribution': '#E35205', 'srs building products': '#E35205', 'beacon (qxo)': '#003A70', 'beacon': '#003A70', 'the home depot': '#F96302', 'home depot': '#F96302', "lowe's": '#004990', 'lowe’s': '#004990', 'gulfeagle supply': '#00539B', 'convoy supply': '#D2232A' };
  /** The saved suppliers as columns, saved through the suppliers' own writer (MaterialsAPI.suppliers.save). */
  function mountTools(host, options = {}){
    const doc = host.ownerDocument || document;
    injectCss(doc);
    const orgId = clean(options.orgId || root.__APP?.userOrgId);
    const api = () => root.MaterialsAPI?.suppliers;
    const toast = (message, kind) => { try { options.toast?.(message, kind); } catch (_) {} };
    host.innerHTML = `<div class="gxsc-tools-head"><strong>${H('gx_sc_tools_title', 'What each supplier carries')}</strong><small>${H('gx_sc_tools_hint', 'Costs are what you pay, not what you charge. Upload a supplier price sheet and the agent sets that supplier’s costs.')}</small></div><div class="gxsc-tools-cols"></div>`;
    const colsEl = host.querySelector('.gxsc-tools-cols');
    let suppliers = [], columns = null, destroyed = false;
    const timers = new Map(), saving = new Map();
    const itemsOf = () => { const state = options.pricebook?.getState?.(); return array(state?.items); };
    function columnsFrom(){
      const book = new Map(itemsOf().map((item) => [String(item.id), item]));
      const carried = new Set(suppliers.flatMap((supplier) => array(supplier.offerings).map((row) => row.item_id)));
      const items = [...carried].map((id) => { const item = book.get(id) || { id, name: id }; const name = clean(item.name) || id, maker = clean(item.manufacturer); return { id, name, label: maker && name.toLowerCase().startsWith(maker.toLowerCase() + ' ') ? name.slice(maker.length + 1) : name, unit: item.unit, price: item.internal_cost ?? item.unit_price ?? '', group: maker || clean(item.category || item.type) || L('gx_sc_items', 'Items') }; })
        .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
      const cols = suppliers.map((supplier) => ({ key: supplier.id, id: supplier.id, name: supplier.name, logo: supplier.logo, color: (options.colors || {})[supplier.id] || KNOWN_COLORS[clean(supplier.name).toLowerCase()] || '#344054',
        item_ids: array(supplier.offerings).map((row) => row.item_id), prices: {}, base_prices: Object.fromEntries(array(supplier.offerings).filter((row) => row.price_cents != null).map((row) => [row.item_id, row.price_cents / 100])) }));
      return { items, cols };
    }
    function save(next){
      for (const column of next) {
        const supplier = suppliers.find((entry) => entry.id === column.key); if (!supplier) continue;
        const before = new Map(array(supplier.offerings).map((row) => [row.item_id, row]));
        const offerings = column.item_ids.map((itemId) => { const row = before.get(itemId); const typed = column.prices[itemId]; return { item_id: itemId, sku: row?.sku || '', price_cents: typed !== undefined ? Math.round(typed * 100) : row?.price_cents ?? null }; });
        if (JSON.stringify(offerings) === JSON.stringify(array(supplier.offerings).map((row) => ({ item_id: row.item_id, sku: row.sku || '', price_cents: row.price_cents ?? null })))) continue;
        clearTimeout(timers.get(supplier.id));
        timers.set(supplier.id, setTimeout(async () => {
          await saving.get(supplier.id);
          const run = (async () => {
            try {
              const result = await api().save(orgId, supplier.id, { name: supplier.name, offerings, expected_revision: supplier.revision });
              const saved = result?.supplier || result;
              if (saved?.id) Object.assign(supplier, saved);
              options.reload?.();
            } catch (error) { toast(clean(error?.message) || L('gx_sc_save_failed', 'That supplier did not save. Try again.'), 'error'); load(); }
          })();
          saving.set(supplier.id, run);
        }, 600));
      }
    }
    async function load(){
      if (!orgId || !api()?.list) { colsEl.innerHTML = `<div class="gxsc-empty">${H('gx_sc_unavailable', 'Suppliers are not available here.')}</div>`; return; }
      try { suppliers = array((await api().list(orgId))?.suppliers); } catch (error) { colsEl.innerHTML = `<div class="gxsc-empty">${esc(clean(error?.message) || L('gx_sc_load_failed', 'Suppliers could not be loaded.'))}</div>`; return; }
      if (destroyed) return;
      if (!suppliers.length) { columns?.destroy(); columns = null; colsEl.innerHTML = `<div class="gxsc-empty">${H('gx_sc_none_saved', 'No suppliers yet. Add one below, or run the price book setup.')}</div>`; return; }
      const { items, cols } = columnsFrom();
      columns?.destroy();
      columns = mount(colsEl, { suppliers: cols, items, onChange: save, onPriceSheet: (supplier) => priceSheet({ supplier: { id: supplier.id, name: supplier.name } }).then(() => toast(L('gx_sc_sheet_sent', 'Sent to the agent. It will show you the matches before changing any costs.'))) });
    }
    load();
    return { reload: load, destroy(){ destroyed = true; timers.forEach((timer) => clearTimeout(timer)); columns?.destroy(); host.innerHTML = ''; } };
  }
  root.FirstMateSupplierTools = { mount: mountTools };
})(window);
