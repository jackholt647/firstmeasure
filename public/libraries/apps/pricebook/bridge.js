/* public/libraries/apps/pricebook/bridge.js
 * Compatibility loader for the shared pricebook library.
 *
 * Platform should load ../libraries/pricebook/firstmate-pricebook.js directly.
 * This shim keeps older script references from silently losing pricebook support.
 */
(function(){
  if (window.FirstMatePricebook) {
    if (window.Portal) {
      window.Portal.modules = window.Portal.modules || {};
      window.Portal.modules.pricebook = window.FirstMatePricebook;
    }
    return;
  }
  const script = document.createElement('script');
  const bridgeUrl = document.currentScript?.src ? new URL(document.currentScript.src, window.location.href) : null;
  const pricebookUrl = new URL('../../pricebook/firstmate-pricebook.js', bridgeUrl || window.location.href);
  if (bridgeUrl?.search) pricebookUrl.search = bridgeUrl.search;
  script.src = pricebookUrl.toString();
  script.onload = function(){
    if (window.FirstMatePricebook && window.Portal) {
      window.Portal.modules = window.Portal.modules || {};
      window.Portal.modules.pricebook = window.FirstMatePricebook;
    }
  };
  document.head.appendChild(script);
})();
