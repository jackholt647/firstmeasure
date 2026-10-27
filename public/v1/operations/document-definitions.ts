import type { JsonObject } from '../platform/storage.js';
import { startFlowTemplate } from '../documents/seeds.js';
import { addFlowPage, flowText, flowRepeater, componentRow } from '../documents/template-kit.js';
import { roofingEstimateDefinition, ROOF_MEASUREMENT_FIELDS, GUTTER_MEASUREMENT_FIELDS } from '../signup-sandbox/roofing-documents.js';

export const OPERATIONS_DOCUMENT_REVISION = 1;
export const OPERATIONS_PIECES = [
  {id:'roof_replacement',name:'Roof replacement',description:'Roof covering, flashing and accessories.',icon:'fa-house',measurement_schema_ids:['roofing']},
  {id:'gutters',name:'Gutter replacement',description:'Gutters, downspouts and optional guards.',icon:'fa-water',measurement_schema_ids:['gutters']},
  {id:'siding_replacement',name:'Siding replacement',description:'Wall covering, trim and weather barrier.',icon:'fa-building',measurement_schema_ids:['siding']}
];
export const OPERATIONS_MEASUREMENTS: Record<string, JsonObject[]> = {
  roof_replacement:ROOF_MEASUREMENT_FIELDS,
  gutters:GUTTER_MEASUREMENT_FIELDS,
  siding_replacement:[{key:'wallNetArea',label:'Net wall area',unit:'sq ft'},{key:'wallTerminationsLf',label:'Wall terminations',unit:'ft'},{key:'wastePercent',label:'Waste',unit:'%',default:10}]
};

/** The workflow captures quantities and selected products. This module interprets that captured scope;
 * it does not calculate prices or invent quantities, and is shared by both document variants. */
export function operationsDeliverable(){
  return {type:'materials_calculus',key:'operations_scope',title:'Project scope of work',source:`
const p=inputs.document.params || {},lines=[],warnings=[];
function walk(rows,path){(rows||[]).forEach((row,index)=>{
 if(row.selected===false||row.excluded===true||row.selection?.selected===false)return;
 const key=path+'_'+index;
 if(Array.isArray(row.children)&&row.children.length){walk(row.children,key);return;}
 if(row.operations_resource!=='material')return;
 const quantity=Number(row.quantity);if(!Number.isFinite(quantity)||quantity<0)throw Error('Review the quantity for '+row.name);
 if(!quantity)return;
 const pack=row.order_packaging||{},coverage=Number(pack.units_per_package);
 lines.push({key,product_id:String(row.pricebook_ref?.item_id||row.item_ref||row.id),name:String(row.name||'Material'),quantity,unit:String(row.unit||'ea'),variant:String(row.variation_id||row.variant_id||row.variables?.color||''),group:String(row.operations_trade||'Materials'),structure:String(row.structure_ref?.name||p.structure||''),explanation:'Selected in the published project scope',...(coverage>0?{packaging:{unit:String(pack.order_unit||'package'),coverage}}:{})});
});}
walk(p.scope_items,'scope');
if(!lines.length)throw Error('Choose at least one material with a quantity before generating materials.');
return {outputs:{lines,work:p.operations_work||[],warnings}};`,bindings:{},inputSchema:{type:'object',additionalProperties:false},defaults:{}};
}

export function operationsDocumentDefinition(path:'scope'|'proposal'):JsonObject{
  const proposal=roofingEstimateDefinition('detailed',{roof:0,gutter:0});
  const params:JsonObject={...(proposal.params as JsonObject),scope_pieces:{type:'list',items:{type:'object'},label:'Project work',default:[]},scope_items:{type:'list',items:{type:'pricebook_line'},label:'Scope of work',default:[]},operations_work:{type:'list',items:{type:'object'},default:[]}};
  if(path==='proposal')return {...proposal,params,program:{enabled:false,deliverables:[operationsDeliverable()]}};
  delete params.payment_schedule;delete params.deposit_at_signing;
  const {doc,theme}=startFlowTemplate('thm_clean','scope_of_work');
  doc.params=params;doc.outputs={};doc.computed={};
  doc.components={scope_row:{params:{item:{type:'object'}},root:componentRow([
    {type:'text',props:{blocks:[{runs:[{text:'',bind:'item.name'}]}]},layout:{grow:1}},
    {type:'text',props:{blocks:[{runs:[{text:'',bind:'item.quantity'},{text:' '},{text:'',bind:'item.unit'}]}]},layout:{w:100}}
  ])}};
  addFlowPage(doc,theme,'body','Scope of work',[
    flowText([{text:'Scope of work'}],{font:{size_pt:25,weight:800}}),
    flowText([{text:'',bind:'coalesce(project.address, project.title, "")'}]),
    flowText([{text:'Internal project plan. No customer signature or payment is requested.'}],{font:{size_pt:10}}),
    flowRepeater({source:'{{coalesce(params.scope_rows, params.scope_items)}}',component:'scope_row',as:'row',props:{item:'{{row}}'},empty_text:'Define the work in the workflow.'})
  ]);
  doc.program={enabled:false,deliverables:[operationsDeliverable()]};
  return doc;
}

export function operationsWorkflowDefinition(path:'scope'|'proposal',definition=operationsDocumentDefinition(path)):JsonObject{
  const fields=Object.values(OPERATIONS_MEASUREMENTS).flat().filter((field,index,all)=>all.findIndex(other=>other.key===field.key)===index);
  return {schema_version:1,name:path==='scope'?'Build your scope of work':'Build your proposal',contract:{params:definition.params,outputs:definition.outputs},steps:[
    {id:'work',title:'What are we working on?',audience:['internal'],items:[{kind:'piece_select',writes:'params.scope_pieces',label:'Choose everything included in this project',multi:true,required:true}]},
    {id:'measure',title:'Measurements',audience:['internal'],items:[{kind:'measurements',writes:'params.measurements',fields_from:'measurement_requirements',fields,prefill:'project.measurements',label:'Check the measurements',required:true}]},
    {id:'items',title:'Build the scope',audience:['internal'],items:[{kind:'line_items_review',writes:'params.scope_items',label:'Choose the products and work included',required:true}]},
    ...(path==='proposal'?[{id:'terms',title:'Payment terms',audience:['internal'],items:[{kind:'payment_schedule',writes:'params.payment_schedule',label:'How will the customer pay?',required:true}]},{id:'review',title:'Review your proposal',audience:['internal'],items:[{kind:'review',label:'Review, present or send'}]}]:[])
  ]};
}
