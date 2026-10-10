import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(import.meta.url),MD=require('../../libraries/doc-markdown/firstmate-markdown.js'),M=require('../../libraries/doc-model/firstmate-doc-model.js');
const example='# Summary\n\n3. **First**\n  - _Nested_\n4. Next\n\n- [x] Done\n- [ ] Pending\n\n> Quoted **text**\n\n| Name | Amount |\n| --- | ---: |\n| A\\|B | `*literal*` |\n\n```js\nconst key = "<script>";\n```';
test('one representation preserves nested lists, tasks, quotes, tables and code through serialization',()=>{
 const parsed=MD.parse(example);assert.deepEqual(MD.parse(MD.stringify(parsed)),parsed);
 const html=MD.render(example);assert.match(html,/<ol start="3" type="1">/);assert.match(html,/<ul /);assert.match(html,/<table>/);assert.match(html,/A\|B/);assert.match(html,/<code>\*literal\*<\/code>/);assert.match(html,/aria-label="Completed"/);assert.match(html,/<blockquote>/);assert.match(html,/&lt;script&gt;/);
});
test('escaping, code spans and URL validation keep untrusted content inert',()=>{
 for(const source of ['<img src=x onerror=alert(1)>','[bad](javascript:alert(1))','[bad](data:text/html,x)','[bad](vbscript:x)','[bad](javascript&#58;alert)'])assert.doesNotMatch(MD.render(source),/<img|href="(?:javascript|data|vbscript):/);
 assert.match(MD.render('`**not bold**`'),/<code>\*\*not bold\*\*<\/code>/);assert.doesNotMatch(MD.render('`**not bold**`'),/<strong>/);
 assert.match(MD.render('[good](https://example.test/a_b?q=x&n=1)'),/href="https:\/\/example.test\/a_b\?q=x&amp;n=1"/);
 assert.doesNotMatch(MD.render('contact_email'),/<em>/);
});
test('input is bounded and malformed or deeply nested Markdown remains text',()=>{
 assert.equal(MD.listMarker('number',Infinity,2),'i.');assert.equal(MD.parse('999999999. Item').blocks[0].start,10000);assert.throws(()=>MD.parse('x'.repeat(262145)),RangeError);assert.ok(MD.render('> '.repeat(40)+'nested').length<5000);assert.match(MD.render('**unfinished'),/\*\*unfinished/);assert.match(MD.render('```\nunclosed'),/<pre><code>unclosed/);
});
test('DocModel adapter uses document blocks and cells, keeps literal prose, and reports export loss',()=>{
 const nodes=MD.toDocNodes(example),doc=M.createDocument({kind:'document'});doc.pages=[M.createPage('letter',{children:nodes})];assert.equal(M.validateDocument(doc).ok,true,JSON.stringify(M.validateDocument(doc)));
 const back=MD.fromDocNodes(nodes);assert.deepEqual(MD.parse(MD.stringify(back.content)),MD.parse(example));assert.ok(back.diagnostics.some(x=>x.includes('visual formatting')));
 const literal=M.createDocument({kind:'document'});literal.pages=[M.createPage('letter',{children:MD.toDocNodes('`{{org.secret}}`')})];const resolved=M.resolveBindings(literal,{org:{secret:'never interpolate'}});assert.equal(resolved.pages[0].children[0].props.blocks[0].runs[0].text,'{{org.secret}}');
 assert.ok(MD.fromDocNodes([{type:'widget',props:{widget:'doc.signature@1'}}]).diagnostics.some(x=>x.includes('widget')));
});
test('agents and secondary Markdown surfaces delegate to the shared implementation',async()=>{
 for(const name of ['agent-chat/agent-chat.js','platform-assistant/platform-assistant.js','apps/stats/app.js','apps/checklists/app.js']){const source=await readFile(new URL('../../libraries/'+name,import.meta.url),'utf8');assert.match(source,/FMMarkdown\.render\(raw\)/);assert.doesNotMatch(source,/trimmed\.match\(\/\^\[\-\*/);}
});

test("quoted lists and tables stay structured through the document adapter",()=>{const text="> - First\n>   2. Child\n>\n> | A | B |\n> | --- | --- |\n> | C | D |";const parsed=MD.parse(text);assert.deepEqual(MD.parse(MD.stringify(MD.fromDocNodes(MD.toDocNodes(parsed)).content)),parsed);});

test("table line breaks and document cell paragraphs retain their text",()=>{const nodes=[{type:"table",props:{rows:[{cells:[{text:"Header"}]},{cells:[{blocks:[{runs:[{text:"First"}]},{runs:[{text:"Second"}]}]}]}]}}];const exported=MD.fromDocNodes(nodes);const source=MD.stringify(exported.content);assert.match(source,/First<br>Second/);assert.equal(MD.parse(source).blocks[0].rows[1][0][0].text,"First\nSecond");assert.deepEqual(MD.parse(MD.stringify(MD.parse(source))),MD.parse(source));});
