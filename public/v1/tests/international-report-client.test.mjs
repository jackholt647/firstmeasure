import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../libraries/apps/project-request/app.js',import.meta.url),'utf8');
test('an authoritative standard-only property quote permits ordering',()=>{
 const functionSource=source.match(/  function reportExpeditePricingReady[\s\S]+?\n  }/)[0];
 const state={selectedType:'residential',reportExpediteStructureCount:()=>1,reportExpediteOptionsAuthoritative:true,reportExpeditePropertyKey:'paris',reportPropertyKey:()=> 'paris',reportExpediteOptionsLoading:false,reportExpediteOptionsProjectType:'residential',reportExpediteOptionsStructureCount:1,reportExpediteOptionsSlot:Math.floor(Date.now()/600000),reportExpediteOptions:[{key:'standard_3_6',expedited:false,_pricingAuthoritative:true}]};
 const context=vm.createContext(state);vm.runInContext(functionSource,context);
 assert.equal(vm.runInContext('reportExpeditePricingReady()',context),true);
 for(const [field,value] of [['reportExpediteOptionsLoading',true],['reportExpediteOptionsAuthoritative',false],['reportExpeditePropertyKey','chicago']]){
  const original=state[field];state[field]=value;assert.equal(vm.runInContext('reportExpeditePricingReady()',context),false,field);state[field]=original;
 }
});
test('gutter display and totals use the verified property quote and discard it after an address change',()=>{
 const functionSource=source.match(/^  function gutterReportAddonPrice.*$/m)[0];
 const state={reportExpeditePropertyKey:'paris',reportPropertyKey:()=> 'paris',reportPropertyPrices:{gutters:6},window:{PlatformCommerce:{price:()=>2}}};
 const context=vm.createContext(state);vm.runInContext(functionSource,context);
 assert.equal(vm.runInContext('gutterReportAddonPrice()',context),6);
 state.reportExpeditePropertyKey='chicago';assert.equal(vm.runInContext('gutterReportAddonPrice()',context),2);
 state.reportExpeditePropertyKey='paris';state.reportPropertyPrices={gutters:5};assert.equal(vm.runInContext('gutterReportAddonPrice()',context),5);
});
