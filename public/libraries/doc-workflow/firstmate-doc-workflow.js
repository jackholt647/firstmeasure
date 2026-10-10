/* public/libraries/doc-workflow/firstmate-doc-workflow.js
 * The document engine's workflow RUNTIME (contracts §8, tiers spec §4.2).
 *
 * One shared stepper that renders a workflow definition
 *   { schema_version, name, contract:{params,outputs},
 *     steps:[{ id, title, when?, audience?, items:[{ kind, writes, ... }] }],
 *     audiences:{ internal:{...}, customer:{ theme, hide_steps } } }
 * against a document instance's params/outputs. The host owns persistence:
 * every item write goes through onWrite(path, value) ("params.x" /
 * "outputs.y") exactly like the Data panel PATCHes the instance.
 *
 * Mounts in: the project Documents tab (audience "internal"), the customer
 * portal (audience "customer", portal-skinned), the studio test pane.
 *
 *   FMDocWorkflow.mount(container, {
 *     workflow, audience, state:{params,outputs,current_step,completed_steps},
 *     contract, onWrite(path,value), onStepState(state), onComplete(),
 *     preview:{ resolve():Promise<resolved>, mount(el,resolved)? },
 *     services:{ pricebook, pieceCatalog, generateScopeItems, media }, scope:{...extra}, theme
 *   }) -> { destroy, goTo(stepId), refresh(state) }
 *
 *   FMDocWorkflow.registerKind(kind, renderer(el, ctx) -> { validate?, destroy? })
 *
 * Styles self-inject (style#fmdw-styles, fmdw- prefix) and follow the visual
 * language of documents.css / customer_portal.css. No hard dependency on any
 * other engine library: FMDocModel powers `when` conditions, FMDocRenderer
 * powers the live preview, FMDocWidgets powers signature/payment — each
 * degrades cleanly when absent.
 */
(function(){
  const root = typeof window !== 'undefined' ? window : globalThis;

  // ------------------------------------------------------------- utilities
  function cleanText(value){ return String(value ?? '').trim(); }
  function esc(value){
    return String(value ?? '').replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
  function clone(value){
    try { return structuredClone(value); } catch (e) {
      try { return JSON.parse(JSON.stringify(value ?? null)); } catch (e2) { return value; }
    }
  }
  function obj(value){ return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function arr(value){ return Array.isArray(value) ? value : []; }
  function firstText(...values){
    for (const value of values) { const text = cleanText(value); if (text) return text; }
    return '';
  }
  let uidCounter = 0;
  function uid(prefix){ return `${prefix}_${Date.now().toString(36)}${(++uidCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
  function moneyFromCents(cents){
    return (Number(cents || 0) / 100).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style: 'currency', currency: 'USD' });
  }
  function moneyFromDollars(dollars){
    return (Number(dollars || 0)).toLocaleString((globalThis.PlatformLanguage?.formatLocale?.("en-US") || "en-US"), { style: 'currency', currency: 'USD' });
  }
  function prettyKey(key){
    return cleanText(key).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function isEmptyValue(value){
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return cleanText(value) === '';
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'object') return Object.keys(value).length === 0;
    return false; // numbers (incl. 0) and booleans (incl. false) count as answered
  }
  function getPath(source, path){
    const parts = cleanText(path).split('.').filter(Boolean);
    let cursor = source;
    for (const part of parts) {
      if (cursor === null || cursor === undefined) return undefined;
      cursor = cursor[part];
    }
    return cursor;
  }
  function setPath(target, path, value){
    const parts = cleanText(path).split('.').filter(Boolean);
    if (!parts.length) return;
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (cursor[parts[i]] === null || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  // ------------------------------------------------- expression evaluation
  // `when` conditions, options_from, and prefill use the SAME expression
  // language as documents (FMDocModel). Missing model → conditions pass,
  // expressions resolve to undefined (never crash the stepper).
  function evalExpr(raw, scope){
    const model = root.FMDocModel;
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw !== 'string') return raw;
    const text = raw.trim();
    if (!text) return undefined;
    if (!model) return undefined;
    try {
      if (typeof model.hasInterpolation === 'function' && model.hasInterpolation(text) && typeof model.interpolate === 'function') {
        return model.interpolate(text, scope || {});
      }
      if (typeof model.evaluateSafe === 'function') return model.evaluateSafe(text, scope || {}, undefined);
    } catch (e) { /* defensive */ }
    return undefined;
  }
  function whenPasses(when, scope){
    const text = cleanText(when);
    if (!text) return true;
    if (!root.FMDocModel) return true; // no evaluator — never hide content
    const value = evalExpr(text, scope);
    if (value === undefined || value === '') return false;
    return !!value;
  }

  // ------------------------------------------------------------ audiences
  const DEFAULT_STEP_AUDIENCE = ['internal'];
  function stepAudiences(step){
    const list = arr(step.audience).map(cleanText).filter(Boolean);
    return list.length ? list : DEFAULT_STEP_AUDIENCE;
  }
  function stepVisibleFor(step, audience, workflow){
    if (!stepAudiences(step).includes(audience)) return false;
    const hidden = arr(obj(obj(workflow.audiences)[audience]).hide_steps).map(cleanText);
    if (hidden.includes(cleanText(step.id))) return false;
    return true;
  }
  function itemVisibleFor(item, audience){
    const list = arr(item.audience).map(cleanText).filter(Boolean);
    if (!list.length) return true; // inherits the step's audience
    return list.includes(audience);
  }

  // ------------------------------------------------------- options helpers
  function normalizeOption(option){
    if (option === null || option === undefined) return null;
    if (typeof option !== 'object') {
      const value = cleanText(option);
      return value ? { value, label: prettyKey(value) } : null;
    }
    const value = firstText(option.value, option.id, option.key, option.name);
    if (!value && option.label === undefined) return null;
    return {
      value: value || cleanText(option.label),
      label: firstText(option.label, option.name, option.display_name, value),
      description: cleanText(option.description),
      image: firstText(option.image, option.image_url, option.thumbnail, option.thumb_url),
      media_id: firstText(option.media_id, option.mediaId),
      icon: firstText(option.icon),
      price_cents: Number.isFinite(Number(option.price_cents)) ? Number(option.price_cents)
        : (Number.isFinite(Number(option.unit_price)) ? Math.round(Number(option.unit_price) * 100) : null)
    };
  }
  /** item.options, or options_from (expression / pricebook sugar), or []. */
  function resolveOptions(item, scope, services){
    const direct = arr(item.options).map(normalizeOption).filter(Boolean);
    if (direct.length) return direct;
    const from = cleanText(item.options_from || item.optionsFrom || item.source);
    if (!from) return [];
    // pricebook.category('shingles') sugar — resolvable client-side.
    const pbMatch = from.match(/pricebook\.category\(\s*['"]([^'"]+)['"]\s*\)/);
    if (pbMatch) {
      const category = pbMatch[1];
      const pricebook = obj(services).pricebook;
      try {
        const items = arr(
          (typeof pricebook?.category === 'function' && pricebook.category(category))
          || arr(obj(typeof pricebook?.getState === 'function' ? pricebook.getState() : null).items)
            .filter((entry) => cleanText(obj(entry).category) === category)
        );
        const mapped = items.map(normalizeOption).filter(Boolean);
        if (mapped.length) return mapped;
      } catch (e) { /* fall through */ }
    }
    const evaluated = evalExpr(from, scope);
    return arr(evaluated).map(normalizeOption).filter(Boolean);
  }

  // ---------------------------------------------------- scope item helpers
  // Line items keep EXACTLY the proposal builder's editable.scope.root_items
  // item shape so the server's doc.line_items resolver understands them.
  function makeScopeItem(overrides){
    return {
      id: uid('scope'),
      type: 'scope_item',
      pricebook_ref: {},
      name: '',
      display_name: '',
      description: '',
      unit: 'ea',
      quantity: '1',
      unit_price: 0,
      base_price: 0,
      included: false,
      price_driving: true,
      selection: { mode: 'always', selected: true },
      variations: [],
      children: [],
      ...obj(overrides)
    };
  }
  function normalizeScopeItem(item){
    const source = obj(item);
    return {
      ...makeScopeItem(),
      ...source,
      id: firstText(source.id, uid('scope')),
      type: firstText(source.type, 'scope_item'),
      name: firstText(source.name, source.display_name, 'Line item'),
      quantity: String(source.quantity ?? '1'),
      unit_price: Number(source.unit_price ?? source.unitPrice ?? source.base_price ?? source.basePrice ?? source.amount ?? 0) || 0,
      base_price: Number(source.base_price ?? source.basePrice ?? source.unit_price ?? 0) || 0,
      children: arr(source.children).map(normalizeScopeItem)
    };
  }
  /** Mirrors proposals/scope.ts: fixed lines always count; choice and
   *  optional lines count only while selected. "Included" hides a line's
   *  price on a package proposal but the line still adds to the total. */
  function scopeItemSelected(item){
    const selection = obj(obj(item).selection);
    if (cleanText(selection.mode || 'fixed') === 'fixed') return true;
    return selection.selected === true;
  }
  function scopeItemOwnAmount(item){
    const line = obj(item);
    if (!scopeItemSelected(line) || line.price_driving === false) return 0;
    return Math.max(0, Number(line.quantity || 0) || 0) * (Number(line.unit_price || 0) || 0);
  }
  function scopeItemAmount(item){
    if (!scopeItemSelected(item)) return 0;
    return scopeItemOwnAmount(item) + arr(obj(item).children).reduce((sum, child) => sum + scopeItemAmount(child), 0);
  }
  /** What a line and the lines under it cost when it is the one chosen: the
   *  price of a whole option (Good / Better / Best), selected or not. */
  function scopeItemAmountIfSelected(item){
    const line = obj(item);
    return scopeItemAmount({ ...line, selection: { ...obj(line.selection), selected: true } });
  }
  function scopeItemsTotal(items){
    return arr(items).reduce((sum, item) => sum + scopeItemAmount(item), 0);
  }
  function countScopeItems(items){
    let count = 0;
    const walk = (list) => arr(list).forEach((item) => { count += 1; walk(obj(item).children); });
    walk(items);
    return count;
  }
  /** Measurement keys referenced by scope-item pricing formulas. */
  function scopeMeasurementKeys(items){
    const keys = new Set();
    const pricebook = root.FirstMatePricebook;
    const addFromConfig = (config) => {
      arr(obj(config).tokens).forEach((raw) => {
        const token = obj(raw);
        if (cleanText(token.type) === 'measurement' && cleanText(token.value)) keys.add(cleanText(token.value));
      });
    };
    const walk = (list) => arr(list).forEach((raw) => {
      const item = obj(raw);
      addFromConfig(item.formula_config || item.formulaConfig);
      arr(item.variations).forEach((variation) => addFromConfig(obj(variation).formula_config || obj(variation).formulaConfig));
      const ref = obj(item.pricebook_ref);
      const refId = firstText(ref.item_id, ref.catalog_item_id, ref.id);
      if (refId && typeof pricebook?.getItem === 'function') {
        try {
          const pbItem = obj(pricebook.getItem(refId));
          addFromConfig(pbItem.formula_config || pbItem.formulaConfig);
        } catch (e) { /* pricebook not hydrated */ }
      }
      walk(item.children);
    });
    walk(items);
    return [...keys];
  }
  /** Measurement keys declared by the piece selection (piece_select writes
   *  them to params.measurement_requirements after derivation). */
  function requiredMeasurementKeys(sc){
    return arr(getPath(sc, 'params.measurement_requirements')).map(cleanText).filter(Boolean);
  }
  /** True when an item already holds a complete answer — used by the
   *  step-level `auto_skip_when_complete` flag. Measurements items driven by
   *  scope formulas count as complete when EVERY formula-derived key has a
   *  value (vacuously true when the scope needs no measurements). */
  function itemAnswered(item, sc){
    const source = obj(item);
    const value = getPath(sc, cleanText(source.writes));
    if (cleanText(source.kind) === 'measurements') {
      const from = cleanText(source.fields_from || source.fieldsFrom);
      let needed = null;
      if (from === 'scope_items_formulas') needed = scopeMeasurementKeys(arr(getPath(sc, 'params.scope_items')));
      else if (from === 'measurement_requirements' || from === 'piece_selection') needed = requiredMeasurementKeys(sc);
      if (needed) {
        const current = obj(value);
        return needed.every((key) => !(current[key] === undefined || current[key] === null || current[key] === ''));
      }
    }
    return !isEmptyValue(value);
  }

  function measurementLabelFor(key){
    const pricebook = root.FirstMatePricebook;
    let fields = [];
    try { fields = arr(pricebook?.formulaFields?.() || pricebook?.measurementFields); }
    catch (e) { fields = arr(pricebook?.measurementFields); }
    return firstText(fields.find((field) => obj(field).key === key)?.label, prettyKey(key));
  }

  // ------------------------------------------------------- value formatting
  function formatValue(item, value){
    const kind = cleanText(obj(item).kind);
    if (isEmptyValue(value) && typeof value !== 'number' && typeof value !== 'boolean') return '—';
    if (kind === 'currency') return moneyFromCents(value);
    if (kind === 'boolean') return value ? 'Yes' : 'No';
    if (kind === 'date') return cleanText(value).slice(0, 10) || '—';
    if (kind === 'multi_select') return arr(value).map((v) => prettyKey(v)).join(', ') || '—';
    if (kind === 'line_item_editor' || kind === 'piece_picker' || kind === 'line_items_review') {
      const count = countScopeItems(value);
      return count ? `${count} line item${count === 1 ? '' : 's'} · ${moneyFromDollars(scopeItemsTotal(value))}` : '—';
    }
    if (kind === 'piece_select') {
      const names = arr(value).map((p) => firstText(obj(p).name, obj(p).template_id, typeof p === 'string' ? p : '')).filter(Boolean);
      return names.length ? names.join(', ') : '—';
    }
    if (kind === 'measurements') {
      const entries = Object.keys(obj(value));
      return entries.length ? `${entries.length} measurement${entries.length === 1 ? '' : 's'}` : '—';
    }
    if (kind === 'payment_schedule') {
      const rows = arr(value).map(obj);
      return rows.length ? rows.map((row) => `${firstText(row.label, 'Payment')} ${Number(row.amount_cents) > 0 ? moneyFromCents(row.amount_cents) : `${Number(row.percent) || 0}%`}`).join(' · ') : '—';
    }
    if (kind === 'content_blocks') {
      const count = arr(value).length;
      return count ? `${count} content block${count === 1 ? '' : 's'}` : '—';
    }
    if (kind === 'media_picker') {
      if (Array.isArray(value)) return value.length ? `${value.length} photo${value.length === 1 ? '' : 's'}` : '—';
      return obj(value).media_id ? '1 photo' : '—';
    }
    if (kind === 'signature') {
      const sig = obj(value);
      return sig.signer_name ? `Signed by ${sig.signer_name}` : (isEmptyValue(value) ? 'Not signed' : 'Signed');
    }
    if (kind === 'payment') return isEmptyValue(value) ? 'Not paid' : 'Paid';
    if (kind === 'choice_group') {
      if (Array.isArray(value)) return value.map((v) => prettyKey(typeof v === 'object' ? firstText(v.value, v.id) : v)).join(', ') || '—';
      if (value && typeof value === 'object') return prettyKey(firstText(value.value, value.id, JSON.stringify(value)));
      return prettyKey(value);
    }
    if (typeof value === 'object') {
      try { return JSON.stringify(value); } catch (e) { return String(value); }
    }
    return String(value);
  }

  // ============================================================ kind registry
  const kindRegistry = new Map();
  function registerKind(kind, renderer){
    if (!cleanText(kind) || typeof renderer !== 'function') return;
    kindRegistry.set(cleanText(kind), renderer);
  }

  // Simple field wrapper used by the scalar kinds.
  function fieldShell(el, ctx, controlHtml){
    el.innerHTML = `
      <label class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        ${controlHtml}
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </label>`;
    return el.querySelector('[data-fmdw-control]');
  }
  function itemLabel(item){
    return firstText(item.label, item.title, prettyKey(cleanText(item.writes).split('.').pop()), 'Field');
  }
  function requiredError(ctx){
    if (ctx.item.required && isEmptyValue(ctx.value())) return 'This field is required.';
    return null;
  }

  // ------------------------------------------------------------ scalar kinds
  registerKind('text', (el, ctx) => {
    const multiline = cleanText(obj(ctx.item.presentation).style) === 'multiline' || obj(ctx.item.presentation).multiline === true;
    const value = ctx.value();
    const control = fieldShell(el, ctx, multiline
      ? `<textarea data-fmdw-control ${ctx.readonly ? 'disabled' : ''} placeholder="${esc(ctx.item.placeholder || '')}">${esc(value ?? '')}</textarea>`
      : `<input type="text" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${esc(value ?? '')}" placeholder="${esc(ctx.item.placeholder || '')}">`);
    control?.addEventListener('change', () => ctx.write(control.value));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('number', (el, ctx) => {
    const value = ctx.value();
    const control = fieldShell(el, ctx, `<input type="number" step="any" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${value === null || value === undefined || value === '' ? '' : esc(value)}">`);
    control?.addEventListener('change', () => ctx.write(cleanText(control.value) === '' ? null : Number(control.value)));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('currency', (el, ctx) => {
    const cents = ctx.value();
    const dollars = cents === null || cents === undefined || cents === '' ? '' : (Number(cents || 0) / 100).toFixed(2);
    const control = fieldShell(el, ctx, `<span class="fmdw-money"><input type="number" step="0.01" min="0" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${esc(dollars)}" placeholder="0.00"></span>`);
    control?.addEventListener('change', () => ctx.write(cleanText(control.value) === '' ? null : Math.round(Number(control.value || 0) * 100)));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('date', (el, ctx) => {
    const control = fieldShell(el, ctx, `<input type="date" data-fmdw-control ${ctx.readonly ? 'disabled' : ''} value="${esc(cleanText(ctx.value()).slice(0, 10))}">`);
    control?.addEventListener('change', () => ctx.write(control.value || null));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('boolean', (el, ctx) => {
    el.innerHTML = `
      <label class="fmdw-toggle-row">
        <span class="fmdw-toggle ${ctx.value() === true ? 'on' : ''}" data-fmdw-toggle role="switch" aria-checked="${ctx.value() === true}" tabindex="${ctx.readonly ? -1 : 0}"><i></i></span>
        <span class="fmdw-toggle-copy">
          <strong>${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</strong>
          ${ctx.item.description ? `<small>${esc(ctx.item.description)}</small>` : ''}
        </span>
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </label>`;
    const toggle = el.querySelector('[data-fmdw-toggle]');
    const flip = () => {
      if (ctx.readonly) return;
      const next = !(ctx.value() === true);
      ctx.write(next);
      toggle.classList.toggle('on', next);
      toggle.setAttribute('aria-checked', String(next));
    };
    toggle?.addEventListener('click', flip);
    toggle?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); }
    });
    return { validate: () => (ctx.item.required && ctx.value() !== true && ctx.value() !== false ? 'Choose an option.' : null) };
  });

  registerKind('select', (el, ctx) => {
    const options = ctx.options();
    const presentation = obj(ctx.item.presentation);
    if (['cards', 'tiles', 'buttons'].includes(cleanText(presentation.style))) {
      renderChoiceCards(el, ctx, options, false);
      return { validate: () => requiredError(ctx) };
    }
    const current = cleanText(ctx.value());
    const control = fieldShell(el, ctx, `
      <select data-fmdw-control ${ctx.readonly ? 'disabled' : ''}>
        <option value="">—</option>
        ${options.map((opt) => `<option value="${esc(opt.value)}" ${opt.value === current ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')}
      </select>`);
    control?.addEventListener('change', () => ctx.write(control.value || null));
    return { validate: () => requiredError(ctx) };
  });

  registerKind('multi_select', (el, ctx) => {
    const options = ctx.options();
    if (['cards', 'tiles', 'buttons'].includes(cleanText(obj(ctx.item.presentation).style))) {
      renderChoiceCards(el, ctx, options, true);
      return { validate: () => requiredError(ctx) };
    }
    const selected = arr(ctx.value()).map(cleanText);
    el.innerHTML = `
      <div class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        <div class="fmdw-check-list">
          ${options.length ? options.map((opt) => `
            <label class="fmdw-check">
              <input type="checkbox" value="${esc(opt.value)}" ${selected.includes(opt.value) ? 'checked' : ''} ${ctx.readonly ? 'disabled' : ''}>
              <span>${esc(opt.label)}</span>
            </label>`).join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2eeb0742b30735","No options are configured for this question.") ?? "No options are configured for this question.")}</p>`}
        </div>
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </div>`;
    el.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener('change', () => {
      const values = [...el.querySelectorAll('input[type="checkbox"]:checked')].map((box) => box.value);
      ctx.write(values);
    }));
    return { validate: () => requiredError(ctx) };
  });

  // ------------------------------------------------------------ choice cards
  function optionImageUrl(opt, services){
    if (opt.image) return opt.image;
    if (opt.media_id && typeof obj(services).media?.url === 'function') {
      try { return cleanText(obj(services).media.url(opt.media_id)); } catch (e) { return ''; }
    }
    return '';
  }
  function renderChoiceCards(el, ctx, options, multi){
    const showImages = obj(ctx.item.presentation).images === true || options.some((opt) => optionImageUrl(opt, ctx.services));
    const selectedValues = multi
      ? arr(ctx.value()).map((v) => cleanText(typeof v === 'object' ? obj(v).value : v))
      : [cleanText(typeof ctx.value() === 'object' ? obj(ctx.value()).value : ctx.value())].filter(Boolean);
    el.innerHTML = `
      <div class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        <div class="fmdw-choice-grid">
          ${options.length ? options.map((opt) => {
            const image = showImages ? optionImageUrl(opt, ctx.services) : '';
            const active = selectedValues.includes(opt.value);
            return `
              <button type="button" class="fmdw-choice-card ${active ? 'active' : ''}" data-fmdw-choice="${esc(opt.value)}" ${ctx.readonly ? 'disabled' : ''}>
                ${image ? `<span class="fmdw-choice-img"><img src="${esc(image)}" alt="" loading="lazy"></span>` : (opt.icon ? `<span class="fmdw-choice-icon"><i class="fas ${esc(opt.icon)}"></i></span>` : '')}
                <strong>${esc(opt.label)}</strong>
                ${opt.description ? `<small>${esc(opt.description)}</small>` : ''}
                ${opt.price_cents !== null && opt.price_cents !== undefined ? `<span class="fmdw-choice-price">${esc(moneyFromCents(opt.price_cents))}</span>` : ''}
                <span class="fmdw-choice-tick"><i class="fas fa-check"></i></span>
              </button>`;
          }).join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2eeb0742b30735","No options are configured for this question.") ?? "No options are configured for this question.")}</p>`}
        </div>
        <span class="fmdw-field-error" data-fmdw-error hidden></span>
      </div>`;
    el.querySelectorAll('[data-fmdw-choice]').forEach((button) => button.addEventListener('click', () => {
      const value = button.dataset.fmdwChoice;
      if (multi) {
        const current = arr(ctx.value()).map((v) => cleanText(typeof v === 'object' ? obj(v).value : v));
        const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
        ctx.write(next);
      } else {
        ctx.write(value);
      }
      renderChoiceCards(el, ctx, options, multi);
      ctx.requestPreview();
    }));
  }

  registerKind('choice_group', (el, ctx) => {
    const source = cleanText(ctx.item.options_from || ctx.item.optionsFrom);
    // options_from:"scope_items" — the customer-facing choices ARE the scope's
    // choice groups (shingle profile, underlayment, optional add-ons...).
    // Internal reps set the defaults directly on params.scope_items; the
    // customer audience records picks as outputs.selections (outputs-only).
    if (source === 'scope_items' || source === 'scope_item_choice_groups') {
      return renderScopeChoiceGroups(el, ctx);
    }
    const options = ctx.options();
    const multi = ctx.item.multi === true || obj(ctx.item.presentation).multi === true;
    renderChoiceCards(el, ctx, options, multi);
    return { validate: () => requiredError(ctx) };
  });

  function collectScopeChoiceGroups(scopeItems){
    const groups = new Map();
    const optionals = [];
    const groupTitles = new Map();
    const walk = (items) => {
      for (const raw of arr(items)) {
        const item = obj(raw);
        for (const def of arr(item.selection_groups)) {
          const g = obj(def);
          if (cleanText(g.id)) groupTitles.set(cleanText(g.id), { title: firstNonEmpty(g.title, g.label, cleanText(g.id)), behavior: cleanText(g.behavior) || 'single' });
        }
        const sel = obj(item.selection);
        const customer = true;
        if (customer && cleanText(sel.mode) === 'choice' && cleanText(sel.group_id)) {
          const gid = cleanText(sel.group_id);
          if (!groups.has(gid)) groups.set(gid, []);
          groups.get(gid).push(item);
          if (!groupTitles.has(gid)) groupTitles.set(gid, { title: firstNonEmpty(sel.group_title, prettyKey(gid.split(':').pop().replace(/_(profile|group|choice)$/i, ''))), behavior: 'single' });
        } else if (customer && cleanText(sel.mode) === 'optional') {
          optionals.push(item);
        }
        walk(item.children);
      }
    };
    walk(scopeItems);
    return { groups, optionals, groupTitles };
  }

  function firstNonEmpty(...values){
    for (const value of values) { const text = cleanText(value); if (text) return text; }
    return '';
  }

  function renderScopeChoiceGroups(el, ctx){
    const render = () => {
      const scope = ctx.scope();
      const scopeItems = arr(getPath(scope, 'params.scope_items'));
      const { groups, optionals, groupTitles } = collectScopeChoiceGroups(scopeItems);
      const customerAudience = ['customer', 'field'].includes(ctx.audience);
      const selections = customerAudience ? obj(getPath(scope, 'outputs.selections')) : {};
      const isSelected = (item) => {
        const sel = obj(item.selection);
        if (!customerAudience) return sel.selected === true;
        const gid = cleanText(sel.group_id);
        if (gid && selections[gid] !== undefined) return cleanText(selections[gid]) === cleanText(item.id);
        if (!gid && selections[cleanText(item.id)] !== undefined) return selections[cleanText(item.id)] === true;
        return sel.selected === true;
      };
      const isPackage = (item) => arr(item.children).length > 0;
      const lineAmount = (item) => (isPackage(item) ? scopeItemAmountIfSelected(item) : Math.max(0, Number(item.quantity || 0) || 0) * (Number(item.unit_price || item.base_price || 0) || 0));
      // In a choice group the customer is choosing between alternatives, so
      // each card shows the difference from the option currently selected;
      // optional add-ons show what they add. A whole option (its own set of
      // lines) shows its full price: that is what is being compared.
      const priceTag = (item, gid) => {
        if (!gid) { const price = lineAmount(item); return price > 0 ? `<em>+ ${esc(moneyFromDollars(price))}</em>` : ''; }
        if (isPackage(item)) return `<em>${esc(moneyFromDollars(lineAmount(item)))}</em>`;
        const current = arr(groups.get(gid)).find((other) => isSelected(other));
        if (!current || current === item) return isSelected(item) ? '<em>Selected</em>' : '';
        const delta = lineAmount(item) - lineAmount(current);
        if (Math.abs(delta) < 0.005) return '<em>Same price</em>';
        return `<em>${delta > 0 ? '+' : '−'} ${esc(moneyFromDollars(Math.abs(delta)))}</em>`;
      };
      const optionCard = (item, gid) => `
        <button type="button" class="fmdw-choice-card ${isSelected(item) ? 'active' : ''}" data-fmdw-scg-option="${esc(cleanText(item.id))}" data-fmdw-scg-group="${esc(gid)}" ${ctx.readonly ? 'disabled' : ''}>
          <strong>${esc(firstNonEmpty(item.display_name, item.name, 'Option'))}</strong>
          ${cleanText(item.description) ? `<span>${esc(cleanText(item.description))}</span>` : ''}
          ${arr(item.highlights).length ? `<span class="fmdw-choice-includes">${arr(item.highlights).map((line) => esc(cleanText(line))).join('<br>')}</span>` : ''}
          ${priceTag(item, gid)}
          ${isSelected(item) ? '<i class="fas fa-circle-check"></i>' : ''}
        </button>`;
      const sections = [];
      for (const [gid, items] of groups.entries()) {
        const meta = groupTitles.get(gid) || { title: gid, behavior: 'single' };
        sections.push(`
          <div class="fmdw-scg-group">
            <span class="fmdw-field-label">${esc(meta.title)}</span>
            <div class="fmdw-choice-grid">${items.map((item) => optionCard(item, gid)).join('')}</div>
          </div>`);
      }
      if (optionals.length) {
        sections.push(`
          <div class="fmdw-scg-group">
            <span class="fmdw-field-label">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_1ad84cd7f804e7","Optional add-ons") ?? "Optional add-ons")}</span>
            <div class="fmdw-choice-grid">${String(optionals.map((item) => optionCard(item, '')).join(''))}</div>
          </div>`);
      }
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          ${sections.length
            ? sections.join('')
            : `<div class="fmdw-card"><p class="fmdw-hint" style="margin:0"><i class="fas fa-circle-info"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_7bbfcb28626c80"," No customer-facing options in this scope yet. Options come from the line items’ choice groups and customer-optional rows.") ?? " No customer-facing options in this scope yet. Options come from the line items’ choice groups and customer-optional rows.")}</p></div>`}
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      if (ctx.readonly) return;
      el.querySelectorAll('[data-fmdw-scg-option]').forEach((button) => button.addEventListener('click', () => {
        const optionId = cleanText(button.dataset.fmdwScgOption);
        const gid = cleanText(button.dataset.fmdwScgGroup);
        if (customerAudience) {
          const next = obj(clone(selections));
          if (gid) next[gid] = optionId;
          else {
            const target = optionals.find((item) => cleanText(item.id) === optionId);
            next[optionId] = !(target && isSelected(target));
          }
          ctx.writePath('outputs.selections', next);
        } else {
          const tree = clone(scopeItems);
          const walk = (items) => {
            for (const item of arr(items)) {
              const sel = obj(item.selection);
              if (gid && cleanText(sel.group_id) === gid && cleanText(sel.mode) === 'choice') {
                item.selection = { ...sel, selected: cleanText(item.id) === optionId };
              } else if (!gid && cleanText(item.id) === optionId && cleanText(sel.mode) === 'optional') {
                item.selection = { ...sel, selected: sel.selected !== true };
              }
              walk(item.children);
            }
          };
          walk(tree);
          ctx.writePath('params.scope_items', tree);
        }
        ctx.requestPreview?.();
        render();
      }));
    };
    render();
    return { validate: () => null };
  }

  // ------------------------------------------------------------ measurements
  registerKind('measurements', (el, ctx) => {
    const services = obj(ctx.services);
    // item.fields names the measurements to ask for, in order; otherwise the
    // scope decides (fields_from). item.prefill is the project value to start
    // from: a scope expression, plus services.projectMeasurements() when the
    // host can read the project's selected measurement dataset.
    const explicitFields = arr(ctx.item.fields).map(obj).filter((field) => cleanText(field.key));
    const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
    const hasValue = (value) => !(value === undefined || value === null || value === '');
    let report = { status: typeof services.projectMeasurements === 'function' && cleanText(ctx.item.prefill) ? 'loading' : 'none', values: {}, source: '' };

    function fields(){
      if (explicitFields.length) return explicitFields.map((field) => ({ ...field, label: firstText(field.label, measurementLabelFor(field.key)) }));
      const fieldsFrom = cleanText(ctx.item.fields_from || ctx.item.fieldsFrom);
      let keys = [];
      if (fieldsFrom === 'scope_items_formulas') keys = scopeMeasurementKeys(arr(getPath(ctx.scope(), 'params.scope_items')));
      else if (fieldsFrom === 'measurement_requirements' || fieldsFrom === 'piece_selection') keys = requiredMeasurementKeys(ctx.scope());
      return keys.map((key) => ({ key, label: measurementLabelFor(key) }));
    }
    function expressionPrefill(){
      const expr = cleanText(ctx.item.prefill);
      if (!expr) return {};
      return obj(expr.includes('{{') || /[()]/.test(expr) ? evalExpr(expr, ctx.scope()) : getPath(ctx.scope(), expr));
    }
    function projectValues(){
      const out = {};
      Object.entries({ ...expressionPrefill(), ...obj(report.values) }).forEach(([key, value]) => {
        if (typeof value === 'number' && Number.isFinite(value)) out[key] = round(value);
        else if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) out[key] = round(value);
      });
      return out;
    }
    /** Start from the project's values; fields the report does not measure
     *  take their declared default. Hand-entered values survive unless the
     *  user asks to reload. */
    function applyProject(overwrite){
      const next = overwrite ? {} : obj(clone(ctx.value()));
      const fromProject = projectValues();
      Object.entries(fromProject).forEach(([key, value]) => { if (overwrite || !hasValue(next[key])) next[key] = value; });
      // A report lists only what the roof has: no hips means no hips entry,
      // not an unknown. So once a report is loaded, anything it leaves out is
      // zero. The first field is the one the document cannot do without, so
      // it stays empty rather than becoming a silent zero.
      const reported = Object.keys(fromProject).length > 0;
      fields().forEach((field, index) => {
        if (hasValue(next[field.key])) return;
        if (hasValue(field.default)) next[field.key] = Number(field.default) || 0;
        else if (reported && index > 0) next[field.key] = 0;
      });
      // Nothing to fill: leave the document untouched (no save, no re-resolve).
      if (!overwrite && JSON.stringify(next) === JSON.stringify(obj(ctx.value()))) return;
      ctx.write(Object.keys(next).length ? next : null);
    }

    const render = () => {
      const current = obj(ctx.value());
      const list = fields();
      const fromProject = projectValues();
      const hasProject = Object.keys(fromProject).length > 0;
      const keys = list.map((field) => field.key);
      const extra = Object.entries(current).filter(([key, value]) => !keys.includes(key) && hasValue(value) && typeof value !== 'object');
      const missing = list.filter((field) => !hasValue(current[field.key]));
      const sourceLine = report.status === 'loading'
        ? `<p class="fmdw-hint fmdw-meas-source"><i class="fas fa-circle-notch fa-spin"></i> Reading this project's measurements…</p>`
        : hasProject
          ? `<p class="fmdw-hint fmdw-meas-source ok"><i class="fas fa-ruler-combined"></i> From ${esc(firstText(report.source, 'this project'))}. Edit any value to override it for this document.</p>`
          : (cleanText(ctx.item.prefill) ? `<p class="fmdw-hint fmdw-meas-source"><i class="fas fa-circle-info"></i> ${esc(report.status === 'error' ? 'This project\'s measurements could not be read. Enter them by hand.' : 'This project has no measurement report yet. Enter the measurements by hand.')}</p>` : '');
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card">
            ${sourceLine}
            ${list.length ? `
              <div class="fmdw-meas-grid">
                ${list.map((field) => {
                  const filled = hasValue(current[field.key]);
                  const edited = filled && hasValue(fromProject[field.key]) && Number(current[field.key]) !== Number(fromProject[field.key]);
                  return `
                    <label class="fmdw-meas-field ${filled ? '' : 'needed'} ${edited ? 'edited' : ''}" ${edited ? `title="Report value: ${esc(fromProject[field.key])}"` : ''}>
                      <span>${esc(field.label)}${edited ? ' <em>edited</em>' : ''}</span>
                      <span class="fmdw-meas-input">
                        <input type="number" step="any" min="0" data-fmdw-meas="${esc(field.key)}" ${ctx.readonly ? 'disabled' : ''} value="${filled ? esc(Number(current[field.key])) : ''}" placeholder="—">
                        ${cleanText(field.unit) ? `<i>${esc(field.unit)}</i>` : ''}
                      </span>
                    </label>`;
                }).join('')}
              </div>
              ${missing.length ? `<p class="fmdw-meas-note"><i class="fas fa-triangle-exclamation"></i> ${missing.length} measurement${missing.length === 1 ? '' : 's'} still needed</p>` : ''}` : (extra.length ? '' : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_08781c4c9e5c9b","No measurements yet.") ?? "No measurements yet.")}</p>`)}
            ${extra.length ? `
              <details class="fmdw-meas-extra">
                <summary>${extra.length} more value${extra.length === 1 ? '' : 's'} from the report</summary>
                <div class="fmdw-stat-grid">
                  ${extra.map(([key, value]) => `<span class="fmdw-stat"><i>${esc(measurementLabelFor(key))}</i><b>${esc(String(value))}</b></span>`).join('')}
                </div>
              </details>` : ''}
            ${ctx.readonly ? '' : `
              <div class="fmdw-row-actions">
                <button type="button" class="fmdw-btn ghost" data-fmdw-meas-reload ${hasProject ? '' : 'disabled'} title="${hasProject ? 'Replace every value with the project\'s measurements' : 'This project has no measurements to load'}"><i class="fas fa-rotate"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_641beeb7a2ff91"," Load from project") ?? " Load from project")}</button>
                ${Object.keys(current).length ? `<button type="button" class="fmdw-btn ghost" data-fmdw-meas-clear><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_687e1653230514"," Clear") ?? " Clear")}</button>` : ''}
              </div>`}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      el.querySelectorAll('[data-fmdw-meas]').forEach((input) => input.addEventListener('change', () => {
        const next = obj(clone(ctx.value()));
        const key = input.dataset.fmdwMeas;
        if (cleanText(input.value) === '') delete next[key];
        else next[key] = Number(input.value) || 0;
        ctx.write(Object.keys(next).length ? next : null);
        // NO re-render here: change fires on Tab/blur, and rebuilding the DOM
        // mid-Tab destroys focus order. Update the highlight in place; the
        // full field list re-renders on step entry.
        const wrap = input.closest('.fmdw-meas-field') || input;
        wrap.classList?.toggle('needed', cleanText(input.value) === '');
      }));
      el.querySelector('[data-fmdw-meas-reload]')?.addEventListener('click', () => { applyProject(true); render(); });
      el.querySelector('[data-fmdw-meas-clear]')?.addEventListener('click', () => { ctx.write(null); render(); });
    };

    // Start from the project automatically. Values already entered are kept;
    // only what is still empty is filled in.
    if (!ctx.readonly && Object.keys(projectValues()).length) applyProject(false);
    render();
    if (report.status === 'loading') {
      Promise.resolve().then(() => services.projectMeasurements()).then((result) => {
        const values = obj(obj(result).values);
        report = { status: Object.keys(values).length ? 'ready' : 'missing', values, source: cleanText(obj(result).source) };
      }).catch(() => { report = { status: 'error', values: {}, source: '' }; }).then(() => {
        if (!el.isConnected) return;
        if (!ctx.readonly && Object.keys(projectValues()).length) applyProject(false);
        render();
      });
    }
    return {
      validate: () => {
        const error = requiredError(ctx);
        if (error || !ctx.item.required) return error;
        const first = fields()[0];
        return first && !(Number(obj(ctx.value())[first.key]) > 0) ? `Enter the ${String(first.label).toLowerCase()} to continue.` : null;
      }
    };
  });

  // ------------------------------------------------------------ media picker
  registerKind('media_picker', (el, ctx) => {
    const media = obj(ctx.services).media;
    const multi = ctx.item.multi === true || obj(ctx.item.presentation).multi === true;
    const render = () => {
      let photos = [];
      try { photos = arr(typeof media?.photos === 'function' ? media.photos() : media?.photos).map(obj).filter((p) => firstText(p.media_id, p.id)); }
      catch (e) { photos = []; }
      const selectedIds = multi
        ? arr(ctx.value()).map((v) => firstText(obj(v).media_id, obj(v).id, typeof v === 'string' ? v : ''))
        : [firstText(obj(ctx.value()).media_id, obj(ctx.value()).id)].filter(Boolean);
      const urlFor = (photo) => {
        if (firstText(photo.url, photo.thumb_url, photo.src)) return firstText(photo.url, photo.thumb_url, photo.src);
        try { return typeof media?.url === 'function' ? cleanText(media.url(firstText(photo.media_id, photo.id))) : ''; } catch (e) { return ''; }
      };
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card">
            ${photos.length ? `
              <div class="fmdw-photo-grid">
                ${photos.slice(0, 30).map((photo) => {
                  const id = firstText(photo.media_id, photo.id);
                  const active = selectedIds.includes(id);
                  return `
                    <button type="button" class="fmdw-photo ${active ? 'active' : ''}" data-fmdw-photo="${esc(id)}" ${ctx.readonly ? 'disabled' : ''} title="${esc(photo.label || '')}">
                      <img src="${esc(urlFor(photo))}" alt="${esc(photo.label || 'Photo')}" loading="lazy">
                      ${active ? '<i class="fas fa-circle-check"></i>' : ''}
                    </button>`;
                }).join('')}
              </div>`
              : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f236362c34b933","No project photos are available to choose from yet.") ?? "No project photos are available to choose from yet.")}</p>`}
            ${!ctx.readonly && selectedIds.length ? `<div class="fmdw-row-actions"><button type="button" class="fmdw-btn ghost" data-fmdw-photo-clear><i class="fas fa-xmark"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_4f893b8c92cc5a"," Clear selection") ?? " Clear selection")}</button></div>` : ''}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      el.querySelectorAll('[data-fmdw-photo]').forEach((button) => button.addEventListener('click', () => {
        const id = button.dataset.fmdwPhoto;
        if (multi) {
          const current = arr(ctx.value()).map((v) => obj(typeof v === 'string' ? { media_id: v } : v));
          const exists = current.some((v) => firstText(v.media_id, v.id) === id);
          const next = exists ? current.filter((v) => firstText(v.media_id, v.id) !== id) : [...current, { media_id: id, variant: 'display' }];
          ctx.write(next);
        } else {
          ctx.write({ media_id: id, variant: 'display' });
        }
        render();
        ctx.requestPreview();
      }));
      el.querySelector('[data-fmdw-photo-clear]')?.addEventListener('click', () => { ctx.write(multi ? [] : null); render(); });
    };
    render();
    return { validate: () => requiredError(ctx) };
  });

  // ----------------------------------------------------------- content blocks
  // Tiers spec §10.1 — edits params.content_blocks rows:
  //   { id, title, body, media: {media_id|url} | null, video: {url} | null,
  //     layout: "auto"|"media_left"|"media_right"|"text_only",
  //     display: "inline"|"popup" }
  // Document-side the rows render through a repeater over a media_text_row
  // component; layout "auto" alternates left/right via the repeater's
  // variant_by_index (doc-model), and display "popup" rows emit the
  // data-fmdoc-media-popup lightbox chip (doc-widgets contract).
  const CONTENT_BLOCK_LAYOUTS = [
    ['auto', 'Alternate sides'],
    ['media_left', 'Media left'],
    ['media_right', 'Media right'],
    ['text_only', 'Text only']
  ];
  const CONTENT_BLOCK_DISPLAYS = [['inline', 'Inline'], ['popup', 'Popup']];
  function normalizeContentBlock(raw){
    const source = obj(raw);
    const media = obj(source.media);
    const video = obj(source.video);
    return {
      id: firstText(source.id, uid('cb')),
      title: cleanText(source.title),
      body: String(source.body ?? ''),
      media: firstText(media.media_id, media.url) ? { ...media } : null,
      video: firstText(video.url) ? { ...video } : null,
      layout: CONTENT_BLOCK_LAYOUTS.some(([value]) => value === cleanText(source.layout)) ? cleanText(source.layout) : 'auto',
      display: cleanText(source.display) === 'popup' ? 'popup' : 'inline'
    };
  }

  registerKind('content_blocks', (el, ctx) => {
    let blocks = arr(ctx.value()).map(normalizeContentBlock);
    const media = obj(ctx.services).media;
    const commit = () => { ctx.write(clone(blocks)); ctx.requestPreview(); };
    const blockThumb = (block) => {
      const source = obj(block.media);
      if (firstText(source.url)) return cleanText(source.url);
      const id = firstText(source.media_id);
      if (id && typeof media?.url === 'function') { try { return cleanText(media.url(id)); } catch (e) { return ''; } }
      return '';
    };

    const render = () => {
      const cards = blocks.map((block, index) => {
        const thumb = blockThumb(block);
        const hasVideo = !!firstText(obj(block.video).url);
        return `
          <div class="fmdw-cb-card" data-fmdw-cb="${String(esc(block.id))}">
            <div class="fmdw-cb-head">
              <span class="fmdw-cb-index">${String(index + 1)}</span>
              <input type="text" class="fmdw-cb-title" data-fmdw-cb-title value="${String(esc(block.title))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_09242ff7fde37f","Block title") ?? "Block title")}" ${String(ctx.readonly ? 'disabled' : '')}>
              ${String(ctx.readonly ? '' : `
                <button type="button" class="fmdw-icon-btn" data-fmdw-cb-up title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f51d0d563b4d76","Move up") ?? "Move up")}" ${index === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="fmdw-icon-btn" data-fmdw-cb-down title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8dda6677ff0f34","Move down") ?? "Move down")}" ${index === blocks.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
                <button type="button" class="fmdw-icon-btn danger" data-fmdw-cb-remove title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_e635189453de2e","Remove block") ?? "Remove block")}"><i class="fas fa-xmark"></i></button>`)}
            </div>
            <div class="fmdw-cb-main">
              <button type="button" class="fmdw-cb-thumb ${String(thumb || hasVideo ? '' : 'empty')}" data-fmdw-cb-media ${String(ctx.readonly ? 'disabled' : '')} title="${thumb || hasVideo ? 'Change the photo or video' : 'Add a photo or video: pick from your library, upload, or paste a link'}">
                ${String(thumb ? `<img src="${esc(thumb)}" alt="">` : `<i class="fas ${hasVideo ? 'fa-circle-play' : 'fa-image'}"></i>`)}
                <span>${thumb || hasVideo ? 'Change' : 'Add media'}</span>
              </button>
              <textarea class="fmdw-cb-body" data-fmdw-cb-body placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8b606c39e02eaa","Body text \u2014 what should the customer read here?") ?? "Body text \u2014 what should the customer read here?")}" ${String(ctx.readonly ? 'disabled' : '')}>${String(esc(block.body))}</textarea>
            </div>
            <div class="fmdw-cb-settings">
              <label>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_414b43a606b221","Layout\n                ") ?? "Layout\n                ")}<select data-fmdw-cb-layout ${String(ctx.readonly ? 'disabled' : '')}>
                  ${String(CONTENT_BLOCK_LAYOUTS.map(([value, label]) => `<option value="${esc(value)}" ${block.layout === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}
                </select>
              </label>
              <label>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0a1b926b9ae7f2","Media display\n                ") ?? "Media display\n                ")}<select data-fmdw-cb-display ${String(ctx.readonly ? 'disabled' : '')}>
                  ${String(CONTENT_BLOCK_DISPLAYS.map(([value, label]) => `<option value="${esc(value)}" ${block.display === value ? 'selected' : ''}>${esc(label)}</option>`).join(''))}
                </select>
              </label>
            </div>
          </div>`;
      });
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-cb-list">
            ${cards.length ? cards.join('') : `<div class="fmdw-card"><p class="fmdw-hint" style="margin:0"><i class="fas fa-circle-info"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9b58eb110cbbc5"," No content blocks yet — add one to pair photos and text on the document.") ?? " No content blocks yet — add one to pair photos and text on the document.")}</p></div>`}
          </div>
          ${ctx.readonly ? '' : `<div class="fmdw-row-actions"><button type="button" class="fmdw-btn" data-fmdw-cb-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_d2da9449c9549c"," Add block") ?? " Add block")}</button></div>`}
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;

      const blockAt = (id) => blocks.find((b) => b.id === id);
      el.querySelectorAll('[data-fmdw-cb]').forEach((card) => {
        const id = card.dataset.fmdwCb;
        card.querySelector('[data-fmdw-cb-title]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.title = cleanText(event.target.value); commit(); }
        });
        card.querySelector('[data-fmdw-cb-body]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.body = String(event.target.value ?? ''); commit(); }
        });
        // The same attach popover the line items use: the shared media library
        // (with upload) inside it, or one link that may be an image or a video.
        card.querySelector('[data-fmdw-cb-media]')?.addEventListener('click', (event) => {
          const block = blockAt(id);
          if (!block) return;
          openMediaAttach({
            anchor: event.currentTarget,
            item: { media: block.media ? [block.media] : [], video: block.video, display: block.display },
            services: ctx.services,
            hideDisplay: true,
            onSave: (patch) => {
              block.media = obj(arr(obj(patch).media)[0]).media_id || obj(arr(obj(patch).media)[0]).url ? arr(patch.media)[0] : null;
              block.video = obj(patch).video && firstText(obj(obj(patch).video).url) ? obj(patch).video : null;
              commit();
              render();
            }
          });
        });
        card.querySelector('[data-fmdw-cb-layout]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.layout = cleanText(event.target.value) || 'auto'; commit(); }
        });
        card.querySelector('[data-fmdw-cb-display]')?.addEventListener('change', (event) => {
          const block = blockAt(id);
          if (block) { block.display = cleanText(event.target.value) === 'popup' ? 'popup' : 'inline'; commit(); }
        });
        card.querySelector('[data-fmdw-cb-remove]')?.addEventListener('click', () => {
          const index = blocks.findIndex((b) => b.id === id);
          if (index !== -1) { blocks.splice(index, 1); commit(); render(); }
        });
        card.querySelector('[data-fmdw-cb-up]')?.addEventListener('click', () => {
          const index = blocks.findIndex((b) => b.id === id);
          if (index > 0) { blocks.splice(index - 1, 0, blocks.splice(index, 1)[0]); commit(); render(); }
        });
        card.querySelector('[data-fmdw-cb-down]')?.addEventListener('click', () => {
          const index = blocks.findIndex((b) => b.id === id);
          if (index !== -1 && index < blocks.length - 1) { blocks.splice(index + 1, 0, blocks.splice(index, 1)[0]); commit(); render(); }
        });
      });
      el.querySelector('[data-fmdw-cb-add]')?.addEventListener('click', () => {
        blocks.push(normalizeContentBlock({ title: '', body: '' }));
        commit();
        render();
      });
    };
    render();
    return { validate: () => (ctx.item.required && !arr(ctx.value()).length ? 'Add at least one content block.' : null) };
  });

  // ---------------------------------------------------- media attach popover
  // Shared by line_items_review rows and the documents app's scope editor
  // (FMDocWorkflow.openMediaAttach): attaches media/video to a scope item —
  //   item.media   = [{ media_id|url, caption? }]
  //   item.video   = { url, caption? } | null
  //   item.display = "inline" | "popup"
  // — persisted with params.scope_items, so the server line-items resolver and
  // doc.line_items / li_row repeater components can render thumbs or the
  // data-fmdoc-media-popup lightbox chip.
  /** Place a body-level popover by its anchor: below when it fits, above when
   *  it does not, and always inside the window. */
  function placePopover(pop, anchor, width){
    const rect = anchor.getBoundingClientRect?.() || { left: 40, right: 80, top: 40, bottom: 40 };
    const w = Math.min(width, Math.max(240, window.innerWidth - 16));
    pop.style.width = `${w}px`;
    const left = rect.right - w >= 8 ? rect.right - w : rect.left;
    pop.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    const height = pop.offsetHeight || 0;
    const below = rect.bottom + 6;
    const above = rect.top - height - 6;
    const top = below + height <= window.innerHeight - 8 ? below : (above >= 8 ? above : Math.max(8, window.innerHeight - height - 8));
    pop.style.top = `${top}px`;
  }
  const VIDEO_URL = /(youtube\.com|youtu\.be|vimeo\.com|loom\.com|wistia\.)|\.(mp4|mov|webm|m4v)(\?|#|$)/i;

  function openMediaAttach(options){
    if (typeof document === 'undefined') return null;
    ensureStyles();
    const opts = obj(options);
    const anchor = opts.anchor;
    const item = obj(opts.item);
    const media = obj(obj(opts.services).media);
    document.querySelectorAll('.fmdw-attach-pop').forEach((existing) => existing.remove());
    if (!anchor || typeof opts.onSave !== 'function') return null;

    const mediaUrl = (id) => {
      try { return typeof media.url === 'function' ? cleanText(media.url(id)) : ''; } catch (e) { return ''; }
    };
    const current = obj(arr(item.media)[0]);
    const hadAttachment = arr(item.media).length > 0 || !!firstText(obj(item.video).url);
    // One link field holds either an image or a video; a library pick fills
    // media_id instead.
    const state = {
      media_id: firstText(current.media_id),
      preview_url: firstText(current.url, current.media_id ? mediaUrl(current.media_id) : ''),
      link: firstText(obj(item.video).url, current.url),
      caption: cleanText(current.caption || obj(item.video).caption),
      display: cleanText(item.display) === 'popup' ? 'popup' : 'inline'
    };
    // A host that can mount the media library inline (the media.picker
    // widget) shows it inside this popover; otherwise pick() opens it.
    const canMount = typeof media.mount === 'function';
    const canPick = canMount || typeof media.pick === 'function';
    let library = null;

    const pop = document.createElement('div');
    pop.className = 'fmdw-attach-pop';
    const usePicked = (value) => {
      const picked = obj(value);
      const id = firstText(picked.media_id, picked.id);
      if (!id && !firstText(picked.url)) return false;
      state.media_id = id;
      state.preview_url = firstText(picked.thumb_url, id ? mediaUrl(id) : '', picked.url);
      state.link = id ? '' : firstText(picked.url);
      return true;
    };
    const closeLibrary = () => {
      const open = library;
      library = null;
      Promise.resolve(open).then((handle) => handle?.destroy?.()).catch(() => {});
      pop.classList.remove('library');
    };
    const showForm = () => {
      closeLibrary();
      renderPop();
      placePopover(pop, anchor, 420);
    };
    const showLibrary = () => {
      pop.classList.add('library');
      pop.innerHTML = `
        <div class="fmdw-attach-head">
          <button type="button" class="fmdw-attach-x" data-fmdw-attach-back title="Back"><i class="fas fa-arrow-left"></i></button>
          <span class="fmdw-attach-title"></span>
          <button type="button" class="fmdw-attach-x" data-fmdw-attach-cancel title="Close"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="fmdw-attach-library" data-fmdw-attach-library></div>`;
      pop.querySelector('[data-fmdw-attach-back]').addEventListener('click', showForm);
      pop.querySelector('[data-fmdw-attach-cancel]').addEventListener('click', () => close());
      const host = pop.querySelector('[data-fmdw-attach-library]');
      const place = () => { if (!closed && library) placePopover(pop, anchor, 640); };
      place();
      try {
        library = media.mount(host, {
          selected: state.media_id,
          onPick: (picked) => { if (usePicked(picked)) showForm(); },
          onResize: place
        });
        Promise.resolve(library).then(place).catch(() => showForm());
      } catch (e) { showForm(); }
      place();
    };
    const renderPop = () => {
      const isVideo = !state.media_id && VIDEO_URL.test(state.link);
      const preview = state.media_id ? state.preview_url : (isVideo ? '' : state.link);
      pop.innerHTML = `
        <div class="fmdw-attach-head">
          <span><i class="fas fa-paperclip"></i> Photo or video</span>
          <button type="button" class="fmdw-attach-x" data-fmdw-attach-cancel title="Close"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="fmdw-attach-body">
          <button type="button" class="fmdw-attach-thumb ${canPick ? 'pick' : ''}" data-fmdw-attach-pick ${canPick ? '' : 'disabled'} title="${canPick ? 'Choose from your photos' : ''}">
            ${preview ? `<img src="${esc(preview)}" alt="">` : ''}
            <i class="fas ${isVideo ? 'fa-circle-play' : (canPick ? 'fa-images' : 'fa-image')}"></i>
            ${canPick ? '<span>Choose photo</span>' : ''}
          </button>
          <div class="fmdw-attach-fields">
            <div class="fmdw-attach-link">
              <input type="text" data-fmdw-attach-link value="${esc(state.media_id ? '' : state.link)}" placeholder="${state.media_id ? 'Photo from your library' : 'Paste an image or video link'}" title="Paste a link to an image, or to a video on YouTube, Vimeo or a video file.">
              ${canPick ? `<button type="button" class="fmdw-icon-btn" data-fmdw-attach-pick title="Choose from your photos"><i class="fas fa-images"></i></button>` : ''}
            </div>
            <input type="text" data-fmdw-attach-caption value="${esc(state.caption)}" placeholder="Caption (optional)">
          </div>
        </div>
        ${opts.hideDisplay ? '' : `<details class="fmdw-attach-more" ${state.display === 'popup' ? 'open' : ''}>
          <summary>Display options</summary>
          <select data-fmdw-attach-display>
            <option value="inline" ${state.display === 'inline' ? 'selected' : ''}>Show in the line on the proposal</option>
            <option value="popup" ${state.display === 'popup' ? 'selected' : ''}>Show as a chip that opens the photo</option>
          </select>
        </details>`}
        <div class="fmdw-attach-actions">
          ${hadAttachment ? `<button type="button" class="fmdw-btn ghost" data-fmdw-attach-remove><i class="fas fa-trash-can"></i> Remove</button>` : ''}
          <button type="button" class="fmdw-btn primary" data-fmdw-attach-save>Save</button>
        </div>`;
      // A photo that will not load shows the placeholder, never a broken image.
      pop.querySelector('.fmdw-attach-thumb img')?.addEventListener('error', (event) => { event.target.remove(); });
      pop.querySelectorAll('[data-fmdw-attach-pick]').forEach((button) => button.addEventListener('click', async () => {
        if (!canPick) return;
        if (canMount) { showLibrary(); return; }
        picking = true;
        // The library is its own window; this popover steps aside for it.
        pop.style.visibility = 'hidden';
        try {
          if (usePicked(await media.pick())) {
            renderPop();
            placePopover(pop, anchor, 420);
          }
        } catch (e) { /* picker closed */ }
        pop.style.visibility = '';
        // The library closes with a click outside this popover; keep it open.
        setTimeout(() => { picking = false; }, 0);
      }));
      pop.querySelector('[data-fmdw-attach-link]')?.addEventListener('change', (event) => {
        state.link = cleanText(event.target.value);
        if (state.link) { state.media_id = ''; state.preview_url = ''; }
        renderPop();
      });
      pop.querySelector('[data-fmdw-attach-caption]')?.addEventListener('change', (event) => { state.caption = cleanText(event.target.value); });
      pop.querySelector('[data-fmdw-attach-display]')?.addEventListener('change', (event) => {
        state.display = cleanText(event.target.value) === 'popup' ? 'popup' : 'inline';
      });
      pop.querySelector('[data-fmdw-attach-remove]')?.addEventListener('click', () => {
        close();
        opts.onSave({ media: [], video: null, display: 'inline' });
      });
      pop.querySelector('[data-fmdw-attach-cancel]')?.addEventListener('click', () => close());
      pop.querySelector('[data-fmdw-attach-save]')?.addEventListener('click', () => {
        // Read the fields directly too, so typing without blurring still lands.
        const typed = cleanText(pop.querySelector('[data-fmdw-attach-link]')?.value);
        if (typed) { state.link = typed; state.media_id = ''; }
        state.caption = cleanText(pop.querySelector('[data-fmdw-attach-caption]')?.value ?? state.caption);
        const video = !state.media_id && VIDEO_URL.test(state.link);
        const mediaEntry = state.media_id
          ? { media_id: state.media_id, variant: 'display' }
          : (state.link && !video ? { url: state.link } : null);
        if (mediaEntry && state.caption) mediaEntry.caption = state.caption;
        close();
        opts.onSave({
          media: mediaEntry ? [mediaEntry] : [],
          video: video ? { url: state.link, ...(state.caption ? { caption: state.caption } : {}) } : null,
          display: state.display
        });
      });
    };

    let picking = false;
    function onDocDown(event){
      // The library may open its own menus and file dialog outside this
      // popover; it closes with Back, the X or Escape.
      if (picking || library) return;
      if (!pop.contains(event.target) && event.target !== anchor && !anchor.contains?.(event.target)) close();
    }
    function onKey(event){
      if (event.key !== 'Escape' || picking) return;
      event.stopPropagation();
      if (library) showForm(); else close();
    }
    let closed = false;
    function close(){
      if (closed) return;
      closed = true;
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
      closeLibrary();
      pop.remove();
    }

    renderPop();
    document.body.appendChild(pop);
    placePopover(pop, anchor, 420);
    // Defer so the click that opened the popover doesn't instantly close it.
    setTimeout(() => {
      if (closed) return;
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
    return { close, element: pop };
  }

  // -------------------------------------------------------- line item editor
  registerKind('line_item_editor', (el, ctx) => {
    let items = arr(ctx.value()).map(normalizeScopeItem);
    const services = obj(ctx.services);
    const commit = () => ctx.write(clone(items));
    const render = () => {
      const rows = [];
      const pushRow = (item, depth) => {
        rows.push(`
          <div class="fmdw-li-row ${String(depth ? 'child' : '')}" data-fmdw-li="${String(esc(item.id))}">
            <div class="fmdw-li-name">
              ${String(ctx.readonly
                ? `<strong>${esc(firstText(item.display_name, item.name, 'Line item'))}</strong>`
                : `<input type="text" data-fmdw-li-name value="${esc(firstText(item.display_name, item.name))}" placeholder="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_83915801b47db5","Line item") ?? "Line item")}">`)}
              ${String(item.description ? `<small>${esc(item.description)}</small>` : '')}
            </div>
            <input class="fmdw-li-qty" type="number" step="any" min="0" data-fmdw-li-qty value="${String(esc(item.quantity))}" ${String(ctx.readonly ? 'disabled' : '')} title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9c689ddee2f502","Quantity") ?? "Quantity")}">
            <span class="fmdw-li-unit">${String(esc(item.unit || 'ea'))}</span>
            <input class="fmdw-li-price" type="number" step="0.01" min="0" data-fmdw-li-price value="${String(esc(Number(item.unit_price || 0).toFixed(2)))}" ${String(ctx.readonly ? 'disabled' : '')} title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c68827ddeaf565","Unit price ($)") ?? "Unit price ($)")}">
            ${String(ctx.readonly ? '' : `<button type="button" class="fmdw-icon-btn danger" data-fmdw-li-remove title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>`)}
          </div>`);
        arr(item.children).forEach((child) => pushRow(child, depth + 1));
      };
      items.forEach((item) => pushRow(item, 0));
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card">
            ${ctx.readonly ? '' : `
              <div class="fmdw-row-actions" style="margin-bottom:2px">
                ${String(services.pricebook && typeof services.pricebook.pick === 'function' ? `<button type="button" class="fmdw-btn" data-fmdw-li-pricebook><i class="fas fa-book-open"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c38fcf1b64a2ea"," Pricebook") ?? " Pricebook")}</button>` : '')}
                <button type="button" class="fmdw-btn" data-fmdw-li-add><i class="fas fa-plus"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8e13db264d4c9f"," Add row") ?? " Add row")}</button>
              </div>`}
            <div class="fmdw-li-list">
              ${rows.length ? rows.join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0b854052709977","No line items yet.") ?? "No line items yet.")}</p>`}
            </div>
            ${rows.length ? `<div class="fmdw-li-total"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9403c7637d4905","Total") ?? "Total")}</span><b>${String(esc(moneyFromDollars(scopeItemsTotal(items))))}</b></div>` : ''}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const findItem = (list, id) => {
        for (const item of arr(list)) {
          if (item.id === id) return { item, list };
          const found = findItem(item.children, id);
          if (found) return found;
        }
        return null;
      };
      el.querySelectorAll('[data-fmdw-li]').forEach((row) => {
        const id = row.dataset.fmdwLi;
        row.querySelector('[data-fmdw-li-name]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) {
            found.item.name = cleanText(event.target.value) || found.item.name;
            found.item.display_name = cleanText(event.target.value) || found.item.display_name;
            commit();
          }
        });
        row.querySelector('[data-fmdw-li-qty]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) { found.item.quantity = String(Math.max(0, Number(event.target.value || 0))); commit(); render(); }
        });
        row.querySelector('[data-fmdw-li-price]')?.addEventListener('change', (event) => {
          const found = findItem(items, id);
          if (found) { found.item.unit_price = Math.max(0, Number(event.target.value || 0)); commit(); render(); }
        });
        row.querySelector('[data-fmdw-li-remove]')?.addEventListener('click', () => {
          const found = findItem(items, id);
          if (found) { found.list.splice(found.list.indexOf(found.item), 1); commit(); render(); }
        });
      });
      el.querySelector('[data-fmdw-li-add]')?.addEventListener('click', () => {
        items.push(makeScopeItem({ name: 'New line item', display_name: 'New line item' }));
        commit();
        render();
      });
      el.querySelector('[data-fmdw-li-pricebook]')?.addEventListener('click', async () => {
        try {
          const picked = await services.pricebook.pick();
          if (arr(picked).length) { items = [...items, ...arr(picked).map(normalizeScopeItem)]; commit(); render(); }
        } catch (e) { /* cancelled */ }
      });
    };
    render();
    return { validate: () => requiredError(ctx) };
  });

  // ------------------------------------------------------------ piece picker


  // ------------------------------------------------------------ piece select
  // Native "What are we doing?" cards — the proposal piece-type vocabulary
  // (scope templates) sourced from services.pieceCatalog(). Writes the
  // selection (params.scope_pieces by convention) and derives
  // params.measurement_requirements — the measurement keys the selected
  // pieces' pricing formulas reference — so later steps (`when` conditions,
  // the measurements item) can condition on the selection BEFORE any line
  // items exist. Changing the selection clears previously generated
  // params.scope_items so the line-items step regenerates.
  const renderPieceSelectKind = (el, ctx) => {
    const services = obj(ctx.services);
    let catalog = null; // null = loading; [] = unavailable

    const selectionValue = () => arr(ctx.value()).map((p) => (typeof p === 'string' ? { template_id: p } : obj(p)));
    const selectedIds = () => selectionValue().map((p) => cleanText(p.template_id || p.id)).filter(Boolean);

    async function loadCatalog(){
      try {
        const raw = typeof services.pieceCatalog === 'function' ? await services.pieceCatalog() : null;
        catalog = arr(raw).map(obj).map((piece) => ({
          id: cleanText(piece.id || piece.template_id),
          name: firstText(piece.name, prettyKey(cleanText(piece.id || piece.template_id))),
          description: cleanText(piece.description),
          icon: firstText(piece.icon, 'fa-diagram-project'),
          color: cleanText(piece.color)
        })).filter((piece) => piece.id);
      } catch (e) { catalog = []; }
      if (el.isConnected) render();
    }

    async function deriveRequirements(selection){
      let keys = [];
      try {
        if (typeof services.measurementKeysForSelection === 'function') {
          keys = arr(await services.measurementKeysForSelection(selection)).map(cleanText).filter(Boolean);
        } else if (arr(selection).length && typeof services.generateScopeItems === 'function') {
          // Provisional generation (current measurements) just to read which
          // measurement keys the generated scope's pricing formulas reference.
          const provisional = arr(await services.generateScopeItems(clone(selection), obj(getPath(ctx.scope(), 'params.measurements'))));
          keys = scopeMeasurementKeys(provisional);
        }
      } catch (e) { keys = []; }
      ctx.writePath('params.measurement_requirements', keys);
    }

    async function toggle(pieceId){
      if (ctx.readonly) return;
      const multi = ctx.item.multi !== false && obj(ctx.item.presentation).multi !== false;
      const current = selectionValue();
      const exists = current.some((p) => cleanText(p.template_id || p.id) === pieceId);
      const meta = arr(catalog).find((p) => p.id === pieceId) || { id: pieceId, name: prettyKey(pieceId) };
      const next = exists
        ? current.filter((p) => cleanText(p.template_id || p.id) !== pieceId)
        : [...(multi ? current : []), {
            id: `piece_${pieceId}`,
            template_id: pieceId,
            name: meta.name,
            ...(meta.icon ? { icon: meta.icon } : {}),
            ...(meta.color ? { color: meta.color } : {})
          }];
      ctx.write(next);
      // Any previously generated items belong to the old selection.
      ctx.writePath('params.scope_items', []);
      render();
      await deriveRequirements(next);
      ctx.requestPreview();
    }

    function render(){
      const ids = selectedIds();
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          ${catalog === null
            ? `<p class="fmdw-hint"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_900d0404687053"," Loading project types…") ?? " Loading project types…")}</p>`
            : (catalog.length ? `
          <div class="fmdw-choice-grid fmdw-piece-grid">
            ${catalog.map((piece) => `
              <button type="button" class="fmdw-choice-card fmdw-piece-type ${ids.includes(piece.id) ? 'active' : ''}" data-fmdw-piece-type="${esc(piece.id)}" ${ctx.readonly ? 'disabled' : ''}${piece.color ? ` style="--fmdw-piece-color:${esc(piece.color)}"` : ''}>
                <span class="fmdw-piece-type-icon"><i class="fas ${esc(piece.icon)}"></i></span>
                <strong>${esc(piece.name)}</strong>
                ${piece.description ? `<small>${esc(piece.description)}</small>` : ''}
                <span class="fmdw-choice-tick"><i class="fas fa-check"></i></span>
              </button>`).join('')}
          </div>` : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0a1a27b7480d52","No project types are available in this session.") ?? "No project types are available in this session.")}</p>`)}
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      el.querySelectorAll('[data-fmdw-piece-type]').forEach((button) => button.addEventListener('click', () => toggle(button.dataset.fmdwPieceType)));
    }

    render();
    loadCatalog();
    return { validate: () => (ctx.item.required && !selectionValue().length ? 'Choose at least one project type.' : null) };
  };
  registerKind('piece_select', renderPieceSelectKind);
  // Old seeded workflows still reference 'piece_picker' — they render the
  // SAME native cards. The legacy inline/modal scope builder is gone from
  // the workflow runtime entirely.
  registerKind('piece_picker', renderPieceSelectKind);

  // ------------------------------------------------------- line items review
  // Generated line items, priced from the price book. On entry with an empty
  // value it runs services.generateScopeItems(selection, measurements), then
  // shows the scope the way it prices: each root heads its group with a
  // subtotal and its lines indent under it; alternatives of one choice group
  // sit together with the priced option marked; optional lines carry a
  // checkbox. Amounts use the same rule as the server (scopeItemAmount), so
  // the total here is the document total. Lines that a quantity modifier
  // touched (waste) carry its badge, and the Modifiers panel changes a
  // modifier's value for every line it applies to.
  // Writes the scope-item tree (params.scope_items). An item with
  // generate:false has nothing to generate from (a change order's added
  // work): its lines are added by hand or from the price book.
  registerKind('line_items_review', (el, ctx) => {
    const services = obj(ctx.services);
    const generates = ctx.item.generate !== false;
    let items = arr(ctx.value()).map(normalizeScopeItem);
    let generating = false;
    let generateNote = '';
    const findItem = (list, id, parent = null) => {
      for (const item of arr(list)) {
        if (item.id === id) return { item, list, parent };
        const found = findItem(item.children, id, item);
        if (found) return found;
      }
      return null;
    };
    const walkItems = (list, visit) => arr(list).forEach((item) => { visit(item); walkItems(item.children, visit); });
    const choiceGroupOf = (item) => {
      const sel = obj(item.selection);
      return cleanText(sel.mode) === 'choice' ? cleanText(sel.group_id) : '';
    };
    const isOptional = (item) => cleanText(obj(item.selection).mode) === 'optional';
    // Alternatives and optional lines left on the estimate are the customer's to pick; to send one, remove the others.
    const customerPicks = () => true;
    const groupTitle = (groupId, options) => firstText(obj(obj(arr(options)[0]).selection).group_title, prettyKey(cleanText(groupId).split(':').pop().replace(/_(profile|group|choice)$/i, '')));
    /** How many decisions the customer is offered (choice groups + optional
     *  lines); later steps show the customer's choosing step only when > 0. */
    function customerChoiceCount(){
      const { groups, optionals } = collectScopeChoiceGroups(items);
      return [...groups.values()].filter((options) => options.length > 1).length + optionals.length;
    }
    const commit = () => {
      ctx.write(clone(items));
      ctx.writePath('params.customer_choice_count', customerChoiceCount());
    };
    const selection = () => arr(getPath(ctx.scope(), cleanText(ctx.item.selection_from) || 'params.scope_pieces'));
    const measurements = () => obj(getPath(ctx.scope(), 'params.measurements'));
    const stampOf = (value) => JSON.stringify(Object.keys(obj(value)).sort().map((key) => [key, obj(value)[key]]));
    // Lines were generated from one set of measurements; a later change to
    // them leaves the quantities behind until the user regenerates.
    const stale = () => {
      const stamp = cleanText(getPath(ctx.scope(), 'params.scope_generated_from'));
      return !!stamp && countScopeItems(items) > 0 && stamp !== stampOf(measurements());
    };
    /** What the line costs when it is priced, whether or not it is selected. */
    const lineAmount = (item) => (item.price_driving === false ? 0 : Math.max(0, Number(item.quantity || 0) || 0) * (Number(item.unit_price || 0) || 0));
    /** A whole option (a pick with its own lines) shows what all of it costs. */
    const isPackage = (item) => !!(choiceGroupOf(item) || isOptional(item)) && arr(item.children).length > 0;
    const rowAmount = (item) => (isPackage(item) ? scopeItemAmountIfSelected(item) : lineAmount(item));
    const formatNumber = (value) => String(Math.round((Number(value) || 0) * 100) / 100);

    // ------------------------------------------------------------ modifiers
    /** Modifiers the generated scope declares, by id. */
    function modifiers(){
      const byId = new Map();
      items.forEach((root) => arr(root.quantity_modifiers).map(obj).forEach((modifier) => {
        if (cleanText(modifier.id) && !byId.has(modifier.id)) byId.set(modifier.id, modifier);
      }));
      return [...byId.values()];
    }
    const affectedBy = (modifierId) => {
      let count = 0;
      walkItems(items, (item) => { if (arr(item.quantity_adjustments).some((entry) => obj(entry).id === modifierId)) count += 1; });
      return count;
    };
    const applyModifier = (quantity, adjustment) => {
      const value = Number(adjustment.value) || 0;
      if (adjustment.operation === 'multiply') return quantity * value;
      if (adjustment.operation === 'add') return quantity + value;
      return quantity * (1 + value / 100);
    };
    const roundQuantity = (value, rounding) => {
      const rule = obj(rounding);
      if (cleanText(rule.mode) === 'none') return Math.round(value * 1e4) / 1e4;
      const factor = 10 ** (Number(rule.decimals) || 0);
      const scaled = Math.round(value * factor * 1e6) / 1e6;
      return Math.max(0, (cleanText(rule.mode) === 'up' ? Math.ceil(scaled) : Math.round(scaled)) / factor);
    };
    const modifierEffect = (adjustment) => {
      const value = formatNumber(adjustment.value);
      if (adjustment.operation === 'multiply') return `× ${value}`;
      if (adjustment.operation === 'add') return `+ ${value}`;
      return `+${value}%`;
    };
    function modifierBadges(item){
      const adjustments = arr(item.quantity_adjustments).map(obj).filter((entry) => cleanText(entry.id));
      if (!adjustments.length) return '';
      const base = Number(item.base_quantity) || 0;
      return adjustments.map((entry) => {
        const tip = item.manual_quantity === true
          ? `${entry.label}: this quantity was entered by hand, so ${String(entry.label).toLowerCase()} is not applied to it.`
          : `${entry.label} ${modifierEffect(entry)}: ${formatNumber(base)} ${item.unit || ''} measured becomes ${formatNumber(item.quantity)} ${item.unit || ''}${cleanText(obj(item.quantity_rounding).mode) === 'up' ? ', rounded up' : ''}.`;
        return `<span class="fmdw-lir-mod ${item.manual_quantity === true ? 'off' : ''}" title="${esc(tip)}">${esc(firstText(entry.badge, String(entry.label || '?').slice(0, 1)))}</span>`;
      }).join('');
    }
    /** Change a modifier's value everywhere it applies. Hand-entered
     *  quantities are left alone. */
    function setModifierValue(modifierId, value){
      let variable = '';
      items.forEach((root) => arr(root.quantity_modifiers).forEach((modifier) => {
        if (obj(modifier).id === modifierId) { modifier.value = value; variable = firstText(modifier.variable, variable); }
      }));
      walkItems(items, (item) => {
        const adjustments = arr(item.quantity_adjustments);
        if (!adjustments.some((entry) => obj(entry).id === modifierId)) return;
        adjustments.forEach((entry) => { if (obj(entry).id === modifierId) entry.value = value; });
        if (item.manual_quantity === true) return;
        const next = adjustments.reduce((quantity, entry) => applyModifier(quantity, obj(entry)), Number(item.base_quantity) || 0);
        item.quantity = String(roundQuantity(next, item.quantity_rounding));
      });
      commit();
      if (variable) {
        // The modifier's value lives with the measurements it was read from,
        // so the Roof step and a later regenerate agree with this screen.
        const next = { ...measurements(), [variable]: value };
        ctx.writePath('params.measurements', next);
        ctx.writePath('params.scope_generated_from', stampOf(next));
      }
      ctx.requestPreview();
    }
    function openModifiers(anchor){
      document.querySelectorAll('.fmdw-mod-pop').forEach((existing) => existing.remove());
      const pop = document.createElement('div');
      pop.className = 'fmdw-attach-pop fmdw-mod-pop';
      const list = modifiers();
      pop.innerHTML = `
        <div class="fmdw-attach-head"><span><i class="fas fa-sliders"></i> Modifiers <i class="fas fa-circle-info fmdw-mod-info" title="A modifier adjusts the quantity of every line it applies to. Lines it touched show its badge."></i></span><button type="button" class="fmdw-attach-x" data-fmdw-mod-close title="Close"><i class="fas fa-xmark"></i></button></div>
        ${list.length ? list.map((modifier) => `
          <label class="fmdw-mod-row ${modifier === list[0] ? 'first' : ''}">
            <span class="fmdw-lir-mod">${esc(firstText(modifier.badge, '?'))}</span>
            <span class="fmdw-mod-copy"><strong>${esc(modifier.label)}</strong><small>${esc(firstText(modifier.description, ''))} ${affectedBy(modifier.id)} line${affectedBy(modifier.id) === 1 ? '' : 's'}.</small></span>
            <span class="fmdw-lir-num"><i>${modifier.operation === 'multiply' ? '×' : '+'}</i><input type="number" step="any" min="0" data-fmdw-mod-value="${esc(modifier.id)}" value="${esc(formatNumber(modifier.value))}" ${ctx.readonly ? 'disabled' : ''}><i>${modifier.operation === 'percent' ? '%' : ''}</i></span>
          </label>`).join('') : `<p class="fmdw-hint" style="margin:0">These lines have no modifiers. Lines generated from the price book carry the ones it defines, such as waste.</p>`}`;
      const close = () => { document.removeEventListener('mousedown', onDown, true); pop.remove(); };
      const onDown = (event) => { if (!pop.contains(event.target) && !anchor.contains(event.target)) close(); };
      pop.querySelector('[data-fmdw-mod-close]')?.addEventListener('click', close);
      pop.querySelectorAll('[data-fmdw-mod-value]').forEach((input) => input.addEventListener('change', () => {
        setModifierValue(input.dataset.fmdwModValue, Math.max(0, Number(input.value) || 0));
        render();
      }));
      document.body.appendChild(pop);
      placePopover(pop, anchor, 380);
      setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    }

    // ------------------------------------------------------------- variants
    // A line's colors and options (variant_dimensions) live on the line, not
    // as lines of their own. One value per dimension is selected: it sets the
    // unit price and prints on the proposal. `variant_offered` lists the
    // values the customer may be offered. A value can rule out values of
    // another dimension (excludes).
    const openVariants = new Set();
    // View state of the tree: which items have their sub-lines folded away,
    // and which choice groups are shown side by side. A workflow can open its
    // groups in compare (item.compare: true, or a list of group ids).
    const folded = new Set();
    const compared = new Map();
    const compareDefault = (groupId) => ctx.item.compare === true || arr(ctx.item.compare).includes(cleanText(groupId).split(':').pop()) || arr(ctx.item.compare).includes(groupId);
    const isCompared = (groupId) => (compared.has(groupId) ? compared.get(groupId) : compareDefault(groupId));
    const lineCount = (item) => { let n = 0; walkItems(item.children, () => { n += 1; }); return n; };
    const foldHtml = (item) => (arr(item.children).length ? `<button type="button" class="fmdw-lir-fold ${folded.has(item.id) ? 'folded' : ''}" data-fmdw-lir-fold="${esc(item.id)}" title="${folded.has(item.id) ? 'Show' : 'Hide'} the ${lineCount(item)} lines under this" aria-expanded="${!folded.has(item.id)}"><i class="fas fa-chevron-down"></i></button>` : '');
    const foldCountHtml = (item) => (arr(item.children).length ? `<span class="fmdw-lir-fold-count" data-fmdw-fold-count="${esc(item.id)}" ${folded.has(item.id) ? '' : 'hidden'}>${lineCount(item)} lines</span>` : '');
    /** The name and description as shown, each renamed for this estimate by a double-click. */
    const nameHtml = (item, fallback) => `<strong data-fmdw-rename="name" title="Double-click to rename for this estimate">${esc(firstText(item.display_name, item.name, fallback))}</strong>`;
    const descHtml = (item) => (item.description ? `<small class="fmdw-lir-desc" data-fmdw-rename="description" title="Double-click to edit">${esc(item.description)}</small>` : '');
    const dimensionsOf = (item) => arr(item.variant_dimensions).map(obj).filter((dimension) => cleanText(dimension.id) && arr(dimension.values).length);
    /** A dimension left off the contract: nothing offered, nothing chosen, no price change. */
    const omittedOf = (item, dimension) => obj(item.variant_omitted)[dimension.id] === true;
    const offeredOf = (item, dimension) => {
      if (omittedOf(item, dimension)) return [];
      const listed = obj(item.variant_offered)[dimension.id];
      return Array.isArray(listed) ? listed.map(cleanText) : arr(dimension.values).map((value) => cleanText(obj(value).id));
    };
    const selectedOf = (item, dimension) => cleanText(obj(item.selected_variants)[dimension.id]);
    /** Values of `dimension` that another dimension's selected value rules out. */
    function excludedOf(item, dimension){
      const out = new Set();
      dimensionsOf(item).forEach((other) => {
        if (other.id === dimension.id) return;
        const chosen = arr(other.values).map(obj).find((value) => cleanText(value.id) === selectedOf(item, other));
        arr(obj(obj(chosen).excludes)[dimension.id]).forEach((id) => out.add(cleanText(id)));
      });
      return out;
    }
    /** Keep every selection legal, then set the price, summary and variables. */
    function applyVariants(item){
      const dimensions = dimensionsOf(item);
      if (!dimensions.length) return;
      const selected = { ...obj(item.selected_variants) };
      dimensions.forEach((dimension) => {
        const excluded = excludedOf({ ...item, selected_variants: selected }, dimension);
        const offered = offeredOf(item, dimension);
        const ids = arr(dimension.values).map((value) => cleanText(obj(value).id));
        const allowed = ids.filter((id) => !excluded.has(id));
        // "" is a real answer: no default, the customer (or nobody) decides.
        if (omittedOf(item, dimension)) selected[dimension.id] = '';
        else if (selected[dimension.id] === '') { /* left without a default on purpose */ }
        else if (!allowed.includes(cleanText(selected[dimension.id]))) selected[dimension.id] = allowed.find((id) => offered.includes(id)) || allowed[0] || ids[0];
      });
      item.selected_variants = selected;
      let price = Number(item.variant_base_price);
      if (Number.isFinite(price)) {
        dimensions.forEach((dimension) => {
          const adjustment = obj(obj(arr(dimension.values).map(obj).find((value) => cleanText(value.id) === cleanText(selected[dimension.id]))).adjustment);
          if (adjustment.operation === 'add') price += Number(adjustment.value) || 0;
          else if (adjustment.operation === 'multiply') price *= Number(adjustment.value) || 1;
        });
        item.unit_price = Math.round(price * 100) / 100;
      }
      item.variant_summary = dimensions.map((dimension) => cleanText(obj(arr(dimension.values).map(obj).find((value) => cleanText(value.id) === cleanText(selected[dimension.id]))).label)).filter(Boolean).join(' · ');
      item.variables = { ...obj(item.variables), ...selected };
    }
    const valuePriceText = (value) => {
      const adjustment = obj(obj(value).adjustment);
      if (adjustment.operation === 'multiply') return `× ${formatNumber(adjustment.value)}`;
      const amount = adjustment.operation === 'add' ? Number(adjustment.value) || 0 : 0;
      return `${amount < 0 ? '−' : '+'}$${formatNumber(Math.abs(amount))}`;
    };
    function variantChipHtml(item){
      const dimensions = dimensionsOf(item);
      if (!dimensions.length) return '';
      const color = dimensions.find((dimension) => dimension.kind === 'color');
      const swatch = color ? cleanText(obj(arr(color.values).map(obj).find((value) => cleanText(value.id) === selectedOf(item, color))).hex) : '';
      const summary = firstText(item.variant_summary, dimensions.map((dimension) => dimension.label).join(' · '));
      return `<button type="button" class="fmdw-lir-variant-chip ${openVariants.has(item.id) ? 'open' : ''}" data-fmdw-lir-variants title="Colors and options for this line">${swatch ? `<i class="fmdw-var-sw" style="background:${esc(swatch)}"></i>` : ''}<span>${esc(summary)}</span><i class="fas fa-chevron-down"></i></button>`;
    }
    /** Black or white, whichever reads on this color. */
    function inkOn(hex){
      const match = /^#?([0-9a-f]{6})$/i.exec(cleanText(hex));
      if (!match) return '#101828';
      const value = parseInt(match[1], 16);
      const luminance = (0.299 * (value >> 16) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)) / 255;
      return luminance > 0.62 ? '#101828' : '#ffffff';
    }
    /** Every tile is a toggle for "offered"; the star marks the default, and there may be none. */
    function variantPanelHtml(item){
      const dimensions = dimensionsOf(item);
      if (!dimensions.length) return '';
      return `
        <div class="fmdw-lir-variants-wrap ${openVariants.has(item.id) ? 'open' : ''}" data-fmdw-var-wrap><div class="fmdw-lir-variants-clip"><div class="fmdw-lir-variants">
          ${dimensions.map((dimension) => {
            const omitted = omittedOf(item, dimension);
            const offered = offeredOf(item, dimension);
            const excluded = excludedOf(item, dimension);
            const values = arr(dimension.values).map(obj);
            const chosen = values.find((value) => cleanText(value.id) === selectedOf(item, dimension));
            const name = cleanText(dimension.label).toLowerCase();
            const status = omitted ? `not on this proposal` : `${offered.length} of ${values.length} \u00b7 ${chosen ? `default ${esc(chosen.label)}` : 'no default'}`;
            return `
              <div class="fmdw-var-dim ${omitted ? 'omitted' : ''}" data-fmdw-var-dim="${esc(dimension.id)}">
                <div class="fmdw-var-head">
                  ${ctx.readonly
                    ? `<strong>${esc(dimension.label)}</strong>`
                    : `<label class="fmdw-var-include" title="${omitted ? `Add ${esc(name)} to this proposal` : `On this proposal \u2014 untick to leave ${esc(name)} off entirely`}"><input type="checkbox" data-fmdw-var-include ${omitted ? '' : 'checked'}><i class="fas fa-check"></i><strong>${esc(dimension.label)}</strong></label>`}
                  <small>${status}</small>
                  ${ctx.readonly || omitted ? '' : `<button type="button" class="fmdw-var-all" data-fmdw-var-all title="${offered.length === values.length ? 'Stop offering every one' : 'Offer every one'}">${offered.length === values.length ? 'None' : 'All'}</button>`}
                </div>
                <div class="fmdw-var-tiles">
                  ${values.map((value) => {
                    const id = cleanText(value.id);
                    const isExcluded = excluded.has(id);
                    const isOffered = offered.includes(id) && !isExcluded;
                    const isDefault = !omitted && selectedOf(item, dimension) === id;
                    const face = dimension.kind === 'color' ? firstText(value.hex, '#d0d5dd') : '#eef1f6';
                    const tip = isExcluded ? `${value.label} is not available with the options selected` : (isOffered ? `${value.label} is offered \u2014 click to stop offering it` : `${value.label} is not offered \u2014 click to offer it`);
                    return `
                      <div class="fmdw-var-tile ${isDefault ? 'default' : ''} ${isOffered ? '' : 'off'} ${isExcluded ? 'excluded' : ''}" data-fmdw-var-value="${esc(id)}">
                        <button type="button" class="fmdw-var-face" data-fmdw-var-toggle style="background:${esc(face)};color:${inkOn(face)}" title="${esc(tip)}" aria-pressed="${isOffered}" ${isExcluded || omitted || ctx.readonly ? 'disabled' : ''}><b>${esc(valuePriceText(value))}</b></button>
                        ${ctx.readonly || isExcluded || omitted ? '' : `<button type="button" class="fmdw-var-star" data-fmdw-var-default title="${isDefault ? 'This is the default \u2014 click for no default' : 'Make this the default'}" aria-pressed="${isDefault}"><i class="fas fa-star"></i></button>`}
                        <span>${esc(value.label)}</span>
                      </div>`;
                  }).join('')}
                </div>
              </div>`;
          }).join('')}
        </div></div></div>`;
    }

    // ------------------------------------------------------- add an option
    /** Search the price book items that fit a choice group and add one. */
    async function openAddOption(anchor, groupId){
      document.querySelectorAll('.fmdw-mod-pop').forEach((existing) => existing.remove());
      const host = (() => {
        let match = null;
        walkItems(items, (item) => { if (!match && arr(item.children).some((child) => choiceGroupOf(child) === groupId)) match = item; });
        return match;
      })();
      if (!host) return;
      const rootOf = items.find((rootItem) => rootItem === host || findItem(rootItem.children, host.id)) || host;
      const pop = document.createElement('div');
      pop.className = 'fmdw-attach-pop fmdw-mod-pop';
      const title = groupTitle(groupId, arr(host.children).filter((child) => choiceGroupOf(child) === groupId));
      let candidates = null;
      let failed = false;
      const present = () => new Set(arr(host.children).filter((child) => choiceGroupOf(child) === groupId).map((child) => firstText(obj(child.pricebook_ref).item_id, obj(child.pricebook_ref).catalog_item_id)));
      const close = () => { document.removeEventListener('mousedown', onDown, true); pop.remove(); };
      const onDown = (event) => { if (!pop.contains(event.target) && !anchor.contains(event.target)) close(); };
      const draw = (query = '') => {
        const needle = cleanText(query).toLowerCase();
        const have = present();
        const rows = arr(candidates).filter((line) => !have.has(firstText(obj(line.pricebook_ref).item_id))).filter((line) => !needle || `${line.name} ${line.description}`.toLowerCase().includes(needle));
        pop.querySelector('[data-fmdw-opt-list]').innerHTML = candidates === null
          ? `<p class="fmdw-hint" style="margin:0"><i class="fas fa-circle-notch fa-spin"></i> Loading ${esc(title.toLowerCase())} options…</p>`
          : (failed ? `<p class="fmdw-hint" style="margin:0">The price book could not be searched. Use Pricebook to add a line instead.</p>`
          : (rows.length ? rows.map((line) => `
              <button type="button" class="fmdw-opt-row" data-fmdw-opt-add="${esc(firstText(obj(line.pricebook_ref).item_id))}">
                <span><strong>${esc(firstText(line.display_name, line.name))}</strong>${line.description ? `<small>${esc(line.description)}</small>` : ''}</span>
                <b>${esc(moneyFromDollars(Number(line.unit_price) || 0))}<i>/${esc(line.unit || 'ea')}</i></b>
              </button>`).join('') : `<p class="fmdw-hint" style="margin:0">${needle ? 'Nothing matches that search.' : `Every ${esc(title.toLowerCase())} in your price book is already an option here.`}</p>`));
        pop.querySelectorAll('[data-fmdw-opt-add]').forEach((button) => button.addEventListener('click', () => {
          const line = arr(candidates).find((entry) => firstText(obj(entry.pricebook_ref).item_id) === button.dataset.fmdwOptAdd);
          if (!line) return;
          const added = normalizeScopeItem({ ...clone(line), selection: { ...obj(line.selection), group_id: groupId, selected: false, default_selected: false } });
          const lastIndex = host.children.reduce((last, child, index) => (choiceGroupOf(child) === groupId ? index : last), host.children.length - 1);
          host.children.splice(lastIndex + 1, 0, added);
          commit();
          ctx.requestPreview();
          close();
          render();
        }));
      };
      pop.innerHTML = `
        <div class="fmdw-attach-head"><span><i class="fas fa-plus"></i> Add ${esc(title.toLowerCase())} option</span><button type="button" class="fmdw-attach-x" data-fmdw-opt-close title="Close"><i class="fas fa-xmark"></i></button></div>
        <input type="text" data-fmdw-opt-search placeholder="Search ${esc(title.toLowerCase())} in your price book">
        <div class="fmdw-opt-list" data-fmdw-opt-list></div>`;
      pop.querySelector('[data-fmdw-opt-close]').addEventListener('click', close);
      pop.querySelector('[data-fmdw-opt-search]').addEventListener('input', (event) => draw(event.target.value));
      document.body.appendChild(pop);
      draw();
      placePopover(pop, anchor, 400);
      setTimeout(() => { document.addEventListener('mousedown', onDown, true); pop.querySelector('[data-fmdw-opt-search]')?.focus(); }, 0);
      try {
        candidates = arr(await services.scopeCandidates(cleanText(rootOf.scope_template_id), groupId, clone(measurements()))).map(obj);
      } catch (e) { candidates = []; failed = true; }
      if (!pop.isConnected) return;
      draw(pop.querySelector('[data-fmdw-opt-search]')?.value || '');
      placePopover(pop, anchor, 400);
    }

    // ------------------------------------------------------------ generate
    async function generate(){
      if (generating || ctx.readonly) return;
      if (typeof services.generateScopeItems !== 'function') {
        generateNote = 'Automatic generation is not available in this session — add lines by hand or from the price book.';
        render();
        return;
      }
      if (!selection().length) {
        generateNote = 'This document has no scope to generate from — add lines by hand or from the price book.';
        render();
        return;
      }
      generating = true;
      generateNote = '';
      render();
      try {
        const used = clone(measurements());
        const roots = arr(await services.generateScopeItems(clone(selection()), clone(used))).map(normalizeScopeItem);
        if (roots.length) {
          items = roots;
          walkItems(items, applyVariants);
          commit();
          ctx.writePath('params.scope_generated_from', stampOf(used));
          ctx.requestPreview();
        } else {
          generateNote = 'Generation produced no lines — add them by hand or from the price book.';
        }
      } catch (e) {
        generateNote = 'Could not generate lines — add them by hand or from the price book.';
      }
      generating = false;
      if (el.isConnected) render();
    }

    function attachThumbHtml(item){
      const entry = obj(arr(item.media)[0]);
      const hasVideo = !!firstText(obj(item.video).url);
      let url = firstText(entry.url);
      const mediaId = firstText(entry.media_id);
      if (!url && mediaId && typeof obj(ctx.services).media?.url === 'function') {
        try { url = cleanText(obj(ctx.services).media.url(mediaId)); } catch (e) { url = ''; }
      }
      if (url) return `<span class="fmdw-li-thumb" title="${esc(entry.caption || 'Attached photo')}"><img src="${esc(url)}" alt=""></span>`;
      if (mediaId || hasVideo) return `<span class="fmdw-li-thumb video" title="${esc(hasVideo ? 'Attached video' : 'Attached photo')}"><i class="fas ${hasVideo ? 'fa-circle-play' : 'fa-image'}"></i></span>`;
      return '';
    }
    const hasAttachment = (item) => arr(item.media).length > 0 || !!firstText(obj(item.video).url);

    /** One editable line. `pick` adds the radio/checkbox that decides whether
     *  the line is priced. The description shows on hover or focus. */
    function rowHtml(item, pick){
      const on = scopeItemSelected(item);
      const control = pick === 'choice'
        ? `<input type="radio" name="fmdw-lir-${esc(choiceGroupOf(item))}" data-fmdw-lir-choose ${on ? 'checked' : ''} ${ctx.readonly ? 'disabled' : ''} title="Price and print this option">`
        : (pick === 'optional' ? `<input type="checkbox" data-fmdw-lir-toggle ${on ? 'checked' : ''} ${ctx.readonly ? 'disabled' : ''} title="Include this line">` : '');
      return `
        <div class="fmdw-lir-row ${on ? '' : 'off'} ${control ? 'pick' : ''}" data-fmdw-lir="${esc(item.id)}">
          ${control ? `<span class="fmdw-lir-pick">${control}</span>` : ''}
          <div class="fmdw-lir-name">
            <span class="fmdw-lir-name-line">${foldHtml(item)}${attachThumbHtml(item)}${nameHtml(item, 'Line item')}${foldCountHtml(item)}${modifierBadges(item)}${pick === 'optional' ? `<span class="fmdw-li-flag optional">Optional</span>` : ''}${variantChipHtml(item)}</span>
            ${descHtml(item)}
          </div>
          <div class="fmdw-lir-nums">
            ${isPackage(item) ? '' : `<label class="fmdw-lir-num" title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9c689ddee2f502","Quantity") ?? "Quantity")}"><input type="number" step="any" min="0" data-fmdw-lir-qty value="${esc(formatNumber(item.quantity))}" ${ctx.readonly ? 'disabled' : ''}><i>${esc(item.unit || 'ea')}</i></label>
            <span class="fmdw-lir-x">×</span>
            <label class="fmdw-lir-num price" title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c68827ddeaf565","Unit price ($)") ?? "Unit price ($)")}"><i>$</i><input type="number" step="0.01" min="0" data-fmdw-lir-price value="${esc(Number(item.unit_price || 0).toFixed(2))}" ${ctx.readonly ? 'disabled' : ''}></label>`}
            <b class="fmdw-lir-amount" data-fmdw-lir-amount="${esc(item.id)}" ${on ? '' : `title="Not selected — this is what ${isPackage(item) ? 'this option costs' : 'it would add'}"`}>${esc(moneyFromDollars(rowAmount(item)))}</b>
          </div>
          ${ctx.readonly ? '' : `<div class="fmdw-lir-actions">
            <button type="button" class="fmdw-icon-btn ${hasAttachment(item) ? 'has-media' : ''}" data-fmdw-lir-attach title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_74c8aa88118d1c","Attach photo or video") ?? "Attach photo or video")}"><i class="fas fa-camera"></i></button>
            <button type="button" class="fmdw-icon-btn danger" data-fmdw-lir-remove title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>
          </div>`}
          ${variantPanelHtml(item)}
        </div>`;
    }

    /** Children in order, with each choice group rendered once, together. */
    function childrenHtml(children){
      const out = [];
      const done = new Set();
      arr(children).forEach((child) => {
        const groupId = choiceGroupOf(child);
        if (groupId) {
          if (done.has(groupId)) return;
          done.add(groupId);
          const options = arr(children).filter((other) => choiceGroupOf(other) === groupId);
          const customer = options.some(customerPicks);
          const comparing = isCompared(groupId);
          out.push(`
            <div class="fmdw-lir-choice ${comparing ? 'comparing' : ''}">
              <div class="fmdw-lir-choice-head">
                <strong>${esc(groupTitle(groupId, options))}</strong>
                <span class="fmdw-li-flag choice" title="${customer ? 'The selected option is your recommendation: the proposal prices it, and the customer can switch before approving.' : 'The selected option is the one this proposal prices and prints.'}">${customer ? 'Customer can choose' : 'Choose one'}</span>
                ${ctx.readonly || typeof services.scopeCandidates !== 'function' || options.some(isPackage) ? '' : `<button type="button" class="fmdw-lir-add-option" data-fmdw-lir-add-option="${esc(groupId)}" title="Add another option from your price book"><i class="fas fa-plus"></i> Add option</button>`}
                <span class="fmdw-lir-view" role="group" aria-label="How to show these options">
                  <button type="button" class="${comparing ? '' : 'on'}" data-fmdw-lir-view="list" data-fmdw-lir-view-group="${esc(groupId)}" title="One under another"><i class="fas fa-list"></i> List</button>
                  <button type="button" class="${comparing ? 'on' : ''}" data-fmdw-lir-view="compare" data-fmdw-lir-view-group="${esc(groupId)}" title="Side by side"><i class="fas fa-table-columns"></i> Compare</button>
                </span>
              </div>
              ${comparing ? compareHtml(options) : `<div class="fmdw-lir-children">
                ${options.map((option) => rowHtml(option, 'choice') + nestedHtml(option)).join('')}
              </div>`}
            </div>`);
          return;
        }
        out.push(rowHtml(child, isOptional(child) ? 'optional' : '') + nestedHtml(child));
      });
      return out.join('');
    }
    const nestedHtml = (item) => (arr(item.children).length ? `<div class="fmdw-lir-fold-body ${folded.has(item.id) ? 'folded' : ''}" data-fmdw-fold-body="${esc(item.id)}"><div class="fmdw-lir-children">${childrenHtml(item.children)}</div></div>` : '');
    /**
     * The options of a choice group as columns: the same lines row for row
     * where the options share them, so prices can be read across. Choosing
     * works here; editing a line is done in List.
     */
    function compareHtml(options){
      const group = cleanText(choiceGroupOf(options[0]));
      const column = (option) => {
        const on = scopeItemSelected(option);
        const lines = [];
        walkItems(option.children, (line) => { if (!arr(line.children).length) lines.push(line); });
        return `
          <div class="fmdw-lir-col ${on ? 'on' : ''}" data-fmdw-lir="${esc(option.id)}">
            <label class="fmdw-lir-col-head">
              <input type="radio" name="fmdw-lir-${esc(group)}" data-fmdw-lir-choose ${on ? 'checked' : ''} ${ctx.readonly ? 'disabled' : ''} title="Price and print this option">
              <span class="fmdw-lir-name">${nameHtml(option, 'Option')}${descHtml(option)}</span>
            </label>
            <b class="fmdw-lir-col-total" data-fmdw-lir-amount="${esc(option.id)}">${esc(moneyFromDollars(rowAmount(option)))}</b>
            ${lines.length ? `<ul class="fmdw-lir-col-lines">${lines.map((line) => `<li class="${scopeItemSelected(line) || !cleanText(obj(line.selection).mode) || cleanText(obj(line.selection).mode) === 'fixed' ? '' : 'off'}"><span>${esc(firstText(line.display_name, line.name))}</span><b>${esc(moneyFromDollars(lineAmount(line)))}</b></li>`).join('')}</ul>` : (cleanText(option.description) ? '' : '<p class="fmdw-lir-col-empty">No lines under this option.</p>')}
          </div>`;
      };
      return `<div class="fmdw-lir-compare" style="--fmdw-cols:${options.length}">${options.map(column).join('')}</div>`;
    }

    function rootHtml(item){
      if (!arr(item.children).length) return rowHtml(item, isOptional(item) ? 'optional' : '');
      return `
        <section class="fmdw-lir-group" data-fmdw-lir-group="${esc(item.id)}">
          <header class="fmdw-lir-row fmdw-lir-group-head">
            <div class="fmdw-lir-name" data-fmdw-rename-item="${esc(item.id)}"><span class="fmdw-lir-name-line">${foldHtml(item)}${nameHtml(item, 'Scope')}${foldCountHtml(item)}</span>${descHtml(item)}</div>
            <b class="fmdw-lir-amount" data-fmdw-lir-subtotal="${esc(item.id)}">${esc(moneyFromDollars(scopeItemAmount(item)))}</b>
            ${ctx.readonly ? '' : `<div class="fmdw-lir-actions"><button type="button" class="fmdw-icon-btn danger" data-fmdw-lir-remove-group="${esc(item.id)}" title="Remove this whole group"><i class="fas fa-xmark"></i></button></div>`}
          </header>
          <div class="fmdw-lir-fold-body ${folded.has(item.id) ? 'folded' : ''}" data-fmdw-fold-body="${esc(item.id)}"><div class="fmdw-lir-children">
            ${Number(item.unit_price || 0) > 0 ? rowHtml({ ...item, display_name: 'Base price', description: '', children: [] }, '') : ''}
            ${childrenHtml(item.children)}
          </div></div>
        </section>`;
    }

    /** Numeric edits update amounts in place so focus and scroll survive. */
    function refreshAmounts(){
      el.querySelectorAll('[data-fmdw-lir-amount]').forEach((node) => {
        const found = findItem(items, node.dataset.fmdwLirAmount);
        if (found) node.textContent = moneyFromDollars(rowAmount(found.item));
      });
      el.querySelectorAll('[data-fmdw-lir-subtotal]').forEach((node) => {
        const found = findItem(items, node.dataset.fmdwLirSubtotal);
        if (found) node.textContent = moneyFromDollars(scopeItemAmount(found.item));
      });
      const total = el.querySelector('[data-fmdw-lir-total]');
      if (total) total.textContent = moneyFromDollars(scopeItemsTotal(items));
    }

    // The step's own header carries the actions when this list is the step.
    const actionsHost = ctx.stepActions || null;
    const titled = !actionsHost || cleanText(itemLabel(ctx.item)).toLowerCase() !== cleanText(obj(ctx.step).title).toLowerCase();

    const render = () => {
      const count = countScopeItems(items);
      const toolbar = ctx.readonly ? '' : `
        ${modifiers().length ? `<button type="button" class="fmdw-btn" data-fmdw-lir-modifiers title="Rules that adjust quantities, such as waste"><i class="fas fa-sliders"></i> Modifiers</button>` : ''}
        ${generates ? `<button type="button" class="fmdw-btn ${count ? '' : 'primary'}" data-fmdw-lir-generate ${generating ? 'disabled' : ''} title="Rebuild every line from the roof measurements and price book">
          <i class="fas ${generating ? 'fa-circle-notch fa-spin' : 'fa-rotate'}"></i> ${generating ? 'Generating…' : (count ? 'Regenerate' : 'Generate lines')}
        </button>` : ''}
        ${services.pricebook && typeof services.pricebook.pick === 'function' ? `<button type="button" class="fmdw-btn" data-fmdw-lir-pricebook><i class="fas fa-book-open"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c38fcf1b64a2ea"," Pricebook") ?? " Pricebook")}</button>` : ''}
        <button type="button" class="fmdw-btn" data-fmdw-lir-add><i class="fas fa-plus"></i> Add line</button>`;
      if (actionsHost) actionsHost.innerHTML = toolbar;
      el.innerHTML = `
        <div class="fmdw-field fmdw-lir-field">
          ${titled ? `<span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>` : ''}
          ${titled && ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-lir">
            ${actionsHost || !toolbar ? '' : `<div class="fmdw-lir-bar">${toolbar}</div>`}
            ${stale() ? `<p class="fmdw-lir-stale"><i class="fas fa-triangle-exclamation"></i> The roof measurements changed after these lines were generated. Regenerate to recalculate the quantities; edits made here will be replaced.</p>` : ''}
            ${generateNote ? `<p class="fmdw-hint"><i class="fas fa-circle-info"></i> ${esc(generateNote)}</p>` : ''}
            <div class="fmdw-lir-list">
              ${count ? items.map(rootHtml).join('') : (generating ? `<p class="fmdw-hint"><i class="fas fa-circle-notch fa-spin"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2b766d3ceb94da"," Generating line items…") ?? " Generating line items…")}</p>` : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_0b854052709977","No line items yet.") ?? "No line items yet.")}</p>`)}
            </div>
            ${count ? `<div class="fmdw-lir-total"><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9403c7637d4905","Total") ?? "Total")}</span><b data-fmdw-lir-total>${esc(moneyFromDollars(scopeItemsTotal(items)))}</b></div>` : ''}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      // Fold and unfold in place: a class on what is already there.
      el.querySelectorAll('[data-fmdw-lir-fold]').forEach((button) => button.addEventListener('click', (event) => {
        event.stopPropagation();
        const id = button.dataset.fmdwLirFold;
        const fold = !folded.has(id);
        if (fold) folded.add(id); else folded.delete(id);
        button.classList.toggle('folded', fold);
        button.setAttribute('aria-expanded', String(!fold));
        el.querySelectorAll('[data-fmdw-fold-body]').forEach((body) => { if (body.dataset.fmdwFoldBody === id) body.classList.toggle('folded', fold); });
        el.querySelectorAll('[data-fmdw-fold-count]').forEach((count) => { if (count.dataset.fmdwFoldCount === id) count.hidden = !fold; });
      }));
      // A compare column is chosen by a click anywhere on it, not only on its heading.
      el.querySelectorAll('.fmdw-lir-col').forEach((column) => column.addEventListener('click', (event) => {
        const radio = column.querySelector('[data-fmdw-lir-choose]');
        if (!radio || radio.disabled || radio.checked || event.target.closest('label, button, input, textarea, .fmdw-lir-edit')) return;
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }));
      el.querySelectorAll('[data-fmdw-lir-view]').forEach((button) => button.addEventListener('click', () => {
        compared.set(button.dataset.fmdwLirViewGroup, button.dataset.fmdwLirView === 'compare');
        render();
      }));
      // Rename for this estimate: double-click the name or the description.
      if (!ctx.readonly) el.querySelectorAll('[data-fmdw-rename]').forEach((target) => target.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const holder = target.closest('[data-fmdw-lir],[data-fmdw-rename-item]');
        const id = holder ? (holder.dataset.fmdwLir || holder.dataset.fmdwRenameItem) : '';
        const found = findItem(items, id);
        const name = target.closest('.fmdw-lir-name');
        if (!found || !name || name.querySelector('.fmdw-lir-edit')) return;
        const editor = document.createElement('div');
        editor.className = 'fmdw-lir-edit';
        editor.innerHTML = `
          <input type="text" data-fmdw-edit-name value="${esc(firstText(found.item.display_name, found.item.name))}" placeholder="${esc(firstText(found.item.name, 'Name'))}" maxlength="160" aria-label="Name on this estimate">
          <textarea data-fmdw-edit-description rows="2" maxlength="600" placeholder="Description (optional)" aria-label="Description on this estimate">${esc(found.item.description || '')}</textarea>
          <span class="fmdw-lir-edit-actions"><small>Only this estimate changes.</small><button type="button" class="fmdw-icon-btn" data-fmdw-edit-cancel title="Cancel (Esc)"><i class="fas fa-xmark"></i></button><button type="button" class="fmdw-icon-btn done" data-fmdw-edit-done title="Done (Enter)"><i class="fas fa-check"></i></button></span>`;
        name.classList.add('editing');
        name.appendChild(editor);
        // Next frame, so the opening height animates from nothing.
        requestAnimationFrame(() => editor.classList.add('open'));
        const first = editor.querySelector(target.dataset.fmdwRename === 'description' ? '[data-fmdw-edit-description]' : '[data-fmdw-edit-name]');
        first.focus();
        first.select();
        const finish = (save) => {
          if (save) {
            const title = cleanText(editor.querySelector('[data-fmdw-edit-name]').value);
            const description = cleanText(editor.querySelector('[data-fmdw-edit-description]').value);
            // The price book name stays as `name`; this estimate shows display_name.
            if (title && title !== cleanText(found.item.name)) found.item.display_name = title; else delete found.item.display_name;
            found.item.description = description;
            commit();
            ctx.requestPreview();
          }
          render();
        };
        editor.querySelector('[data-fmdw-edit-done]').addEventListener('click', () => finish(true));
        editor.querySelector('[data-fmdw-edit-cancel]').addEventListener('click', () => finish(false));
        editor.addEventListener('keydown', (key) => {
          if (key.key === 'Escape') { key.preventDefault(); finish(false); }
          else if (key.key === 'Enter' && (key.target.matches('[data-fmdw-edit-name]') || key.ctrlKey || key.metaKey)) { key.preventDefault(); finish(true); }
        });
        editor.addEventListener('click', (click) => click.stopPropagation());
      }));
      el.querySelectorAll('[data-fmdw-lir]').forEach((row) => {
        const id = row.dataset.fmdwLir;
        const edit = (apply) => {
          const found = findItem(items, id);
          if (!found) return;
          apply(found);
          commit();
          ctx.requestPreview();
        };
        row.querySelector('[data-fmdw-lir-qty]')?.addEventListener('change', (event) => {
          // A typed quantity stands on its own; modifiers no longer move it.
          edit((found) => { found.item.quantity = String(Math.max(0, Number(event.target.value || 0))); found.item.manual_quantity = true; });
          row.querySelectorAll('.fmdw-lir-mod').forEach((badge) => badge.classList.add('off'));
          refreshAmounts();
        });
        row.querySelector('[data-fmdw-lir-price]')?.addEventListener('change', (event) => {
          edit((found) => { found.item.unit_price = Math.max(0, Number(event.target.value || 0)); });
          refreshAmounts();
        });
        row.querySelector('[data-fmdw-lir-choose]')?.addEventListener('change', () => {
          edit((found) => {
            const groupId = choiceGroupOf(found.item);
            arr(found.list).filter((other) => choiceGroupOf(other) === groupId).forEach((other) => {
              other.selection = { ...obj(other.selection), selected: other === found.item };
            });
          });
          render();
        });
        row.querySelector('[data-fmdw-lir-toggle]')?.addEventListener('change', (event) => {
          edit((found) => { found.item.selection = { ...obj(found.item.selection), selected: event.target.checked }; });
          render();
        });
        row.querySelector('[data-fmdw-lir-remove]')?.addEventListener('click', () => {
          edit((found) => { found.list.splice(found.list.indexOf(found.item), 1); });
          render();
        });
        // Opening a line's colors grows the line (the lines below move down);
        // a click inside patches this row only, so nothing else re-renders.
        const setVariantsOpen = (open) => {
          if (open) openVariants.add(id); else openVariants.delete(id);
          row.querySelector('[data-fmdw-lir-variants]')?.classList.toggle('open', open);
          row.querySelector('[data-fmdw-var-wrap]')?.classList.toggle('open', open);
        };
        const bindVariants = () => {
          row.querySelector('[data-fmdw-lir-variants]')?.addEventListener('click', () => setVariantsOpen(!openVariants.has(id)));
          row.querySelectorAll('[data-fmdw-var-dim]').forEach((dimEl) => {
            const dimId = dimEl.dataset.fmdwVarDim;
            const change = (apply) => {
              edit((found) => {
                const dimension = dimensionsOf(found.item).find((entry) => entry.id === dimId);
                if (!dimension) return;
                apply(found.item, dimension);
                applyVariants(found.item);
              });
              const found = findItem(items, id);
              if (!found) return;
              const swap = (selector, html) => {
                const node = row.querySelector(selector);
                if (!node) return;
                const holder = document.createElement('div');
                holder.innerHTML = html.trim();
                if (holder.firstElementChild) node.replaceWith(holder.firstElementChild);
              };
              swap('[data-fmdw-var-wrap]', variantPanelHtml(found.item));
              swap('[data-fmdw-lir-variants]', variantChipHtml(found.item));
              const price = row.querySelector('[data-fmdw-lir-price]');
              if (price) price.value = Number(found.item.unit_price || 0).toFixed(2);
              bindVariants();
              refreshAmounts();
            };
            const valueOf = (button) => button.closest('[data-fmdw-var-value]').dataset.fmdwVarValue;
            dimEl.querySelectorAll('[data-fmdw-var-toggle]').forEach((button) => button.addEventListener('click', () => {
              const valueId = valueOf(button);
              change((item, dimension) => {
                const offered = offeredOf(item, dimension);
                const on = !offered.includes(valueId);
                item.variant_offered = { ...obj(item.variant_offered), [dimension.id]: on ? [...offered, valueId] : offered.filter((entry) => entry !== valueId) };
                // A default that is no longer offered is no default.
                if (!on && selectedOf(item, dimension) === valueId) item.selected_variants = { ...obj(item.selected_variants), [dimension.id]: '' };
              });
            }));
            dimEl.querySelectorAll('[data-fmdw-var-default]').forEach((button) => button.addEventListener('click', () => {
              const valueId = valueOf(button);
              change((item, dimension) => {
                const isDefault = selectedOf(item, dimension) === valueId;
                item.selected_variants = { ...obj(item.selected_variants), [dimension.id]: isDefault ? '' : valueId };
                // The default is one you offer.
                if (!isDefault) item.variant_offered = { ...obj(item.variant_offered), [dimension.id]: [...new Set([...offeredOf(item, dimension), valueId])] };
              });
            }));
            dimEl.querySelector('[data-fmdw-var-include]')?.addEventListener('change', (event) => change((item, dimension) => {
              const omitted = { ...obj(item.variant_omitted) };
              if (event.target.checked) delete omitted[dimension.id]; else omitted[dimension.id] = true;
              item.variant_omitted = omitted;
            }));
            dimEl.querySelector('[data-fmdw-var-all]')?.addEventListener('click', () => change((item, dimension) => {
              const all = arr(dimension.values).map((value) => cleanText(obj(value).id));
              const none = offeredOf(item, dimension).length === all.length;
              item.variant_offered = { ...obj(item.variant_offered), [dimension.id]: none ? [] : all };
              if (none) item.selected_variants = { ...obj(item.selected_variants), [dimension.id]: '' };
            }));
          });
        };
        bindVariants();
        row.querySelector('[data-fmdw-lir-attach]')?.addEventListener('click', (event) => {
          const found = findItem(items, id);
          if (!found) return;
          openMediaAttach({
            anchor: event.currentTarget,
            item: found.item,
            services,
            onSave: (patch) => {
              found.item.media = arr(obj(patch).media);
              found.item.video = obj(patch).video && firstText(obj(obj(patch).video).url) ? obj(patch).video : null;
              found.item.display = cleanText(obj(patch).display) === 'popup' ? 'popup' : 'inline';
              commit();
              render();
              ctx.requestPreview();
            }
          });
        });
      });
      el.querySelectorAll('[data-fmdw-lir-add-option]').forEach((button) => button.addEventListener('click', () => openAddOption(button, button.dataset.fmdwLirAddOption)));
      el.querySelectorAll('[data-fmdw-lir-remove-group]').forEach((button) => button.addEventListener('click', () => {
        const found = findItem(items, button.dataset.fmdwLirRemoveGroup);
        if (!found || !root.confirm(`Remove "${firstText(found.item.display_name, found.item.name)}" and every line under it?`)) return;
        found.list.splice(found.list.indexOf(found.item), 1);
        commit();
        render();
        ctx.requestPreview();
      }));
      const bar = actionsHost || el;
      bar.querySelector('[data-fmdw-lir-modifiers]')?.addEventListener('click', (event) => openModifiers(event.currentTarget));
      bar.querySelector('[data-fmdw-lir-generate]')?.addEventListener('click', () => {
        if (countScopeItems(items) && !root.confirm('Regenerate every line from the roof measurements and price book? Edits made here will be replaced.')) return;
        generate();
      });
      bar.querySelector('[data-fmdw-lir-add]')?.addEventListener('click', () => {
        items.push(makeScopeItem({ name: 'New line item', display_name: 'New line item' }));
        commit();
        render();
        ctx.requestPreview();
      });
      bar.querySelector('[data-fmdw-lir-pricebook]')?.addEventListener('click', async () => {
        try {
          const picked = await services.pricebook.pick();
          if (arr(picked).length) { items = [...items, ...arr(picked).map(normalizeScopeItem)]; commit(); render(); ctx.requestPreview(); }
        } catch (e) { /* cancelled */ }
      });
    };

    render();
    // Auto-generate on entry when nothing has been generated yet.
    if (generates && !countScopeItems(items)) generate();
    return {
      validate: () => (ctx.item.required && !countScopeItems(arr(ctx.value())) ? (generates ? 'Generate or add at least one line item.' : 'Add at least one line item.') : null),
      destroy: () => {
        if (actionsHost) actionsHost.innerHTML = '';
        document.querySelectorAll('.fmdw-mod-pop').forEach((existing) => existing.remove());
      }
    };
  });

  // -------------------------------------------------------- payment schedule
  // Payment terms as milestones: each is a percent of the document total or a
  // fixed amount, with when it falls due. Writes the payment_schedule param
  // the document's schedule and pay widgets, and the receivables minted at
  // signing, all read. The milestone due on signature is the deposit.
  const SCHEDULE_DUE_OPTIONS = [
    { value: 'on_receipt', label: 'On receipt' },
    { value: 'on_signature', label: 'On signature' },
    { value: 'project_completion', label: 'On completion' },
    { value: 'on_invoice', label: 'When invoiced' },
    { value: 'on_date', label: 'Specific date' }
  ];
  // Starting points for a payment schedule. A workflow can supply its own as
  // item.presets: [{ label, title?, parts: [{ label, percent, due_rule }] }].
  const SCHEDULE_PRESETS = [
    { label: '30 / 70', title: '30% deposit on signature, 70% on completion', parts: [{ label: 'Deposit', percent: 30, due_rule: 'on_signature' }, { label: 'Final payment', percent: 70, due_rule: 'project_completion' }] },
    { label: '50 / 50', title: '50% deposit on signature, 50% on completion', parts: [{ label: 'Deposit', percent: 50, due_rule: 'on_signature' }, { label: 'Final payment', percent: 50, due_rule: 'project_completion' }] },
    { label: '40 / 30 / 30', title: '40% deposit on signature, 30% when invoiced mid-job, 30% on completion', parts: [{ label: 'Deposit', percent: 40, due_rule: 'on_signature' }, { label: 'Progress payment', percent: 30, due_rule: 'on_invoice' }, { label: 'Final payment', percent: 30, due_rule: 'project_completion' }] },
    { label: 'On completion', title: 'Paid in full on completion', parts: [{ label: 'Payment in full', percent: 100, due_rule: 'project_completion' }] }
  ];
  /** Paid when the customer approves: due on signature, or on receipt. */
  const dueNow = (row) => ['on_signature', 'on_receipt'].includes(cleanText(obj(row).due_rule));
  function normalizeScheduleRow(row, index){
    const source = obj(row);
    const kind = cleanText(source.kind) === 'fixed' || Number(source.amount_cents) > 0 ? 'fixed' : 'percent';
    return {
      ...source,
      id: firstText(source.id, uid('sched')),
      label: firstText(source.label, source.title, index === 0 ? 'Deposit' : 'Payment'),
      kind,
      percent: Number(source.percent ?? (Number(source.percent_bps) ? Number(source.percent_bps) / 100 : 0)) || 0,
      amount_cents: Math.round(Number(source.amount_cents) || 0),
      due_rule: firstText(source.due_rule, source.due, 'on_signature'),
      due_date: cleanText(source.due_date).slice(0, 10)
    };
  }
  registerKind('payment_schedule', (el, ctx) => {
    let rows = arr(ctx.value()).map(normalizeScheduleRow);
    // Percent rows resolve against the scope total the workflow is pricing.
    const basisCents = () => Math.round(scopeItemsTotal(arr(getPath(ctx.scope(), cleanText(ctx.item.total_from) || 'params.scope_items'))) * 100);
    const rowCents = (row) => (row.kind === 'fixed' ? row.amount_cents : Math.round(basisCents() * row.percent / 100));
    const commit = () => {
      // payment_kind tells receivables which milestone is the deposit.
      const out = rows.map((row, index) => {
        const next = { ...row };
        if (!cleanText(next.payment_kind) || ['deposit', 'final', 'progress'].includes(cleanText(next.payment_kind))) {
          next.payment_kind = dueNow(next) ? 'deposit' : (index === rows.length - 1 ? 'final' : 'progress');
        }
        if (next.kind === 'percent') delete next.amount_cents; else delete next.percent;
        if (next.due_rule !== 'on_date') delete next.due_date;
        return next;
      });
      ctx.write(out.length ? out : null);
      // Later steps ask for a deposit only when one falls due at signing.
      ctx.writePath('params.deposit_at_signing', rows.some((row) => dueNow(row) && (row.kind === 'fixed' ? row.amount_cents > 0 : row.percent > 0)));
      ctx.requestPreview();
    };
    const presets = (arr(ctx.item.presets).length ? arr(ctx.item.presets) : SCHEDULE_PRESETS).map(obj).filter((entry) => cleanText(entry.label) && arr(entry.parts).length);
    const preset = (parts) => {
      rows = arr(parts).map(obj).map((part, index, all) => normalizeScheduleRow({ id: index === 0 && part.due_rule === 'on_signature' ? 'deposit' : (index === all.length - 1 ? 'final' : `milestone_${index}`), label: part.label, kind: 'percent', percent: Number(part.percent) || 0, due_rule: firstText(part.due_rule, 'project_completion') }, index));
      commit();
      render();
    };
    const gapCents = () => basisCents() - rows.reduce((sum, row) => sum + rowCents(row), 0);
    /** Put the difference on the largest milestone, so the schedule adds up to the total. */
    function balance(){
      const gap = gapCents();
      const basis = basisCents();
      if (!rows.length || !gap || basis <= 0) return;
      const largest = rows.reduce((best, row) => (rowCents(row) > rowCents(best) ? row : best), rows[0]);
      const cents = Math.max(0, rowCents(largest) + gap);
      if (largest.kind === 'fixed') largest.amount_cents = cents;
      else largest.percent = Math.round(cents / basis * 10000) / 100;
      commit();
      render();
    }
    function summaryHtml(){
      const basis = basisCents();
      const scheduled = rows.reduce((sum, row) => sum + rowCents(row), 0);
      const deposit = rows.filter(dueNow).reduce((sum, row) => sum + rowCents(row), 0);
      const gap = basis - scheduled;
      // Percent rows round to the cent one by one; a cent or two of drift is not a gap.
      const shown = Math.abs(gap) <= rows.length ? basis : scheduled;
      const parts = [`<span>Due at signing <b>${esc(moneyFromCents(deposit))}</b></span>`, `<span>Scheduled <b>${esc(moneyFromCents(shown))}</b> of ${esc(moneyFromCents(basis))}</span>`];
      const warning = !rows.length ? '' : (Math.abs(gap) > rows.length
        ? `<p class="fmdw-meas-note fmdw-sched-gap"><i class="fas fa-triangle-exclamation"></i> <span>${gap > 0 ? `${esc(moneyFromCents(gap))} of the total is not scheduled.` : `The schedule is ${esc(moneyFromCents(-gap))} over the total.`}</span>${ctx.readonly ? '' : `<button type="button" class="fmdw-btn" data-fmdw-sched-balance title="${gap > 0 ? 'Add the remainder to the largest milestone' : 'Take the overage out of the largest milestone'}"><i class="fas fa-scale-balanced"></i> Balance</button>`}</p>`
        : '');
      return `<div class="fmdw-sched-summary">${parts.join('')}</div>${warning}`;
    }
    const render = () => {
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card fmdw-sched">
            ${rows.length ? rows.map((row, index) => `
              <div class="fmdw-sched-row" data-fmdw-sched="${index}">
                ${ctx.readonly ? '<span></span>' : `<button type="button" class="fmdw-sched-grip" data-fmdw-sched-grip title="Drag to reorder (or Alt + arrow keys)" aria-label="Reorder ${esc(row.label)}"><i class="fas fa-grip-vertical"></i></button>`}
                <input type="text" class="fmdw-sched-label" data-fmdw-sched-label value="${esc(row.label)}" placeholder="Milestone" ${ctx.readonly ? 'disabled' : ''}>
                <span class="fmdw-sched-amount">
                  <select data-fmdw-sched-kind ${ctx.readonly ? 'disabled' : ''} title="Percent of the total, or a fixed amount">
                    <option value="percent" ${row.kind === 'percent' ? 'selected' : ''}>%</option>
                    <option value="fixed" ${row.kind === 'fixed' ? 'selected' : ''}>$</option>
                  </select>
                  <input type="number" min="0" step="${row.kind === 'percent' ? '0.5' : '0.01'}" ${row.kind === 'percent' ? 'max="100"' : ''} data-fmdw-sched-value value="${esc(row.kind === 'percent' ? row.percent : (row.amount_cents / 100).toFixed(2))}" ${ctx.readonly ? 'disabled' : ''}>
                </span>
                <select class="fmdw-sched-due" data-fmdw-sched-due ${ctx.readonly ? 'disabled' : ''}>
                  ${SCHEDULE_DUE_OPTIONS.map((option) => `<option value="${esc(option.value)}" ${row.due_rule === option.value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}
                </select>
                ${row.due_rule === 'on_date' ? `<input type="date" data-fmdw-sched-date value="${esc(row.due_date)}" ${ctx.readonly ? 'disabled' : ''}>` : ''}
                <b class="fmdw-sched-cents" data-fmdw-sched-cents>${esc(moneyFromCents(rowCents(row)))}</b>
                ${ctx.readonly ? '' : `<button type="button" class="fmdw-icon-btn danger" data-fmdw-sched-remove title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_f643f568915438","Remove") ?? "Remove")}"><i class="fas fa-xmark"></i></button>`}
              </div>`).join('') : `<p class="fmdw-hint" style="margin:0">No payment terms yet. Pick a starting point or add milestones.</p>`}
            <div data-fmdw-sched-summary>${rows.length ? summaryHtml() : ''}</div>
            ${ctx.readonly ? '' : `
              <div class="fmdw-row-actions">
                <button type="button" class="fmdw-btn" data-fmdw-sched-add><i class="fas fa-plus"></i> Add milestone</button>
                <span class="fmdw-sched-presets">${presets.map((entry, index) => `<button type="button" class="fmdw-sched-pill" data-fmdw-sched-preset="${index}" title="${esc(firstText(entry.title, entry.label))}">${esc(entry.label)}</button>`).join('')}</span>
              </div>`}
          </div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const refreshAmounts = () => {
        el.querySelectorAll('[data-fmdw-sched]').forEach((rowEl) => {
          const row = rows[Number(rowEl.dataset.fmdwSched)];
          const cents = rowEl.querySelector('[data-fmdw-sched-cents]');
          if (row && cents) cents.textContent = moneyFromCents(rowCents(row));
        });
        const summary = el.querySelector('[data-fmdw-sched-summary]');
        if (summary) summary.innerHTML = rows.length ? summaryHtml() : '';
      };
      el.querySelectorAll('[data-fmdw-sched]').forEach((rowEl) => {
        const index = Number(rowEl.dataset.fmdwSched);
        const row = rows[index];
        if (!row) return;
        rowEl.querySelector('[data-fmdw-sched-label]')?.addEventListener('change', (event) => { row.label = cleanText(event.target.value) || row.label; commit(); });
        rowEl.querySelector('[data-fmdw-sched-kind]')?.addEventListener('change', (event) => {
          // Keep the same money when switching between percent and dollars.
          const cents = rowCents(row);
          row.kind = event.target.value === 'fixed' ? 'fixed' : 'percent';
          if (row.kind === 'fixed') row.amount_cents = cents;
          else row.percent = basisCents() > 0 ? Math.round(cents / basisCents() * 1000) / 10 : 0;
          commit();
          render();
        });
        rowEl.querySelector('[data-fmdw-sched-value]')?.addEventListener('change', (event) => {
          if (row.kind === 'percent') row.percent = Math.min(100, Math.max(0, Number(event.target.value) || 0));
          else row.amount_cents = Math.max(0, Math.round(Number(event.target.value || 0) * 100));
          commit();
          refreshAmounts();
        });
        rowEl.querySelector('[data-fmdw-sched-due]')?.addEventListener('change', (event) => { row.due_rule = event.target.value; commit(); render(); });
        rowEl.querySelector('[data-fmdw-sched-date]')?.addEventListener('change', (event) => { row.due_date = cleanText(event.target.value); commit(); });
        rowEl.querySelector('[data-fmdw-sched-remove]')?.addEventListener('click', () => { rows.splice(index, 1); commit(); render(); });
      });
      el.querySelector('[data-fmdw-sched-add]')?.addEventListener('click', () => {
        const scheduled = rows.filter((row) => row.kind === 'percent').reduce((sum, row) => sum + row.percent, 0);
        rows.push(normalizeScheduleRow({ label: rows.length ? 'Payment' : 'Deposit', kind: 'percent', percent: Math.max(0, 100 - scheduled), due_rule: rows.length ? 'project_completion' : 'on_signature' }, rows.length));
        commit();
        render();
      });
      el.querySelectorAll('[data-fmdw-sched-preset]').forEach((button) => button.addEventListener('click', () => preset(obj(presets[Number(button.dataset.fmdwSchedPreset)]).parts)));
      // The summary is redrawn on every amount edit, so its button is found from the card.
      // Pressing it must not lose to the field being edited: leaving that
      // field redraws the summary, and a click would land on nothing.
      const card = el.querySelector('.fmdw-sched');
      card?.addEventListener('pointerdown', (event) => {
        if (!event.target.closest?.('[data-fmdw-sched-balance]')) return;
        event.preventDefault();
        if (el.contains(document.activeElement)) document.activeElement.blur();
        balance();
      });
      card?.addEventListener('click', (event) => { if (event.target.closest?.('[data-fmdw-sched-balance]')) balance(); });
      // Reorder: drag a row by its grip, or Alt + arrow keys on the grip.
      const move = (from, to) => {
        if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return;
        rows.splice(to, 0, rows.splice(from, 1)[0]);
        commit();
        render();
        el.querySelectorAll('[data-fmdw-sched-grip]')[to]?.focus();
      };
      let dragging = -1;
      el.querySelectorAll('[data-fmdw-sched]').forEach((rowEl) => {
        const index = Number(rowEl.dataset.fmdwSched);
        const grip = rowEl.querySelector('[data-fmdw-sched-grip]');
        if (!grip) return;
        grip.addEventListener('pointerdown', () => { rowEl.draggable = true; });
        grip.addEventListener('keydown', (event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
        });
        rowEl.addEventListener('dragstart', (event) => {
          dragging = index;
          rowEl.classList.add('dragging');
          try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); } catch (e) { /* older browsers */ }
        });
        rowEl.addEventListener('dragend', () => {
          dragging = -1;
          rowEl.draggable = false;
          el.querySelectorAll('.fmdw-sched-row').forEach((other) => other.classList.remove('dragging', 'drop-before', 'drop-after'));
        });
        rowEl.addEventListener('dragover', (event) => {
          if (dragging < 0 || dragging === index) return;
          event.preventDefault();
          const rect = rowEl.getBoundingClientRect();
          const after = event.clientY > rect.top + rect.height / 2;
          rowEl.classList.toggle('drop-after', after);
          rowEl.classList.toggle('drop-before', !after);
        });
        rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drop-before', 'drop-after'));
        rowEl.addEventListener('drop', (event) => {
          if (dragging < 0 || dragging === index) return;
          event.preventDefault();
          const after = rowEl.classList.contains('drop-after');
          const from = dragging;
          let to = index + (after ? 1 : 0);
          if (from < to) to -= 1;
          dragging = -1;
          move(from, to);
        });
      });
    };
    render();
    return {
      validate: () => {
        if (ctx.item.required && !rows.length) return 'Add the payment terms to continue.';
        const basis = basisCents();
        const scheduled = rows.reduce((sum, row) => sum + rowCents(row), 0);
        return rows.length && basis > 0 && scheduled - basis > rows.length ? 'The payment schedule adds up to more than the total.' : null;
      }
    };
  });

  // ----------------------------------------------------------------- review
  // What the sender should know before this goes out: the total, anything
  // that looks unfinished, then the answers the workflow collected.
  registerKind('review', (el, ctx) => {
    const workflow = ctx.workflow;
    const rows = [];
    const checks = [];
    let total = null;
    arr(workflow.steps).forEach((step) => {
      arr(obj(step).items).forEach((item) => {
        const kind = cleanText(obj(item).kind);
        if (kind === 'review') return;
        const writes = cleanText(obj(item).writes);
        if (!writes) return;
        const value = getPath(ctx.scope(), writes);
        const hiddenHere = !stepVisibleFor(obj(step), ctx.audience, workflow) || !itemVisibleFor(obj(item), ctx.audience);
        if (kind === 'line_items_review' || kind === 'line_item_editor') {
          total = (total || 0) + scopeItemsTotal(value);
          let zeroQuantity = 0;
          let unpriced = 0;
          const groups = new Set();
          const walk = (list) => arr(list).forEach((raw) => {
            const line = obj(raw);
            const selection = obj(line.selection);
            if (cleanText(selection.mode) === 'choice' && cleanText(selection.group_id)) groups.add(cleanText(selection.group_id));
            if (!scopeItemSelected(line)) return;
            const leaf = !arr(line.children).length;
            if (leaf && !(Number(line.quantity) > 0)) zeroQuantity += 1;
            else if (leaf && line.price_driving !== false && !(Number(line.unit_price) > 0)) unpriced += 1;
            walk(line.children);
          });
          walk(value);
          if (zeroQuantity) checks.push(`${zeroQuantity} line${zeroQuantity === 1 ? ' has' : 's have'} a quantity of 0. ${zeroQuantity === 1 ? 'It prints on the proposal and adds' : 'They print on the proposal and add'} nothing to the price — remove ${zeroQuantity === 1 ? 'it' : 'them'} or enter a quantity.`);
          if (unpriced) checks.push(`${unpriced} line${unpriced === 1 ? ' has' : 's have'} no unit price.`);
          if (groups.size) checks.push(`${groups.size} choice group${groups.size === 1 ? '' : 's'}: the proposal prices and prints the option selected in each.`);
        }
        if (isEmptyValue(value) && typeof value !== 'number' && typeof value !== 'boolean') {
          if (obj(item).required && !hiddenHere) checks.push(`${itemLabel(obj(item))} is not filled in.`);
          return;
        }
        const chosen = kind === 'select' ? resolveOptions(obj(item), ctx.scope(), ctx.services).find((option) => option.value === cleanText(value)) : null;
        rows.push({ label: itemLabel(obj(item)), value: chosen ? chosen.label : formatValue(obj(item), value), hidden: hiddenHere });
      });
    });
    el.innerHTML = `
      <div class="fmdw-field">
        <span class="fmdw-field-label">${esc(itemLabel(ctx.item) === 'Field' ? 'Review' : itemLabel(ctx.item))}</span>
        ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
        ${total === null ? '' : `<div class="fmdw-card fmdw-review-total"><span>${esc(firstText(ctx.item.total_label, 'Scope total'))}</span><b>${esc(moneyFromDollars(total))}</b></div>`}
        ${checks.length ? `<div class="fmdw-card fmdw-review-checks">${checks.map((text) => `<p><i class="fas fa-triangle-exclamation"></i> ${esc(text)}</p>`).join('')}</div>` : ''}
        <div class="fmdw-card fmdw-review">
          ${rows.length ? rows.map((row) => `
            <div class="fmdw-review-row ${row.hidden ? 'muted' : ''}">
              <span>${esc(row.label)}${row.hidden ? ` <em>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_b355543c278b0d","(set by your project team)") ?? "(set by your project team)")}</em>` : ''}</span>
              <b>${esc(row.value)}</b>
            </div>`).join('') : `<p class="fmdw-hint">${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c36246dea049d6","Nothing has been filled in yet.") ?? "Nothing has been filled in yet.")}</p>`}
        </div>
        ${ctx.hasPreview ? `<p class="fmdw-hint"><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_eff08b0fc06db7"," The live preview shows the finished document with these answers.") ?? " The live preview shows the finished document with these answers.")}</p>` : ''}
      </div>`;
    return {};
  });

  // ------------------------------------------------------ signature / payment
  function outputKeyFor(item, fallback){
    const writes = cleanText(obj(item).writes);
    if (writes.startsWith('outputs.')) return writes.slice('outputs.'.length);
    return firstText(obj(item).output_key, fallback);
  }
  function widgetContext(ctx, config, refresh){
    return {
      node: { id: uid('fmdw_widget'), type: 'widget', props: { widget: '', config } },
      config,
      data: null,
      mode: ctx.readonly ? 'static' : 'interactive',
      scope: ctx.scope(),
      themeVars: {},
      skin: {},
      outputs: obj(getPath(ctx.scope(), 'outputs')),
      api: obj(ctx.services).api || {},
      submitOutput: (key, value) => {
        return Promise.resolve(ctx.writePath(`outputs.${key}`, value)).then(result => { ctx.requestPreview(); return result; });
      },
      refresh: () => { try { refresh(); } catch (e) {} }
    };
  }
  function statusCardHtml(icon, title, sub, done){
    return `
      <div class="fmdw-card fmdw-status-card ${done ? 'done' : ''}">
        <span class="fmdw-status-icon"><i class="fas ${icon}"></i></span>
        <div class="fmdw-piece-copy"><strong>${esc(title)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      </div>`;
  }

  // Server-generated document (receipt / follow-up): the backend mints the
  // configured document when this step completes and records its ref at the
  // item's outputs.* path — this card just reflects that state.
  registerKind('generate_document', (el, ctx) => {
    function draw(){
      const current = obj(ctx.value());
      const config = obj(ctx.item.config);
      const label = firstText(ctx.item.label, config.title, 'Generated document');
      if (cleanText(current.document_id)) {
        const canOpen = typeof obj(ctx.services).openDocument === 'function' && ctx.audience !== 'customer';
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${String(esc(label))}</span>
            <div class="fmdw-gen-doc done">
              <i class="fas fa-file-circle-check"></i>
              <span class="fmdw-gen-doc-copy"><strong>${String(esc(firstText(current.title, label)))}</strong><small>${((v2) => globalThis.PlatformLanguage?.htmlText("doc-workflow","m_7cda0ae68e2436",`Generated ${v2}`,{v2}) ?? `Generated ${v2}`)(esc(cleanText(current.generated_at).slice(0, 10)))}</small></span>
              ${String(canOpen ? `<button type="button" class="fmdw-gen-doc-open" data-fmdw-gen-open>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_c25cc66b28cc9d","Open") ?? "Open")}</button>` : '')}
            </div>
          </div>`;
        el.querySelector('[data-fmdw-gen-open]')?.addEventListener('click', () => {
          try { obj(ctx.services).openDocument(cleanText(current.document_id)); } catch (e) { /* host handles */ }
        });
      } else {
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${String(esc(label))}</span>
            <div class="fmdw-gen-doc pending">
              <i class="fas fa-file-circle-plus"></i>
              <span class="fmdw-gen-doc-copy"><strong>${String(esc(firstText(config.title, label)))}</strong><small>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_3aae9c62ecf927","Created automatically when this step is completed.") ?? "Created automatically when this step is completed.")}</small></span>
            </div>
          </div>`;
      }
    }
    draw();
    return { validate: () => null };
  });

  registerKind('signature', (el, ctx) => {
    const key = outputKeyFor(ctx.item, 'sig_customer');
    const render = () => {
      const value = obj(getPath(ctx.scope(), `outputs.${key}`));
      const signed = !!firstText(value.signer_name, value.text, value.image_data);
      if (!['customer', 'field'].includes(ctx.audience) || ctx.readonly) {
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
            ${statusCardHtml('fa-signature', signed ? `Signed by ${firstText(value.signer_name, 'customer')}` : 'Awaiting customer signature', signed ? cleanText(value.signed_at).slice(0, 10) : 'The customer signs from their portal.', signed)}
            <span class="fmdw-field-error" data-fmdw-error hidden></span>
          </div>`;
        return;
      }
      const widget = root.FMDocWidgets?.get?.('doc.signature', 1);
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card"><div class="fmdw-widget-host" data-fmdw-widget></div></div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const host = el.querySelector('[data-fmdw-widget]');
      if (widget?.renderInteractive) {
        try {
          widget.renderInteractive(host, widgetContext(ctx, { label: itemLabel(ctx.item), output_key: key, signer: 'customer' }, render));
          return;
        } catch (e) { /* fall through to the fallback card */ }
      }
      host.outerHTML = statusCardHtml('fa-signature', signed ? `Signed by ${firstText(value.signer_name, 'you')}` : 'Signature required', signed ? '' : 'Open the document view to sign.', signed);
    };
    render();
    return {
      validate: () => {
        if (!ctx.item.required) return null;
        const value = obj(getPath(ctx.scope(), `outputs.${key}`));
        return firstText(value.signer_name, value.text, value.image_data) ? null : 'A signature is required before continuing.';
      }
    };
  });

  registerKind('payment', (el, ctx) => {
    const key = outputKeyFor(ctx.item, 'payment');
    const render = () => {
      const value = getPath(ctx.scope(), `outputs.${key}`);
      const paymentValue = obj(value);
      const paid = !isEmptyValue(value) && !!firstText(paymentValue.payment_method, paymentValue.method, obj(paymentValue.checkout).payment_method);
      if (!['customer', 'field'].includes(ctx.audience) || ctx.readonly) {
        el.innerHTML = `
          <div class="fmdw-field">
            <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
            ${statusCardHtml('fa-credit-card', paid ? 'Payment received' : 'Awaiting payment', paid ? '' : 'The customer pays from their portal.', paid)}
            <span class="fmdw-field-error" data-fmdw-error hidden></span>
          </div>`;
        return;
      }
      const widget = root.FMDocWidgets?.get?.('doc.pay_now', 1);
      el.innerHTML = `
        <div class="fmdw-field">
          <span class="fmdw-field-label">${esc(itemLabel(ctx.item))}${ctx.item.required ? '<i class="fmdw-req">*</i>' : ''}</span>
          ${ctx.item.description ? `<span class="fmdw-field-desc">${esc(ctx.item.description)}</span>` : ''}
          <div class="fmdw-card"><div class="fmdw-widget-host" data-fmdw-widget></div></div>
          <span class="fmdw-field-error" data-fmdw-error hidden></span>
        </div>`;
      const host = el.querySelector('[data-fmdw-widget]');
      if (widget?.renderInteractive) {
        try {
          const config = { ...obj(ctx.item.config), label: itemLabel(ctx.item), output_key: key };
          const source = cleanText(config.source || ctx.item.amount_from);
          const scopedAmount = source
            ? getPath(ctx.scope(), source)
            : getPath(ctx.scope(), key === 'final_payment' ? 'params.final_payment_cents' : 'params.deposit_cents');
          if (scopedAmount !== undefined && scopedAmount !== null && scopedAmount !== '') config.amount_cents = Number(scopedAmount) || 0;
          widget.renderInteractive(host, widgetContext(ctx, config, render));
          return;
        } catch (e) { /* fall through */ }
      }
      host.outerHTML = statusCardHtml('fa-credit-card', paid ? 'Payment received' : 'Payment', paid ? '' : 'Payment can be completed from the document view.', paid);
    };
    render();
    return {
      validate: () => (ctx.item.required && isEmptyValue(getPath(ctx.scope(), `outputs.${key}`)) ? 'Payment is required before continuing.' : null)
    };
  });

  // ============================================================= mount
  function mount(container, options = {}){
    if (!container) throw new Error('FMDocWorkflow.mount: container is required');
    ensureStyles();

    const opts = obj(options);
    const workflow = obj(opts.workflow);
    const requestedAudience = cleanText(opts.audience);
    const audience = ['customer', 'field'].includes(requestedAudience) ? requestedAudience : 'internal';
    const contract = obj(opts.contract && Object.keys(obj(opts.contract)).length ? opts.contract : workflow.contract);
    const services = obj(opts.services);
    const preview = opts.preview && typeof obj(opts.preview).resolve === 'function' ? obj(opts.preview) : null;
    const extraScope = obj(opts.scope);
    const theme = firstText(opts.theme, obj(obj(workflow.audiences)[audience]).theme);
    const showWorkflowTitle = opts.showWorkflowTitle !== false;

    const st = {
      params: obj(clone(obj(opts.state).params)),
      outputs: obj(clone(obj(opts.state).outputs)),
      completed: new Set(arr(obj(opts.state).completed_steps).map(cleanText).filter(Boolean)),
      currentId: cleanText(obj(opts.state).current_step),
      destroyed: false,
      itemHandles: [],
      previewTimer: 0,
      previewBusy: false,
      previewHandle: null,
      previewStale: false
    };

    function scope(){
      return { params: st.params, outputs: st.outputs, contract, ...extraScope };
    }

    function visibleSteps(){
      const sc = scope();
      return arr(workflow.steps)
        .map(obj)
        .filter((step) => cleanText(step.id))
        .filter((step) => stepVisibleFor(step, audience, workflow))
        .filter((step) => whenPasses(step.when, sc));
    }

    function stepItems(step){
      const sc = scope();
      // A step may itself be `{kind:"review"}` sugar with no items array.
      const sectionItems = arr(step.sections)
        .map(obj)
        .filter((section) => itemVisibleFor(section, audience))
        .filter((section) => whenPasses(section.when, sc))
        .flatMap((section) => arr(section.items));
      const items = sectionItems.length ? sectionItems : (arr(step.items).length ? arr(step.items) : (cleanText(step.kind) ? [{ kind: step.kind, ...obj(step.item) }] : []));
      return items.map(obj).filter((item) => itemVisibleFor(item, audience)).filter((item) => whenPasses(item.when, sc));
    }

    function stepSections(step){
      const sc = scope();
      const sections = arr(step.sections).map(obj).filter((section) => itemVisibleFor(section, audience)).filter((section) => whenPasses(section.when, sc));
      if (sections.length) return sections.map((section) => ({ ...section, items: arr(section.items).map(obj).filter((item) => itemVisibleFor(item, audience)).filter((item) => whenPasses(item.when, sc)) }));
      return [{ id: `${cleanText(step.id)}_default`, title: '', items: stepItems(step), legacy: true }];
    }

    // Step-level `auto_skip_when_complete: true`: when FORWARD navigation
    // lands on the step and every answerable item already holds a complete
    // answer, the step is skipped (marked done). Manual entry — a rail click
    // or Back — always enters the step, even when it is complete.
    function stepAutoSkips(step, sc){
      if (obj(step).auto_skip_when_complete !== true) return false;
      const items = stepItems(step).filter((item) => !['review', 'signature', 'payment'].includes(cleanText(item.kind)));
      if (!items.length) return false;
      return items.every((item) => itemAnswered(item, sc));
    }

    function currentIndex(steps){
      const index = steps.findIndex((step) => cleanText(step.id) === st.currentId);
      if (index >= 0) return index;
      // Default: first step not yet completed.
      const firstOpen = steps.findIndex((step) => !st.completed.has(cleanText(step.id)));
      return firstOpen >= 0 ? firstOpen : Math.max(0, steps.length - 1);
    }

    // Index of the first step that may NOT be jumped to: everything after the
    // first incomplete step (you can revisit done steps + the next open one).
    function firstLockedIndex(steps){
      for (let i = 0; i < steps.length; i += 1) {
        if (!st.completed.has(cleanText(steps[i].id))) return i + 1;
      }
      return steps.length;
    }

    // ------------------------------------------------------------- writes
    function allowedWrite(path){
      if (audience !== 'customer') return true;
      return cleanText(path).startsWith('outputs.');
    }
    function writePath(path, value){
      const target = cleanText(path);
      if (!target || !allowedWrite(target)) return false;
      if (target.startsWith('outputs.') && value?.__signing) {
        return Promise.resolve(opts.onWrite?.(target, clone(value))).then(result => {
          if (result === false) throw new Error('Signature was not recorded.');
          const retained = clone(value); delete retained.__signing;
          setPath(st.outputs, target.slice('outputs.'.length), retained);
          schedulePreview(); updateRail(); return true;
        });
      }
      if (target.startsWith('params.')) setPath(st.params, target.slice('params.'.length), clone(value));
      else if (target.startsWith('outputs.')) setPath(st.outputs, target.slice('outputs.'.length), clone(value));
      else setPath(st.params, target, clone(value));
      try { opts.onWrite?.(target, clone(value)); } catch (e) { console.warn('FMDocWorkflow onWrite failed', e); }
      schedulePreview();
      updateRail();
      return true;
    }

    /** The deliverables are ready once the workflow stands on its last step (or has finished every one before it). */
    function deliverablesReady(){
      const steps = visibleSteps();
      if (steps.length <= 1) return true;
      const last = cleanText(steps[steps.length - 1].id);
      return cleanText(st.currentId) === last || steps.slice(0, -1).every((step) => st.completed.has(cleanText(step.id)));
    }
    function emitStepState(){
      const payload = { current_step: st.currentId, completed_steps: [...st.completed], ready: deliverablesReady() };
      try { opts.onStepState?.(payload); } catch (e) { /* host issue */ }
      try { opts.onStepChange?.(payload); } catch (e) { /* legacy alias */ }
    }

    // -------------------------------------------------------------- layout
    container.innerHTML = `
      <div class="fmdw ${String(theme === 'portal' ? 'fmdw-portal' : '')} ${String(preview ? 'has-preview' : '')}" data-fmdw-root>
        <aside class="fmdw-rail">
          <div class="fmdw-rail-head ${String(showWorkflowTitle ? '' : 'titleless')}">
            ${String(showWorkflowTitle ? `<strong>${esc(firstText(workflow.name, 'Workflow'))}</strong>` : '')}
            <span data-fmdw-rail-sub></span>
          </div>
          <nav class="fmdw-steps" data-fmdw-steps></nav>
        </aside>
        <section class="fmdw-main">
          <header class="fmdw-step-head" data-fmdw-step-head></header>
          <div class="fmdw-items" data-fmdw-items></div>
          <footer class="fmdw-foot">
            <button type="button" class="fmdw-btn" data-fmdw-back><i class="fas fa-arrow-left"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_9c5b830c019950"," Previous") ?? " Previous")}</button>
            <span class="fmdw-foot-note" data-fmdw-foot-note></span>
            ${String(preview && typeof services.openFullPreview !== 'function' ? `<button type="button" class="fmdw-btn ghost fmdw-preview-toggle" data-fmdw-preview-toggle title="Show or hide the live preview"><i class="fas fa-eye"></i><span> Preview</span></button>` : '')}
            <span class="fmdw-foot-deliver" data-fmdw-foot-deliver></span>
            <button type="button" class="fmdw-btn primary" data-fmdw-continue>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_854c72abba5166","Continue ") ?? "Continue ")}<i class="fas fa-arrow-right"></i></button>
          </footer>
        </section>
        ${String(preview ? `
        <div class="fmdw-resizer" data-fmdw-resizer title="Drag to resize the preview" role="separator" aria-orientation="vertical"></div>
        <aside class="fmdw-preview" data-fmdw-preview>
          <div class="fmdw-preview-head" data-fmdw-preview-head>
            <strong><i class="fas fa-eye"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_a979f59edfcd90"," Live preview") ?? " Live preview")}</strong>
            <div class="fmdw-preview-zoom">
              <button type="button" class="fmdw-icon-btn" data-fmdw-zoom-out title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_acf282d479dddf","Zoom out") ?? "Zoom out")}"><i class="fas fa-magnifying-glass-minus"></i></button>
              <button type="button" class="fmdw-zoom-pct" data-fmdw-zoom-fit title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_b4e9fa5595e7cf","Fit width") ?? "Fit width")}" data-fmdw-zoom-pct>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2d8510904d5879","Fit") ?? "Fit")}</button>
              <button type="button" class="fmdw-icon-btn" data-fmdw-zoom-in title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_a593d968057ce9","Zoom in") ?? "Zoom in")}"><i class="fas fa-magnifying-glass-plus"></i></button>
              <button type="button" class="fmdw-icon-btn" data-fmdw-preview-refresh title="${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_acf1841e689f24","Refresh preview") ?? "Refresh preview")}"><i class="fas fa-rotate"></i></button>
              ${String(typeof services.openFullPreview === 'function' ? `<button type="button" class="fmdw-icon-btn" data-fmdw-preview-full title="Full screen"><i class="fas fa-expand"></i></button>` : '')}
              <button type="button" class="fmdw-icon-btn" data-fmdw-preview-hide title="Hide the preview"><i class="fas fa-xmark"></i></button>
            </div>
          </div>
          <div class="fmdw-preview-stage" data-fmdw-preview-stage>
            <div class="fmdw-preview-empty"><i class="fas fa-file-lines"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_cec49be42c7614","The preview updates as you answer.") ?? "The preview updates as you answer.")}</span></div>
          </div>
        </aside>` : '')}
      </div>`;

    const el = {
      root: container.querySelector('[data-fmdw-root]'),
      railSub: container.querySelector('[data-fmdw-rail-sub]'),
      steps: container.querySelector('[data-fmdw-steps]'),
      stepHead: container.querySelector('[data-fmdw-step-head]'),
      items: container.querySelector('[data-fmdw-items]'),
      back: container.querySelector('[data-fmdw-back]'),
      cont: container.querySelector('[data-fmdw-continue]'),
      footNote: container.querySelector('[data-fmdw-foot-note]'),
      preview: container.querySelector('[data-fmdw-preview]'),
      previewStage: container.querySelector('[data-fmdw-preview-stage]')
    };

    // ---------------------------------------------------------------- rail
    function updateRail(){
      if (st.destroyed) return;
      const steps = visibleSteps();
      const index = currentIndex(steps);
      const lockedFrom = firstLockedIndex(steps);
      st.currentId = cleanText(obj(steps[index]).id);
      el.railSub.textContent = steps.length ? `Step ${index + 1} of ${steps.length}` : 'No steps';
      el.steps.innerHTML = steps.map((step, i) => {
        const id = cleanText(step.id);
        const done = st.completed.has(id);
        const current = i === index;
        const locked = !done && !current && i >= lockedFrom;
        return `
          <button type="button" class="fmdw-step ${current ? 'current' : ''} ${done ? 'done' : ''} ${locked ? 'locked' : ''}" data-fmdw-step="${esc(id)}" ${locked ? 'disabled' : ''}>
            <span class="fmdw-step-dot">${done && !current ? '<i class="fas fa-check"></i>' : (locked ? '<i class="fas fa-lock"></i>' : i + 1)}</span>
            <span class="fmdw-step-title">${esc(firstText(step.navigation_title, step.short_title, step.title, prettyKey(id)))}</span>
          </button>`;
      }).join('');
      el.steps.querySelectorAll('[data-fmdw-step]').forEach((button) => button.addEventListener('click', () => goTo(button.dataset.fmdwStep)));
    }

    // --------------------------------------------------------------- items
    function destroyItemHandles(){
      st.itemHandles.forEach((entry) => { try { entry.handle?.destroy?.(); } catch (e) {} });
      st.itemHandles = [];
    }

    function renderStep(){
      if (st.destroyed) return;
      const steps = visibleSteps();
      if (!steps.length) {
        el.stepHead.innerHTML = `<h2>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_cdf312ca4a3b4e","Nothing to fill in") ?? "Nothing to fill in")}</h2><p>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_44399b69b88f2d","This workflow has no steps for you right now.") ?? "This workflow has no steps for you right now.")}</p>`;
        el.items.innerHTML = `<div class="fmdw-empty"><i class="fas fa-circle-check"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_b4700fabfa5e9b","You are all set.") ?? "You are all set.")}</span></div>`;
        el.back.hidden = true;
        el.cont.hidden = true;
        return;
      }
      const index = currentIndex(steps);
      const step = steps[index];
      st.currentId = cleanText(step.id);
      destroyItemHandles();
      el.stepHead.innerHTML = `
        <div class="fmdw-step-heading">
          <h2>${esc(firstText(step.title, prettyKey(step.id)))}</h2>
          ${cleanText(step.description) ? `<p>${esc(step.description)}</p>` : ''}
        </div>
        <div class="fmdw-step-actions" data-fmdw-step-actions></div>`;
      el.items.innerHTML = '';
      el.footNote.textContent = '';
      const sections = stepSections(step);
      const items = sections.flatMap((section) => arr(section.items));
      if (!items.length) {
        el.items.innerHTML = `<div class="fmdw-empty"><i class="fas fa-circle-info"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_8a8fecd55b2bdc","Nothing to answer on this step.") ?? "Nothing to answer on this step.")}</span></div>`;
      }
      const renderItem = (item, parent) => {
        const holder = document.createElement('div');
        const itemTransition = obj(obj(item.presentation).transition);
        // Lists and grids need the full row; simple fields pair up.
        const wide = ['measurements', 'payment_schedule', 'line_items_review', 'line_item_editor', 'review', 'content_blocks', 'piece_select', 'piece_picker', 'choice_group'].includes(cleanText(item.kind))
          || obj(item.presentation).multiline === true || ['cards', 'tiles'].includes(cleanText(obj(item.presentation).style));
        holder.className = `fmdw-item ${wide ? 'fmdw-item-wide' : ''} fmdw-enter-${firstText(itemTransition.type, 'fade').replace(/[^a-z-]/gi, '')}`;
        holder.style.setProperty('--fmdw-enter-ms', `${Math.max(0, Number(itemTransition.duration_ms || 180))}ms`);
        if (item.disabled === true) {
          holder.classList.add('fmdw-capability-disabled');
          holder.setAttribute('aria-disabled', 'true');
          holder.setAttribute('data-disabled-reason', firstText(item.disabled_reason, 'This feature is disabled for this organization.'));
        }
        parent.appendChild(holder);
        const renderer = kindRegistry.get(cleanText(item.kind));
        const readonly = item.disabled === true || opts.readonly === true || !allowedWrite(cleanText(item.writes) || 'params._');
        const ctx = {
          item,
          step,
          audience,
          readonly,
          disabled: item.disabled === true,
          workflow,
          services,
          hasPreview: !!preview,
          // A step made of one item may put its actions beside the step title.
          stepActions: items.length === 1 ? el.stepHead.querySelector('[data-fmdw-step-actions]') : null,
          scope,
          value: () => getPath(scope(), cleanText(item.writes)),
          write: (value) => writePath(cleanText(item.writes), value),
          writePath,
          options: () => resolveOptions(item, scope(), services),
          requestPreview: () => schedulePreview(),
          // Advance the stepper (validation still applies) — used by kinds
          // whose embedded flow finishing means "this step is done".
          next: () => goNext(),
          helpers: { esc, cleanText, moneyFromCents, moneyFromDollars, prettyKey, clone }
        };
        if (!renderer) {
          holder.innerHTML = `<div class="fmdw-card"><p class="fmdw-hint"><i class="fas fa-puzzle-piece"></i>${((v0) => globalThis.PlatformLanguage?.htmlText("doc-workflow","m_2060888166e53b",` This question type ("${v0}") is not supported in this view.`,{v0}) ?? ` This question type ("${v0}") is not supported in this view.`)(esc(item.kind))}</p></div>`;
          st.itemHandles.push({ item, el: holder, handle: {} });
          return;
        }
        let handle = {};
        try { handle = obj(renderer(holder, ctx)); }
        catch (error) {
          console.warn('FMDocWorkflow kind renderer failed', item.kind, error);
          holder.innerHTML = `<div class="fmdw-card"><p class="fmdw-hint"><i class="fas fa-triangle-exclamation"></i>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_63c83caf528f7c"," This question could not be displayed.") ?? " This question could not be displayed.")}</p></div>`;
        }
        st.itemHandles.push({ item, el: holder, ctx, handle });
      };
      sections.forEach((section) => {
        const sectionEl = document.createElement('section');
        const transition = obj(section.transition);
        sectionEl.className = `fmdw-section fmdw-enter-${esc(firstText(transition.type, section.legacy ? 'none' : 'grow'))}`;
        sectionEl.style.setProperty('--fmdw-enter-ms', `${Math.max(0, Number(transition.duration_ms || 220))}ms`);
        const background = firstText(obj(section.style).background);
        if (background) sectionEl.style.background = background;
        if (cleanText(section.title)) sectionEl.innerHTML = `<h3>${esc(section.title)}</h3>${cleanText(section.description) ? `<p>${esc(section.description)}</p>` : ''}`;
        const body = document.createElement('div'); body.className = 'fmdw-section-items'; sectionEl.appendChild(body); el.items.appendChild(sectionEl);
        arr(section.items).forEach((item) => renderItem(item, body));
      });
      // Footer
      const isLast = index >= steps.length - 1;
      el.back.hidden = index === 0;
      el.cont.hidden = false;
      el.cont.innerHTML = isLast
        ? `${esc(firstText(obj(opts.labels).finish, 'Submit'))} <i class="fas fa-check"></i>`
        : `${esc(firstText(obj(opts.labels).continue, 'Next'))} <i class="fas fa-arrow-right"></i>`;
      // On the last step the host says what else the workflow hands over
      // (present, share...): [{ label, icon, title?, disabled?, run }]. They
      // sit beside the finish button; a workflow that declares none has none.
      const deliver = el.root.querySelector('[data-fmdw-foot-deliver]');
      if (deliver) {
        deliver.innerHTML = '';
        const forStep = st.currentId;
        if (isLast && opts.readonly !== true && typeof services.deliverables === 'function') {
          Promise.resolve().then(() => services.deliverables()).then((actions) => {
            if (st.destroyed || st.currentId !== forStep) return;
            const list = arr(actions).map(obj).filter((action) => cleanText(action.label));
            deliver.innerHTML = list.map((action, at) => `<button type="button" class="fmdw-btn ${action.quiet ? 'ghost' : ''}" data-fmdw-deliver-run="${at}" ${action.disabled ? 'disabled' : ''} title="${esc(cleanText(action.title))}"><i class="fas ${esc(firstText(action.icon, 'fa-arrow-right'))}"></i> ${esc(action.label)}</button>`).join('');
            deliver.querySelectorAll('[data-fmdw-deliver-run]').forEach((button) => button.addEventListener('click', () => {
              try { list[Number(button.dataset.fmdwDeliverRun)].run?.(); } catch (e) { /* host action */ }
            }));
          }).catch(() => {});
        }
      }
      updateRail();
      // Scroll the pane back to the top on step change.
      try { el.items.scrollTop = 0; } catch (e) {}
    }

    function validateCurrentStep(){
      let firstError = null;
      st.itemHandles.forEach((entry) => {
        let message = null;
        try { message = obj(entry.item).disabled !== true && entry.handle?.validate ? entry.handle.validate() : null; } catch (e) { message = null; }
        if (!message && entry.ctx && obj(entry.item).required && obj(entry.item).disabled !== true && isEmptyValue(entry.ctx.value())) {
          const kind = cleanText(entry.item.kind);
          if (!['review', 'signature', 'payment'].includes(kind)) message = 'This field is required.';
        }
        const errorEl = entry.el.querySelector('[data-fmdw-error]');
        if (errorEl) {
          errorEl.hidden = !message;
          errorEl.textContent = message || '';
        }
        entry.el.classList.toggle('invalid', !!message);
        if (message && !firstError) firstError = entry;
      });
      if (firstError) {
        try { firstError.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
        el.footNote.textContent = (globalThis.PlatformLanguage?.text("doc-workflow","m_252c511fd2c95b","Fill in the highlighted fields to continue.") ?? "Fill in the highlighted fields to continue.");
      } else {
        el.footNote.textContent = '';
      }
      return !firstError;
    }

    function goNext(){
      if (!validateCurrentStep()) return;
      let steps = visibleSteps();
      const index = currentIndex(steps);
      const step = steps[index];
      st.completed.add(cleanText(step.id));
      // Recompute: completing this step's writes may reveal `when` steps.
      steps = visibleSteps();
      let nextIndex = steps.findIndex((s) => cleanText(s.id) === cleanText(step.id)) + 1;
      if (nextIndex <= 0) nextIndex = index + 1;
      // Skip past auto_skip_when_complete steps that are already answered.
      const sc = scope();
      while (nextIndex < steps.length && stepAutoSkips(steps[nextIndex], sc)) {
        st.completed.add(cleanText(steps[nextIndex].id));
        nextIndex += 1;
      }
      if (nextIndex >= steps.length) {
        emitStepState();
        try { opts.onComplete?.({ params: clone(st.params), outputs: clone(st.outputs) }); } catch (e) { console.warn('FMDocWorkflow onComplete failed', e); }
        return;
      }
      st.currentId = cleanText(steps[nextIndex].id);
      emitStepState();
      renderStep();
    }
    function goBack(){
      const steps = visibleSteps();
      const index = currentIndex(steps);
      if (index <= 0) return;
      st.currentId = cleanText(steps[index - 1].id);
      emitStepState();
      renderStep();
    }
    function goTo(stepId){
      const steps = visibleSteps();
      const target = steps.find((step) => cleanText(step.id) === cleanText(stepId));
      if (!target) return;
      const targetIndex = steps.indexOf(target);
      const lockedFrom = firstLockedIndex(steps);
      if (targetIndex >= lockedFrom && !st.completed.has(cleanText(target.id)) && audience === 'internal') return; // customer + field task links may jump directly
      st.currentId = cleanText(target.id);
      emitStepState();
      renderStep();
    }

    el.back?.addEventListener('click', goBack);
    el.cont?.addEventListener('click', goNext);

    // -------------------------------------------------------------- preview
    function schedulePreview(){
      if (!preview || st.destroyed) return;
      clearTimeout(st.previewTimer);
      st.previewTimer = setTimeout(() => refreshPreview(), 700);
    }
    async function refreshPreview(){
      if (!preview || st.destroyed) return;
      if (st.previewBusy) { st.previewStale = true; return; }
      st.previewBusy = true;
      el.preview?.classList.add('loading');
      try {
        // The host reads totals off this resolve, so it runs even while the
        // pane is hidden; only the page render is skipped.
        const resolved = obj(await preview.resolve());
        if (st.destroyed) return;
        if (el.root.classList.contains('preview-hidden')) { st.lastResolved = resolved; return; }
        renderPreview(resolved);
      } catch (error) {
        if (!st.destroyed) renderPreviewUnavailable();
      } finally {
        st.previewBusy = false;
        el.preview?.classList.remove('loading');
        if (st.previewStale && !st.destroyed) { st.previewStale = false; schedulePreview(); }
      }
    }
    function renderPreviewUnavailable(){
      if (!el.previewStage) return;
      try { st.previewHandle?.destroy?.(); } catch (e) {}
      st.previewHandle = null;
      el.previewStage.innerHTML = `<div class="fmdw-preview-empty"><i class="fas fa-eye-slash"></i><span>${(globalThis.PlatformLanguage?.htmlText("doc-workflow","m_4478f7b14b3b0c","Preview unavailable right now.") ?? "Preview unavailable right now.")}</span></div>`;
    }
    function previewFitScale(definition){
      const dims = root.FMDocModel?.paperDimensions?.(definition) || { w_pt: 612 };
      // Stage padding is 14px a side; leave a little slack so a fitted page
      // never triggers a horizontal scrollbar.
      const available = Math.max(240, (el.previewStage?.clientWidth || 266) - 32);
      return Math.min(1, available / (dims.w_pt * (96 / 72)));
    }
    function previewScale(definition){
      return st.previewZoom > 0 ? st.previewZoom : previewFitScale(definition);
    }
    function syncZoomLabel(scale){
      const label = el.preview?.querySelector('[data-fmdw-zoom-pct]');
      if (label) label.textContent = st.previewZoom > 0 ? `${Math.round(scale * 100)}%` : 'Fit';
    }
    function renderPreview(resolved){
      if (!el.previewStage) return;
      st.lastResolved = resolved; // zoom changes retransform without re-resolving
      if (typeof preview.mount === 'function') {
        try { preview.mount(el.previewStage, resolved); return; } catch (e) { /* fall through */ }
      }
      const renderer = root.FMDocRenderer;
      const definition = obj(resolved.resolved_definition || resolved.definition);
      if (!renderer?.render || (!arr(definition.pages).length && !definition.root)) { renderPreviewUnavailable(); return; }
      try { st.previewHandle?.destroy?.(); } catch (e) {}
      st.previewHandle = null;
      el.previewStage.innerHTML = '';
      try {
        const scale = previewScale(definition);
        st.previewHandle = renderer.render(el.previewStage, {
          document: definition,
          theme: resolved.theme || null,
          // Server-resolved theme_vars carry org branding the client can't
          // see — pass them as overrides so preview colors match the PDF.
          themeContext: { ...obj(resolved.theme_context || resolved.themeContext), overrides: { ...obj(obj(resolved.theme_context || resolved.themeContext).overrides), ...obj(resolved.theme_vars) } },
          mode: 'static',
          widgetData: obj(resolved.widget_data || resolved.widgetData),
          scale
        });
        syncZoomLabel(scale);
      } catch (error) {
        renderPreviewUnavailable();
      }
    }
    /** Zoom without re-resolving: retransform the live handle (renderer fast
     *  path) or re-render the cached payload. */
    function applyPreviewZoom(){
      const resolved = obj(st.lastResolved);
      const definition = obj(resolved.resolved_definition || resolved.definition);
      const scale = previewScale(definition);
      if (st.previewHandle?.setScale) {
        try { st.previewHandle.setScale(scale); syncZoomLabel(scale); return; } catch (e) { /* re-render below */ }
      }
      if (st.lastResolved) renderPreview(st.lastResolved);
    }
    el.preview?.querySelector('[data-fmdw-preview-refresh]')?.addEventListener('click', () => refreshPreview());
    el.preview?.querySelector('[data-fmdw-zoom-in]')?.addEventListener('click', () => {
      const current = st.previewZoom > 0 ? st.previewZoom : previewFitScale(obj(obj(st.lastResolved).resolved_definition));
      st.previewZoom = Math.min(2, Math.round((current + 0.15) * 100) / 100);
      applyPreviewZoom();
    });
    el.preview?.querySelector('[data-fmdw-zoom-out]')?.addEventListener('click', () => {
      const current = st.previewZoom > 0 ? st.previewZoom : previewFitScale(obj(obj(st.lastResolved).resolved_definition));
      st.previewZoom = Math.max(0.25, Math.round((current - 0.15) * 100) / 100);
      applyPreviewZoom();
    });
    el.preview?.querySelector('[data-fmdw-zoom-fit]')?.addEventListener('click', () => {
      st.previewZoom = 0;
      applyPreviewZoom();
    });

    // ------------------------------------------------- preview pane layout
    // The preview can be hidden and its width dragged; both choices persist
    // per browser. Below NARROW_PX the pane cannot fit beside the form, so it
    // hides until the window is wider.
    const PREVIEW_PREF_KEY = 'fmdw:preview';
    const NARROW_PX = 780;
    const COMPACT_RAIL_PX = 980;
    const previewPref = (() => {
      try { return obj(JSON.parse(root.localStorage?.getItem(PREVIEW_PREF_KEY) || '{}')); } catch (e) { return {}; }
    })();
    function savePreviewPref(){
      try { root.localStorage?.setItem(PREVIEW_PREF_KEY, JSON.stringify(previewPref)); } catch (e) { /* storage unavailable */ }
    }
    function previewVisible(){
      return !!preview && previewPref.hidden !== true && !el.root.classList.contains('narrow');
    }
    function applyPreviewLayout(){
      if (!preview || st.destroyed) return;
      const wasVisible = !el.root.classList.contains('preview-hidden');
      const width = el.root.clientWidth || 0;
      el.root.classList.toggle('narrow', width > 0 && width < NARROW_PX);
      el.root.classList.toggle('compact-rail', width > 0 && width < COMPACT_RAIL_PX);
      const visible = previewVisible();
      el.root.classList.toggle('preview-hidden', !visible);
      if (Number(previewPref.width) > 0) {
        const max = Math.max(280, width - (el.root.querySelector('.fmdw-rail')?.offsetWidth || 0) - 340);
        el.root.style.setProperty('--fmdw-preview-w', `${Math.round(Math.min(Math.max(280, Number(previewPref.width)), max))}px`);
      }
      const toggle = el.root.querySelector('[data-fmdw-preview-toggle]');
      if (toggle) {
        toggle.classList.toggle('active', visible);
        toggle.disabled = el.root.classList.contains('narrow');
        toggle.title = toggle.disabled ? 'Widen this window to show the live preview' : (visible ? 'Hide the live preview' : 'Show the live preview');
      }
      // Coming back into view: the document may have changed while hidden.
      if (visible && !wasVisible) { if (st.lastResolved) renderPreview(st.lastResolved); else refreshPreview(); }
      else if (visible && !(st.previewZoom > 0)) applyPreviewZoom();
    }
    el.root.querySelector('[data-fmdw-preview-toggle]')?.addEventListener('click', () => {
      previewPref.hidden = previewPref.hidden !== true;
      savePreviewPref();
      applyPreviewLayout();
    });
    el.root.querySelector('[data-fmdw-preview-full]')?.addEventListener('click', () => { try { services.openFullPreview(); } catch (e) { /* host preview */ } });
    el.root.querySelector('[data-fmdw-preview-hide]')?.addEventListener('click', () => {
      previewPref.hidden = true;
      savePreviewPref();
      applyPreviewLayout();
    });
    const resizer = el.root.querySelector('[data-fmdw-resizer]');
    resizer?.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = el.preview.offsetWidth;
      resizer.setPointerCapture?.(event.pointerId);
      el.root.classList.add('resizing');
      const move = (moveEvent) => {
        previewPref.width = startWidth + (startX - moveEvent.clientX);
        applyPreviewLayout();
      };
      const stop = () => {
        resizer.removeEventListener('pointermove', move);
        resizer.removeEventListener('pointerup', stop);
        resizer.removeEventListener('pointercancel', stop);
        el.root.classList.remove('resizing');
        savePreviewPref();
        applyPreviewLayout();
      };
      resizer.addEventListener('pointermove', move);
      resizer.addEventListener('pointerup', stop);
      resizer.addEventListener('pointercancel', stop);
    });
    resizer?.addEventListener('dblclick', () => {
      delete previewPref.width;
      el.root.style.removeProperty('--fmdw-preview-w');
      savePreviewPref();
      applyPreviewLayout();
    });
    let layoutObserver = null;
    if (typeof root.ResizeObserver === 'function') {
      layoutObserver = new root.ResizeObserver(() => applyPreviewLayout());
      layoutObserver.observe(el.root);
    }

    // ----------------------------------------------------------------- boot
    renderStep();
    applyPreviewLayout();
    if (preview) refreshPreview();

    const handle = {
      destroy(){
        if (st.destroyed) return;
        st.destroyed = true;
        clearTimeout(st.previewTimer);
        try { layoutObserver?.disconnect(); } catch (e) {}
        destroyItemHandles();
        try { st.previewHandle?.destroy?.(); } catch (e) {}
        container.innerHTML = '';
      },
      goTo,
      next: goNext,
      back: goBack,
      refresh(nextState){
        const next = obj(nextState);
        if (next.params) st.params = obj(clone(next.params));
        if (next.outputs) st.outputs = obj(clone(next.outputs));
        if (next.completed_steps) st.completed = new Set(arr(next.completed_steps).map(cleanText).filter(Boolean));
        if (cleanText(next.current_step)) st.currentId = cleanText(next.current_step);
        renderStep();
        schedulePreview();
      },
      state(){
        return { params: clone(st.params), outputs: clone(st.outputs), current_step: st.currentId, completed_steps: [...st.completed] };
      },
      /** Force a preview re-resolve now (hosts call this after out-of-band
       *  document changes: theme switch, Data-panel saves, etc.). */
      /** Show or hide the docked live preview. Returns false when it cannot be docked (no preview, or the window is too narrow). */
      togglePreview(){
        if (!preview || st.destroyed || el.root.classList.contains('narrow')) return false;
        previewPref.hidden = previewPref.hidden !== true;
        savePreviewPref();
        applyPreviewLayout();
        return true;
      },
      previewVisible: () => previewVisible(),
      deliverablesReady: () => deliverablesReady(),
      refreshPreview(){
        if (preview && !st.destroyed) refreshPreview();
      }
    };
    return handle;
  }

  // =============================================================== styles
  const CSS = `
/* FMDocWorkflow runtime (self-injected). Visual language mirrors
   documents.css / customer_portal.css: neutral grays, --primary accents. */
.fmdw{--fmdw-primary:var(--cp-primary,var(--fm-primary,var(--primary,#2563EB)));--fmdw-on-primary:var(--cp-on-primary,var(--fmdx-on-primary,#fff));--fmdw-ink:#111827;--fmdw-muted:#667085;--fmdw-line:#e4e7ec;--fmdw-bg:#f8fafc;--fmdw-card:#fff;
  display:flex;align-items:stretch;width:100%;max-width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--fmdw-bg);color:var(--fmdw-ink);font-family:inherit}
.fmdw,.fmdw *,.fmdw *::before,.fmdw *::after{box-sizing:border-box}
/* rail */
.fmdw-rail{flex:none;width:230px;min-width:0;border-right:1px solid var(--fmdw-line);background:#fff;display:flex;flex-direction:column;overflow:auto}
.fmdw-rail-head{padding:16px 16px 10px;display:flex;flex-direction:column;gap:3px;border-bottom:1px solid var(--fmdw-line)}
.fmdw-rail-head.titleless{padding-top:12px}
.fmdw-rail-head strong{font-size:13.5px;font-weight:1000;line-height:1.3}
.fmdw-rail-head span{font-size:10.5px;font-weight:850;color:var(--fmdw-muted)}
.fmdw-steps{display:flex;flex-direction:column;width:100%;max-width:100%;min-width:0;padding:10px 8px;gap:2px}
.fmdw-step{display:flex;align-items:center;gap:10px;border:0;background:transparent;border-radius:11px;padding:9px 10px;font:inherit;font-size:12px;font-weight:900;color:#475467;cursor:pointer;text-align:left;min-width:0;transition:background .12s ease,color .12s ease}
.fmdw-step:hover{background:#f4f6fa}
.fmdw-step.current{background:color-mix(in srgb,var(--fmdw-primary) 9%,#fff);color:var(--fmdw-primary)}
.fmdw-step.done{color:#137a45}
.fmdw-step.locked{color:#98a2b3;cursor:not-allowed}
.fmdw-step-dot{flex:none;width:24px;height:24px;border-radius:99px;display:grid;place-items:center;font-size:10.5px;font-weight:1000;background:#eef0f5;color:#5a6382}
.fmdw-step.current .fmdw-step-dot{background:var(--fmdw-primary);color:var(--fmdw-on-primary)}
.fmdw-step.done .fmdw-step-dot{background:#d7f5e3;color:#0c5f36}
.fmdw-step.locked .fmdw-step-dot{background:#f2f4f7;color:#98a2b3;font-size:9px}
.fmdw-step-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* main — equal flex basis with the preview so the two panes split the space
   after the (thin) rail ~50/50 on wide screens. */
.fmdw-main{flex:1 1 0;width:100%;max-width:100%;min-width:0;overflow:hidden;display:flex;flex-direction:column}
.fmdw-step-head{flex:none;padding:18px 22px 4px;display:flex;align-items:flex-start;gap:12px}
.fmdw-step-heading{flex:1;min-width:0}
.fmdw-step-actions{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.fmdw-step-actions:empty{display:none}
.fmdw-step-actions .fmdw-btn{min-height:34px;padding:0 12px}
.fmdw-step-head h2{margin:0;font-size:18px;font-weight:1000;line-height:1.25}
.fmdw-step-head p{margin:6px 0 0;font-size:12.5px;font-weight:800;color:var(--fmdw-muted);line-height:1.5}
.fmdw-items{flex:1;min-height:0;overflow:auto;padding:14px 22px 18px;display:flex;flex-direction:column;gap:14px}
.fmdw-section{border:1px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:16px;display:flex;flex-direction:column;gap:12px;transform-origin:top center}
.fmdw-section>h3{margin:0;font-size:14px;font-weight:1000}.fmdw-section>p{margin:-6px 0 0;color:var(--fmdw-muted);font-size:11.5px;font-weight:750}.fmdw-section-items{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.fmdw-section-items>.fmdw-item:only-child,.fmdw-section-items>.fmdw-item-wide{grid-column:1/-1}
.fmdw-enter-fade{animation:fmdw-enter-fade var(--fmdw-enter-ms,180ms) ease both}.fmdw-enter-grow{animation:fmdw-enter-grow var(--fmdw-enter-ms,220ms) ease both}.fmdw-enter-slide{animation:fmdw-enter-slide var(--fmdw-enter-ms,220ms) ease both}
@keyframes fmdw-enter-fade{from{opacity:0}to{opacity:1}}@keyframes fmdw-enter-grow{from{opacity:0;transform:scaleY(.04)}to{opacity:1;transform:scaleY(1)}}@keyframes fmdw-enter-slide{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.fmdw-item.invalid .fmdw-card,.fmdw-item.invalid input,.fmdw-item.invalid select,.fmdw-item.invalid textarea{border-color:#e5484d}
.fmdw-capability-disabled{position:relative;filter:grayscale(.8);opacity:.52;cursor:not-allowed}
.fmdw-capability-disabled::after{content:attr(data-disabled-reason);display:block;margin-top:7px;padding:6px 9px;border:1px solid #d0d5dd;border-radius:8px;background:#f2f4f7;color:#667085;font-size:9.5px;font-weight:900;line-height:1.35}
.fmdw-capability-disabled :is(button,input,select,textarea,[role="switch"]){pointer-events:none}
.fmdw-foot{flex:none;display:flex;align-items:center;gap:10px;padding:12px 22px;border-top:1px solid var(--fmdw-line);background:#fff}
.fmdw-foot [data-fmdw-continue]{margin-left:auto}
.fmdw-foot-note{font-size:11px;font-weight:900;color:#b42318}
/* fields */
.fmdw-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.fmdw-field-label{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:var(--fmdw-muted)}
.fmdw-field-desc{font-size:11.5px;font-weight:800;color:var(--fmdw-muted);text-transform:none;letter-spacing:0;line-height:1.45}
.fmdw-req{color:#e5484d;font-style:normal;margin-left:2px}
.fmdw-field input,.fmdw-field select,.fmdw-field textarea{width:100%;max-width:460px;border:1px solid #d4d9e6;border-radius:10px;background:#fff;color:var(--fmdw-ink);padding:10px 12px;font:inherit;font-size:13px;font-weight:800;outline:none;min-width:0}
.fmdw-field textarea{min-height:76px;resize:vertical;line-height:1.5}
.fmdw-field input:focus,.fmdw-field select:focus,.fmdw-field textarea:focus{border-color:var(--fmdw-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--fmdw-primary) 12%,transparent)}
.fmdw-field input:disabled,.fmdw-field select:disabled,.fmdw-field textarea:disabled{background:#f5f7fb;color:#98a2b3;cursor:not-allowed}
.fmdw-field-error{font-size:11px;font-weight:900;color:#b42318;text-transform:none;letter-spacing:0}
.fmdw-money{position:relative;display:block;max-width:460px}
.fmdw-money::before{content:'$';position:absolute;left:12px;top:50%;transform:translateY(-50%);font-size:12.5px;font-weight:900;color:#98a2b3;pointer-events:none}
.fmdw-money input{padding-left:26px}
.fmdw-foot-deliver{display:inline-flex;flex-wrap:nowrap;justify-content:flex-end;gap:8px;margin-left:auto}
.fmdw-foot-deliver:not(:empty)+[data-fmdw-continue]{margin-left:0}
.fmdw-foot .fmdw-btn{white-space:nowrap}
.fmdw-foot-deliver:empty{display:none}
.fmdw-hint{margin:0;font-size:11.5px;font-weight:800;color:var(--fmdw-muted);line-height:1.5;text-transform:none;letter-spacing:0}
.fmdw-hint i{margin-right:5px}
.fmdw-card{border:1px solid var(--fmdw-line);border-radius:14px;background:var(--fmdw-card);padding:14px;display:flex;flex-direction:column;gap:11px}
.fmdw-empty{flex:1;min-height:120px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--fmdw-muted);font-size:12.5px;font-weight:850}
.fmdw-empty i{font-size:24px;color:#98a2b3}
/* buttons */
.fmdw-btn{min-height:36px;border:1px solid var(--fmdw-line);border-radius:11px;background:#fff;color:#344054;padding:0 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:12px;font-weight:1000;cursor:pointer;white-space:nowrap;transition:border-color .12s ease,color .12s ease,background .12s ease}
.fmdw-btn:hover{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-btn.primary{background:var(--fmdw-primary);border-color:var(--fmdw-primary);color:var(--fmdw-on-primary)}
.fmdw-btn.primary:hover{filter:brightness(1.07);color:var(--fmdw-on-primary)}
.fmdw-btn.ghost{border-color:transparent;background:transparent;color:var(--fmdw-muted)}
.fmdw-btn.ghost:hover{color:var(--fmdw-primary)}
.fmdw-btn:disabled{opacity:.5;cursor:not-allowed;pointer-events:none}
.fmdw-icon-btn{width:30px;height:30px;flex:none;border:1px solid var(--fmdw-line);border-radius:9px;background:#fff;color:var(--fmdw-muted);display:inline-grid;place-items:center;cursor:pointer;font-size:11px}
.fmdw-icon-btn:hover{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-icon-btn.danger:hover{border-color:#e5484d;color:#e5484d}
.fmdw-row-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* toggle */
.fmdw-toggle-row{display:flex;align-items:center;gap:12px;border:1px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:13px 14px;cursor:pointer;max-width:460px}
.fmdw-toggle{flex:none;width:40px;height:23px;border-radius:99px;background:#d6dbe7;position:relative;transition:background .15s ease;cursor:pointer}
.fmdw-toggle i{position:absolute;top:2.5px;left:3px;width:18px;height:18px;border-radius:99px;background:#fff;transition:left .15s ease;box-shadow:0 1px 3px rgba(15,23,42,.25)}
.fmdw-toggle.on{background:var(--fmdw-primary)}
.fmdw-toggle.on i{left:19px}
.fmdw-toggle-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.fmdw-toggle-copy strong{font-size:12.5px;font-weight:1000}
.fmdw-toggle-copy small{font-size:11px;font-weight:800;color:var(--fmdw-muted)}
/* checkboxes */
.fmdw-check-list{display:flex;flex-direction:column;gap:7px;max-width:460px}
.fmdw-check{display:flex;align-items:center;gap:9px;border:1px solid var(--fmdw-line);border-radius:11px;background:#fff;padding:10px 12px;font-size:12.5px;font-weight:850;cursor:pointer;text-transform:none;letter-spacing:0;color:var(--fmdw-ink)}
.fmdw-check input{width:auto;max-width:none;accent-color:var(--fmdw-primary);margin:0}
/* choice cards */
.fmdw-choice-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.fmdw-choice-card{position:relative;border:1.5px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:13px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;cursor:pointer;font:inherit;text-align:left;color:var(--fmdw-ink);min-width:0;transition:border-color .12s ease,box-shadow .12s ease}
.fmdw-choice-card:hover{border-color:color-mix(in srgb,var(--fmdw-primary) 45%,var(--fmdw-line))}
.fmdw-choice-card.active{border-color:var(--fmdw-primary);background:color-mix(in srgb,var(--fmdw-primary) 5%,#fff);box-shadow:0 0 0 3px color-mix(in srgb,var(--fmdw-primary) 14%,transparent)}
.fmdw-choice-card:disabled{opacity:.6;cursor:default}
.fmdw-choice-img{width:100%;aspect-ratio:4/3;border-radius:9px;overflow:hidden;background:#eef1f6}
.fmdw-choice-img img{width:100%;height:100%;object-fit:cover;display:block}
.fmdw-choice-icon{width:32px;height:32px;border-radius:9px;background:color-mix(in srgb,var(--fmdw-primary) 10%,#fff);color:var(--fmdw-primary);display:grid;place-items:center;font-size:14px}
.fmdw-choice-card strong{font-size:12.5px;font-weight:1000;line-height:1.3}
.fmdw-choice-card small{font-size:10.5px;font-weight:800;color:var(--fmdw-muted);line-height:1.4}
.fmdw-choice-card .fmdw-choice-includes{font-size:11px;font-weight:900;line-height:1.55}
.fmdw-choice-price{font-size:11px;font-weight:1000;color:var(--fmdw-primary)}
.fmdw-choice-tick{position:absolute;top:9px;right:9px;width:20px;height:20px;border-radius:99px;background:var(--fmdw-primary);color:var(--fmdw-on-primary);display:none;place-items:center;font-size:9px}
.fmdw-choice-card.active .fmdw-choice-tick{display:grid}
/* measurements */
.fmdw-meas-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:9px 12px}
.fmdw-meas-field{display:flex;flex-direction:column;gap:4px}
.fmdw-meas-field span{font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:var(--fmdw-muted)}
.fmdw-meas-field.needed input{border-color:#e8b93c;background:#fffdf4}
.fmdw-meas-note{margin:0;font-size:11px;font-weight:900;color:#b58a00}
.fmdw-meas-source{margin:0}
.fmdw-meas-source.ok{color:#067647}
.fmdw-meas-input{display:flex;align-items:center;gap:6px}
.fmdw-meas-input input{min-width:0;flex:1}
.fmdw-meas-input i{flex:none;font-style:normal;font-size:10.5px;font-weight:900;color:var(--fmdw-muted);min-width:16px;text-transform:none}
.fmdw-meas-field span em{font-style:normal;font-weight:900;color:#b58a00;text-transform:none;letter-spacing:0}
.fmdw-meas-field.edited input{border-color:#e8b93c}
.fmdw-meas-extra summary{cursor:pointer;font-size:11px;font-weight:900;color:var(--fmdw-muted)}
.fmdw-meas-extra .fmdw-stat-grid{margin-top:8px}
/* line items review */
/* the lines are the content: no card around the whole list */
.fmdw-section:has(>.fmdw-section-items>.fmdw-item>.fmdw-lir-field){border:0;background:transparent;padding:0;box-shadow:none}
.fmdw-lir{container-type:inline-size;display:flex;flex-direction:column;gap:10px;min-width:0}
.fmdw-lir-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fmdw-lir-stale{margin:0;border:1px solid #f0d58a;background:#fffbea;color:#7a5b00;border-radius:10px;padding:9px 11px;font-size:11.5px;font-weight:850;line-height:1.45}
.fmdw-lir-list,.fmdw-lir-group{display:flex;flex-direction:column;gap:6px;min-width:0}
.fmdw-lir-children{display:flex;flex-direction:column;gap:6px;margin-left:22px;min-width:0}
/* folding: the lines under an item slide away; the chevron and a count say so */
.fmdw-lir-fold-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .2s cubic-bezier(.3,.8,.3,1),opacity .16s ease}
.fmdw-lir-fold-body>.fmdw-lir-children{min-height:0;overflow:hidden}
.fmdw-lir-fold-body.folded{grid-template-rows:0fr;opacity:0}
.fmdw-lir-fold{flex:none;width:20px;height:20px;margin-left:-4px;border:0;border-radius:6px;background:transparent;color:#667085;font-size:9px;cursor:pointer;display:grid;place-items:center;padding:0;transition:transform .16s ease,background .12s ease}
.fmdw-lir-fold:hover{background:#eef1f6;color:#111827}
.fmdw-lir-fold.folded{transform:rotate(-90deg)}
.fmdw-lir-fold-count{font-size:10px;font-weight:900;color:#667085;background:#eef1f6;border-radius:999px;padding:2px 8px;white-space:nowrap}
.fmdw-lir-fold-count[hidden]{display:none}
/* renaming: the name block opens into two fields */
[data-fmdw-rename]{cursor:text}
.fmdw-lir-name.editing>.fmdw-lir-name-line>strong,.fmdw-lir-name.editing>.fmdw-lir-desc,.fmdw-lir-name.editing>strong{display:none}
.fmdw-lir-name.editing .fmdw-lir-name-line{transform:none}
.fmdw-lir-edit{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .2s cubic-bezier(.3,.8,.3,1),opacity .16s ease;min-width:0;width:100%}
.fmdw-lir-edit.open{grid-template-rows:1fr;opacity:1}
.fmdw-lir-edit>*{min-height:0}
.fmdw-lir-edit{row-gap:0}
.fmdw-lir-edit.open{row-gap:5px;padding:2px 0 3px}
.fmdw-lir-edit input,.fmdw-lir-edit textarea{width:100%;min-width:0;box-sizing:border-box;border:1px solid #d4d9e6;border-radius:8px;background:#fff;color:#111827;font:inherit;font-size:12.5px;font-weight:800;padding:6px 9px;outline:none;overflow:hidden}
.fmdw-lir-edit textarea{font-size:11px;font-weight:700;line-height:1.4;resize:vertical;min-height:0}
.fmdw-lir-edit.open textarea{min-height:42px;overflow:auto}
.fmdw-lir-edit input:focus,.fmdw-lir-edit textarea:focus{border-color:var(--fmdw-primary)}
.fmdw-lir-edit-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;overflow:hidden}
.fmdw-lir-edit-actions small{margin-right:auto;font-size:10px;font-weight:800;color:var(--fmdw-muted)}
.fmdw-lir-edit-actions .done{background:var(--fmdw-primary);border-color:var(--fmdw-primary);color:#fff}
/* a choice group side by side */
.fmdw-lir-view{margin-left:auto;display:inline-flex;border:1px solid var(--fmdw-line);border-radius:8px;overflow:hidden;background:#fff}
.fmdw-lir-view button{border:0;background:transparent;color:#667085;font:inherit;font-size:10.5px;font-weight:900;padding:4px 9px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.fmdw-lir-view button.on{background:#111827;color:#fff}
.fmdw-lir-choice-head .fmdw-lir-add-option{margin-left:0}
.fmdw-lir-compare{display:grid;grid-template-columns:repeat(var(--fmdw-cols,3),minmax(0,1fr));gap:8px;margin-left:22px}
.fmdw-lir-col{cursor:pointer;display:flex;flex-direction:column;gap:8px;min-width:0;border:1.5px solid var(--fmdw-line);border-radius:12px;background:#fff;padding:10px 11px;transition:border-color .14s ease,box-shadow .14s ease}
.fmdw-lir-col.on{border-color:var(--fmdw-primary);box-shadow:0 0 0 1px var(--fmdw-primary)}
.fmdw-lir-col-head{display:flex;align-items:flex-start;gap:8px;cursor:pointer;min-width:0}
.fmdw-lir-compare .fmdw-lir-col .fmdw-lir-col-head input[type=radio]{flex:0 0 16px;width:16px;height:16px;min-width:0;margin:2px 0 0;padding:0;accent-color:var(--fmdw-primary)}
.fmdw-lir-col-head .fmdw-lir-name{flex:1 1 auto;min-width:0}
.fmdw-lir-col-head .fmdw-lir-name{min-height:0}
.fmdw-lir-col-head strong{font-size:13px;font-weight:1000}
.fmdw-lir-col .fmdw-lir-desc{height:auto;opacity:1;white-space:normal}
.fmdw-lir-col .fmdw-lir-name-line,.fmdw-lir-col .fmdw-lir-name:has(.fmdw-lir-desc) .fmdw-lir-name-line{transform:none}
.fmdw-lir-col-total{font-size:17px;font-weight:1000;font-variant-numeric:tabular-nums}
.fmdw-lir-col:not(.on) .fmdw-lir-col-total{color:#667085}
.fmdw-lir-col-lines{list-style:none;margin:0;padding:8px 0 0;border-top:1px solid #f0f2f7;display:flex;flex-direction:column;gap:5px}
.fmdw-lir-col-lines li{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;font-weight:800;color:#344054}
.fmdw-lir-col-lines li span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-lir-col-lines li b{font-weight:900;font-variant-numeric:tabular-nums;white-space:nowrap}
.fmdw-lir-col-lines li.off{color:#98a2b3;text-decoration:line-through}
.fmdw-lir-col-empty{margin:0;font-size:11px;font-weight:800;color:var(--fmdw-muted)}
@container (max-width:560px){.fmdw-lir-compare{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.fmdw-lir-fold-body,.fmdw-lir-edit,.fmdw-lir-fold{transition:none}}
.fmdw-lir-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:2px 10px;padding:7px 9px 7px 12px;border:1px solid var(--fmdw-line);border-radius:11px;background:#fff;min-width:0;transition:border-color .12s ease,box-shadow .12s ease}
.fmdw-lir-row:hover,.fmdw-lir-row:focus-within{border-color:#cdd3e0;box-shadow:0 2px 10px rgba(16,24,40,.06)}
.fmdw-lir-row.pick{grid-template-columns:auto minmax(0,1fr) auto auto}
.fmdw-lir-group-head{background:#f4f6fa;padding-top:9px;padding-bottom:9px}
.fmdw-lir-group-head .fmdw-lir-name strong{font-size:13.5px}
.fmdw-lir-group-head .fmdw-lir-amount{font-size:14px}
.fmdw-lir-row.off{background:#fafbfc}
.fmdw-lir-row.off .fmdw-lir-name strong,.fmdw-lir-row.off .fmdw-lir-amount{color:#98a2b3}
.fmdw-lir-row.off .fmdw-lir-amount{text-decoration:line-through}
.fmdw-lir-pick{display:grid;place-items:center}
.fmdw-lir-pick input{width:16px;height:16px;margin:0;accent-color:var(--fmdw-primary);cursor:pointer}
.fmdw-lir-name{min-width:0;flex:1;display:flex;flex-direction:column;justify-content:center;min-height:30px}
.fmdw-lir-name-line{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.fmdw-lir-name strong{font-size:12.5px;font-weight:1000;line-height:1.3;overflow-wrap:anywhere}
/* Descriptions stay out of the way until the line is hovered or focused.
   The name block already has room for one description line (min-height
   above), so revealing it re-centres the text without changing the row's
   height: nothing below moves. */
.fmdw-lir-name strong{line-height:15px}
.fmdw-lir-desc{height:14px;opacity:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10.5px;font-weight:800;color:var(--fmdw-muted);line-height:14px;transition:opacity .14s ease}
.fmdw-lir-name:has(.fmdw-lir-desc) .fmdw-lir-name-line{transform:translateY(7px);transition:transform .14s ease}
.fmdw-lir-row:hover .fmdw-lir-desc,.fmdw-lir-row:focus-within .fmdw-lir-desc{opacity:1}
.fmdw-lir-row:hover .fmdw-lir-name-line,.fmdw-lir-row:focus-within .fmdw-lir-name-line{transform:none}
.fmdw-lir-mod{flex:none;width:16px;height:16px;border-radius:50%;display:inline-grid;place-items:center;font-size:8.5px;font-weight:1000;font-style:normal;line-height:1;background:#fff3dc;color:#8a6100;border:1px solid #f0d58a;cursor:help}
.fmdw-lir-mod.off{background:#f2f4f7;color:#98a2b3;border-color:#e4e7ec;text-decoration:line-through}
.fmdw-lir-nums{display:flex;align-items:center;gap:6px;min-width:0}
.fmdw-lir-num{display:flex;align-items:center;gap:4px;border:1px solid var(--fmdw-line);border-radius:8px;background:#fff;padding:0 7px;height:30px}
.fmdw-lir-num:focus-within{border-color:var(--fmdw-primary)}
.fmdw-lir-num input{width:46px;border:0 !important;outline:0;background:transparent;padding:0 !important;font:inherit;font-size:12px;font-weight:900;text-align:right;box-shadow:none !important;-moz-appearance:textfield}
.fmdw-lir-num.price input{width:58px}
.fmdw-lir-num input::-webkit-outer-spin-button,.fmdw-lir-num input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.fmdw-lir-num i{font-style:normal;font-size:10.5px;font-weight:900;color:var(--fmdw-muted)}
.fmdw-lir-x{font-size:11px;color:#98a2b3}
.fmdw-lir-amount{min-width:78px;text-align:right;font-size:12.5px;font-weight:1000;font-variant-numeric:tabular-nums}
.fmdw-lir-actions{display:flex;align-items:center;gap:5px}
.fmdw-lir-choice{display:flex;flex-direction:column;gap:6px}
/* a choice group is a thin grouping line; its options indent beneath it */
.fmdw-lir-choice-head{display:flex;align-items:center;gap:8px;min-height:30px;padding:3px 9px 3px 12px;border:1px solid var(--fmdw-line);border-radius:11px;background:#f4f6fa}
.fmdw-lir-choice-head strong{font-size:12.5px;font-weight:1000}
.fmdw-lir-choice-head .fmdw-li-flag{cursor:help}
.fmdw-lir-add-option{margin-left:auto;border:0;background:transparent;color:var(--fmdw-muted);font:inherit;font-size:11px;font-weight:900;cursor:pointer;padding:4px 6px;border-radius:7px}
.fmdw-lir-add-option:hover{color:var(--fmdw-primary);background:#fff}
/* colors and options of one line */
.fmdw-lir-variant-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;border:1px solid var(--fmdw-line);border-radius:999px;background:#fff;color:#475467;font:inherit;font-size:10.5px;font-weight:900;padding:2px 8px 2px 4px;cursor:pointer}
.fmdw-lir-variant-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.fmdw-lir-variant-chip>.fas{font-size:8px;transition:transform .12s ease}
.fmdw-lir-variant-chip.open>.fas{transform:rotate(180deg)}
.fmdw-lir-variant-chip:hover,.fmdw-lir-variant-chip.open{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-var-sw{flex:none;width:14px;height:14px;border-radius:50%;border:1px solid rgba(16,24,40,.18)}
.fmdw-lir-variants-wrap{grid-column:1 / -1;display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .22s cubic-bezier(.3,.8,.3,1),opacity .18s ease}
.fmdw-lir-variants-wrap.open{grid-template-rows:1fr;opacity:1}
.fmdw-lir-variants-clip{min-height:0;overflow:hidden}
.fmdw-lir-variants{display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px 26px;border-top:1px solid #f0f2f7;margin-top:7px;padding:11px 6px 6px}
.fmdw-var-dim{flex:0 1 auto;min-width:0;max-width:100%;display:flex;flex-direction:column;gap:7px}
.fmdw-var-head{display:flex;align-items:center;gap:7px;white-space:nowrap}
.fmdw-var-head strong{font-size:10.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#475467}
.fmdw-var-head small{font-size:10px;font-weight:800;color:var(--fmdw-muted);min-width:0;overflow:hidden;text-overflow:ellipsis}
.fmdw-var-all{border:0;background:transparent;color:var(--fmdw-muted);font:inherit;font-size:10px;font-weight:900;cursor:pointer;padding:0;text-decoration:underline;text-underline-offset:2px}
.fmdw-var-all:hover{color:var(--fmdw-primary)}
.fmdw-var-include{position:relative;display:inline-flex;align-items:center;gap:6px;cursor:pointer}
/* Kept inside its label: an absolutely placed input with no positioned parent sits far away, and focusing it scrolls the whole window to reach it. */
.fmdw-var-include input{position:absolute;left:0;top:0;width:13px;height:13px;margin:0;opacity:0;pointer-events:none}
.fmdw-var-include i{width:13px;height:13px;border-radius:4px;border:1.5px solid #c0c6d2;background:#fff;color:transparent;font-size:7px;display:grid;place-items:center;transition:background .12s ease,border-color .12s ease}
.fmdw-var-include input:checked+i{background:var(--fmdw-primary);border-color:var(--fmdw-primary);color:#fff}
.fmdw-var-include input:focus-visible+i{outline:2px solid var(--fmdw-primary);outline-offset:2px}
.fmdw-var-dim.omitted .fmdw-var-head strong{color:#98a2b3}
.fmdw-var-tiles{display:flex;flex-wrap:wrap;gap:7px 6px}
.fmdw-var-dim.omitted .fmdw-var-tiles{opacity:.35;filter:grayscale(1)}
.fmdw-var-tile{position:relative;display:flex;flex-direction:column;gap:3px;width:64px;min-width:0}
.fmdw-var-face{position:relative;height:34px;border:1px solid rgba(16,24,40,.14);border-radius:9px;cursor:pointer;font:inherit;display:grid;place-items:center;padding:0;overflow:hidden;transition:transform .12s ease,box-shadow .12s ease,filter .15s ease}
.fmdw-var-face b{position:relative;z-index:1;font-size:10.5px;font-weight:1000;font-variant-numeric:tabular-nums}
.fmdw-var-face:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 4px 10px rgba(16,24,40,.16)}
.fmdw-var-face:focus-visible{outline:2px solid var(--fmdw-primary);outline-offset:2px}
.fmdw-var-tile>span{font-size:9.5px;font-weight:800;line-height:1.2;text-align:center;color:#344054;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-var-tile.default .fmdw-var-face{box-shadow:0 0 0 2px #fff,0 0 0 4px var(--fmdw-primary)}
.fmdw-var-star{position:absolute;top:-5px;right:-4px;z-index:2;width:17px;height:17px;border:1px solid var(--fmdw-line);border-radius:50%;background:#fff;color:#c0c6d2;font-size:8px;cursor:pointer;display:grid;place-items:center;padding:0;opacity:0;transition:opacity .12s ease}
.fmdw-var-tile:hover .fmdw-var-star,.fmdw-var-star:focus-visible,.fmdw-var-tile.default .fmdw-var-star{opacity:1}
.fmdw-var-star:hover{color:var(--fmdw-primary);border-color:var(--fmdw-primary)}
.fmdw-var-tile.default .fmdw-var-star{background:var(--fmdw-primary);border-color:var(--fmdw-primary);color:#fff}
/* not offered, or ruled out by another option: hatched and washed out */
.fmdw-var-tile.off .fmdw-var-face{filter:grayscale(.85) opacity(.55)}
.fmdw-var-tile.off .fmdw-var-face::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(135deg,transparent 0 5px,rgba(255,255,255,.75) 5px 7px)}
.fmdw-var-tile.off>span{color:#98a2b3;text-decoration:line-through}
.fmdw-var-tile.excluded .fmdw-var-face{cursor:not-allowed}
@media (prefers-reduced-motion:reduce){.fmdw-lir-variants-wrap{transition:none}}
/* add-an-option search */
.fmdw-opt-list{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto}
.fmdw-opt-row{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid transparent;border-radius:9px;background:transparent;font:inherit;text-align:left;padding:7px 8px;cursor:pointer;color:#111827}
.fmdw-opt-row:hover{border-color:var(--fmdw-line);background:#f6f7fb}
.fmdw-opt-row span{min-width:0;display:flex;flex-direction:column;gap:1px}
.fmdw-opt-row strong{font-size:12px;font-weight:1000}
.fmdw-opt-row small{font-size:10.5px;font-weight:800;color:#667085}
.fmdw-opt-row b{flex:none;font-size:12px;font-weight:1000;font-variant-numeric:tabular-nums}
.fmdw-opt-row b i{font-style:normal;font-weight:800;color:#98a2b3}
.fmdw-lir-total{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:4px 12px;font-size:12px;font-weight:900;color:var(--fmdw-muted)}
.fmdw-lir-total b{font-size:17px;font-weight:1000;color:var(--fmdw-ink);font-variant-numeric:tabular-nums}
@container (max-width:500px){
  .fmdw-lir-children{margin-left:12px}
  .fmdw-lir-row{grid-template-columns:minmax(0,1fr) auto}
  .fmdw-lir-row.pick{grid-template-columns:auto minmax(0,1fr) auto}
  .fmdw-lir-row:not(.fmdw-lir-group-head) .fmdw-lir-nums{grid-row:2;grid-column:1 / -1;justify-content:flex-end}
  .fmdw-lir-row.pick .fmdw-lir-nums{grid-column:2 / -1}
  .fmdw-lir-row:not(.fmdw-lir-group-head) .fmdw-lir-actions{grid-row:1;grid-column:-2}
}
/* modifiers panel */
.fmdw-mod-info{margin:0 0 0 4px !important;color:#98a2b3;cursor:help;font-size:11px}
.fmdw-mod-row{display:flex;align-items:center;gap:10px;border-top:1px solid #f0f2f7;padding-top:9px}
.fmdw-mod-row.first{border-top:0;padding-top:0}
.fmdw-mod-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.fmdw-mod-copy strong{font-size:12.5px;font-weight:1000}
.fmdw-mod-copy small{font-size:10.5px;font-weight:800;color:#667085;line-height:1.35}
/* payment schedule */
.fmdw-sched{container-type:inline-size}
.fmdw-sched-row{position:relative;display:grid;grid-template-columns:auto minmax(0,1.3fr) auto minmax(0,1fr) auto auto;align-items:center;gap:8px;min-width:0}
.fmdw-sched-row:has([data-fmdw-sched-date]){grid-template-columns:auto minmax(0,1.3fr) auto minmax(0,1fr) auto auto auto}
.fmdw-sched-grip{border:0;background:transparent;color:#b3bac7;width:18px;height:34px;padding:0;cursor:grab;display:grid;place-items:center;font-size:12px;border-radius:6px;touch-action:none}
.fmdw-sched-grip:hover,.fmdw-sched-grip:focus-visible{color:var(--fmdw-primary);background:#f2f4f7;outline:none}
.fmdw-sched-grip:active{cursor:grabbing}
.fmdw-sched-row.dragging{opacity:.45}
.fmdw-sched-row.drop-before::before,.fmdw-sched-row.drop-after::after{content:"";position:absolute;left:0;right:0;height:2px;border-radius:2px;background:var(--fmdw-primary)}
.fmdw-sched-row.drop-before::before{top:-5px}
.fmdw-sched-row.drop-after::after{bottom:-5px}
.fmdw-sched-presets{display:inline-flex;flex-wrap:wrap;gap:6px;margin-left:auto}
.fmdw-sched-pill{border:1px solid var(--fmdw-line);background:#fff;color:#344054;border-radius:999px;height:30px;padding:0 13px;font:inherit;font-size:11.5px;font-weight:900;font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;transition:border-color .12s ease,color .12s ease,background .12s ease}
.fmdw-sched-pill:hover,.fmdw-sched-pill:focus-visible{border-color:var(--fmdw-primary);color:var(--fmdw-primary);background:color-mix(in srgb,var(--fmdw-primary) 7%,#fff);outline:none}
.fmdw-sched-gap{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.fmdw-sched-gap span{flex:1 1 200px}
.fmdw-sched-gap .fmdw-btn{min-height:30px;padding:0 11px;font-size:11px}
.fmdw-sched-row input,.fmdw-sched-row select{min-width:0;height:34px;padding:0 9px;font-size:12px;border-radius:9px}
.fmdw-sched-amount{display:flex;align-items:center;gap:4px}
.fmdw-sched-amount select{width:52px}
.fmdw-sched-amount input{width:84px;text-align:right}
.fmdw-sched-cents{min-width:88px;text-align:right;font-size:12.5px;font-weight:1000;font-variant-numeric:tabular-nums}
.fmdw-sched-summary{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11.5px;font-weight:850;color:var(--fmdw-muted)}
.fmdw-sched-summary b{color:var(--fmdw-ink);font-weight:1000;font-variant-numeric:tabular-nums}
@container (max-width:560px){
  .fmdw-sched-row,.fmdw-sched-row:has([data-fmdw-sched-date]){grid-template-columns:auto minmax(0,1fr) auto auto;padding-bottom:8px;border-bottom:1px solid #f0f2f7}
  .fmdw-sched-label{grid-column:2 / -2}
  .fmdw-sched-due{grid-column:1 / 3}
}
/* review */
.fmdw-review-total{flex-direction:row;align-items:baseline;justify-content:space-between;gap:12px}
.fmdw-review-total span{font-size:11px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:var(--fmdw-muted)}
.fmdw-review-total b{font-size:22px;font-weight:1000;font-variant-numeric:tabular-nums}
.fmdw-review-checks{gap:8px;border-color:#f0d58a;background:#fffbea}
.fmdw-review-checks p{margin:0;font-size:11.5px;font-weight:850;line-height:1.45;color:#7a5b00}
.fmdw-stat-grid{display:flex;flex-wrap:wrap;gap:7px}
.fmdw-stat{display:inline-flex;flex-direction:column;gap:1px;border:1px solid var(--fmdw-line);border-radius:9px;padding:6px 9px;background:#fafbfe}
.fmdw-stat i{font-style:normal;font-size:9px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:var(--fmdw-muted)}
.fmdw-stat b{font-size:11.5px;font-weight:1000}
/* photos */
.fmdw-photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
.fmdw-photo{position:relative;border:2px solid transparent;border-radius:11px;overflow:hidden;background:#eef1f6;padding:0;cursor:pointer;aspect-ratio:1/1}
.fmdw-photo img{width:100%;height:100%;object-fit:cover;display:block}
.fmdw-photo.active{border-color:var(--fmdw-primary)}
.fmdw-photo.active i{position:absolute;right:6px;top:6px;color:var(--fmdw-primary);background:#fff;border-radius:99px;font-size:14px}
/* line items */
.fmdw-li-list{display:flex;flex-direction:column;gap:6px}
.fmdw-li-row{display:flex;align-items:center;gap:8px;border:1px solid var(--fmdw-line);border-radius:11px;background:#fff;padding:8px 10px;min-width:0}
.fmdw-li-row.child{margin-left:22px}
.fmdw-li-name{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fmdw-li-name strong{font-size:12.5px;font-weight:1000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-li-name small{font-size:10.5px;font-weight:800;color:var(--fmdw-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-li-name input{max-width:none;padding:6px 9px;font-size:12px;border-radius:8px}
.fmdw-li-qty{width:74px !important;flex:none;padding:6px 8px !important;font-size:12px !important;border-radius:8px !important;text-align:right}
.fmdw-li-price{width:96px !important;flex:none;padding:6px 8px !important;font-size:12px !important;border-radius:8px !important;text-align:right}
.fmdw-li-unit{flex:none;font-size:10.5px;font-weight:900;color:var(--fmdw-muted);min-width:22px}
.fmdw-li-total{display:flex;align-items:center;justify-content:flex-end;gap:10px;font-size:12px;font-weight:900;color:var(--fmdw-muted)}
.fmdw-li-total b{font-size:14px;font-weight:1000;color:var(--fmdw-ink)}
/* piece select (native "What are we doing?" type cards) */
.fmdw-piece-grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.fmdw-piece-type{--fmdw-piece-color:var(--fmdw-primary);gap:8px;padding:15px 14px}
.fmdw-piece-type-icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:16px;background:color-mix(in srgb,var(--fmdw-piece-color) 11%,#fff);color:var(--fmdw-piece-color)}
.fmdw-piece-type.active{border-color:var(--fmdw-primary)}
/* line-item review flags */
.fmdw-li-name-line{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.fmdw-li-name-line strong{font-size:12.5px;font-weight:1000;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-li-flag{flex:none;display:inline-flex;align-items:center;border-radius:999px;padding:2px 8px;font-size:9px;font-weight:1000;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
.fmdw-li-flag.optional{background:#fff3dc;color:#b58a00}
.fmdw-li-flag.choice{background:#e8efff;color:#1d4ed8}
.fmdw-li-flag.included{background:#eef0f5;color:#5a6382}
/* line-item media attach */
.fmdw-li-thumb{flex:none;width:26px;height:20px;border-radius:6px;overflow:hidden;background:#eef1f6;border:1px solid var(--fmdw-line);display:inline-grid;place-items:center}
.fmdw-li-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.fmdw-li-thumb.video{background:#111827;color:#fff;font-size:10px}
.fmdw-icon-btn.has-media{border-color:color-mix(in srgb,var(--fmdw-primary) 55%,var(--fmdw-line));color:var(--fmdw-primary);background:color-mix(in srgb,var(--fmdw-primary) 7%,#fff)}
.fmdw-attach-pop{--fmdw-primary:var(--cp-primary,var(--fm-primary,var(--primary,#2563EB)));--fmdw-on-primary:var(--cp-on-primary,var(--fmdx-on-primary,#fff));--fmdw-line:#e4e7ec;--fmdw-muted:#667085;--fmdw-ink:#111827;
  position:fixed;z-index:2147483400;box-sizing:border-box;border:1px solid var(--fmdw-line);border-radius:14px;background:#fff;box-shadow:0 18px 48px rgba(16,24,40,.22);padding:12px;display:flex;flex-direction:column;gap:10px;max-height:min(520px,calc(100vh - 16px));overflow:auto;font-size:12px;color:#111827}
.fmdw-attach-pop *{box-sizing:border-box}
.fmdw-attach-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:10px;font-weight:1000;text-transform:uppercase;letter-spacing:.05em;color:#667085}
.fmdw-attach-head i{margin-right:5px}
.fmdw-attach-x{border:0;background:transparent;color:#98a2b3;width:24px;height:24px;border-radius:7px;cursor:pointer;display:grid;place-items:center;font-size:12px}
.fmdw-attach-x i{margin:0}
.fmdw-attach-x:hover{background:#f2f4f7;color:#344054}
.fmdw-attach-body{display:flex;align-items:stretch;gap:10px}
.fmdw-attach-thumb{position:relative;flex:none;width:104px;min-height:78px;border:1px dashed #cfd5e2;border-radius:11px;background:#f6f7fb;color:#98a2b3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;font:inherit;font-size:10px;font-weight:900;overflow:hidden;padding:0}
.fmdw-attach-thumb.pick{cursor:pointer}
.fmdw-attach-thumb.pick:hover{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-attach-thumb i{font-size:17px}
.fmdw-attach-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.fmdw-attach-thumb img~i,.fmdw-attach-thumb img~span{display:none}
.fmdw-attach-fields{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
.fmdw-attach-link{display:flex;align-items:center;gap:6px}
.fmdw-attach-pop input[type=text],.fmdw-attach-pop select{width:100%;min-width:0;border:1px solid #d4d9e6;border-radius:9px;background:#fff;color:#111827;padding:8px 10px;font:inherit;font-size:12px;font-weight:800;outline:none}
.fmdw-attach-pop input[type=text]:focus,.fmdw-attach-pop select:focus{border-color:var(--fmdw-primary)}
.fmdw-attach-more summary{cursor:pointer;font-size:10.5px;font-weight:900;color:#667085}
.fmdw-attach-more select{margin-top:7px}
.fmdw-attach-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}
.fmdw-attach-actions [data-fmdw-attach-save]{margin-left:auto;min-width:92px}
.fmdw-attach-placeholder{display:none}
.fmdw-attach-pop.library .fmdw-attach-title{flex:1}
.fmdw-attach-library{max-height:min(480px,calc(100vh - 110px));min-height:160px;overflow:auto;text-transform:none;letter-spacing:0}
/* content blocks */
.fmdw-cb-list{display:flex;flex-direction:column;gap:10px}
.fmdw-cb-card{border:1px solid var(--fmdw-line);border-radius:14px;background:#fff;padding:12px;display:flex;flex-direction:column;gap:9px}
.fmdw-cb-head{display:flex;align-items:center;gap:8px}
.fmdw-cb-index{flex:none;width:24px;height:24px;border-radius:99px;display:grid;place-items:center;font-size:10.5px;font-weight:1000;background:color-mix(in srgb,var(--fmdw-primary) 10%,#fff);color:var(--fmdw-primary)}
.fmdw-cb-title{flex:1;min-width:0;max-width:none !important}
.fmdw-cb-body{min-height:64px;max-width:none !important}
.fmdw-cb-main{display:flex;align-items:stretch;gap:10px;min-width:0}
.fmdw-cb-main .fmdw-cb-body{flex:1;min-width:0;min-height:84px}
.fmdw-cb-thumb{position:relative;flex:none;width:118px;min-height:84px;border-radius:11px;overflow:hidden;background:#f6f7fb;border:1px dashed #cfd5e2;color:#98a2b3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;font:inherit;font-size:10px;font-weight:900;cursor:pointer;padding:0;transition:border-color .12s ease,color .12s ease}
.fmdw-cb-thumb:not(.empty){border-style:solid;border-color:var(--fmdw-line)}
.fmdw-cb-thumb:hover:not(:disabled){border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-cb-thumb:disabled{cursor:default}
.fmdw-cb-thumb i{font-size:18px}
.fmdw-cb-thumb img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.fmdw-cb-thumb img~span{position:absolute;left:6px;bottom:6px;background:rgba(17,20,28,.72);color:#fff;border-radius:999px;padding:3px 8px;opacity:0;transition:opacity .12s ease}
.fmdw-cb-thumb:hover img~span,.fmdw-cb-thumb:focus-visible img~span{opacity:1}
.fmdw-cb-settings{display:flex;gap:10px;flex-wrap:wrap}
.fmdw-cb-settings label{flex:1 1 160px;min-width:0;display:flex;flex-direction:column;gap:3px;font-size:9.5px;font-weight:1000;text-transform:uppercase;letter-spacing:.04em;color:#8a94a6}
.fmdw-cb-settings select{max-width:none !important;padding:7px 9px !important;font-size:12px !important;border-radius:9px !important}
/* piece picker / status cards */
.fmdw-piece-card,.fmdw-status-card{flex-direction:row;align-items:center;gap:13px}
.fmdw-piece-icon,.fmdw-status-icon{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:15px;background:color-mix(in srgb,var(--fmdw-primary) 10%,#fff);color:var(--fmdw-primary)}
.fmdw-status-card.done .fmdw-status-icon{background:#d7f5e3;color:#0c5f36}
.fmdw-piece-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fmdw-piece-copy strong{font-size:12.5px;font-weight:1000}
.fmdw-piece-copy small{font-size:11px;font-weight:800;color:var(--fmdw-muted)}
/* piece picker — embedded scope builder */
.fmdw-piece-embed{padding:0;overflow:hidden;gap:0}
.fmdw-piece-embed-head{display:flex;align-items:center;gap:13px;padding:12px 14px;border-bottom:1px solid var(--fmdw-line);background:#fafbfe}
.fmdw-piece-embed-host{min-height:340px;display:flex;flex-direction:column;background:#fff}
.fmdw-piece-embed-host>*{flex:1;min-height:0}
/* review */
.fmdw-gen-doc{display:flex;align-items:center;gap:11px;border:1px solid #e4e7ec;border-radius:12px;background:#fbfcfe;padding:11px 13px;min-width:0}
.fmdw-gen-doc i{font-size:16px;color:#98a2b3;flex:none}
.fmdw-gen-doc.done{border-color:#b5e3c8;background:#f2fbf6}
.fmdw-gen-doc.done i{color:#12b76a}
.fmdw-gen-doc-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.fmdw-gen-doc-copy strong{font-size:12.5px;font-weight:950;color:#101828;text-transform:none;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-gen-doc-copy small{font-size:10.5px;font-weight:800;color:#8a92ab;text-transform:none;letter-spacing:0}
.fmdw-gen-doc-open{flex:none;border:1px solid #d0d5dd;border-radius:9px;background:#fff;color:#344054;font:inherit;font-size:11.5px;font-weight:900;padding:7px 12px;cursor:pointer}
.fmdw-gen-doc-open:hover{border-color:var(--fmdw-primary,#2563EB);color:var(--fmdw-primary,#2563EB)}
.fmdw-review{gap:0;padding:4px 14px}
.fmdw-review-row{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid #f0f2f7;font-size:12px;font-weight:850}
.fmdw-review-row:last-child{border-bottom:0}
.fmdw-review-row span{color:var(--fmdw-muted);text-transform:none;letter-spacing:0}
.fmdw-review-row span em{font-style:normal;font-size:10px;color:#98a2b3}
.fmdw-review-row b{font-weight:1000;text-align:right;min-width:0;overflow-wrap:anywhere}
.fmdw-review-row.muted{opacity:.65}
/* widgets */
.fmdw-widget-host{min-height:60px}
/* preview pane — same flex basis as the step content (~50/50 after the rail) */
.fmdw-preview{flex:0 0 var(--fmdw-preview-w,44%);min-width:0;background:#eef1f5;display:flex;flex-direction:column}
.fmdw-resizer{flex:none;width:7px;margin:0 -3px;z-index:2;cursor:col-resize;position:relative;touch-action:none}
.fmdw-resizer::after{content:'';position:absolute;top:0;bottom:0;left:3px;width:1px;background:var(--fmdw-line)}
.fmdw-resizer:hover::after,.fmdw.resizing .fmdw-resizer::after{left:2px;width:3px;background:var(--fmdw-primary)}
.fmdw.resizing{user-select:none;cursor:col-resize}
.fmdw.resizing .fmdw-preview-stage{pointer-events:none}
.fmdw.preview-hidden .fmdw-preview,.fmdw.preview-hidden .fmdw-resizer{display:none}
.fmdw-preview-toggle.active{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
/* compact rail: numbered dots only, titles on hover */
.fmdw.compact-rail .fmdw-rail{width:58px}
.fmdw.compact-rail .fmdw-rail-head{display:none}
.fmdw.compact-rail .fmdw-step{justify-content:center;padding:9px 0}
.fmdw.compact-rail .fmdw-step-title{display:none}
.fmdw.compact-rail .fmdw-step-head{padding:14px 14px 2px}
.fmdw.compact-rail .fmdw-items{padding:12px 14px 16px}
.fmdw.compact-rail .fmdw-foot{padding:10px 14px}
.fmdw.narrow .fmdw-preview-toggle span{display:none}
.fmdw-preview-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--fmdw-line);background:#fff}
.fmdw-preview-zoom{display:flex;align-items:center;gap:5px}
.fmdw-scg-group{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.fmdw-zoom-pct{min-width:44px;height:28px;border:1px solid var(--fmdw-line);border-radius:8px;background:#fff;color:#344054;font:inherit;font-size:11px;font-weight:800;cursor:pointer;padding:0 6px}
.fmdw-zoom-pct:hover{border-color:var(--fmdw-primary);color:var(--fmdw-primary)}
.fmdw-preview-head strong{font-size:11.5px;font-weight:1000;color:var(--fmdw-muted);text-transform:uppercase;letter-spacing:.05em}
.fmdw-preview-head strong i{margin-right:6px}
.fmdw-preview.loading .fmdw-preview-head strong i{animation:fmdw-spin .8s linear infinite}
.fmdw-preview-stage{flex:1;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;align-items:center;gap:12px}
.fmdw-preview-stage .fmdoc-page{box-shadow:0 10px 28px rgba(16,24,40,.14);border-radius:4px;overflow:hidden;background:#fff}
.fmdw-preview-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;color:#98a2b3;font-size:12px;font-weight:850;text-align:center;padding:22px}
.fmdw-preview-empty i{font-size:26px}
@keyframes fmdw-spin{to{transform:rotate(360deg)}}
.fmdw-btn[hidden]{display:none}
/* portal theme */
.fmdw.fmdw-portal{--fmdw-bg:#f6f8fb}
.fmdw.fmdw-portal .fmdw-rail-head strong{color:var(--fmdw-primary)}
/* full-screen overlay chrome (used by portal + any host needing a takeover) */
.fmdw-overlay{position:fixed;inset:0;z-index:2147483540;background:#f6f8fb;display:flex;flex-direction:column}
.fmdw-overlay-head{flex:none;display:flex;align-items:center;gap:12px;padding:12px 18px;background:#fff;border-bottom:1px solid #e4e7ec}
.fmdw-overlay-head strong{font-size:14px;font-weight:1000;color:#101828;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fmdw-overlay-head .fmdw-overlay-close{margin-left:auto}
.fmdw-overlay-close{width:36px;height:36px;border:1px solid #e4e7ec;border-radius:11px;background:#fff;color:#5a6382;display:grid;place-items:center;cursor:pointer;font-size:13px}
.fmdw-overlay-close:hover{border-color:#b42318;color:#b42318}
.fmdw-overlay-body{flex:1;min-height:0;display:flex}
.fmdw-overlay-body>*{flex:1;min-width:0}
/* responsive */
@media(max-width:760px){
  .fmdw{flex-direction:column}
  .fmdw-rail,.fmdw.compact-rail .fmdw-rail{width:100%;max-width:100%;min-width:0;max-height:none;overflow:hidden;border-right:0;border-bottom:1px solid var(--fmdw-line)}
  .fmdw.compact-rail .fmdw-step{padding:9px 10px}
  .fmdw-steps{flex-direction:row;overflow-x:auto;overflow-y:hidden;padding:8px;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
  .fmdw-step{flex:none}
  .fmdw-step-title{max-width:120px}
  .fmdw-section-items{grid-template-columns:1fr}
}`;

  function ensureStyles(){
    if (typeof document === 'undefined' || document.getElementById('fmdw-styles')) return;
    const style = document.createElement('style');
    style.id = 'fmdw-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ================================================================ export
  root.FMDocWorkflow = {
    version: 1,
    mount,
    registerKind,
    kinds(){ return [...kindRegistry.keys()]; },
    ensureStyles,
    /** Line-item media/video attach popover — shared with the documents app's
     *  scope editor. openMediaAttach({ anchor, item, services:{media},
     *  onSave(patch) }) where patch = { media:[{media_id|url,caption?}],
     *  video:{url,caption?}|null, display:"inline"|"popup" }. */
    openMediaAttach,
    // exposed for hosts/tests
    helpers: { evalExpr, whenPasses, resolveOptions, formatValue, stepVisibleFor, itemVisibleFor, normalizeScopeItem, scopeItemsTotal, normalizeContentBlock }
  };
})();
