import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {chromium} from 'playwright-core';

const settings = new URL('../../libraries/apps/settings/', import.meta.url);
const autosave = await readFile(new URL('../../libraries/settings-pages/firstmate-settings-pages.js', import.meta.url), 'utf8');
for (const [file, prefix] of [['company.js', 'cu'], ['firstmeasure-users.js', 'fmu']]) {
  test(`${file}: user actions stay open without triggering settings autosave`, async () => {
    const source = await readFile(new URL(file, settings), 'utf8');
    const start = source.indexOf('    floatingMenu = document.createElement');
    const end = source.indexOf(file === 'company.js' ? '    let lastSidebarLogoKey' : '    // **** Users UI', start);
    const menuStart = source.indexOf('    function renderActionsMenuForUser');
    const menuEnd = source.indexOf('\n    function ', menuStart + 20);
    const buttonMarkup = source.match(new RegExp(`<button class="${prefix}-kebab"[\\s\\S]*?</button>`))[0];
    const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium'), headless:true});
    try {
      const page = await browser.newPage();
      await page.setContent('<style>i{display:inline-block;width:12px;height:12px}</style><main><section class="active" data-settings-pane="users"><div id="row"></div><input aria-label="Setting"><button id="save">Save changes</button></section></main><button id="outside">Outside</button>');
      await page.addScriptTag({content:autosave});
      await page.evaluate(({setup, menu, buttonMarkup}) => {
        window.saveCount = 0;
        document.querySelector('#save').addEventListener('click', () => window.saveCount++);
        const escapeHtml = value => String(value ?? '');
        const paneUsers = document.querySelector('section');
        document.querySelector('#row').innerHTML = new Function('return `'+buttonMarkup+'`;')();
        const initialize = new Function('paneUsers', 'escapeHtml', `
          let floatingMenu; const usersState = {superAdmins:[]};
          const lifecycle = new AbortController();
          const canAddDelete = true;
          const guardInfoForUser = () => ({isMe:false,isSuper:false});
          const normEmail = u => u.email;
          const openEditUserModal = () => { const dialog=document.createElement('div'); dialog.setAttribute('role','dialog'); dialog.textContent='Edit user'; document.body.append(dialog); };
          ${setup}
          ${menu}
          const kebab=paneUsers.querySelector('[data-act="kebab"]');
          kebab.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); renderActionsMenuForUser({id:'example',email:'example@example.test'},kebab); });
        `);
        initialize(paneUsers, escapeHtml);
        window.FirstMateSettingsPages.installAutosave(document.querySelector('main'));
      }, {setup:source.slice(start,end),menu:source.slice(menuStart,menuEnd),buttonMarkup});
      const menu = page.locator(`.${prefix}-fmenu`);
      await page.locator('[data-act="kebab"] i').click();
      await page.waitForTimeout(150); // Let the real zero-delay autosave callback run.
      assert.equal(await page.evaluate(() => window.saveCount), 0, 'opening a menu must not save unrelated settings');
      assert.equal(await menu.isVisible(), true);
      await menu.locator('[data-act="edit"]').click();
      assert.equal(await page.getByRole('dialog').isVisible(), true);
      assert.equal(await menu.isVisible(), false);
      await page.locator('[data-act="kebab"]').press('Enter');
      await page.waitForTimeout(100);
      assert.equal(await menu.isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await menu.isVisible(), false);
      await page.locator('[data-act="kebab"]').click();
      await page.locator('#outside').click();
      assert.equal(await menu.isVisible(), false);
      assert.equal(await page.evaluate(() => window.saveCount), 0);
      await page.getByLabel('Setting').fill('Updated');
      await page.waitForFunction(() => window.saveCount === 1);
    } finally { await browser.close(); }
  });
}
