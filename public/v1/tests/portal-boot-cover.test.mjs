import assert from 'node:assert/strict';import test from 'node:test';import {readFile} from 'node:fs/promises';import crypto from 'node:crypto';
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const page=await read('../../portal/index.php'),core=await read('../../portal/scripts/core.js'),source=JSON.parse(await read('../platform/localization/catalog-source.json'));
const key=text=>'m_'+crypto.createHash('sha256').update('plain\0'+text).digest('hex').slice(0,14);
// FM-431: the boot cover is the platform's loading look, painted before any script, and its copy is catalogued.
test('every boot cover line has a catalogued language key that core.js localizes',()=>{
 const copy=[...page.matchAll(/data-fm-boot-copy="(\w+)">([^<]+)</g)].map(([, name,text])=>({name,text}));
 assert.deepEqual(copy.map(c=>c.name),['loading','slow','reload']);
 for(const {name,text} of copy){
  assert.equal(source.platform[key(text)],text,`${text} is in the platform catalog`);
  assert.match(core,new RegExp(`${name}:\\(globalThis\\.PlatformLanguage\\?\\.text\\("platform","${key(text)}"`),`core.js localizes ${name}`);
 }
});
test('the cover never reloads by itself and keeps tabs hidden until boot finishes',()=>{
 assert.match(page,/body\.platform-booting > :not\(script\):not\(style\):not\(#fmPlatformBootCover\)\{visibility:hidden!important\}/);
 assert.doesNotMatch(page.slice(page.indexOf('id="fmPlatformBootCover"'),page.indexOf('id="fmPlatformBootCover"')+3000),/setTimeout\([^)]*reload/);
});
test('the balance and permissions read runs beside the other boot reads, not after them',()=>{
 const boot=core.slice(core.indexOf("document.addEventListener('DOMContentLoaded', async ()=>{"));
 assert.ok(boot.indexOf('readCredits(orgId)')<boot.indexOf('await Promise.all(['),'credits read starts before the boot reads are awaited');
 assert.match(boot,/await refreshCredits\(\{ reads:creditReads \}\)[\s\S]{0,120}classList\.remove\('platform-booting'\)/);
});
