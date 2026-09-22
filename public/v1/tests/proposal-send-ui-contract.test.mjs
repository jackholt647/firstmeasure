import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const publicRoot = path.resolve(import.meta.dirname, '..', '..');
const proposalSource = await readFile(path.join(publicRoot, 'libraries/apps/proposals/project.js'), 'utf8');
const projectRequestSource = await readFile(path.join(publicRoot, 'libraries/apps/project-request/app.js'), 'utf8');

test('proposal send requires a valid recipient email and saves it before delivery', () => {
  assert.match(proposalSource, /Email required to send/);
  assert.match(proposalSource, /proposalRecipientEmailIsValid/);

  const submitHandler = proposalSource.match(/#rProposalSendSubmit'[\s\S]*?catch \(error\) \{/);
  assert.ok(submitHandler, 'proposal send submit handler should be present');
  const saveIndex = submitHandler[0].indexOf('saveProposalRecipientEmail');
  const sendIndex = submitHandler[0].indexOf('sendProposalToBackend');
  assert.ok(saveIndex >= 0, 'missing recipient email should be saved to the contact');
  assert.ok(sendIndex > saveIndex, 'contact persistence must happen before proposal delivery');
});

test('project contact email persistence reaches remote project storage', () => {
  const hostMethod = projectRequestSource.match(/saveContactEmail: async[\s\S]*?return collectContacts\(\)[\s\S]*?\n      \},/);
  assert.ok(hostMethod, 'project workspace should expose contact email persistence');
  assert.match(hostMethod[0], /persistActiveBaseProject\(\)/);
  assert.match(hostMethod[0], /ProjectStore\.saveRemote\(activeBaseProject\)/);
});
