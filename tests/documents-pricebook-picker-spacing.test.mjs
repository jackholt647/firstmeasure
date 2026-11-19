// "Add from pricebook" (documents/project.js openPricebookPicker) renders its search controls, results list and
// footer inside [data-pb-body], not as children of .fmdx-modal, so the modal's gap never spaced them: the list
// touched the search and the footer sat 4px under it, with 22px below (GP-101). The picker spaces them itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'public/libraries/apps/documents');
const css = fs.readFileSync(path.join(dir, 'documents.css'), 'utf8');
const project = fs.readFileSync(path.join(dir, 'project.js'), 'utf8');

test('the picker still renders controls, list and footer inside [data-pb-body] directly in the modal', () => {
  assert.match(project, /openModal\(`<h2>[^`]*<\/h2><div data-pb-body>/);
  assert.match(project, /<div class="fmdx-pb-controls">[\s\S]*<div class="fmdx-pb-list">[\s\S]*<div class="fmdx-modal-foot">/);
});

test('[data-pb-body] spaces its children and trims the space under the footer', () => {
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return css.match(new RegExp(`(?:^|\\n)${escaped}\\{([^}]*)\\}`))?.[1] || '';
  };
  const body = rule('.fmdx-modal>[data-pb-body]');
  assert.match(body, /display:flex/);
  assert.match(body, /flex-direction:column/);
  assert.match(body, /gap:(1[2-9]|2\d)px/);
  assert.match(rule('.fmdx-modal:has(>[data-pb-body])'), /padding-bottom:16px/);
  assert.match(rule('.fmdx-modal>[data-pb-body]>.fmdx-modal-foot'), /padding-top:0/);
});
