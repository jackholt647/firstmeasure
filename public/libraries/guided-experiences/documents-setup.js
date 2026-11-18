// The document setup's steps (guided experience `documents.setup`, FM-582, docs/architecture/guided-experiences.md,
// "Document setup"). It plays the first time someone who manages company settings presses New document: which kind
// of document they want to make, then for a proposal (after the company type, the kinds of work and who sells, each
// asked only while unanswered) how they present it, whether the customer may change it, how much detail it carries,
// whether a written scope of work goes with it, their prices (optional), and for every kind one of three styles,
// previewed with what their answers make. Each step is this module with its own `part`; the answers are the setup's
// selections and its finish (documents.setup.apply) makes the kind's template. It reads through the publication layer
// only (document-setup.price_sheet, .previews) and writes nothing itself.
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const clean = (value) => String(value ?? '').trim();

const css = `
.gxd{display:flex;flex-direction:column;gap:14px;min-width:0;padding:2px 0 8px;color:#101828}
.gxd p{margin:0;color:#475467;line-height:1.5;font-size:13px}
.gxd-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.gxd-tile{position:relative;display:flex;align-items:flex-start;gap:12px;min-height:76px;padding:14px 42px 14px 14px;border:1px solid #e4e7ec;border-radius:13px;background:#fff;font:inherit;text-align:left;color:#101828;cursor:pointer;transition:border-color .15s,background .15s,box-shadow .2s,transform .15s}
.gxd-tile:hover{border-color:#c4c9d2;transform:translateY(-1px)}
.gxd-tile:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-tile>span:not(.gxd-icon):not(.gxd-tick){display:flex;flex-direction:column;gap:3px;min-width:0}
.gxd-tile strong{font-size:14px;font-weight:700;line-height:1.25}
.gxd-tile small{font-size:12px;color:#667085;line-height:1.4}
.gxd-tile[aria-checked=true]{border-color:var(--primary,#d93025);background:rgba(var(--primary-rgb,217,48,37),.06);box-shadow:0 0 0 1px var(--primary,#d93025)}
.gxd-icon{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:rgba(var(--primary-rgb,217,48,37),.08);color:var(--primary,#d93025);font-size:16px}
.gxd-tick{position:absolute;top:10px;right:10px;width:22px;height:22px;border-radius:50%;border:1.5px solid #d0d5dd;display:grid;place-items:center;transition:background .15s,border-color .15s}
.gxd-tick svg{width:12px;height:12px;stroke:#fff;fill:none;stroke-width:3;opacity:0;transition:opacity .15s}
[aria-checked=true]>.gxd-tick{background:var(--primary,#d93025);border-color:var(--primary,#d93025)}
[aria-checked=true]>.gxd-tick svg{opacity:1}
.gxd-prices{display:flex;flex-direction:column;border:1px solid #e4e7ec;border-radius:13px;overflow:hidden}
.gxd-price{display:flex;align-items:center;gap:12px;padding:9px 12px;border-top:1px solid #f2f4f7;font-size:13px}
.gxd-price:first-child{border-top:0}
.gxd-price label{flex:1 1 auto;min-width:0;font-weight:600;color:#344054}
.gxd-money{display:flex;align-items:center;gap:6px;flex:none;color:#667085;font-size:12px}
.gxd-money span:first-child{color:#344054;font-size:13px}
.gxd-money input{width:96px;height:34px;padding:0 10px;border:1px solid #d0d5dd;border-radius:9px;font:inherit;font-size:14px;text-align:right;color:#101828}
.gxd-money input:focus{outline:none;border-color:var(--primary,#d93025);box-shadow:0 0 0 3px rgba(var(--primary-rgb,217,48,37),.14)}
.gxd-note{font-size:12px!important;color:#667085!important}
.gxd-styles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.gxd-style{display:flex;flex-direction:column;gap:8px;padding:8px;border:1px solid #e4e7ec;border-radius:14px;background:#fff;font:inherit;text-align:left;cursor:pointer;transition:border-color .15s,box-shadow .2s}
.gxd-style:focus-visible{outline:2px solid var(--primary,#d93025);outline-offset:2px}
.gxd-style[aria-checked=true]{border-color:var(--primary,#d93025);box-shadow:0 0 0 2px var(--primary,#d93025)}
.gxd-page{position:relative;display:block;width:100%;aspect-ratio:8.5/11;overflow:hidden auto;overscroll-behavior:contain;scrollbar-width:thin;border-radius:8px;background:#f2f4f7;box-shadow:inset 0 0 0 1px #eaecf0}
.gxd-page>div{position:relative}
.gxd-style-name{display:flex;align-items:center;gap:8px;padding:0 4px 2px}
.gxd-style-name strong{flex:1 1 auto;font-size:14px;color:#101828}
.gxd-style-name small{display:block;font-size:12px;color:#667085;font-weight:400}
.gxd-style .gxd-tick{position:static;flex:none}
.gxd-busy{display:grid;place-items:center;min-height:180px}
.gxd-error{color:#b42318!important}
.gxd-error:empty{display:none}
@media(max-width:640px){.gxd-grid{grid-template-columns:1fr}.gxd-styles{grid-template-columns:repeat(3,minmax(200px,1fr));overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:6px}.gxd-style{scroll-snap-align:start}}
@media(prefers-reduced-motion:reduce){.gxd *{transition:none!important}}
`;
function installStyle(){
  if (document.getElementById('gxd-css')) return;
  const style = document.createElement('style'); style.id = 'gxd-css'; style.textContent = css; document.head.append(style);
}
const tick = '<span class="gxd-tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></span>';
const scripts = new Map();
function loadScript(path){
  if (!scripts.has(path)) scripts.set(path, new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = path; script.onload = resolve;
    script.onerror = () => { script.remove(); scripts.delete(path); reject(new Error('The preview could not be loaded.')); };
    document.head.append(script);
  }));
  return scripts.get(path);
}
async function renderer(){
  if (!window.FMDocModel) await loadScript('/libraries/doc-model/firstmate-doc-model.js');
  // Signatures, payment and other widgets draw as they do on the document, not as placeholders.
  if (!window.FMDocWidgets) await loadScript('/libraries/doc-widgets/firstmate-doc-widgets.js').catch(() => null);
  if (!window.FMDocRenderer) await loadScript('/libraries/doc-renderer/firstmate-doc-renderer.js');
  return window.FMDocRenderer;
}

/** The questions with one answer each: the choices, with their copy (gx_docs_setup_* keys). */
function choicesFor(part, selections){
  const c = (id, icon, key, title, hint, value = id) => ({ id, icon, value, title: [`gx_docs_setup_${key}`, title], hint: [`gx_docs_setup_${key}_hint`, hint] });
  if (part === 'kind') return { key: 'document_kind', choices: [
    c('proposal', 'fa-file-signature', 'kind_proposal', 'Proposal', 'Price the work for your customer to approve and sign.'),
    c('invoice', 'fa-file-invoice-dollar', 'kind_invoice', 'Invoice', 'Bill a deposit, the balance or extra charges.'),
    c('change_order', 'fa-pen-to-square', 'kind_change_order', 'Change order', 'Add or change work on a signed agreement.'),
    c('completion_certificate', 'fa-award', 'kind_certificate', 'Completion certificate', 'Your customer signs off that the work is done.')
  ] };
  if (part === 'presentation') return { key: 'presentation', choices: [
    c('options', 'fa-layer-group', 'presentation_options', 'Several options to choose from', 'For example good, better and best.'),
    c('single', 'fa-file-lines', 'presentation_single', 'One main option', 'The work you recommend, at one price.')
  ] };
  if (part === 'changes') return { key: 'customer_changes', choices: clean(selections.presentation) === 'options' ? [
    c('mix', 'fa-shuffle', 'changes_mix', 'They can mix and match', 'Your customer swaps line items between the options before signing.'),
    c('pick', 'fa-hand-pointer', 'changes_pick', 'They pick one of the options', 'Each option stays as you wrote it.')
  ] : [
    c('mix', 'fa-sliders', 'changes_mix_single', 'They can add or remove items', 'Optional items your customer turns on or off before signing.'),
    c('ask', 'fa-comments', 'changes_ask', 'They talk to us', 'Any change means a new estimate from you.')
  ] };
  if (part === 'detail') return { key: 'detail', choices: [
    c('itemized', 'fa-list-check', 'detail_itemized', 'Every line item', 'Each part of the job, with its own price.'),
    c('rough', 'fa-ruler-combined', 'detail_rough', 'A broad estimate', 'From a few things: squares, the shingle and underlayment, ice and water, add-ons.')
  ] };
  if (part === 'scope') return { key: 'scope_write_up', choices: [
    c('yes', 'fa-images', 'scope_yes', 'A written scope of work', 'Photos and descriptions from the estimate, then the proposal.', true),
    c('no', 'fa-file-contract', 'scope_no', 'Just the proposal', 'The price and what’s included.', false)
  ] };
  return null;
}

export function mount(el, ctx){
  installStyle();
  const { esc } = ctx;
  const L = (copy) => ctx.L(copy[0], copy[1]);
  const t = (key, text) => ctx.L(`gx_docs_setup_${key}`, text);
  const part = clean(ctx.options.part);
  const selections = object(ctx.selections);
  if (part === 'prices') return pricesPart();
  if (part === 'style') return stylePart();
  const question = choicesFor(part, selections);
  if (!question) { el.innerHTML = `<p class="gxd-error">${esc(t('unknown', 'This step cannot be shown here.'))}</p>`; return { valid: () => false }; }

  // ── One answer from a few choices ─────────────────────────────────────
  const { key, choices } = question;
  const valueOf = (choice) => choice.value;
  let chosen = choices.find((choice) => valueOf(choice) === selections[key]) || null;
  el.innerHTML = `<div class="gxd"><div class="gxd-grid" role="radiogroup" aria-label="${esc(ctx.L(ctx.step.title))}">${choices.map((choice) => `
    <button type="button" class="gxd-tile" role="radio" data-choice="${esc(choice.id)}" aria-checked="${chosen === choice}">
      <span class="gxd-icon" aria-hidden="true"><i class="fas ${esc(choice.icon)}"></i></span>
      <span><strong>${esc(L(choice.title))}</strong><small>${esc(L(choice.hint))}</small></span>${tick}
    </button>`).join('')}</div></div>`;
  const report = () => ctx.change(chosen ? { [key]: valueOf(chosen) } : {}, chosen ? L(chosen.title) : '');
  const onClick = (event) => {
    const tile = event.target.closest('[data-choice]'); if (!tile) return;
    chosen = choices.find((choice) => choice.id === tile.dataset.choice) || null;
    el.querySelectorAll('[data-choice]').forEach((node) => node.setAttribute('aria-checked', String(node.dataset.choice === chosen?.id)));
    report();
  };
  el.addEventListener('click', onClick);
  if (chosen) report();
  return {
    valid: () => !!chosen,
    hint: () => t('choose_hint', 'Choose the answer that fits best.'),
    summary: () => chosen ? L(chosen.title) : '',
    destroy(){ el.removeEventListener('click', onClick); }
  };

  // ── Prices (optional) ─────────────────────────────────────────────────
  function pricesPart(){
    let alive = true, items = [];
    const given = new Map(array(selections.prices).map((entry) => [clean(entry.item_id), Number(entry.unit_price)]));
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    const unitLabel = (unit) => ({ sq: t('unit_sq', 'per square'), lf: t('unit_lf', 'per foot'), ft: t('unit_lf', 'per foot'), ea: t('unit_ea', 'each'), job: t('unit_job', 'per job') }[clean(unit).toLowerCase()] || (unit ? `/ ${unit}` : ''));
    const changed = () => items.map((item) => {
      const input = el.querySelector(`[data-price="${CSS.escape(item.id)}"]`);
      const value = Number(String(input?.value ?? '').replace(/[^0-9.]/g, ''));
      if (!input || clean(input.value) === '' || !Number.isFinite(value)) return null;
      return value !== item.unit_price ? { item_id: item.id, unit_price: Math.round(value * 100) / 100 } : null;
    }).filter(Boolean);
    const report = () => { const list = changed(); ctx.change({ prices: list }, list.length ? t('prices_summary', '{count} prices').replace('{count}', String(list.length)) : ''); };
    ctx.read('document-setup', 'price_sheet').then((sheet) => {
      if (!alive) return;
      items = array(object(sheet).items).map((item) => ({ ...item, unit_price: item.unit_price == null ? null : Number(item.unit_price) }));
      if (!items.length) {
        el.innerHTML = `<div class="gxd"><p>${esc(t('prices_none', 'Your price book has nothing for these yet. Skip this step and set your prices in the price book any time.'))}</p></div>`;
        return;
      }
      const shown = (item) => given.has(item.id) ? given.get(item.id) : item.unit_price;
      el.innerHTML = `<div class="gxd">
        <p>${esc(t('prices_lead', 'What you charge your customer for each, before tax. We price your proposals from these.'))}</p>
        <div class="gxd-prices">${items.map((item) => `<div class="gxd-price"><label for="gxd-price-${esc(item.id)}">${esc(item.name)}</label><span class="gxd-money"><span>$</span><input id="gxd-price-${esc(item.id)}" inputmode="decimal" autocomplete="off" data-price="${esc(item.id)}" value="${shown(item) == null ? '' : esc(String(shown(item)))}" placeholder="0.00"><span>${esc(unitLabel(item.unit))}</span></span></div>`).join('')}</div>
        <p class="gxd-note">${esc(t('prices_note', 'You can change your default prices in your price book at any time, and any price on a single proposal while you write it.'))}</p>
      </div>`;
      el.addEventListener('input', report);
      report();
    }).catch((error) => { if (alive) el.innerHTML = `<div class="gxd"><p class="gxd-error" role="alert">${esc(clean(error?.message) || t('load_failed', 'This didn’t load. Skip this step or try again.'))}</p></div>`; });
    return {
      valid: () => true,
      summary: () => { const count = changed().length; return count ? t('prices_summary', '{count} prices').replace('{count}', String(count)) : ''; },
      destroy(){ alive = false; el.removeEventListener('input', report); }
    };
  }

  // ── Three styles, previewed with what the answers make ────────────────
  function stylePart(){
    let alive = true, chosen = clean(selections.theme_id), previews = [];
    const handles = [];
    const args = { document_kind: clean(selections.document_kind) || 'proposal' };
    if (args.document_kind === 'proposal') for (const name of ['presentation', 'customer_changes', 'detail', 'scope_write_up']) if (selections[name] !== undefined) args[name] = selections[name];
    el.innerHTML = '<div class="gxd"><div class="gxd-busy"><span class="gxs-spin" aria-hidden="true"></span></div></div>';
    const report = () => { const entry = previews.find((preview) => preview.theme_id === chosen); ctx.change(entry ? { theme_id: chosen } : {}, entry ? entry.name : ''); };
    const onClick = (event) => {
      const card = event.target.closest('[data-theme]'); if (!card) return;
      chosen = card.dataset.theme;
      el.querySelectorAll('[data-theme]').forEach((node) => node.setAttribute('aria-checked', String(node.dataset.theme === chosen)));
      report();
    };
    // A card is not a button (it holds the rendered document): Enter and Space choose it.
    const onKey = (event) => { if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-theme]')) { event.preventDefault(); onClick(event); } };
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    Promise.all([ctx.read('document-setup', 'previews', { args }), renderer()]).then(([value, Renderer]) => {
      if (!alive) return;
      value = object(value);
      previews = array(value.previews);
      if (!previews.some((preview) => preview.theme_id === chosen)) chosen = '';
      el.innerHTML = `<div class="gxd">
        <p>${esc(t('style_lead', 'Here is your {name} in three styles, with a sample customer. Pick the one you like.').replace('{name}', clean(value.name) || t('style_document', 'document')))}</p>
        <div class="gxd-styles" role="radiogroup" aria-label="${esc(ctx.L(ctx.step.title))}">${previews.map((preview) => `
          <div class="gxd-style" role="radio" tabindex="0" data-theme="${esc(preview.theme_id)}" aria-checked="${preview.theme_id === chosen}" aria-label="${esc(preview.name)}">
            <div class="gxd-page" aria-hidden="true"><div data-page></div></div>
            <span class="gxd-style-name"><strong>${esc(preview.name)}<small>${esc(preview.description)}</small></strong>${tick}</span>
          </div>`).join('')}</div>
      </div>`;
      // Each preview is the real render at the card's width; a second page scrolls inside the card.
      el.querySelectorAll('[data-theme]').forEach((card, at) => {
        const preview = previews[at], holder = card.querySelector('[data-page]');
        const width = card.querySelector('.gxd-page').clientWidth || 220;
        try {
          handles.push(Renderer.render(holder, { document: preview.resolved_definition, theme: preview.theme, themeContext: { overrides: object(preview.theme_vars) }, widgetData: object(preview.widget_data), mode: 'static', scale: width / (612 * 96 / 72) }));
        } catch (error) { holder.textContent = clean(error?.message); }
      });
      report();
    }).catch((error) => { if (alive) el.innerHTML = `<div class="gxd"><p class="gxd-error" role="alert">${esc(clean(error?.message) || t('preview_failed', 'The previews didn’t load. Close the setup and try again.'))}</p></div>`; });
    return {
      valid: () => previews.some((preview) => preview.theme_id === chosen),
      hint: () => t('style_hint', 'Choose a style.'),
      summary: () => previews.find((preview) => preview.theme_id === chosen)?.name || '',
      destroy(){ alive = false; el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey); handles.forEach((handle) => { try { handle?.destroy?.(); } catch (_) {} }); }
    };
  }
}
export default mount;
