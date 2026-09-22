/* Money overlay integrity guard.
 *
 * The hosted portal is cross-origin, so this guard intentionally protects the
 * parent-owned iframe element and overlay only. It cannot inspect the hosted
 * document. Any failed check permanently fails closed for this page runtime.
 */
(function(){
  'use strict';
  if (window.FirstMateMoneyOverlayEnforcer?.version) return;

  const MONEY_STYLE_ID = 'css_company_money_settings';
  const POLL_INTERVAL_MS = 250;
  const TARGETED_CSS = /(?:#csPaneMoney|\.money-|\[data-money)/;
  const DYNAMIC_CLASSES = new Set([
    'active',
    'money-bank-add-hover',
    'money-accounts-portal-ready',
    'money-accounts-view-overview',
    'money-accounts-view-bank',
    'money-accounts-hosted-bank-opened',
    'money-bank-menu-open',
    'money-bank-workflow-active',
    'money-bank-workflow-ready',
    'money-bank-mode-manual',
    'money-bank-mode-instant',
    'money-bank-manual-page-open',
    'money-bank-workflow-complete',
    'money-bank-plaid-active',
    'money-overlay-layout-mode'
  ]);
  const DYNAMIC_ATTRIBUTES = new Set([
    'class', 'hidden', 'style', 'tabindex', 'disabled', 'src', 'value',
    'aria-selected', 'aria-expanded', 'aria-checked', 'aria-disabled'
  ]);
  const CRITICAL_COMPUTED_PROPERTIES = [
    'display', 'visibility', 'opacity', 'pointer-events', 'position',
    'z-index', 'overflow', 'overflow-x', 'overflow-y', 'clip-path',
    'transform', 'filter'
  ];
  const REQUIRED = Object.freeze({
    accounts: Object.freeze([
      ['iframe[data-money-portal-frame]', 1],
      ['[data-money-accounts-overview-tab]', 1],
      ['[data-money-accounts-bank-tab]', 1],
      ['[data-money-accounts-overview]', 1],
      ['[data-money-iframe-blocker="accounts-primary"]', 1],
      ['[data-money-accounts-controls]', 1],
      ['[data-money-other-options]', 1],
      ['[data-money-other-dropdown]', 1],
      ['[data-money-bank-view-payouts]', 1],
      ['[data-money-bank-account-cover]', 1],
      ['[data-money-bank-hover-rail]', 4],
      ['[data-money-iframe-click-cover] > div', 4],
      ['[data-money-bank-transition-loading]', 1],
      ['[data-money-plaid-loading]', 1],
      ['.money-plaid-visual-mask', 1],
      ['.money-plaid-click-deadzone', 1],
      ['[data-money-bank-workflow-controls]', 1],
      ['[data-money-bank-workflow-cover] > div', 4],
      ['[data-money-bank-manual-page]', 1],
      ['[data-money-overlay-dev-toolbar]', 1],
      ['[data-money-overlay-dev-shield]', 1]
    ]),
    disputes: Object.freeze([
      ['iframe[data-money-portal-frame]', 1],
      ['[data-money-iframe-blocker="disputes"]', 1]
    ])
  });

  let failedClosed = false;
  let approvedStylesheetSignature = null;
  let approvedTargetedStylesSignature = null;

  const stableClassName = (element) => Array.from(element.classList || [])
    .filter((name) => !DYNAMIC_CLASSES.has(name))
    .sort()
    .join('.');

  const structuralSignature = (root) => {
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return `#${String(node.textContent || '').replace(/\s+/g, ' ').trim()}`;
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const attributes = Array.from(node.attributes || [])
        .filter((attribute) => !DYNAMIC_ATTRIBUTES.has(attribute.name))
        .map((attribute) => `${attribute.name}=${attribute.value}`)
        .sort()
        .join('|');
      const classes = stableClassName(node);
      const children = Array.from(node.childNodes || []).map(visit).join('');
      return `<${node.tagName.toLowerCase()}:${classes}:${attributes}>${children}</${node.tagName.toLowerCase()}>`;
    };
    return visit(root);
  };

  const dynamicSignature = (root) => [root, ...Array.from(root.querySelectorAll('*'))].map((element) => {
    const dynamic = [
      element === root ? Array.from(root.classList).sort().join('.') : '',
      element.hasAttribute('hidden') ? 'hidden' : '',
      element.getAttribute('aria-selected') || '',
      element.getAttribute('aria-expanded') || '',
      element.getAttribute('aria-checked') || '',
      element.getAttribute('aria-disabled') || '',
      element.hasAttribute('disabled') ? 'disabled' : '',
      element.getAttribute('tabindex') || '',
      element.getAttribute('style') || ''
    ];
    return dynamic.join('|');
  }).join('\n');

  const computedSignature = (root) => Array.from(root.querySelectorAll([
    'iframe[data-money-portal-frame]',
    '[data-money-overlay-item]',
    '[data-money-iframe-blocker]',
    '[data-money-accounts-overview]',
    '[data-money-bank-workflow-controls]',
    '[data-money-bank-manual-page]',
    '[data-money-portal-loading]',
    '[data-money-bank-transition-loading]',
    '[data-money-plaid-loading]'
  ].join(','))).map((element) => {
    const style = getComputedStyle(element);
    return CRITICAL_COMPUTED_PROPERTIES.map((property) => style.getPropertyValue(property)).join('|');
  }).join('\n');

  const stylesheetSignature = () => {
    const style = document.getElementById(MONEY_STYLE_ID);
    if (!style || style.tagName !== 'STYLE') return null;
    let rules = '';
    try { rules = Array.from(style.sheet?.cssRules || []).map((rule) => rule.cssText).join('\n'); }
    catch (_error) { return null; }
    return `${style.textContent || ''}\n---CSSOM---\n${rules}`;
  };

  const targetedStylesSignature = () => {
    const matches = [];
    for (const sheet of Array.from(document.styleSheets || [])) {
      let rules;
      try { rules = Array.from(sheet.cssRules || []); }
      catch (_error) { continue; }
      for (const rule of rules) {
        const cssText = String(rule.cssText || '');
        if (TARGETED_CSS.test(cssText)) matches.push(cssText);
      }
    }
    return matches.join('\n');
  };

  const validateRequiredNodes = (root, surface) => (REQUIRED[surface] || []).every(([selector, count]) => (
    root.querySelectorAll(selector).length === count
  ));

  const validFrame = (frame, portalOrigin) => {
    if (!frame || frame.tagName !== 'IFRAME' || frame.getAttribute('allow') !== 'clipboard-write' || frame.getAttribute('scrolling') !== 'no') return false;
    const rawSource = String(frame.getAttribute('src') || '');
    if (!rawSource) return false;
    try {
      const source = new URL(rawSource, window.location.href);
      return source.protocol === 'https:' && source.origin === portalOrigin;
    } catch (_error) {
      return false;
    }
  };

  const surfaceIsRendered = (root, card, frame) => {
    for (let element = root; element && element.nodeType === Node.ELEMENT_NODE; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
      if (element === card) break;
    }
    const rootRect = root.getBoundingClientRect();
    const frameStyle = getComputedStyle(frame);
    const frameRect = frame.getBoundingClientRect();
    return rootRect.width > 0
      && rootRect.height > 0
      && frameRect.width > 0
      && Math.abs(frameRect.height - 700) < 0.5
      && frameStyle.display === 'block'
      && frameStyle.opacity === '1';
  };

  function arm(options = {}){
    const root = options.root;
    const frame = options.frame;
    const surface = String(options.surface || root?.dataset?.moneyPortal || '');
    const portalOrigin = String(options.portalOrigin || '');
    const card = root?.closest?.('.cs-card') || root?.parentElement;
    if (!root || !frame || !card || !portalOrigin || !REQUIRED[surface]) return null;

    let stopped = false;
    let expectedStructure = '';
    let expectedDynamic = '';
    let expectedComputed = '';
    const expectedStylesheet = approvedStylesheetSignature;
    const expectedTargetedStyles = approvedTargetedStylesSignature;

    const disconnectors = [];
    let intervalId = null;
    let checkQueued = false;

    const disarm = () => {
      if (stopped) return;
      stopped = true;
      disconnectors.splice(0).forEach((disconnect) => disconnect());
      if (intervalId) window.clearInterval(intervalId);
      intervalId = null;
    };

    const failClosed = (reason) => {
      if (stopped || failedClosed) return;
      failedClosed = true;
      disarm();
      console.error('[Money overlay integrity] Fail-closed removal', { surface, reason, timestamp:new Date().toISOString() });
      try { options.onFailure?.(reason); } catch (_error) { /* removal continues */ }
      try { frame.__moneyPortalFrameCleanup?.(); } catch (_error) { /* removal continues */ }
      card.remove();
      window.dispatchEvent(new CustomEvent('fm:money:integrity-failed', { detail:{ surface, reason } }));
    };

    const sync = () => {
      if (stopped || failedClosed || !root.isConnected) return;
      expectedStructure = structuralSignature(root);
      expectedDynamic = dynamicSignature(root);
      expectedComputed = computedSignature(root);
    };

    const check = () => {
      checkQueued = false;
      if (stopped) return;
      if (failedClosed) return failClosed('integrity latch already tripped');
      if (!root.isConnected || !card.isConnected) return failClosed('Money card or overlay root was removed');
      if (!validateRequiredNodes(root, surface)) return failClosed('required overlay element changed');
      if (!validFrame(frame, portalOrigin)) return failClosed('iframe identity or destination changed');
      if (!surfaceIsRendered(root, card, frame)) return failClosed('Money surface was hidden or its fixed iframe geometry changed');
      if (structuralSignature(root) !== expectedStructure) return failClosed('overlay structure or content changed');
      if (dynamicSignature(root) !== expectedDynamic) return failClosed('overlay state or inline styling changed outside the state machine');
      if (computedSignature(root) !== expectedComputed) return failClosed('effective overlay styling changed');
      if (stylesheetSignature() !== expectedStylesheet) return failClosed('Money stylesheet changed or was removed');
      if (targetedStylesSignature() !== expectedTargetedStyles) return failClosed('additional CSS targeted the Money surface');
    };

    const queueCheck = () => {
      if (checkQueued || stopped) return;
      checkQueued = true;
      queueMicrotask(check);
    };

    if (failedClosed) {
      card.remove();
      return Object.freeze({ sync(){}, check(){}, disarm(){} });
    }
    if (!expectedStylesheet || expectedTargetedStyles == null || stylesheetSignature() !== expectedStylesheet || targetedStylesSignature() !== expectedTargetedStyles || !validateRequiredNodes(root, surface) || !validFrame(frame, portalOrigin)) {
      failClosed('integrity contract could not be established');
      return Object.freeze({ sync(){}, check(){}, disarm(){} });
    }

    sync();
    const rootObserver = new MutationObserver((records) => {
      if (records.some((record) => record.type === 'childList' || record.type === 'characterData')) {
        failClosed('overlay nodes or text were mutated');
        return;
      }
      queueCheck();
    });
    rootObserver.observe(root, { subtree:true, childList:true, characterData:true, attributes:true });
    disconnectors.push(() => rootObserver.disconnect());
    const documentObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target === root || root.contains(record.target)) continue;
        const touchedMoneyStyle = Array.from(record.addedNodes || []).concat(Array.from(record.removedNodes || [])).some((node) => (
          node === document.getElementById(MONEY_STYLE_ID)
          || node?.id === MONEY_STYLE_ID
          || (node?.nodeType === Node.ELEMENT_NODE && TARGETED_CSS.test(String(node.textContent || '')))
        ));
        if (touchedMoneyStyle) {
          failClosed('Money CSS was added, removed, or replaced');
          return;
        }
      }
      queueCheck();
    });
    documentObserver.observe(document.documentElement, { subtree:true, childList:true, characterData:true });
    disconnectors.push(() => documentObserver.disconnect());
    intervalId = window.setInterval(check, POLL_INTERVAL_MS);

    return Object.freeze({ sync, check, disarm });
  }

  const portalUtil = window.Portal?.util;
  const originalInjectCSS = portalUtil?.injectCSS;
  if (typeof originalInjectCSS === 'function') {
    portalUtil.injectCSS = function integrityAwareInjectCSS(id, cssText){
      const result = originalInjectCSS.call(this, id, cssText);
      if (id === 'company_money_settings') {
        approvedStylesheetSignature = stylesheetSignature();
        approvedTargetedStylesSignature = targetedStylesSignature();
      }
      return result;
    };
  }

  const api = Object.freeze({ arm, locked:true, version:'1' });
  Object.defineProperty(window, 'FirstMateMoneyOverlayEnforcer', {
    value:api,
    enumerable:false,
    configurable:false,
    writable:false
  });
})();
