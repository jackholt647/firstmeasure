import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const source = await readFile(new URL('../../libraries/apps/settings/company.js', import.meta.url), 'utf8');
const renderer = source.slice(source.indexOf('    async function renderDocumentSettings(){'), source.indexOf('    async function renderCrewSettings(){'));

test('document settings migrate and save delivery controls without losing required documents', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main></main>');
    await page.evaluate(async renderer => {
      window.saved = null;
      window.PlatformAPI = { branchModules: {
        get: async (_org, _branch, id) => ({ module: { data: id === 'presentation_style'
          ? { proposal_defaults: { send_include_pdf: false, send_include_portal: false, completion_message: 'Old {{company}} message' } }
          : { required_documents: [{ key: 'permit', label: 'Permit', document_type: 'permit', enabled: true }], other_setting: 'retain' } } }),
        save: async (_org, _branch, _id, data) => { window.saved = data; }
      } };
      const render = new Function('paneDocuments', 'currentOrgId', 'currentBranchId', 'escapeHtml', 'showToast', renderer + '\nreturn renderDocumentSettings();');
      await render(document.querySelector('main'), () => 'org', () => 'default', value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'), () => {});
    }, renderer);
    assert.equal(await page.locator('#docSendPdfDefault').isChecked(), false);
    assert.equal(await page.locator('#docSendPortalDefault').isChecked(), false);
    assert.equal(await page.locator('#docCompletionMessage').inputValue(), 'Old {{company}} message');
    await page.locator('#docSendPortalDefault').check();
    await page.locator('#docCompletionMessage').fill('');
    await page.locator('#docReqAdd').click();
    assert.equal(await page.locator('#docCompletionMessage').inputValue(), '');
    await page.locator('#docReqSave').click();
    await page.waitForFunction(() => window.saved !== null);
    const saved = await page.evaluate(() => window.saved);
    assert.equal(saved.send_include_pdf, false);
    assert.equal(saved.send_include_portal, true);
    assert.equal(saved.completion_message, '');
    assert.equal(saved.other_setting, 'retain');
    assert.equal(saved.required_documents[0].label, 'Permit');
    assert.equal(saved.required_documents.length, 2);
    assert.ok(!source.includes("{ id:'proposals', allowed:"), 'legacy settings tab is removed');
  } finally { await browser.close(); }
});

test('document Send dialog loads branch defaults and allows per-send overrides', async () => {
  const projectSource = await readFile(new URL('../../libraries/apps/documents/project.js', import.meta.url), 'utf8');
  const send = projectSource.slice(projectSource.indexOf('    async function openSendModal(docRecord){'), projectSource.indexOf('    function renderSendSuccess('));
  const client = await readFile(new URL('../../libraries/documents-api/documents-api.js', import.meta.url), 'utf8');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<main></main>');
    await page.evaluate(() => {
      Object.defineProperty(document, "cookie", { value: "", configurable: true });
      window.fetch = async url => {
        window.settingsUrl = url;
        return { ok: true, text: async () => JSON.stringify({ ok: true, settings: { send_include_pdf: false, send_include_portal: false } }) };
      };
    });
    await page.addScriptTag({ content: client });
    await page.evaluate(async send => {
      DocumentsAPI.configure({ baseUrl: 'https://app.test/v1/documents' });
      const text = v => String(v ?? '').trim();
      const obj = v => v && typeof v === 'object' ? v : {};
      const open = new Function('bindings', 'const {api,orgId,project,state,firstText,objectValue,cleanText,arrayValue,projectContacts,esc,openModal,showToast,errorMessage} = bindings;'+send+'; return openSendModal({id:"doc",branch_id:"west",title:"Document"});');
      await open({
        api: () => DocumentsAPI, orgId: () => 'org', project: () => ({}), state: {},
        firstText: (...v) => v.map(text).find(Boolean) || '', objectValue: obj,
        cleanText: text, arrayValue: v => Array.isArray(v) ? v : [], projectContacts: () => [],
        esc: text, showToast: () => {}, errorMessage: text,
        openModal: html => { document.querySelector('main').innerHTML = html; return { el: document.querySelector('main') }; }
      });
    }, send);
    assert.equal(await page.evaluate(() => settingsUrl), 'https://app.test/v1/documents/organizations/org/settings?branch_id=west');
    assert.equal(await page.locator('[data-send-pdf]').isChecked(), false);
    assert.equal(await page.locator('[data-send-portal]').isChecked(), false);
    await page.locator('[data-send-pdf]').check();
    assert.equal(await page.locator('[data-send-pdf]').isChecked(), true);
  } finally { await browser.close(); }
});
