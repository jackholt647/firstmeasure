import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const source = await readFile(path.join(publicRoot, 'libraries/agent-chat/agent-chat.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, console });
const chat = window.FirstMateAgentChat;

test('agent replies do not render editor mutation actions as empty buttons', () => {
  const html = chat.messageHtml({
    id: 'message-1',
    role: 'assistant',
    content: 'Updated the document.',
    data: { actions: [{ type: 'document.set_definition', document: { pages: [] } }] }
  }, { prefix: 'test-agent' });

  assert.doesNotMatch(html, /data-agent-actions/);
  assert.doesNotMatch(html, /data-agent-action-index/);
});

test('supported navigation actions always have a visible accessible label', () => {
  const html = chat.messageHtml({
    id: 'message-2',
    role: 'assistant',
    content: 'The destination is ready.',
    data: { actions: [
      { type: 'internal-mutation' },
      { kind: 'project', project_id: 'project-1' },
      { kind: 'tab', tab: 'document_templates' }
    ] }
  }, { prefix: 'test-agent' });

  assert.match(html, /data-agent-action-index="1" aria-label="Open project"/);
  assert.match(html, /<span>Open project<\/span>/);
  assert.match(html, /data-agent-action-index="2" aria-label="Open Document Templates"/);
  assert.match(html, /<span>Open Document Templates<\/span>/);
});
