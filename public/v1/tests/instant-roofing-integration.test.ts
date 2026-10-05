import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
test('Instant roofing estimates sign, publish, edit and order through the native adapter',async()=>{
const root=await mkdtemp(path.join(os.tmpdir(),'instant-roofing-'));
Object.assign(process.env,{NODE_ENV:'test',PLATFORM_STORAGE_ROOT:root,PRICEBOOK_STORAGE_ROOT:path.join(root,'pricebook'),PLATFORM_HEARTBEAT_DISABLED:'1',SIGNUP_SANDBOX_STORAGE_ROOT:path.join(root,'sandbox'),FIRSTMEASURE_DATA_ENVIRONMENT:'development',EMAIL_OUTBOUND_DISABLED:'1'});
const storage=await import('../platform/storage.js');
const signup=await import('../signup-sandbox/service.js');
await signup.ensureSeedData();
const {authContext:ctx,testOrg}=await signup.createTestInstance('swf_instant_full_org');
const {seedInstantRoofingDocuments,ROOFING_ESTIMATES}=await import('../signup-sandbox/roofing-documents.js');
const documentStorage=await import('../documents/storage.js');
assert.ok(await documentStorage.readDocumentTemplate(ctx.orgId,'tpl_instant_roofing_quick'));
const extraUser=await signup.addTestOrgUser(String(testOrg.id),{name:'Second tester',email:'second@roofing.test',role:'admin'});
const extraContext=await signup.loginAsTestOrgUser(String(testOrg.id),String(extraUser.id));
const {publicAuthContext}=await import('../platform/auth.js');
assert.equal((publicAuthContext(extraContext).identity.preferences as any).left_column_behavior,'tooltip');
assert.equal((publicAuthContext(extraContext).identity.preferences as any).always_collapsible_left_column,true);
await seedInstantRoofingDocuments(ctx.orgId,ctx);
const {createDocumentInstance,resolveDocumentInstance,sendDocument}=await import('../documents/service.js');
const project=await storage.upsertDocument(ctx.orgId,'projects',{id:'project_roofing_test',data:{title:'Roofing test',branch_id:'default'}});
for(const spec of ROOFING_ESTIMATES){
 const {document}=await createDocumentInstance(ctx.orgId,String(project.id),{document_type:'proposal',template_id:`tpl_instant_roofing_${spec.key}`},ctx);
 const resolved=await resolveDocumentInstance(ctx.orgId,document,{target:'static'});
 const {buildRenderHarnessHtml}=await import('../documents/render.js');
 const html=await buildRenderHarnessHtml({resolved_definition:resolved.resolved_definition,theme:resolved.theme,themeContext:resolved.theme_context,widgetData:resolved.widget_data,scope:resolved.scope,title:document.title} as any);

 if(spec.key==='quick') {
  assert.equal((resolved.scope as any).params.scope_items[0].amount_cents,796000);
  const sent:any=await sendDocument(ctx.orgId,String(document.id),{recipients:[{name:'Test Customer',email:'roof@example.test',role:'customer'}],consent_contact:'support@example.test'},ctx);
  const signing=await import('../documents/signing/service.js');
  const access=await signing.publicSigningAccess(sent.signing.invitations[0].token);
  const review=await signing.prepareSigning(access);
  await signing.acceptSigning(access,'sig_customer',{value:{type:'typed',signer_name:'Test Customer'},challenge:review.challenge,content_hash:review.content_hash,consent:{intent:true,electronic_records:true,can_access_and_retain:true,disclosure_hash:review.disclosure.hash}});
  const {userPublicationContext}=await import('../platform/publication/context.js');
  const calculus=await import('../materials/calculus.js');
  (await import('../platform/publication/bootstrap.js')).initializePublication();
  const c=userPublicationContext(ctx,{projectId:String(project.id)});
  let ledger=await calculus.readMaterialsLedger(c,String(project.id));assert.equal(ledger.sets.length,1);
  const evalResult=await calculus.materialsCommand(c,String(project.id),{key:crypto.randomUUID(),expected_revision:ledger.revision,operation:'evaluate',input:{set_id:ledger.sets[0]!.id}});
  const applied=await calculus.materialsCommand(c,String(project.id),{key:crypto.randomUUID(),expected_revision:evalResult.ledger.revision,operation:'apply',input:{set_id:ledger.sets[0]!.id,evaluation_id:evalResult.result.evaluation_id}});
  assert.equal(applied.ledger.sets[0]!.lines[0]!.order_quantity,66);
  const {nativeCalculusAPI}=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../../libraries/apps/materials/calculus-native.js',import.meta.url),'utf8')).toString('base64'));
  const native=nativeCalculusAPI({projects:{list:async()=>({material_lists:[]})},lists:{},orders:{},request:async(_path:string,options:any)=>options?calculus.materialsCommand(c,String(project.id),JSON.parse(JSON.stringify(options.body))):{ledger:await calculus.readMaterialsLedger(c,String(project.id))}},()=>String(project.id));
  const lists=await native.projects.list(ctx.orgId,String(project.id));
  let material=lists.material_lists[0];const original=material.current_items[0];
  assert.equal(original.selected_options.color,'charcoal');
  let edited=await native.lists.createVersion(ctx.orgId,material.id,{expected_revision:material.revision,update_items:[{id:original.id,quantity:25.5,selected_options:{color:'weathered_wood'}}],reason:'Review roof quantities and finish'});
  assert.notEqual(edited.material_list.current_items[0].id,original.id);
  material=edited.material_list;
  const changed=material.current_items.find((l:any)=>l.pricebook_ref.item_id==='gaf_hd');
  assert.equal(changed.quantity,25.5);assert.equal(changed.order_quantity,77);assert.equal(changed.selected_options.color,'weathered_wood');
  const order=await native.lists.createOrder(ctx.orgId,material.id,{expected_revision:material.revision,title:'QA roof order',vendor:{name:'Development supplier'}});
  assert.equal(order.material_list.status,'ordered');
  await native.orders.recordDelivery(ctx.orgId,order.order.id,{status:'delivered'});
  const committed=await calculus.readMaterialsLedger(c,String(project.id));
  assert.ok(committed.orders[0]!.lines.every((l:any)=>l.received===l.quantity));
 }
 console.log(JSON.stringify({template:spec.key,valid:true}));
}
console.log('seed integration passed');
});
