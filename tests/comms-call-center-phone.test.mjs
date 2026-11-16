// The Call Center (FM-497) on a phone: the portal's top bar carries the title, so the app's
// own heading and the "Call Center" intro are hidden, the settings button joins the
// Personal / Call center / Manager view switch in one row, and the desk, filters and cards
// use a compact phone layout. Desktop keeps the shared header with its settings button.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'public/libraries/apps/comms', file), 'utf8');
const workspace = read('workspace.js');
const css = read('communications.css');
const ui = read('communications-ui.js');

const phoneBlock = () => {
  const marker = '/* Phone: the portal\'s mobile top bar carries the title, so the call center starts with one compact control row. */';
  const start = css.indexOf(marker);
  assert.ok(start > 0, 'no call center phone block');
  const open = css.indexOf('@media(max-width:820px){', start);
  assert.ok(open > start, 'phone block is not at the 820px breakpoint');
  return css.slice(open, css.indexOf('\n}\n', open));
};

test('the switch and a settings button share one row', () => {
  assert.match(workspace, /<div class="fmcc-modebar"><div class="fmcc-switch" role="tablist"/);
  assert.match(workspace, /<button type="button" class="fmcc-settings" data-view="setup" aria-label="Communications settings">\$\{icon\('gear'\)\}<\/button><\/div>`;\}/);
  assert.match(workspace, /<div class="fmcc-top"><div class="fmcc-title"><h2>Call Center<\/h2>/);
  assert.match(workspace, /<label class="fmcc-department"><span>\$\{esc\(context\.department_label/);
  // Desktop: the shared header keeps the settings button, the mode bar does not repeat it.
  assert.ok(css.includes('.fmcm .fmcc-settings{display:none}'));
});

test('a phone shows no second or third title', () => {
  const phone = phoneBlock();
  for (const piece of [
    '.fmcm>[data-app-header] .app-heading{display:none}',
    '.fmcm:has(.fmcc)>[data-app-header]:not(:has(.app-tabs)){display:none!important}',
    '.fmcm .fmcc-settings{display:inline-flex',
    '.fmcm:has(>[data-app-header] .app-tabs) .fmcc-settings{display:none}',
    '.fmcc .fmcc-title{display:none}',
    '.fmcc .fmcc-section-head h3,.fmcc .fmcc-section-head>div:not(.fmcc-meta){display:none}',
  ]) assert.ok(phone.includes(piece), `phone block lacks ${piece}`);
  assert.match(workspace, /<div class="fmcc-section-head"><div class="fmcc-meta"><h3>Your call history<\/h3><p>\$\{state\.centerTotal\} calls match/);
});

test('desk controls, filters and cards are compact on a phone', () => {
  const phone = phoneBlock();
  for (const piece of [
    '.fmcc .fmcc-filters,.fmcc .fmcc-dial-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))',
    '.fmcc .fmcc-filters{grid-template-columns:repeat(3,minmax(0,1fr))}',
    '.fmcc .fmcc-filters .fmcc-search,.fmcc .fmcc-dial-controls>button{grid-column:1/-1}',
    '.fmcc .fmcm-empty{min-height:0',
    '.fmcc .fmcc-stat{padding:10px 12px}',
  ]) assert.ok(phone.includes(piece), `phone block lacks ${piece}`);
});

test('the stylesheet version moved with the phone layout', () => {
  assert.match(ui, /communications\.css\?v=20261116-fm497-call-center-phone/);
});
