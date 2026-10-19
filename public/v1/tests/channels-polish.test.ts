import test from 'node:test';
import assert from 'node:assert/strict';
import { protectPolishText } from '../channels/polish-text.js';
import { polishDraftSchema } from '../channels/schemas.js';
test('polish protects references, repeated mentions, code and table structure',()=>{
 const text='helo @Ada Bell and @Ada Bell, see [plan](https://example.com/a). Cost 120.50.\n```\nconst x=5;\n```\n| Item | Qty |\n| --- | --- |\n| wood | 3 |';
 const draft=protectPolishText(text,['Ada Bell','Unused Name']);assert.equal(draft.restore(draft.text.replace('helo','Hello')),text.replace('helo','Hello'));assert.ok(!draft.text.includes('@Ada Bell'));assert.ok(!draft.text.includes('const x=5'));
 const tokens=draft.text.match(/\[\[FM_POLISH_[a-f0-9]+_\d+\]\]/g)!;assert.throws(()=>draft.restore(draft.text.replace(tokens[0],'')),/preserve/);assert.throws(()=>draft.restore(draft.text+tokens[0]),/preserve/);
});
test('polish rejects empty and oversized drafts and excessive mention labels',()=>{assert.equal(polishDraftSchema.safeParse({text:' '}).success,false);assert.equal(polishDraftSchema.safeParse({text:'x'.repeat(20001)}).success,false);assert.equal(polishDraftSchema.safeParse({text:'ok',mention_names:Array(101).fill('name')}).success,false);});
