import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('shared agent rendering and document import/export preserve tables, list starts and undo',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setContent('<div id="agent"></div><div id="doc" style="height:800px"></div>');
 for(const name of ['doc-markdown/firstmate-markdown.js','doc-model/firstmate-doc-model.js','doc-renderer/firstmate-doc-renderer.js','doc-editor/firstmate-doc-editor.js','agent-chat/agent-chat.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+name,import.meta.url),'utf8')});
 const result=await page.evaluate(async()=>{
  const source='3. First\n4. Second\n\n| Name | Value |\n| --- | --- |\n| Item | **yes** |';
  document.querySelector('#agent').innerHTML=FirstMateAgentChat.renderMarkdown(source);
  window.editor=FMDocEditor.mount(document.querySelector('#doc'),{document:FMDocModel.createDocument({kind:'document'}),profile:'document',mode:'doc'});editor.setMode('doc');
  const inserted=editor.insertMarkdown(source);await new Promise(r=>setTimeout(r,300));const exported=editor.exportMarkdown();const tables=JSON.stringify(editor.getDocument()).includes('"type":"table"');const markers=[...document.querySelectorAll('#doc [data-marker]')].map(e=>e.dataset.marker);editor.undo();await new Promise(r=>setTimeout(r,100));return {inserted:!!inserted,tables,markers,exported,afterUndo:JSON.stringify(editor.getDocument()).includes('"type":"table"')};
 });assert.ok(result.inserted);assert.ok(result.tables);assert.ok(result.markers.includes('3.'));assert.match(result.exported.markdown,/\| Name \| Value \|/);assert.equal(result.afterUndo,false);assert.equal(await page.locator('#agent table').count(),1);assert.equal(await page.locator('#agent ol').getAttribute('start'),'3');assert.deepEqual(errors,[]);await page.evaluate(()=>editor.destroy());
 }finally{await browser.close();}
});
