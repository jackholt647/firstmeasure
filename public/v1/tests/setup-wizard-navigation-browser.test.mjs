import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

// GP-5: changing step in the setup-wizard shell answers the click at once,
// even while the draft save is slow (dev is HTTP/1.1 and a busy portal queues
// the save for seconds).
const shell = await readFile(new URL('../../libraries/setup-wizard/setup-wizard.js', import.meta.url), 'utf8');
const sms = await readFile(new URL('../../libraries/apps/settings/sms-registration.js', import.meta.url), 'utf8');
const executablePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium');

async function openFixture(page, autosave){
  await page.setContent('<style>body{font:14px Arial}</style>');
  await page.addScriptTag({ content: shell });
  await page.evaluate((autosave) => {
    window.saves = [];
    window.release = () => {};
    const state = { name: '' };
    const step = (id) => ({
      id,
      label: id.toUpperCase(),
      render: (container, ctx) => {
        container.innerHTML = `<input data-name value="${ctx.state.name}">`;
        container.querySelector('input').addEventListener('input', (event) => { ctx.state.name = event.target.value; ctx.touch(); });
      }
    });
    window.wizard = window.FirstMateSetupWizard.open({
      id: 'gp5',
      title: 'GP-5',
      steps: [step('a'), step('b'), step('c')],
      state,
      autosave: {
        ...autosave,
        debounceMs: 60000,
        save: (saved) => new Promise((resolve) => { window.saves.push(saved.name); window.release = resolve; })
      }
    });
  }, autosave);
}

const snapshot = (page) => page.evaluate(() => ({
  active: document.querySelector('.fm-wizard-step.active')?.dataset.fmStep,
  pending: Array.from(document.querySelectorAll('.fm-wizard-step.pending')).map((el) => el.dataset.fmStep),
  stepSpinner: !!document.querySelector('.fm-wizard-step.pending .num .fa-spinner'),
  railDisabled: Array.from(document.querySelectorAll('[data-fm-step]')).every((el) => el.disabled),
  nextSpinner: !!document.querySelector('[data-fm-next].fm-wizard-pending .fa-spinner'),
  actionsDisabled: Array.from(document.querySelectorAll('[data-fm-actions] button')).every((el) => el.disabled),
  busy: document.querySelector('.fm-wizard')?.getAttribute('aria-busy') === 'true',
  note: document.querySelector('[data-fm-note]')?.textContent,
  saves: window.saves.slice()
}));

test('a step change that waits for the save shows it at once on the step and the button', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openFixture(page, {});

    await page.locator('[data-name]').fill('Ada');
    await page.locator('[data-fm-step="c"]').click();
    let now = await snapshot(page);
    assert.equal(now.active, 'a', 'stays on the step until the save is done');
    assert.deepEqual(now.pending, ['c']);
    assert.equal(now.stepSpinner, true);
    assert.equal(now.railDisabled, true);
    assert.equal(now.actionsDisabled, true);
    assert.equal(now.busy, true);
    assert.equal(now.note, 'Saving draft...');
    assert.deepEqual(now.saves, ['Ada']);

    // A host refresh while the save runs keeps the pending state.
    await page.evaluate(() => window.wizard.refresh());
    assert.deepEqual((await snapshot(page)).pending, ['c']);
    // A second click is ignored instead of queueing another change.
    await page.evaluate(() => window.wizard.goTo('b'));
    await page.evaluate(() => window.release());
    await page.waitForFunction(() => document.querySelector('.fm-wizard-step.active')?.dataset.fmStep === 'c');
    now = await snapshot(page);
    assert.deepEqual(now.pending, []);
    assert.equal(now.busy, false);
    assert.equal(now.railDisabled, false);

    // Continue: its own spinner, then the next step... (c is last: go back to b first).
    await page.locator('[data-fm-back]').click();
    await page.waitForFunction(() => document.querySelector('.fm-wizard-step.active')?.dataset.fmStep === 'b');
    await page.locator('[data-name]').fill('Ada Lovelace');
    await page.locator('[data-fm-next]').click();
    now = await snapshot(page);
    assert.equal(now.active, 'b');
    assert.equal(now.nextSpinner, true);
    assert.equal(now.actionsDisabled, true);
    assert.deepEqual(now.pending, ['c']);
    await page.evaluate(() => window.release());
    await page.waitForFunction(() => document.querySelector('.fm-wizard-step.active')?.dataset.fmStep === 'c');
    assert.equal((await snapshot(page)).nextSpinner, false);

    // Nothing to save: the step changes straight away, with no spinner.
    await page.locator('[data-fm-step="a"]').click();
    assert.equal((await snapshot(page)).active, 'a');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('flushOnStep:false moves on at once and still saves what was typed', async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openFixture(page, { flushOnStep: false });

    await page.locator('[data-name]').fill('Grace');
    await page.locator('[data-fm-next]').click();
    let now = await snapshot(page);
    assert.equal(now.active, 'b');
    assert.deepEqual(now.pending, []);
    assert.equal(now.busy, false);
    assert.deepEqual(now.saves, ['Grace'], 'the save starts on the click');

    // The rail answers at once while that save is still running.
    await page.locator('[data-fm-step="c"]').click();
    now = await snapshot(page);
    assert.equal(now.active, 'c');
    assert.deepEqual(now.saves, ['Grace'], 'nothing new to save');
    await page.evaluate(() => window.release());
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('the SMS registration wizard does not wait for its draft save to change step', () => {
  assert.match(sms, /autosave: \{ debounceMs: \d+, flushOnStep: false, save: \(\) => persistDraft\(\) \}/);
});
