import type { PlatformAuthContext } from '../platform/auth.js';
import { FMDocModel } from '../documents/schemas.js';
import { ensureDefaultDocumentAssets, TEMPLATE_SEEDS } from '../documents/seeds.js';
import { createDocumentTemplate, createDocumentWorkflow, readDocumentTemplate } from '../documents/storage.js';
import { getOrganizationPricebook } from '../pricebook/storage.js';
import type { JsonObject } from '../platform/storage.js';

export const ROOFING_ESTIMATES = [
  { key: 'quick', title: 'Roof replacement · Per-square estimate', theme: 'thm_clean', description: 'A concise roof estimate priced by area, with measured accessories supplied separately.' },
  { key: 'detailed', title: 'Roof replacement · Itemized proposal', theme: 'thm_margin', description: 'Review the shared price-book scope, quantities, product choices and individual prices.' },
  { key: 'package', title: 'Summer roof · Fixed-price proposal', theme: 'thm_triangles', description: 'A fixed-price HDZ roofing package. The selling price does not change the physical material quantities.' },
  { key: 'gutters', title: 'Gutters · Exterior improvement estimate', theme: 'thm_clean', description: 'A separate gutter agreement that adds its own material set alongside the roofing agreement.' }
] as const;

const obj = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const dataBinding = (name: string, project = false) => ({ kind: 'data', policy: 'frozen', required: !project,
  source: { provider: 'materials-inputs', export: name, target: { scope: project ? 'project' : 'organization', organizationId: '$organization', ...(project ? { projectId: '$project' } : {}) } } });

/** This code travels with the accepted document, never with the project UI. */
export function roofingCalculus(mode: string) {
  return {
    type: 'materials_calculus', key: `roofing_${mode}`, title: mode === 'gutters' ? 'Gutters' : 'Roof replacement',
    bindings: { products: dataBinding('products'), measurements: dataBinding('measurements', true) },
    source: `const p = inputs.document.params;
const products = await api.data.read('products');
const dataset = await api.data.read('measurements');
const measured = dataset?.measurements || {};
const warnings = [], lines = [];
const mode = ${JSON.stringify(mode)};
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
if (mode === 'gutters') {
  add('gutter', 'gutter_replace', amount(p.gutter_feet, 'Gutter length'), 'Gutters', 'Accepted gutter length', p.color || 'white');
  warnings.push('Confirm downspouts, outlets, end caps, hangers and site-specific accessories before ordering.');
} else if (mode === 'detailed') {
  const physical = new Set(['gaf_hd','laminated_shingles','three_tab_shingles','starter','ridge_cap','underlayment','drip_edge','valley_metal','ridge_vent','gutter_replace']);
  function walk(rows, path) { (rows || []).forEach((r, index) => {
    if (r.selected === false || r.excluded === true || r.selection?.selected === false) return;
    const key = path + '_' + index;
    const id = r.pricebook_ref?.item_id || r.item_ref || r.catalog_item_id || r.id;
    if (physical.has(id) || products.find(x=>x.id===id)?.packaging) add(key, id, amount(r.quantity, r.name || id), 'Accepted scope', 'Quantity accepted on the itemized proposal', r.variation_id || r.variant_id || r.variables?.color || p.color || '');
    walk(r.children, key);
  }); }
  walk(p.scope_items, 'scope');
  if (!lines.length) throw new Error('Select physical price-book materials on the itemized proposal before generating materials.');
  warnings.push('Quantities follow the accepted itemized scope; check flashing, ventilation and accessories against the roof before ordering.');
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

export function roofingEstimateDefinition(mode: string, rates: { roof: number; gutter: number }) {
  const spec = ROOFING_ESTIMATES.find(x => x.key === mode)!;
  const gutter = mode === 'gutters';
  const params: JsonObject = {
    structure: { type: 'string', label: 'Structure', default: 'Main house' },
    color: { type: 'string', label: 'Material color', default: gutter ? 'white' : 'charcoal' },
    roof_squares: { type: 'number', label: 'Roof area (squares)', default: 20 },
    waste_percent: { type: 'number', label: 'Material waste (%)', default: 10 },
    ridge_vent: { type: 'boolean', label: 'Include ridge ventilation', default: true },
    gutter_feet: { type: 'number', label: 'Gutter length (feet)', default: 120 },
    rate_cents: { type: 'currency', label: gutter ? 'Price per foot' : 'Price per square', default: Math.round((gutter ? rates.gutter : rates.roof) * 100) },
    package_cents: { type: 'currency', label: 'Package price', default: 2000000 },
    scope_items: { type: 'list', items: { type: 'pricebook_line' }, label: 'Accepted scope', default: mode === 'detailed' ? [] : [{ id: 'accepted_work', name: gutter ? 'Seamless gutter installation' : mode === 'package' ? 'Summer HDZ roof package' : 'HDZ roof replacement', quantity: 1, unit: 'job', pricing: { formula: mode === 'package' ? 'params.package_cents' : gutter ? 'round(params.gutter_feet * params.rate_cents)' : 'round(params.roof_squares * params.rate_cents)' } }] },
    scope_pieces: { type: 'list', items: { type: 'object' }, label: 'Project work' },
    measurement_requirements: { type: 'list', items: { type: 'string' } },
    measurements: { type: 'measurements', label: 'Measurements' }
  };
  const doc = obj(FMDocModel.createDocument({kind:'document', first_page_role:'body', theme_ref:{theme_id:spec.theme}, metadata:{document_type:'proposal'}}));
  const text = (y:number, h:number, runs:JsonObject[], size=11) => FMDocModel.createNode('text',{frame:{x:44,y,w:524,h},props:{blocks:[{id:FMDocModel.generateId('blk'),type:'paragraph',runs}]},style:{font:{family:'Inter',size_pt:size,color:'#172b4d'}}});
  const page = obj((doc.pages as JsonObject[])[0]);
  const standard=TEMPLATE_SEEDS.find(s=>s.id==='tpl_proposal_default')!.definition();
  doc.components=standard.components;doc.styles=standard.styles;
  const flowNode=(type:string,props:JsonObject,h:number)=>({...FMDocModel.createNode(type,{frame:{x:0,y:0,w:524,h},props}),anchor:'flow'});
  const pricing=FMDocModel.createNode('frame',{frame:{x:44,y:310,w:524,h:345,layout:'flow'},props:{flow:{direction:'column',gap:8},overflow:'paginate'},children:[
    flowNode('component_ref',{component:'li_header',input:{}},22),
    flowNode('repeater',{source:'{{coalesce(params.scope_rows, params.scope_items)}}',component:'li_row',as:'row',layout:{direction:'column',columns:1,gap_pt:4},break_rules:{repeat_header:true,header_component:'li_header'},empty_text:'Choose price-book items in the estimate workflow.'},40),
    flowNode('component_ref',{component:'li_totals',input:{}},76)
  ]});
  page.name = 'Estimate';
  page.children = [text(68,26,[{text:'',bind:'org.name'}],12),text(104,65,[{text:spec.title}],25),
    text(185,44,[{text:'Prepared for ',bind:"coalesce(customer.name, 'Customer')"},{text:' · '},{text:'',bind:"coalesce(project.title, params.structure)"}]),
    text(240,65,[{text:spec.description}]),
    ...(mode==='detailed'?[pricing]:[
      text(332,45,[{text:gutter?'Gutter length: ':'Roof area: '},{text:'',bind:gutter?'params.gutter_feet':'params.roof_squares'},{text:gutter?' linear feet':' squares'}],17),
      text(389,40,[{text:gutter?'Finish: ':'Roofing system: GAF Timberline HDZ · '},{text:'',bind:'params.color'}],14),
      text(440,45,mode==='package'?[{text:'Package includes field shingles, underlayment, perimeter materials and agreed ventilation.'}]:[{text:gutter?'Price per foot: ':'Price per square: '},{text:'',bind:'params.rate_cents | money'}]),
      FMDocModel.createNode('shape',{frame:{x:44,y:520,w:524,h:95},style:{fill:{type:'solid',color:'#f1f5f9'}},props:{shape:'rect'}}),
      text(544,48,[{text:'Estimate total: '},{text:'',bind:'computed.total_cents | money'}],23)
    ]),
    text(673,38,[{text:'Development sample • Confirm the scope and quantities before approval. Prices are sample selling prices, not supplier quotes.'}],9)];
  const terms = obj(FMDocModel.createPage('signature',{name:'Scope & approval'}));
  terms.children = [text(70,40,[{text:'Scope & approval'}],24),
    text(130,65,[{text:gutter ? 'Install the agreed seamless gutter length and selected finish. Downspouts and other accessories require explicit scope confirmation.' : 'Replace roofing on the identified structure using the selected HDZ system, underlayment, perimeter materials and agreed ventilation. The itemized proposal, when selected, governs its listed products and quantities.'}]),
    text(215,55,[{text:'Structure: '},{text:'',bind:'params.structure'},{text:'   Color: '},{text:'',bind:'params.color'}]),
    text(290,95,[{text:'Site review: confirm access, decking condition, flashing, ventilation and disposal arrangements. Hidden damage and additional work require a separately approved change. Schedule and payment terms must be agreed before work starts.'}]),
    text(418,65,[{text:'Approval accepts the scope and price shown in this estimate. The material list supports fulfillment; changes to that list do not change this signed estimate.'}]),
    FMDocModel.createNode('widget',{frame:{x:44,y:530,w:440,h:100},props:{widget:'doc.signature@1',config:{output:'sig_customer',label:'Customer approval',signer:'customer'}}}),
    text(675,40,[{text:'Sample agreement for development testing. Replace sample terms with your organization’s approved terms before customer use.'}],9)];
  doc.pages = [page,terms]; doc.params=params;
  doc.outputs={sig_customer:{type:'signature',required:true,signer:'customer'}};
  doc.computed={subtotal_cents:'sum(params.scope_items[].amount_cents)',tax_cents:'0',total_cents:'computed.subtotal_cents'};
  doc.program={enabled:false,deliverables:[roofingCalculus(mode)]};
  return doc;
}

export async function seedInstantRoofingDocuments(orgId:string, ctx:PlatformAuthContext) {
  const catalog = await getOrganizationPricebook(orgId);
  await ensureDefaultDocumentAssets(orgId,ctx);
  const price = (id:string) => Number(catalog.catalog.items.find(x=>x.id===id)?.unitPrice || 0);
  if (!price('gaf_hd') || !price('gutter_replace')) throw new Error('Roofing test pack requires the shared roofing price book.');
  for (const spec of ROOFING_ESTIMATES) {
    const id=`tpl_instant_roofing_${spec.key}`, workflow=`wfl_instant_roofing_${spec.key}`;
    const existing=await readDocumentTemplate(orgId,id).catch((e:any)=>{if(e.statusCode===404)return null;throw e;});
    if(existing)continue;
    const definition=roofingEstimateDefinition(spec.key,{roof:price('gaf_hd'),gutter:price('gutter_replace')});
    const fields=spec.key==='gutters'?['structure','gutter_feet','color','rate_cents']:['structure','roof_squares','waste_percent','color','ridge_vent',...(spec.key==='package'?['package_cents']:spec.key==='quick'?['rate_cents']:[])];
    await createDocumentWorkflow(orgId,{id:workflow,name:spec.title,description:spec.description,status:'active',definition:{schema_version:1,name:spec.title,contract:{params:definition.params,outputs:definition.outputs},steps:[
      {id:'scope',title:'Define the work',audience:['internal'],items:fields.map(key=>({kind:obj(obj(definition.params)[key]).type==='string'?'text':obj(obj(definition.params)[key]).type,writes:`params.${key}`,label:obj(obj(definition.params)[key]).label,required:true}))},
      ...(spec.key==='detailed'?[{id:'pieces',title:'Choose work',audience:['internal'],items:[{kind:'piece_select',writes:'params.scope_pieces',label:'Roofing work',required:true}]},{id:'measure',title:'Measurements',audience:['internal'],items:[{kind:'measurements',writes:'params.measurements',fields_from:'measurement_requirements',prefill:'project.measurements'}]},{id:'items',title:'Review price-book scope',audience:['internal'],items:[{kind:'line_items_review',writes:'params.scope_items',required:true,label:'Materials and services'}]}]:[]),
      {id:'review',title:'Review estimate',audience:['internal'],items:[{kind:'review',label:'Review before sending'}],preview:{template_ref:id,live:true}}
    ]},metadata:{instant_roofing_pack:1}},ctx);
    await createDocumentTemplate(orgId,{id,name:spec.title,document_type:'proposal',description:spec.description,status:'active',definition,metadata:{default:false,default_workflow_id:workflow,instant_roofing_pack:1}},ctx);
  }
}
