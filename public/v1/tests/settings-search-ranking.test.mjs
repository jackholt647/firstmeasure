import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const engine=readFileSync(new URL('../../libraries/apps/settings/search.js',import.meta.url),'utf8');
const index=readFileSync(new URL('../../libraries/apps/settings/search-index.js',import.meta.url),'utf8');
function search(entries){const window={};const ctx=vm.createContext({window});vm.runInContext(index,ctx);if(entries)window.FirstMateSettingsIndex.entries=entries;vm.runInContext(engine,ctx);return q=>Array.from(window.FirstMateSettingsSearch.search(q));}
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
 const found=search(rows)('user');assert.equal(found.length,36);assert.equal(found[0].title,'Users');
});
