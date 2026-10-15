import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const engine=readFileSync(new URL('../../libraries/apps/settings/search.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../../libraries/apps/settings/search-index.js',import.meta.url),'utf8');
function search(entries,resolve){const window={};const ctx=vm.createContext({window});vm.runInContext(index,ctx);if(entries)window.FirstMateSettingsIndex.entries=entries;vm.runInContext(engine,ctx);if(resolve)window.FirstMateSettingsSearch.registerDestination('people',resolve);return q=>Array.from(window.FirstMateSettingsSearch.search(q));}
test('user and users lead to the Users page; specific controls remain first',()=>{
 const find=search();for(const q of ['user','users']){const first=find(q)[0];assert.equal(first.title,'Users');assert.equal(first.view,'users');assert.equal(first.section,'people');}
 for(const [query,title]of [['waste','Waste'],['company language','Company language'],['message templates','Message templates'],['mesage templates','Message templates']])assert.equal(find(query)[0].title,title,query);
});
test('navigation wins comparable title matches, but an exact control beats a broader page',()=>{
 const find=search([
  {title:'Users',kind:'view',section:'people',tab:'People'},
  {title:'User',kind:'control',section:'phone',tab:'Phone'},
  {title:'User preferences',kind:'section',section:'preferences',tab:'User preferences'},
  {title:'User language',kind:'control',section:'people',tab:'People'},
  {title:'Assigned users',kind:'heading',section:'phone',tab:'Phone'},
 ]);
 assert.equal(find('user')[0].title,'Users');assert.equal(find('user language')[0].title,'User language');
 assert.equal(find('preferences')[0].kind,'section');
});
test('title matches precede category-only and tooltip-only matches; repetition cannot boost rank',()=>{
 const rows=[{title:'Quiet hours',kind:'control',tab:'Notifications',section:'notifications'},
 {title:'Summary',kind:'control',tab:'Quiet hours',section:'summary'},
 {title:'AAA',kind:'control',tab:'Phone',section:'phone',description:'Quiet hours'}];
 const before=search(rows)('quiet hours');assert.deepEqual(before.map(x=>x.title),['Quiet hours','Summary','AAA']);
 const after=search(rows.map(x=>({...x,description:(x.description||'').repeat(100)})))('quiet hours');
 assert.deepEqual(after.map(x=>[x.title,x.score]),before.map(x=>[x.title,x.score]));
});
test('unrelated categories cannot win through volume and all eligible results remain available',()=>{
 const rows=[{title:'Users',kind:'view',tab:'People',section:'people'},...Array.from({length:35},(_,i)=>({title:'Phone feature '+i,description:'Assigned user',kind:'control',tab:'Phone',section:'phone'}))];
 const found=search(rows)('user');assert.equal(found.length,2);assert.equal(found[0].title,'Users');assert.equal(found[1].matchCount,35);
});
test('a Settings suffix does not demote the destination below incidental exact fields',()=>{
 const find=search([{title:'Phone',kind:'control',tab:'People',section:'people'}, {title:'Phone Settings',kind:'section',tab:'Phone Settings',section:'sms'}]);
 assert.equal(find('phone')[0].section,'sms');assert.equal(find('phone settings')[0].section,'sms');
});
test('grouping uses destinations, folds plural labels and resolves unambiguous missing views',()=>{
 const find=search([
  {title:'Users',kind:'view',section:'people',tab:'People',view:'users'},
  {title:'Users',kind:'heading',section:'people',tab:'People'},
  {title:'User',kind:'control',section:'people',tab:'People',view:'users'},
  {title:'Invite user',kind:'control',section:'people',tab:'People',view:'users'},
  {title:'Invite user',kind:'heading',section:'people',tab:'People'},
  {title:'Departments',kind:'view',section:'people',tab:'People',view:'departments'},
  {title:'User',kind:'control',section:'people',tab:'People',view:'departments'},
 ]);
 const found=find('user');assert.equal(found.length,2);
 assert.equal(found[0].destinationTitle,'Users');assert.equal(found[0].matchSummary,'Invite user');
 assert.equal(found[1].destinationTitle,'Departments');assert.equal(found[1].matchSummary,'User');
});
test('grouping preserves the most relevant control and limits the inline match summary',()=>{
 const found=search(['Language','Language defaults','Language fallback','Language translation'].map((title,i)=>({title,kind:'control',section:'company',tab:'Company',selector:'#field'+i})))('language');
 assert.equal(found.length,1);assert.equal(found[0].selector,'#field0');assert.equal(found[0].matchCount,4);
 assert.equal(found[0].matchSummary,'Language defaults · Language fallback · +1');
});

test('destination owners canonicalize aliases and fallback routes using their own routing rules',()=>{
 const found=search([
  {title:'Users',kind:'view',tab:'People',section:'people',view:'users'},
  {title:'User',kind:'control',tab:'People',section:'people',view:'old-users'},
  {title:'User roles',kind:'heading',tab:'People',section:'people',view:'roles'},
 ],view=>view==='users'?view:'users')('user');
 assert.equal(found.length,1);assert.equal(found[0].view,'users');assert.equal(found[0].matchSummary,'User roles');
});
