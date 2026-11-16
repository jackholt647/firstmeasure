// In the phone drawer the New menu drops down over the app list; it must never sit in the flow and push the
// apps down (FM-487). The rule and openMenu() live inline in public/portal/index.php.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'public/portal/index.php'), 'utf8');

function rule(selector){
  const start = source.indexOf(`${selector}{`);
  assert.ok(start >= 0, `index.php has a ${selector} rule`);
  return source.slice(start, source.indexOf('}', start) + 1);
}

test('the drawer New menu is positioned over the app list, not in the flow', () => {
  const css = rule('.sidebar.mob-open .new-menu-popout');
  assert.match(css, /position:absolute;/);
  assert.match(css, /top:calc\(100% \+ \d+px\);/);
  assert.match(css, /max-height:var\(--new-menu-max-height/);
  assert.match(css, /overflow-y:auto;/);
  assert.doesNotMatch(css, /position:static/);
  assert.doesNotMatch(css, /margin-top/);
  assert.match(rule('    .new-menu-wrap'), /position:relative;/);
});

test('openMenu keeps the drawer menu inside the scroll area', () => {
  const start = source.indexOf('const openMenu = () => {');
  const body = source.slice(start, source.indexOf('\n      };', start));
  assert.match(body, /closest\('\.sidebar-scroll'\)/);
  assert.match(body, /--new-menu-max-height/);
});
