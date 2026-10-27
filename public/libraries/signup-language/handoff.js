/* Language hand-off for pages outside the app (1M8-240): the 1m8.ai and eu.1m8.ai websites.
 *
 * Include once per page:
 *   <script src="https://app.1m8.ai/libraries/signup-language/handoff.js" defer></script>
 *
 * When a visitor follows a link into the app (app.1m8.ai), the language this page is being shown in is passed on
 * as `?lang=<tag>` and stored in the `fm_lang` cookie for all of 1m8.ai. The page's language is:
 *   1. an explicit `?lang=` on this page (also kept for later pages);
 *   2. the language the browser translated the page into (Chrome/Google Translate mark <html> as translated and set
 *      its lang), or the page's own <html lang> when that is not English.
 * An untranslated English page passes nothing; the app then uses the visitor's browser language. */
(function () {
  'use strict';
  var COOKIE = 'fm_lang';
  var html = document.documentElement;
  var original = (html.getAttribute('lang') || '').toLowerCase();
  function valid(tag) { return /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(String(tag || '')); }
  function remember(tag) {
    var host = location.hostname.toLowerCase();
    var domain = host === '1m8.ai' || /\.1m8\.ai$/.test(host) ? '; Domain=.1m8.ai' : '';
    document.cookie = COOKIE + '=' + encodeURIComponent(tag) + '; Max-Age=2592000; Path=/; SameSite=Lax' + domain + (location.protocol === 'https:' ? '; Secure' : '');
  }
  var explicit = '';
  try { explicit = new URLSearchParams(location.search).get('lang') || ''; } catch (e) {}
  if (valid(explicit)) remember(explicit); else explicit = '';
  function pageLanguage() {
    if (explicit) return explicit;
    var current = html.getAttribute('lang') || '';
    var translated = /\btranslated-(ltr|rtl)\b/.test(html.className) || (current && current.toLowerCase() !== original);
    if (valid(current) && (translated || !/^en\b/i.test(current))) return current;
    return '';
  }
  function appLink(a) {
    try {
      var url = new URL(a.href, location.href);
      return url.hostname === 'app.1m8.ai' || /(^|\.)app\.1m8\.ai$/.test(url.hostname) ? url : null;
    } catch (e) { return null; }
  }
  // Decide at click time: browser translation happens after the page loads.
  document.addEventListener('click', function (event) {
    var a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    var url = a && appLink(a);
    var tag = url && pageLanguage();
    if (!tag) return;
    remember(tag);
    if (!url.searchParams.has('lang')) { url.searchParams.set('lang', tag); a.href = url.toString(); }
  }, true);
  window.FirstMateLanguageHandoff = { pageLanguage: pageLanguage };
})();
