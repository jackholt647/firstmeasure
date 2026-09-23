const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.FIRSTMEASURE_PLAYWRIGHT_MODULE || '../public/v1/node_modules/playwright-core');

test('photo controls work while wall mode captures model clicks', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="three-view-wrapper"><div id="three-container" style="position:relative;width:800px;height:650px"></div></div>');
    await page.addStyleTag({ path: 'public/measure/internal/editor_scripts/project_resources.css' });
    await page.addScriptTag({ path: 'public/measure/internal/editor_scripts/resource_3d_overlay.js' });
    // Exercise the actual wall-mode capture handler with model editing enabled.
    const wall = fs.readFileSync('public/measure/internal/editor_scripts/wall_mode.js', 'utf8');
    const start = wall.indexOf("        for(const type of ['pointerdown','mousedown','dblclick','click'])");
    const end = wall.indexOf('        function cancelInteraction()', start);
    assert.ok(start > 0 && end > start);
    await page.addScriptTag({ content: `(() => { let nudgeEpoch=0,nudgeKey=null; const settleNudges=()=>{}; const enabled=true,editingLayer='walls',baseEditor=null,wallEditor=null; ${wall.slice(start, end)} })();` });
    await page.evaluate(async () => {
      window.currentProjectId = 'fixture';
      const image = document.createElement('canvas'); image.width = 400; image.height = 200;
      await window.Resource3DOverlay.show({ image, label: 'Fixture', project: 'fixture' });
    });
    const state = () => page.locator('.resource-3d-background img').evaluate(el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top), width: parseFloat(el.style.width), opacity: Number(el.style.opacity) }));
    const initial = await state();
    await page.evaluate(()=>{window.modelWheels=0;document.getElementById('three-container').addEventListener('wheel',()=>window.modelWheels++);});
    const container=await page.locator('#three-container').boundingBox();
    await page.mouse.move(container.x+100,container.y+300);await page.mouse.wheel(0,-100);
    await page.waitForFunction(()=>window.modelWheels===1);
    assert.deepEqual(await state(),initial,'scrolling over the photo image leaves its alignment unchanged');
    await page.mouse.move(container.x+100,container.y+20);await page.mouse.wheel(0,100);
    await page.waitForFunction(()=>window.modelWheels===2);assert.equal((await state()).width,initial.width,'outside photo keeps model zoom');
    await page.locator('#resource-3d-controls header').hover();await page.mouse.wheel(0,-100);
    await page.waitForFunction(()=>parseFloat(document.querySelector('.resource-3d-background img').style.width)>800);
    assert.equal((await state()).left,initial.left,'controls zoom around the photo center');
    assert.equal(await page.evaluate(()=>window.modelWheels),2);
    await page.locator('[data-photo="fit"]').click();

    for (const [direction, axis, delta] of [['right','left',10],['left','left',-10],['up','top',-10],['down','top',10]]) {
      const before = await state();
      await page.locator(`[data-photo="${direction}"]`).click();
      assert.equal((await state())[axis], before[axis] + delta);
    }
    for (const [control, property] of [['size','width'],['opacity','opacity']]) {
      const slider = page.locator(`[data-photo="${control}"]`);
      const box = await slider.boundingBox();
      const before = await state();
      await page.mouse.click(box.x + box.width * .8, box.y + box.height / 2);
      assert.notEqual((await state())[property], before[property], `${control} responds to mouse input`);
      const beforeDrag = await state();
      await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      assert.ok((await state())[property] < beforeDrag[property], `${control} responds to dragging`);
      await slider.focus();
      const value = await slider.inputValue();
      await page.keyboard.press('ArrowLeft');
      assert.equal(Number(await slider.inputValue()), Number(value) - 1);
    }
    const pad = await page.locator('[data-photo="drag"]').boundingBox();
    const rotation = page.getByRole('slider', {name:'Photo rotation'});
    await rotation.focus();await page.keyboard.press('ArrowRight');
    assert.equal(await rotation.inputValue(),'0.1');
    assert.equal(await page.locator('[data-value="rotation"]').textContent(),'0.1°');
    assert.match(await page.locator('.resource-3d-background img').evaluate(el=>el.style.transform),/rotate\(0.1deg\)/);
    await page.keyboard.press('Home');assert.equal(await rotation.inputValue(),'-15');
    await page.keyboard.press('End');assert.equal(await rotation.inputValue(),'15');
    await page.mouse.move(pad.x + 12, pad.y + 12); await page.mouse.down();
    await page.mouse.move(pad.x + 42, pad.y + 32); await page.mouse.up();
    assert.equal((await state()).left, initial.left + 30);
    await page.locator('[data-photo="fit"]').click();
    assert.equal((await state()).width, initial.width);
    assert.equal((await state()).left, initial.left);
    assert.equal((await state()).top, initial.top);
    assert.equal(await rotation.inputValue(),'0');
    assert.match(await page.locator('.resource-3d-background img').evaluate(el=>el.style.transform),/rotate\(0deg\)/);
    await page.locator('[data-photo="remove"]').click();
    assert.equal(await page.locator('#resource-3d-controls').isVisible(), false);
  } finally { await browser.close(); }
});
