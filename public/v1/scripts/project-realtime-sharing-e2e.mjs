import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const client=await readFile(new URL('../../libraries/platform-realtime/platform-realtime.js',import.meta.url),'utf8');
const html=`<script>window.__APP={userOrgId:'test'};window.sources=[];window.EventSource=class{constructor(url){this.url=url;this.listeners={};sources.push(this)}addEventListener(type,fn){this.listeners[type]=fn}close(){this.closed=true}};window.FirstMateProjectLayout={accepts:(token,child)=>[...document.querySelectorAll('iframe')].some(f=>f.contentWindow===child&&f.name==='fm-project-pane:'+token)};</script><script src="/realtime.js"></script><script>window.events=[];if(window.name){PlatformRealtime.subscribe('test','project.',event=>events.push(event));PlatformRealtime.watchPresence('test','project:one',users=>window.users=users);}</script>`;
const server=createServer((req,res)=>{res.setHeader('content-type',req.url==='/realtime.js'?'text/javascript':'text/html');res.end(req.url==='/realtime.js'?client:html)});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>{const frame=document.createElement('iframe');frame.name='fm-project-pane:'+i;frame.src='/';frame.onload=resolve;document.body.append(frame);});});
 assert.equal(await page.evaluate(()=>sources.filter(s=>!s.closed).length),3);
 assert.equal(await page.evaluate(()=>PlatformRealtime.diagnostics()[0].subscribers),8);
 assert.equal(await page.evaluate(()=>[...document.querySelectorAll('iframe')].reduce((n,f)=>n+f.contentWindow.sources.length,0)),0);
 await page.evaluate(()=>{sources.find(s=>s.url.includes('events/stream')).listeners.platform({lastEventId:'1',data:JSON.stringify({topic:'project.changed',payload:{}})});sources.find(s=>s.url.includes('presence/project')).listeners.presence({data:'[{"name":"Viewer"}]'});});
 assert.ok(await page.evaluate(()=>[...document.querySelectorAll('iframe')].every(f=>f.contentWindow.events.length===1&&f.contentWindow.users[0].name==='Viewer')));
 await page.evaluate(()=>document.querySelector('iframe').remove());assert.equal(await page.evaluate(()=>PlatformRealtime.diagnostics()[0].subscribers),7);
 await page.evaluate(()=>document.querySelectorAll('iframe').forEach(f=>f.remove()));assert.equal(await page.evaluate(()=>PlatformRealtime.diagnostics()[0].subscribers),0);assert.equal(await page.evaluate(()=>sources.filter(s=>!s.closed).length),1);
 console.log('PASS: eight project panes share three transports; events and presence reach every pane; closing frames releases all pane subscriptions.');
}finally{await browser.close();server.close();}
