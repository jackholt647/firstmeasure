// FM-539: on the Android app the phone Feed's "Take photos" bar sat high above
// the bottom of the screen. The Feed is in the top portal document, where the
// WebView still reports the system bars as env(safe-area-inset-*) although
// MainActivity already pads it for them (FM-535), so the bar, the camera and the
// feed's scroll padding counted the navigation bar twice. They read the
// window's real bottom inset (--fm-window-safe-bottom, 0px on Android) instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const feed = readFileSync(new URL('../public/libraries/apps/photos/feed.js', import.meta.url), 'utf8');
const rules = feed.split('\n').filter(line => line.includes('.pf-feed-camera-host'));
const rule = selector => rules.find(line => line.trim().startsWith(selector + '{'));

test('the feed camera host takes its bottom inset from the window, not env()', () => {
  assert.match(rule('.pf-feed-camera-host') || '', /--fm-safe-bottom:var\(--fm-window-safe-bottom,env\(safe-area-inset-bottom,0px\)\)/);
});

test('the bar and the scroll padding sit on that inset', () => {
  assert.match(rule('.pf-feed-camera-host>.fmc-bar') || '', /bottom:max\(12px,var\(--fm-safe-bottom\)\)/);
  assert.match(rule('.pf-feed-camera-host.fmc-host .pf-wrap>[data-photo-feed-dynamic]>.pf-scroll') || '', /padding-bottom:calc\(76px \+ var\(--fm-safe-bottom\)\)/);
});

test('no feed camera rule pads with a raw env(safe-area-inset-bottom)', () => {
  for (const line of rules) {
    assert.doesNotMatch(line.replace(/var\(--fm-window-safe-bottom,env\(safe-area-inset-bottom,0px\)\)/g, ''), /safe-area-inset-bottom/, line.trim());
  }
});
