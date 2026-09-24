import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const billing = await readFile(new URL('../../libraries/apps/settings/platform-billing.js', import.meta.url), 'utf8');
const search = await readFile(new URL('../../libraries/apps/settings/search.js', import.meta.url), 'utf8');
const definition = (key, expanded = true, type = 'boolean') => ({key,group:key.split('.')[0],flag:key.split('.')[1],type,requires:expanded?['platform.expanded_access']:[]});
const definitions = [definition('platform.expanded_access',false),definition('platform.platform_billing'),definition('apps.firstmeasure',false),definition('apps.billing',false),definition('platform.storage_limits',false),definition('apps.assistant'),definition('future.new_feature'),definition('future.limit',true,'number')];
function fixture(values){
  const root = {PlatformAPI:{appFlags:{has:(group,flag)=>values[`${group}.${flag}`]===true,current:()=>({definitions})}}};
  const context = vm.createContext({window:root});vm.runInContext(billing,context);vm.runInContext(search,context);return root;
}
test('FirstMeasure and billing switches alone do not show platform billing',()=>{
  for(const expanded of [false,true]) assert.equal(fixture({'platform.expanded_access':expanded,'platform.platform_billing':true,'apps.firstmeasure':true,'apps.billing':true,'platform.storage_limits':true,'future.limit':100}).FirstMatePlatformBilling.isEnabled(),false);
});
test('an enabled platform app or newly registered feature enables the combined section',()=>{
  for(const key of ['apps.assistant','future.new_feature']) assert.equal(fixture({'platform.expanded_access':true,'platform.platform_billing':true,[key]:true}).FirstMatePlatformBilling.isEnabled(),true);
});
test('expanded access and the dedicated billing switch remain required',()=>{
  for(const disabled of ['platform.expanded_access','platform.platform_billing']) assert.equal(fixture({'platform.expanded_access':true,'platform.platform_billing':true,'apps.assistant':true,[disabled]:false}).FirstMatePlatformBilling.isEnabled(),false);
});
test('search uses the single Billing destination and hides platform entries when features are off',()=>{
  const enabled=fixture({'platform.expanded_access':true,'platform.platform_billing':true,'apps.assistant':true});
  const matches=enabled.FirstMateSettingsSearch.search('usage charges');assert.equal(matches.length,1);assert.equal(matches[0].section,'billing');assert.equal(matches[0].tab,'Billing');
  let route;enabled.Portal={navigation:{navigate:value=>{route=value;}}};enabled.FirstMateSettingsSearch.open(matches[0]);assert.equal(route.sub,'billing');
  assert.equal(fixture({'platform.expanded_access':true,'platform.platform_billing':true}).FirstMateSettingsSearch.search('usage charges').length,0);
});
