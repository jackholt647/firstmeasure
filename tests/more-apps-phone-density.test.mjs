// GP-130: on a phone the More apps sheet left room for fewer tiles than it
// could. Its bottom padding added env(safe-area-inset-bottom), which the
// Android WebView still reports although MainActivity already pads it for the
// navigation bar (FM-535), so the bar was counted twice; tiles were 1.08 times
// as tall as wide; and an app with sub-views put its chevron in a row of its
// own under the name. The sheet now reads the window's real inset, a tile is as
// tall as its parts, and the chevron sits beside the name (in the corner only
// when the name cannot fit beside it).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const core = readFileSync(new URL('../public/portal/scripts/core.js', import.meta.url), 'utf8');
const pins = readFileSync(new URL('../public/libraries/left-column-pins/left-column-pins.js', import.meta.url), 'utf8');
const compactLines = (source) => source.split('\n').filter((line) => line.includes('.fm-advanced-apps-overlay.is-compact'));

test('the phone sheet takes its bottom inset from the window, not env()', () => {
  const rule = compactLines(core).find((line) => line.trim().startsWith('.fm-advanced-apps-overlay.is-compact{'));
  assert.ok(rule, 'compact overlay rule');
  assert.match(rule, /\.fm-advanced-apps-overlay\.is-compact\{padding:[^}]*var\(--fm-window-safe-bottom,env\(safe-area-inset-bottom,0px\)\)/);
  for (const line of compactLines(core)) {
    assert.doesNotMatch(line.replace(/var\(--fm-window-safe-bottom,env\(safe-area-inset-bottom,0px\)\)/g, ''), /safe-area-inset-bottom/, line.trim().slice(0, 120));
  }
});

test('a phone tile is as tall as its icon and two lines of name, not a ratio of its width', () => {
  assert.doesNotMatch(core, /--fm-advanced-tile-height', `\$\{Math\.round\(tile \* 1\.08\)\}px`/);
  assert.match(core, /const tileHeight = iconTop \+ iconSize \+ 4 \+ Math\.ceil\(labelSize \* 2\.3\) \+ 7;/);
  assert.match(core, /--fm-advanced-tile-height', `\$\{tileHeight\}px`/);
  // The label reserves exactly two lines of its own size (line-height 1.15).
  assert.match(core, /\.is-compact \.fm-advanced-app-open\{[^}]*min-height:calc\(var\(--fm-advanced-label-size,12px\) \* 2\.3\)/);
});

test('the sub-view chevron sits beside the name on phones, in the corner only for a name too long', () => {
  const lines = compactLines(pins);
  assert.ok(lines.some((line) => /\.has-subviews\{flex-flow:row wrap/.test(line)), 'tile lays the name and chevron out in one row');
  const toggle = lines.find((line) => line.trim().startsWith('.fm-advanced-apps-overlay.is-compact .fm-advanced-app-subviews-toggle{'));
  assert.match(toggle || '', /position:relative;right:auto;bottom:auto/);
  assert.ok(lines.some((line) => /\.is-long-label \.fm-advanced-app-subviews-toggle\{position:absolute/.test(line)), 'long names give the chevron the corner');
  assert.match(core, /tile\.classList\.add\('is-long-label'\)/);
});

test('a closed sub-view list adds no blank space under the last row', () => {
  assert.ok(compactLines(pins).some((line) => /:not\(\.is-expanded\):not\(:has\(:focus-visible\)\) \.fm-advanced-app-subviews\{top:auto;bottom:0\}/.test(line)));
});

test('nothing here changes the desktop sheet', () => {
  for (const line of pins.split('\n').filter((l) => l.includes('is-long-label') || l.includes('flex-flow:row wrap'))) {
    assert.match(line, /\.fm-advanced-apps-overlay\.is-compact /, line.trim().slice(0, 120));
  }
});
