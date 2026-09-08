import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const interactionSource = await readFile('../measure/internal/editor_scripts/interaction_2d.js', 'utf8');
const start = interactionSource.indexOf('function firstMeasureInteractive3DRenderIntervalMs(');
const end = interactionSource.indexOf('\nfunction requestGeoRender(', start);
assert.ok(start >= 0 && end > start, 'dense-project render budget helper is present');
const context = vm.createContext({ Number });
vm.runInContext(interactionSource.slice(start, end), context);
assert.equal(vm.runInContext('firstMeasureInteractive3DRenderIntervalMs(179)', context), 0);
assert.ok(vm.runInContext('firstMeasureInteractive3DRenderIntervalMs(180)', context) >= 33);

const sceneSource = await readFile('../measure/internal/editor_scripts/scene_3d.js', 'utf8');
assert.match(sceneSource, /const IDLE_SCENE_RENDER_INTERVAL_MS = 100/);
assert.match(sceneSource, /const controlsChanged=.*controls\.update\(\)/);
assert.match(sceneSource, /const shouldRender=_sceneDirty3D\|\|now-_lastSceneRender3D>=IDLE_SCENE_RENDER_INTERVAL_MS/);

console.log('PASS: dense editor interactions are capped at 30 FPS and idle 3D redraws at 10 FPS.');
