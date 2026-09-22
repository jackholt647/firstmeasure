import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

test('exterior checkout draft retains references and notes across edit and pricing refresh, and resets on property-type change', async()=>{
 let enabled=true, revision=2;
 const portal={cfg:{},capabilities:{value:key=>key==='firstmeasure.exteriors'&&enabled},util:{escapeHtml:s=>s,injectCSS(){},postAction:async()=>({data:{success:true,pricing_revision:revision,options:[{key:'exteriors_priority',amount:35}]}})}};
 vm.runInNewContext(await readFile(new URL('../../libraries/apps/firstmeasure/order/exteriors.js',import.meta.url),'utf8'),{window:{Portal:portal},document:{getElementById:()=>null},URL});
 const order=portal.ExteriorOrder;
 const context={type:'residential',count:1,ordered:false,orderWorkflow:true,refresh:()=>order.sync(context)};
 order.sync(context);await new Promise(resolve=>setImmediate(resolve));
 assert.equal(order.needsChoice(),true);
 const references=['front','front-right','right','back-right','back','back-left','left','front-left'].map((view,i)=>({structure:0,view,media_id:'media_'+i}));
 order.restore({measurement_scope:'full_house',report_expedite_option:'exteriors_priority',tech_notes:'Keep the porch details.',exterior_references:JSON.stringify(references)});
 assert.equal(order.active(),true);assert.equal(order.needsChoice(),false);assert.equal(order.ready(),false,'restored order must be reviewed again');
 assert.deepEqual(JSON.parse(order.payload().exterior_references),references);assert.equal(order.payload().tech_notes,'Keep the porch details.');assert.equal(order.price(),35);
 revision=3;order.failed({error:'pricing_changed',message:'Prices changed.'});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(order.payload().report_pricing_revision,3);assert.deepEqual(JSON.parse(order.payload().exterior_references),references);
 context.type='commercial';order.sync(context);assert.equal(order.active(),false);assert.equal(order.needsChoice(),false);
 context.type='residential';enabled=false;order.sync(context);assert.equal(order.needsChoice(),false);assert.equal(order.active(),false);
 order.reset();
});
