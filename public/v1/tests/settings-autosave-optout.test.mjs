import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtime = readFileSync(new URL('../../libraries/settings-pages/firstmate-settings-pages.js', import.meta.url), 'utf8');
const company = readFileSync(new URL('../../libraries/apps/settings/company.js', import.meta.url), 'utf8');

function harness() {
  const management = runtime.slice(runtime.indexOf('    const manageButton ='), runtime.indexOf('    const scan ='));
  const clicks = runtime.slice(runtime.indexOf('    const onActionClick ='), runtime.indexOf('\n    scan();'));
  return new Function(`
    const managed = new Set(), scheduled = [];
    class HTMLButtonElement {
      constructor(label, optedOut = false) { this.textContent = label; this.optedOut = optedOut; this.dataset = {}; }
      closest(selector) { return selector === 'button' ? this : this.optedOut ? {} : null; }
      matches() { return false; }
      setAttribute() {}
    }
    const buttonLabel = button => button.textContent;
    const saveLabel = /^(?:save|apply)\\b/i;
    const transactionalLabel = /and add card|new version/i;
    const nonSaveActionLabel = /^(?:add card|create)\\b/i;
    const unmanageButton = button => { managed.delete(button); delete button.dataset.settingsAutosaveTrigger; };
    const saveBarFor = () => null;
    const schedule = button => scheduled.push(button);
    ${management}
    ${clicks}
    return { button: (label, off) => new HTMLButtonElement(label, off), manageButton,
      click: button => onActionClick({ target: button }), managed, scheduled };
  `)();
}

test('feature flag drafts keep their explicit Save and Discard controls outside autosave', () => {
  assert.match(company, /class="cap-sections" data-settings-autosave="off"/);
  const ui = harness();
  const save = ui.button('Save Changes', true);
  ui.manageButton(save);
  assert.equal(ui.managed.size, 0);
  assert.equal(save.dataset.settingsAutosaveTrigger, undefined);
  for (const label of ['Save Changes', 'Discard', 'Advanced App Menu']) ui.click(ui.button(label, true));
  assert.equal(ui.scheduled.length, 0);
});

test('ordinary settings retain autosave behavior', () => {
  const ui = harness();
  const save = ui.button('Save Changes');
  ui.manageButton(save);
  assert.equal(save.dataset.settingsAutosaveTrigger, 'true');
  ui.click(ui.button('Enable'));
  assert.equal(ui.scheduled.length, 1);
});
