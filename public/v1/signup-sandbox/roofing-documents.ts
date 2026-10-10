import type { PlatformAuthContext } from '../platform/auth.js';
import { contentBlockStyles, contentBlocksRepeater, ensureDefaultDocumentAssets, lineItemBlocks, lineItemStyles, mediaTextRowComponent, proposalLineItemComponents, startFlowTemplate } from '../documents/seeds.js';
import { createDocumentTemplate, createDocumentWorkflow, publishDocumentTemplate, publishDocumentWorkflow, readDocumentTemplate, readDocumentWorkflow } from '../documents/storage.js';
import { FMDocModel } from '../documents/schemas.js';
import { addFlowPage, componentColumn, componentRow, flowColumn, flowComponent, flowLogo, flowRepeater, flowRow, flowSpacer, flowText, flowWidget, labeledText, type RunSpec } from '../documents/template-kit.js';
import { getOrganizationPricebook } from '../pricebook/storage.js';
import type { JsonObject } from '../platform/storage.js';

/**
 * The sales documents a roofing organization starts with. `scope` names the
 * scope piece the server prices from measurements (pricebook/scope-generation)
 * and that signing starts; `variant` asks for it another way ("options":
 * Good / Better / Best). The estimates without a scope price from a few
 * inputs. `presentation` is the deck its last step offers.
 */
export const ROOFING_ESTIMATES = [
  { key: 'detailed', title: 'Roof replacement · Itemized proposal', theme: 'thm_margin', scope: 'roof_replacement', variant: '', presentation: 'itemized', description: 'Every line priced from the roof measurements and your price book, with the product choices the customer can make.' },
  { key: 'onepage', title: 'Roof replacement · One-page proposal', theme: 'thm_clean', scope: 'roof_replacement', variant: '', presentation: 'itemized', description: 'The same priced scope on a single page: scope summary, total, terms and signature.' },
  { key: 'options', title: 'Roof replacement · Good / Better / Best', theme: 'thm_margin', scope: 'roof_replacement', variant: 'options', presentation: 'options', description: 'Three complete roofs from one set of measurements. The customer compares them, picks one, signs and pays the deposit.' },
  { key: 'gutters', title: 'Gutters · Estimate', theme: 'thm_clean', scope: 'gutters', variant: '', presentation: 'gutters', description: 'A gutter job on its own: removal, new seamless gutters and downspouts, with gutter guards as an option.' },
  { key: 'quick', title: 'Roof replacement · Per-square estimate', theme: 'thm_clean', scope: '', variant: '', presentation: '', description: 'A concise roof estimate priced by area, with measured accessories supplied separately.' },
  { key: 'package', title: 'Summer roof · Fixed-price proposal', theme: 'thm_triangles', scope: '', variant: '', presentation: '', description: 'A fixed-price HDZ roofing package. The selling price does not change the physical material quantities.' }
] as const;

type EstimateSpec = typeof ROOFING_ESTIMATES[number];
const obj = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const dataBinding = (name: string, project = false) => ({ kind: 'data', policy: 'frozen', required: !project,
  source: { provider: 'materials-inputs', export: name, target: { scope: project ? 'project' : 'organization', organizationId: '$organization', ...(project ? { projectId: '$project' } : {}) } } });

/** This code travels with the accepted document, never with the project UI. */
export function roofingCalculus(mode: string, scoped = mode === 'detailed') {
  return {
    type: 'materials_calculus', key: `roofing_${mode}`, title: mode === 'gutters' ? 'Gutters' : 'Roof replacement',
    bindings: { products: dataBinding('products'), measurements: dataBinding('measurements', true) },
    source: `const p = inputs.document.params;
const products = await api.data.read('products');
const dataset = await api.data.read('measurements');
const measured = dataset?.measurements || {};
const warnings = [], lines = [];
const scoped = ${JSON.stringify(scoped)};
function amount(value, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(label + ' must be a nonnegative number'); return value; }
function length(key, label) {
  const v = measured[key];
  if (!v || v.value === null || (v.status && v.status !== 'ready')) { warnings.push('Missing ' + label + ': review and add this accessory before ordering.'); return null; }
  if (!['ft','lf'].includes(v.unit)) throw new Error(label + ' must be measured in feet');
  return amount(v.value, label);
}
function add(key, id, quantity, group, explanation, variant = '') {
  if (quantity === null || quantity === 0) return;
  const product = products.find(x => x.id === id);
  if (!product) throw new Error('The shared price book is missing product ' + id);
  lines.push({ key, product_id: id, name: product.name, quantity: amount(quantity, product.name), unit: product.unit,
    ...(product.packaging ? {packaging: product.packaging} : {}), variant, structure: p.structure || 'Main house', group, explanation });
}
if (scoped) {
  // The accepted scope is the order: options and add-ons the customer passed over are not on it.
  const physical = new Set(['gaf_hd','gaf_ns','gaf_uhdz','laminated_shingles','three_tab_shingles','starter','ridge_cap','underlayment','gaf_feltbuster','gaf_tiger_paw','drip_edge','valley_metal','ridge_vent','gutter_replace','downspout','gutter_guard']);
  function walk(rows, path) { (rows || []).forEach((r, index) => {
    if (r.selected === false || r.excluded === true || r.selection?.selected === false) return;
    const key = path + '_' + index;
    const id = r.pricebook_ref?.item_id || r.item_ref || r.catalog_item_id || r.id;
    if (physical.has(id) || products.find(x=>x.id===id)?.packaging) add(key, id, amount(Number(r.quantity), r.name || id), 'Accepted scope', 'Quantity accepted on the proposal', r.variation_id || r.variant_id || r.variables?.color || p.color || '');
    walk(r.children, key);
  }); }
  walk(p.scope_items, 'scope');
  if (!lines.length) throw new Error('Select physical price-book materials on the proposal before generating materials.');
  warnings.push('Quantities follow the accepted scope; check flashing, ventilation and accessories on site before ordering.');
} else {
  const squares = amount(p.roof_squares, 'Roof squares');
  if (!squares) throw new Error('Enter the accepted roof area before generating materials.');
  const waste = amount(p.waste_percent, 'Waste percent');
  if (waste > 50) throw new Error('Review waste above 50% before generating materials.');
  const required = squares * (1 + waste / 100);
  add('shingles', 'gaf_hd', required, 'Roof covering', 'Accepted roof area plus ' + waste + '% waste', p.color || 'charcoal');
  add('underlayment', 'underlayment', required, 'Roof covering', 'Roof area plus the accepted waste allowance');
  const eaves = length('eavesLf','eaves'), rakes = length('rakesLf','rakes');
  if (eaves !== null && rakes !== null) { add('starter','starter',eaves+rakes,'Perimeter','Measured eaves + rakes'); add('drip','drip_edge',eaves+rakes,'Perimeter','Measured eaves + rakes'); }
  const hips = length('hipsLf','hips'), ridges = length('ridgesLf','ridges');
  if (hips !== null && ridges !== null) add('cap','ridge_cap',hips+ridges,'Ridges & hips','Measured hips + ridges');
  if (p.ridge_vent === true && ridges !== null) add('vent','ridge_vent',ridges,'Ventilation','Measured ridges; verify usable vent length on site');
  warnings.push('Confirm ice barrier, wall/penetration flashing, fasteners and ventilation requirements on site. These are not inferred from roof area.');
}
return {outputs:{lines,warnings}};`
  };
}

const DEFAULT_SCHEDULE = [
  { id: 'deposit', label: 'Deposit', kind: 'percent', percent: 30, payment_kind: 'deposit', due_rule: 'on_signature' },
  { id: 'final', label: 'Final payment', kind: 'percent', percent: 70, payment_kind: 'final', due_rule: 'project_completion' }
];
const TERMS = 'This proposal is valid for 30 days. Work is scheduled once the signed proposal and deposit are received. Hidden damage found after tear-off, such as rotted decking, and any work not listed here are priced and approved in writing before they are done. Manufacturer warranties cover materials; our workmanship is warranted as stated in your warranty certificate. The balance is due as shown in the payment terms.';
const bodyFont = (sizePt: number, extra: JsonObject = {}) => ({ family: 'var(--fm-body-font)', size_pt: sizePt, color: 'var(--fm-text)', ...extra });
const mutedFont = (sizePt: number, extra: JsonObject = {}) => bodyFont(sizePt, { color: 'var(--fm-color-muted)', ...extra });
const displayFont = (sizePt: number, extra: JsonObject = {}) => ({ family: 'var(--fm-display-font)', size_pt: sizePt, weight: 800, color: 'var(--fm-text)', ...extra });
/** Signature beside the deposit, the way every proposal here is approved. */
const approvalRow = (height = 100) => flowRow([
  flowWidget('doc.signature@1', { output: 'sig_customer', label: 'Customer approval', signer: 'customer' }, { grow: 1, h: height }),
  flowWidget('doc.pay_now@1', { label: 'Deposit due' }, { w: 190, h: height })
], { gap: 24 });
/** Who the proposal is from and for: logo and company on the left, customer and address on the right. */
const partiesRow = () => flowRow([
  flowColumn([
    flowLogo({ w: 150, h: 34 }),
    flowText([{ text: '', bind: "coalesce(org.name, '')" }], { font: mutedFont(10.5, { weight: 700 }) })
  ], { grow: 1, gap: 4 }),
  labeledText('Prepared for', [{ text: '', bind: "coalesce(customer.name, 'Customer')" }, { text: '\n' }, { text: '', bind: "coalesce(project.address, project.title, '')", font: { weight: 400, color: 'var(--fm-color-muted)' } }], { grow: 1, align: 'right', size_pt: 11 })
], { gap: 20 });

/** Params every proposal priced from a generated scope shares. */
function scopedParams(spec: EstimateSpec): JsonObject {
  return {
    structure: { type: 'string', label: 'Structure', default: 'Main house' },
    scope_items: { type: 'list', items: { type: 'pricebook_line' }, label: 'Accepted scope', default: [] },
    // The document IS this kind of job: its scope piece is fixed, so the
    // workflow never asks which kind of project this is.
    scope_pieces: { type: 'list', items: { type: 'object' }, label: 'Project work', default: [{ id: `piece_${spec.scope}`, template_id: spec.scope, ...(spec.variant ? { variant: spec.variant } : {}), name: spec.scope === 'gutters' ? 'Gutter Replacement' : 'Roof Replacement' }] },
    measurement_requirements: { type: 'list', items: { type: 'string' } },
    measurements: { type: 'measurements', label: 'Measurements' },
    payment_schedule: { type: 'payment_schedule', label: 'Payment terms', default: DEFAULT_SCHEDULE },
    // Workflow bookkeeping: which measurements the lines were generated
    // from, whether the customer has options to pick, and whether a
    // deposit falls due at signing (they gate the customer's steps).
    scope_generated_from: { type: 'string' },
    customer_choice_count: { type: 'number', default: 0 },
    deposit_at_signing: { type: 'boolean', default: true }
  };
}
const scopedOutputs = () => ({
  // Customer picks in the proposal's choice groups; recording them
  // moves the selection onto params.scope_items, so the price follows.
  selections: { type: 'select', applies: 'scope_selections', label: 'Your options' },
  sig_customer: { type: 'signature', required: true, signer: 'customer' },
  deposit_payment: { type: 'payment', obligation: 'deposit', required_for: 'completed' }
});
function finishScoped(doc: JsonObject, spec: EstimateSpec, params: JsonObject, components: JsonObject = {}, styles: JsonObject = {}) {
  doc.components = { ...proposalLineItemComponents(), ...components };
  doc.styles = { ...lineItemStyles(), ...styles };
  doc.params = { ...scopedParams(spec), ...params };
  doc.outputs = scopedOutputs();
  doc.computed = { subtotal_cents: 'sum(params.scope_items[].amount_cents)', tax_cents: '0', total_cents: 'computed.subtotal_cents' };
  doc.program = { enabled: false, deliverables: [roofingCalculus(spec.key, true)] };
  return doc;
}

/** Everything on one page: who, what, how much, the terms and the signature. */
function onePageDefinition(spec: EstimateSpec) {
  const { doc, theme } = startFlowTemplate(spec.theme, 'proposal');
  // One line of the scope summary: the work and its quantity, no price.
  const summaryName = (weight: number) => flowText([{ bind: 'coalesce(item.display_name, item.name)' }, { bind: "coalesce(item.variant_summary, '') != '' ? concat('  ·  ', item.variant_summary) : ''", font: { weight: 400, color: 'var(--fm-color-muted)' } }], { font: bodyFont(8.6, { weight }), grow: 1 });
  const summaryQuantity = () => flowText([{ bind: 'item.quantity | qty(item.unit)' }], { font: mutedFont(8.6), align: 'right', w: 62 });
  const summaryRow = componentRow([summaryName(500), summaryQuantity()], { gap: 6, padding: [1, 12, 1, 0] });
  addFlowPage(doc, theme, 'body', 'Proposal', [
    partiesRow(),
    flowSpacer(2),
    flowRow([
      flowColumn([
        flowText([{ text: 'Roof replacement proposal' }], { style_ref: 'h2' }),
        flowText([{ text: 'Complete tear-off and replacement of the roof at the address above, as summarized below.' }], { font: mutedFont(9.5) })
      ], { grow: 1, gap: 4 }),
      flowColumn([
        flowText([{ text: 'TOTAL' }], { font: mutedFont(8, { weight: 800 }), align: 'right' }),
        flowText([{ bind: 'computed.total_cents | money' }], { font: displayFont(24), align: 'right' })
      ], { w: 190, gap: 0, padding: [10, 14, 10, 14], fill: 'color-mix(in srgb, var(--fm-primary) 7%, var(--fm-color-paper))' })
    ], { gap: 20, align: 'center' }),
    flowText([{ text: 'Scope of work' }], { font: displayFont(11) }),
    flowRepeater({
      source: '{{coalesce(params.scope_rows, params.scope_items)}}', component: 'scope_summary_row', as: 'row',
      layout: { direction: 'column', columns: 2, gap_pt: 2 },
      empty_text: 'The scope appears here once the line items are generated.'
    }),
    flowText([{ text: 'Payment terms' }], { font: displayFont(11) }),
    flowWidget('doc.payment_schedule@1', { source: 'params.payment_schedule' }),
    flowText([{ text: 'Terms' }], { font: displayFont(11) }),
    flowText([{ text: TERMS }], { font: mutedFont(8) }),
    flowSpacer(2),
    approvalRow(88)
  ], { gap: 8 });
  return finishScoped(doc, spec, {}, {
    scope_summary_row: { params: { item: { type: 'pricebook_line' } }, root: summaryRow, variants: {
      // The piece heads its lines; alone on a row it would read as a line with no quantity.
      group: { children: [summaryName(800)] }
    } }
  });
}

/** One card of the comparison: the option, its price and what sets it apart. */
function optionCardComponent(): JsonObject {
  const badge = flowText([{ bind: "option.selected ? '✓ Selected' : ''" }], { font: bodyFont(8.5, { weight: 800, color: 'var(--fm-primary)' }) });
  return {
    option_card: { params: { option: { type: 'object' } }, root: componentColumn([
      flowText([{ bind: "coalesce(option.name, 'Option')" }], { font: displayFont(13) }),
      flowText([{ bind: 'coalesce(option.price_cents, 0) | money' }], { font: displayFont(17, { color: 'var(--fm-primary)' }) }),
      flowText([{ bind: "coalesce(option.description, '')" }], { font: mutedFont(8.4) }),
      flowText([{ bind: "join(option.highlights, '\n')" }], { font: bodyFont(8.6, { weight: 600 }) }),
      badge
    ], { gap: 5, padding: [12, 12, 12, 12], fill: 'color-mix(in srgb, var(--fm-primary) 5%, var(--fm-color-paper))' }) }
  };
}

/** Three complete roofs side by side, then the lines of the one selected. */
function optionsDefinition(spec: EstimateSpec) {
  const { doc, theme } = startFlowTemplate(spec.theme, 'proposal');
  addFlowPage(doc, theme, 'body', 'Your options', [
    partiesRow(),
    flowText([{ text: 'Your roof, three ways' }], { style_ref: 'h1' }),
    flowText([{ text: 'Each option is a complete roof replacement priced from the same measurements of your home. Every one includes tear-off, disposal, new flashing and cleanup; they differ in the shingle, what goes under it and the warranty behind it.' }], { font: bodyFont(10.5) }),
    flowSpacer(4),
    flowRepeater({
      source: '{{params.scope_packages}}', component: 'option_card', as: 'option',
      layout: { direction: 'column', columns: 3, gap_pt: 10 },
      empty_text: 'The three options appear here once the line items are generated.'
    }),
    flowSpacer(8),
    flowText([{ text: 'What your selected option includes' }], { style_ref: 'h2' }),
    ...lineItemBlocks('{{coalesce(params.scope_rows, params.scope_items)}}', 'The selected option is itemized here once the line items are generated.')
  ], { gap: 6 });
  addFlowPage(doc, theme, 'signature', 'Approval', [
    flowText([{ text: 'Approval' }], { style_ref: 'h2' }),
    flowText([{ text: 'Signing accepts the option marked as selected, any add-ons listed with it, and the total shown. To choose a different option, pick it before you sign and the price follows.' }], { font: bodyFont(10.5) }),
    flowText([{ text: TERMS }], { font: mutedFont(9) }),
    flowSpacer(6),
    flowText([{ text: 'Payment terms' }], { style_ref: 'h2' }),
    flowWidget('doc.payment_schedule@1', { source: 'params.payment_schedule' }),
    flowSpacer(12),
    approvalRow()
  ]);
  return finishScoped(doc, spec, {}, optionCardComponent());
}

/** A gutter job on one page: the lines with their prices, the terms and the signature. */
function guttersDefinition(spec: EstimateSpec) {
  const { doc, theme } = startFlowTemplate(spec.theme, 'proposal');
  addFlowPage(doc, theme, 'body', 'Estimate', [
    partiesRow(),
    flowText([{ text: 'Gutter replacement estimate' }], { style_ref: 'h2' }),
    flowText([{ text: 'We take down and haul away the existing gutters, then hang new seamless gutters and downspouts pitched to drain away from the house.' }], { font: bodyFont(10.5) }),
    ...lineItemBlocks('{{coalesce(params.scope_rows, params.scope_items)}}', 'The gutter lines appear here once they are generated.'),
    flowText([{ text: 'Payment terms' }], { font: displayFont(11) }),
    flowWidget('doc.payment_schedule@1', { source: 'params.payment_schedule' }),
    flowText([{ text: 'This estimate is valid for 30 days. Rotted fascia or other hidden damage found once the old gutters are down is priced and approved in writing before it is repaired. Signing accepts the work and total shown.' }], { font: mutedFont(9) }),
    flowSpacer(4),
    approvalRow(88)
  ], { gap: 6 });
  return finishScoped(doc, spec, { show_line_prices: { type: 'boolean', label: 'Print each line price', default: true } });
}

export function roofingEstimateDefinition(mode: string, rates: { roof: number; gutter: number }) {
  const spec = ROOFING_ESTIMATES.find(x => x.key === mode)!;
  if (mode === 'onepage') return onePageDefinition(spec);
  if (mode === 'options') return optionsDefinition(spec);
  if (mode === 'gutters') return guttersDefinition(spec);
  const detailed = mode === 'detailed';
  const params: JsonObject = {
    structure: { type: 'string', label: 'Structure', default: 'Main house' },
    color: { type: 'string', label: 'Material color', default: 'charcoal' },
    roof_squares: { type: 'number', label: 'Roof area (squares)', default: 20 },
    waste_percent: { type: 'number', label: 'Material waste (%)', default: 10 },
    ridge_vent: { type: 'boolean', label: 'Include ridge ventilation', default: true },
    rate_cents: { type: 'currency', label: 'Price per square', default: Math.round(rates.roof * 100) },
    package_cents: { type: 'currency', label: 'Package price', default: 2000000 },
    scope_items: { type: 'list', items: { type: 'pricebook_line' }, label: 'Accepted scope', default: [{ id: 'accepted_work', name: mode === 'package' ? 'Summer HDZ roof package' : 'HDZ roof replacement', quantity: 1, unit: 'job', pricing: { formula: mode === 'package' ? 'params.package_cents' : 'round(params.roof_squares * params.rate_cents)' } }] },
    scope_pieces: { type: 'list', items: { type: 'object' }, label: 'Project work' },
    measurement_requirements: { type: 'list', items: { type: 'string' } },
    measurements: { type: 'measurements', label: 'Measurements' }
  };
  const { doc, theme } = startFlowTemplate(spec.theme, 'proposal');
  const body = (runs: RunSpec[], sizePt = 11) => flowText(runs, { font: { family: 'var(--fm-body-font)', size_pt: sizePt, color: 'var(--fm-text)' } });
  const note = (text: string) => flowText([{ text }], { style_ref: 'caption' });
  // Photos and a description of the work, when the salesperson added any:
  // they follow the heading and the pricing starts on a fresh page. With
  // none, the page is the pricing alone.
  const described = { if: 'count(params.content_blocks) > 0' };
  const details = detailed ? [
    Object.assign(flowText([{ text: 'About this project' }], { style_ref: 'h2' }), { bind: described }),
    Object.assign(contentBlocksRepeater('{{params.content_blocks}}'), { bind: described }),
    Object.assign(FMDocModel.createNode('page_break', { frame: { x: 0, y: 0, w: 0, h: 0, z: 0, layout: 'flow' } }) as JsonObject, { anchor: 'flow', bind: described })
  ] : [];
  const priced = detailed
    ? lineItemBlocks('{{coalesce(params.scope_rows, params.scope_items)}}', 'Choose price-book items in the estimate workflow.')
    : [
        body([{ text: 'Roof area: ' }, { text: '', bind: 'params.roof_squares' }, { text: ' squares' }], 17),
        body([{ text: 'Roofing system: GAF Timberline HDZ · ' }, { text: '', bind: 'params.color' }], 14),
        body(mode === 'package'
          ? [{ text: 'Package includes field shingles, underlayment, perimeter materials and agreed ventilation.' }]
          : [{ text: 'Price per square: ' }, { text: '', bind: 'params.rate_cents | money' }]),
        flowSpacer(10),
        flowColumn([
          flowText([{ text: 'Estimate total: ' }, { text: '', bind: 'computed.total_cents | money' }], { font: { family: 'var(--fm-display-font)', size_pt: 23, weight: 800, color: 'var(--fm-text)' } })
        ], { padding: [22, 20, 22, 20], fill: 'color-mix(in srgb, var(--fm-primary) 6%, var(--fm-color-paper))' })
      ];
  addFlowPage(doc, theme, 'body', 'Estimate', [
    flowLogo(),
    flowText([{ text: '', bind: "coalesce(org.name, '')" }], { font: { family: 'var(--fm-body-font)', size_pt: 12, weight: 700, color: 'var(--fm-color-muted)' } }),
    flowText([{ text: spec.title }], { style_ref: 'h1' }),
    body([{ text: 'Prepared for ' }, { text: '', bind: "coalesce(customer.name, 'Customer')" }, { text: ' · ' }, { text: '', bind: 'coalesce(project.title, params.structure)' }]),
    body([{ text: detailed ? 'Each line below is priced from the measurements of your roof. Where you have a choice of product, the one priced here is our recommendation; you can change it before you approve.' : spec.description }]),
    flowSpacer(10),
    ...details,
    ...priced,
    flowSpacer(12),
    note('Development sample • Confirm the scope and quantities before approval. Prices are sample selling prices, not supplier quotes.')
  ], { gap: detailed ? 4 : 10 });
  addFlowPage(doc, theme, 'signature', 'Scope & approval', [
    flowText([{ text: 'Scope & approval' }], { style_ref: 'h2' }),
    body([{ text: detailed ? 'Replace the roofing on the identified structure with the products, quantities and options listed in this proposal.' : 'Replace roofing on the identified structure using the selected HDZ system, underlayment, perimeter materials and agreed ventilation.' }]),
    // The itemized proposal prints each product's color on its own line.
    body(detailed ? [{ text: 'Structure: ' }, { text: '', bind: 'params.structure' }] : [{ text: 'Structure: ' }, { text: '', bind: 'params.structure' }, { text: '   Color: ' }, { text: '', bind: 'params.color' }]),
    body([{ text: 'Site review: confirm access, decking condition, flashing, ventilation and disposal arrangements. Hidden damage and additional work require a separately approved change. Schedule and payment terms must be agreed before work starts.' }]),
    body([{ text: 'Approval accepts the scope and price shown in this estimate. The material list supports fulfillment; changes to that list do not change this signed estimate.' }]),
    ...(detailed ? [
      flowSpacer(6),
      flowText([{ text: 'Payment terms' }], { style_ref: 'h2' }),
      flowWidget('doc.payment_schedule@1', { source: 'params.payment_schedule' })
    ] : []),
    flowSpacer(16),
    ...(detailed ? [approvalRow()] : [flowWidget('doc.signature@1', { output: 'sig_customer', label: 'Customer approval', signer: 'customer' }, { w: 360, h: 100 })]),
    flowSpacer(16),
    note('Sample agreement for development testing. Replace sample terms with your organization’s approved terms before customer use.')
  ]);
  if (detailed) {
    return finishScoped(doc, spec, {
      show_line_prices: { type: 'boolean', label: 'Print each line price', default: true },
      content_blocks: { type: 'list', label: 'Photos & description', default: [] }
    }, mediaTextRowComponent(), contentBlockStyles());
  }
  doc.components = proposalLineItemComponents(); doc.styles = lineItemStyles(); doc.params = params;
  doc.outputs = { sig_customer: { type: 'signature', required: true, signer: 'customer' } };
  doc.computed={subtotal_cents:'sum(params.scope_items[].amount_cents)',tax_cents:'0',total_cents:'computed.subtotal_cents'};
  doc.program={enabled:false,deliverables:[roofingCalculus(mode)]};
  return doc;
}

/** Bump when the estimate layouts or their workflows change; existing packs republish. */
export const INSTANT_ROOFING_PACK = 13;

/** Roof measurements the proposals price from, in the order a roofer reads a report. */
export const ROOF_MEASUREMENT_FIELDS = [
  { key: 'roofSquares', label: 'Roof area', unit: 'sq' },
  { key: 'wastePercent', label: 'Waste', unit: '%', default: 10 },
  { key: 'eavesLf', label: 'Eaves', unit: 'ft' },
  { key: 'rakesLf', label: 'Rakes', unit: 'ft' },
  { key: 'ridgesLf', label: 'Ridges', unit: 'ft' },
  { key: 'hipsLf', label: 'Hips', unit: 'ft' },
  { key: 'valleyLf', label: 'Valleys', unit: 'ft' },
  { key: 'sideWallLf', label: 'Sidewalls', unit: 'ft' },
  { key: 'headWallLf', label: 'Headwalls', unit: 'ft' },
  { key: 'pipeBootsEa', label: 'Pipe boots', unit: 'ea', default: 0 },
  { key: 'skylightsEa', label: 'Skylights', unit: 'ea', default: 0 },
  { key: 'chimneysEa', label: 'Chimneys', unit: 'ea', default: 0 },
  // Offered as optional lines; a roof report rarely measures them.
  { key: 'gutterLf', label: 'Gutters', unit: 'ft', default: 0 },
  { key: 'downspoutLf', label: 'Downspouts', unit: 'ft', default: 0 }
];
export const GUTTER_MEASUREMENT_FIELDS = [
  { key: 'gutterLf', label: 'Gutter length', unit: 'ft' },
  { key: 'downspoutLf', label: 'Downspout length', unit: 'ft', default: 0 }
];

/** The steps of a proposal priced from a generated scope: measure, price, terms, send; then the customer's side. */
export function scopedWorkflowSteps(spec: EstimateSpec, templateId: string) {
  const gutters = spec.scope === 'gutters';
  return [
    gutters
      ? { id: 'measure', title: 'Gutters', description: 'Enter the gutter run and the downspouts to replace. Every quantity on the estimate follows from these.', audience: ['internal'], items: [
          { kind: 'measurements', writes: 'params.measurements', label: 'Gutter measurements', required: true, fields: GUTTER_MEASUREMENT_FIELDS, prefill: 'project.measurements' }] }
      : { id: 'measure', title: 'Roof', description: 'Measurements come from the report on this project. Correct anything that looks off; every quantity on the proposal follows from these. Gutters are offered as optional lines: enter their lengths if you measured them, otherwise the gutter run is priced along the eaves.', audience: ['internal'], items: [
          { kind: 'measurements', writes: 'params.measurements', label: 'Roof measurements', required: true, fields: ROOF_MEASUREMENT_FIELDS, prefill: 'project.measurements' },
          ...(spec.key === 'detailed' ? [{ kind: 'text', writes: 'params.structure', label: 'Structure', required: true }] : [])] },
    // Optional: pages of photos and description ahead of the pricing.
    ...(spec.key === 'detailed' ? [{ id: 'details', title: 'Photos & description', description: 'Optional. Show the customer their roof and describe the work before they reach the pricing. Leave this empty and the proposal goes straight to the line items.', audience: ['internal'], items: [
      { kind: 'content_blocks', writes: 'params.content_blocks', label: 'Photos & description' }], preview: { template_ref: templateId, live: true } }] : []),
    { id: 'items', title: 'Line items', audience: ['internal'], items: [{ kind: 'line_items_review', writes: 'params.scope_items', required: true, label: 'Line items',
      // The three options open side by side, so their prices read across.
      ...(spec.key === 'options' ? { compare: ['roof_package'] } : {}) }] },
    { id: 'terms', title: 'Payment terms', description: 'How the job is paid. The milestone due on signature is the deposit the customer pays when they approve.', audience: ['internal'], items: [{ kind: 'payment_schedule', writes: 'params.payment_schedule', label: 'Payment schedule', required: true }] },
    { id: 'review', title: 'Review & send', audience: ['internal'], items: [{ kind: 'review', label: 'Before you send' }], preview: { template_ref: templateId, live: true } },
    // The customer's side, in the portal: choose, approve, pay the deposit.
    { id: 'choose', title: spec.key === 'options' ? 'Choose your roof' : 'Choose your options', audience: ['customer'], when: '{{coalesce(params.customer_choice_count, 0) > 0}}', items: [{ kind: 'choice_group', writes: 'outputs.selections', options_from: 'scope_items', label: 'Your options',
      description: spec.key === 'options' ? 'Pick the roof you want. The proposal total updates with your choice.' : 'Pick the products you want. The proposal total updates with each choice.' }] },
    { id: 'sign', title: 'Approve', audience: ['customer'], items: [{ kind: 'signature', writes: 'outputs.sig_customer', required: true, label: 'Approve this proposal', description: 'Sign to accept the scope, the options you selected and the price shown.' }] },
    { id: 'pay', title: 'Pay deposit', audience: ['customer'], when: '{{params.deposit_at_signing == true}}', items: [{ kind: 'payment', writes: 'outputs.deposit_payment', required: true, label: 'Deposit', config: { amount_label: 'Deposit due' } }] }
  ];
}

const PRESENTATION_NAMES: Record<string, string> = { itemized: 'Roof replacement presentation', options: 'Good / Better / Best presentation', gutters: 'Gutter replacement presentation' };

/**
 * Create the roofing sales templates and workflows, and republish the ones an
 * earlier pack revision created. With create:false only existing packs are
 * upgraded, so organizations that never had the pack stay without it.
 */
export async function seedInstantRoofingDocuments(orgId:string, ctx:PlatformAuthContext|null, options:{create?:boolean}={}) {
  const create = options.create !== false;
  const catalog = await getOrganizationPricebook(orgId);
  if (create) await ensureDefaultDocumentAssets(orgId,ctx);
  const price = (id:string) => Number(catalog.catalog.items.find(x=>x.id===id)?.unitPrice || 0);
  if (!price('gaf_hd') || !price('gutter_replace')) {
    if (!create) return;
    throw new Error('Roofing test pack requires the shared roofing price book.');
  }
  const missing = (e:any) => { if (e.statusCode===404) return null; throw e; };
  // A pack is upgraded whole: a template added by a later revision arrives with it.
  const had = !!(await readDocumentTemplate(orgId,'tpl_instant_roofing_quick').catch(missing));
  for (const spec of ROOFING_ESTIMATES) {
    const id=`tpl_instant_roofing_${spec.key}`, workflow=`wfl_instant_roofing_${spec.key}`;
    const existing=await readDocumentTemplate(orgId,id).catch(missing);
    if (existing ? Number(obj(existing.metadata).instant_roofing_pack || 0) >= INSTANT_ROOFING_PACK : !(create || had)) continue;
    const definition=roofingEstimateDefinition(spec.key,{roof:price('gaf_hd'),gutter:price('gutter_replace')});
    const fields=['structure','roof_squares','waste_percent','color','ridge_vent',...(spec.key==='package'?['package_cents']:['rate_cents'])];
    const paramItem=(key:string)=>({kind:obj(obj(definition.params)[key]).type==='string'?'text':obj(obj(definition.params)[key]).type,writes:`params.${key}`,label:obj(obj(definition.params)[key]).label,required:true});
    // Scoped proposals measure (from the project's report), price the scope
    // from the price book and send. The other estimates price from a few inputs.
    const steps=spec.scope?scopedWorkflowSteps(spec,id):[
      {id:'scope',title:'Define the work',audience:['internal'],items:fields.map(paramItem)},
      {id:'review',title:'Review estimate',audience:['internal'],items:[{kind:'review',label:'Review before sending'}],preview:{template_ref:id,live:true}}
    ];
    // A proposal with a deck can be presented: its last step offers the
    // slideshow, sending the estimate as it is, or sending the slideshow.
    let completion:Record<string,unknown>|null=null;
    if (spec.presentation) {
      const { ensurePresentationPreset } = await import('../documents/modules/presentation-service.js');
      const { roofingPresentationLayout, ROOFING_PRESENTATION_REVISION } = await import('../documents/modules/presentation-presets.js');
      const preset = await ensurePresentationPreset(orgId,{id:`roofing_${spec.presentation}`,name:PRESENTATION_NAMES[spec.presentation]!,layout:roofingPresentationLayout(spec.presentation),preset_revision:ROOFING_PRESENTATION_REVISION});
      completion={offers:['present','send_estimate','send_presentation'],default:'present',presentation:{module_id:preset.moduleId}};
    }
    const workflowDefinition={schema_version:1,name:spec.title,contract:{params:definition.params,outputs:definition.outputs},steps,...(completion?{completion}:{})};
    const metadata={instant_roofing_pack:INSTANT_ROOFING_PACK,
      // Scoped proposals have customer steps, so the portal offers the
      // workflow alongside the document.
      ...(spec.scope?{customer_presentation:{tab:{id:'proposals',label:'Proposals',icon:'fa-file-signature',order:50},mode:'hybrid',workflow_cta:spec.key==='options'?'Choose your roof & approve':'Choose options & approve'}}:{})};
    const existingWorkflow=await readDocumentWorkflow(orgId,workflow).catch(missing);
    if (existingWorkflow) await publishDocumentWorkflow(orgId,workflow,{definition:workflowDefinition,expected_version:Number(existingWorkflow.current_version||0),metadata},ctx);
    else await createDocumentWorkflow(orgId,{id:workflow,name:spec.title,description:spec.description,status:'active',definition:workflowDefinition,metadata},ctx);
    // The itemized proposal is what "new proposal" means when no template is named.
    const templateMetadata={...metadata,default:spec.key==='detailed',default_workflow_id:workflow};
    if (existing) await publishDocumentTemplate(orgId,id,{definition,expected_version:Number(existing.current_version||0),metadata:templateMetadata},ctx);
    else await createDocumentTemplate(orgId,{id,name:spec.title,document_type:'proposal',description:spec.description,status:'active',definition,metadata:templateMetadata},ctx);
  }
}
