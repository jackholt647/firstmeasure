// FM-608: an organization with payments off still sends what is owed. Its payment schedule and amount due draw on the
// document (and so the PDF) as they do with payments on, with no way to pay and no word that payments are off; an
// e-signature that is off still shows the disabled box.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const lib = (name) => readFile(new URL('../../libraries/' + name, import.meta.url), 'utf8');
const off = { disabled: true, disabled_capability: 'documents.payments', disabled_reason: 'Payments is disabled for this organization.' };
const widget = (id, ref, props = {}) => ({ id, type: 'widget', frame: { x: 0, y: 0, w: 300, h: 120, layout: 'flow' }, anchor: 'flow', visible: true, props: { widget: ref, config: {}, ...props } });

test('payment widgets with payments off show what is owed without a disabled notice', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setContent('<div id="static"></div><div id="live"></div><div id="caps"></div>');
    for (const name of ['doc-model/firstmate-doc-model.js', 'doc-widgets/firstmate-doc-widgets.js', 'doc-renderer/firstmate-doc-renderer.js']) await page.addScriptTag({ content: await lib(name) });
    const result = await page.evaluate(async ({ off, nodes }) => {
      const make = (children) => { const doc = FMDocModel.createDocument({ kind: 'document' }); doc.pages[0].children = children; return doc; };
      const widgetData = {
        schedule: { rows: [{ label: 'Deposit', amount_cents: 437790, due_label: 'On signature', status: 'scheduled' }] },
        pay: { amount_due_cents: 437790, portal_url: 'https://example.com/pay' }
      };
      const paymentNodes = nodes.filter((node) => node.id !== 'sign').map((node) => ({ ...node, props: { ...node.props, ...off } }));
      const api = { portalUrl: 'https://example.com/pay', openPayment: () => {} };
      await FMDocRenderer.render(document.querySelector('#static'), { document: make(paymentNodes), widgetData, mode: 'static', widgetContext: { api } });
      await FMDocRenderer.render(document.querySelector('#live'), { document: make(paymentNodes), widgetData, mode: 'interactive', widgetContext: { api } });
      // Off by the organization's capabilities rather than a marked definition, beside an e-signature that is off.
      await FMDocRenderer.render(document.querySelector('#caps'), { document: make(nodes), widgetData, mode: 'interactive', capabilities: { 'documents.payments': false, 'documents.esign': false }, widgetContext: { api } });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const read = (selector) => {
        const host = document.querySelector(selector);
        return {
          text: host.textContent,
          disabled: [...host.querySelectorAll('.fmdoc-capability-disabled')].map((el) => el.getAttribute('data-disabled-reason')),
          buttons: host.querySelectorAll('button').length,
          qr: host.querySelectorAll('.fmdoc-pay-now-qr').length
        };
      };
      return { static: read('#static'), live: read('#live'), caps: read('#caps') };
    }, { off, nodes: [widget('schedule', 'doc.payment_schedule@1'), widget('pay', 'doc.pay_now@1', { config: { label: 'Pay deposit' } }), widget('sign', 'doc.signature@1', { config: { output: 'sig', label: 'Customer approval' } })] });
    for (const [name, view] of Object.entries(result)) {
      assert.doesNotMatch(view.text, /disabled for this organization/i, `${name}: no notice that payments are off`);
      assert.match(view.text, /Deposit/, `${name}: the payment schedule is drawn`);
      assert.match(view.text, /\$4,377\.90/, `${name}: the amount due is drawn`);
      assert.equal(view.qr, 0, `${name}: no QR to pay online`);
    }
    assert.deepEqual(result.static.disabled, []);
    assert.deepEqual(result.live.disabled, []);
    assert.equal(result.live.buttons, 0, 'no Pay button with payments off');
    assert.deepEqual(result.caps.disabled, ['E-signature is disabled for this organization.'], 'only the e-signature is marked off');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
