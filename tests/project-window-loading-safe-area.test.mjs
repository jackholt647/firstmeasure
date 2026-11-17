// FM-535: on the Android app a project window opened with extra white space
// under its tray rail until the project loaded. MainActivity pads the WebView
// for the system bars but the WebView still reports them as
// env(safe-area-inset-*), so the loading chrome (top document) padded the
// navigation bar twice; the loaded rail lives in the window's iframe, where
// env() is zero.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('the Android app zeroes both window safe-area insets before any loading chrome paints', () => {
  const page = read('public/portal/index.php');
  const script = page.match(/<script id="fm-native-window-insets">([\s\S]*?)<\/script>/);
  assert.ok(script, 'index.php keeps the native window insets script in <head>');
  assert.ok(page.indexOf(script[0]) < page.indexOf('<link'), 'insets are applied before stylesheets load');
  for (const side of ['top', 'bottom']) {
    assert.match(script[1], new RegExp(`--fm-window-safe-${side}', '0px'`), `--fm-window-safe-${side} is 0px on Android`);
  }
});

test('the loading tray rail pads the bottom through --fm-window-safe-bottom', () => {
  const shell = read('public/libraries/window-manager/window-shell.js');
  const rule = shell.split('\n').find(line => line.includes('.fm-project-loading-header[data-window-mobile=true]>.fm-project-tray-tabs{'));
  assert.ok(rule, 'window-shell.js styles the loading tray rail');
  assert.match(rule, /padding:0 6px var\(--fm-window-safe-bottom,env\(safe-area-inset-bottom,0px\)\)!important/);
  assert.doesNotMatch(rule.replace(/var\(--fm-window-safe-bottom,env\(safe-area-inset-bottom,0px\)\)/g, ''), /safe-area-inset-bottom/);
});
