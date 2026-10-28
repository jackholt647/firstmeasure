import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryEntries } from '../config-library/library.js';
import { validateCalculus } from '../materials/calculus.js';
import { FMDocModel } from '../documents/schemas.js';
import { runModuleCode } from '../documents/modules/runtime.js';
import { effectiveNavigationPreferences } from '../platform/navigation-defaults.js';

// The roofing sales pack: config library templates tpl_instant_roofing_<key> (config-library/snapshot/document_template).
const PACK = libraryEntries<any>('document_template').filter(entry => entry.id.startsWith('tpl_instant_roofing_'));
const calculus = (key: string) => PACK.find(entry => entry.id === `tpl_instant_roofing_${key}`)!.data.definition.program.deliverables[0];

test('every roofing style is a valid document with an accepted materials recipe', () => {
  assert.deepEqual(PACK.map(entry => entry.id.slice('tpl_instant_roofing_'.length)), ['detailed', 'gutters', 'onepage', 'options', 'package', 'quick']);
  for(const entry of PACK) {
    const result=FMDocModel.validateDocument(entry.data.definition);
    assert.equal(result.ok,true,JSON.stringify(result.errors));
    validateCalculus(entry.data.definition.program.deliverables[0]);
  }
  // The per-square rate is the organization's price book, filled in when its copy is made.
  for (const key of ['quick', 'package']) assert.deepEqual(PACK.find(entry => entry.id === `tpl_instant_roofing_${key}`)!.data.pricebook_defaults, [{ param: 'rate_cents', item_id: 'gaf_hd' }]);
});
const products=['gaf_hd','underlayment','starter','ridge_cap','drip_edge','ridge_vent','gutter_replace'].map(id=>({id,name:id,unit:['gaf_hd','underlayment'].includes(id)?'sq':'lf',...(id==='gaf_hd'?{packaging:{unit:'bundle',coverage:1/3}}:{})}));
async function calculate(mode:string, params:any, measurements:any={}) {
  return (await runModuleCode({source:calculus(mode).source,inputs:{document:{params},values:{}},state:{},mode:'evaluate',now:'2026-10-05'}, {read:async name=>name==='products'?products:{measurements},invoke:async()=>{throw Error('No effects');}})).outputs as any;
}
test('quick and package prices do not alter physical quantities; missing measurements warn',async()=>{
  for(const mode of ['quick','package']) {
    const result=await calculate(mode,{roof_squares:20,waste_percent:10,package_cents:1,color:'charcoal'});
    assert.equal(result.lines[0].quantity,22);
    assert.equal(Math.ceil(result.lines[0].quantity/result.lines[0].packaging.coverage),66);
    assert.ok(result.warnings.some((s:string)=>s.includes('eaves')));
    assert.equal(result.lines.length,2);
  }
  await assert.rejects(calculate('quick',{roof_squares:0,waste_percent:10}));
});
test('measured accessories use declared units and independent gutter requirements',async()=>{
  const measurements=Object.fromEntries(['eavesLf','rakesLf','hipsLf','ridgesLf'].map(key=>[key,{value:40,unit:'ft'}]));
  const result=await calculate('quick',{roof_squares:20,waste_percent:10,ridge_vent:true},measurements);
  assert.equal(result.lines.find((l:any)=>l.key==='starter').quantity,80);
  await assert.rejects(calculate('quick',{roof_squares:20,waste_percent:10},{eavesLf:{value:40,unit:'m'}}));
  // The gutter estimate orders what its accepted scope lists.
  assert.equal((await calculate('gutters',{scope_items:[{id:'gutter_replace',quantity:120}]})).lines[0].product_id,'gutter_replace');
});
test('itemized proposals preserve duplicate material rows and omit services',async()=>{
  const result=await calculate('detailed',{scope_items:[{id:'gaf_hd',quantity:20},{id:'gaf_hd',quantity:20},{id:'tearoff',quantity:40}]});
  assert.deepEqual(result.lines.map((l:any)=>l.quantity),[20,20]);
  assert.notEqual(result.lines[0].key,result.lines[1].key);
});
test('instant navigation defaults apply to every member and preserve personal choices',()=>{
  const org={metadata:{sandbox_workflow_id:'swf_instant_full_org'}};
  assert.equal(effectiveNavigationPreferences(org,{}).left_column_behavior,'tooltip');
  assert.equal(effectiveNavigationPreferences(org,{}).left_column_apps,true);
  assert.equal(effectiveNavigationPreferences(org,{left_column_behavior:'locked'}).left_column_behavior,'locked');
  assert.deepEqual(effectiveNavigationPreferences({},{}),{});
});
