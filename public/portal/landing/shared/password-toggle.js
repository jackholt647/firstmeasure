/* FirstMate password fields: a show/hide button inside every password input (1M8-221).
   FirstMatePasswordToggle.enhance(root) works on a document or a shadow root and is safe to call again. */
(function () {
  'use strict';
  if (window.FirstMatePasswordToggle) return;

  const say = (key, fallback) => globalThis.PlatformLanguage?.text?.('auth', key, fallback) ?? fallback;
  const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 5C6.5 5 2.2 8.4 1 12c1.2 3.6 5.5 7 11 7s9.8-3.4 11-7c-1.2-3.6-5.5-7-11-7Zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Zm0-2.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2.3 3.7 3.7 2.3l18 18-1.4 1.4-3.3-3.3A11.7 11.7 0 0 1 12 19c-5.5 0-9.8-3.4-11-7a12.3 12.3 0 0 1 4.3-5.6L2.3 3.7Zm5.5 5.5A4.5 4.5 0 0 0 14.8 16l-1.7-1.7a2.2 2.2 0 0 1-3.4-3.4L7.8 9.2ZM12 5c5.5 0 9.8 3.4 11 7a12.4 12.4 0 0 1-3.2 4.8l-3.4-3.4A4.5 4.5 0 0 0 10.6 7.6L8.4 5.4C9.5 5.1 10.7 5 12 5Z"/></svg>';
  const CSS = '.fm-pw-wrap{position:relative;display:block}.fm-pw-wrap>input{width:100%;padding-right:42px!important;box-sizing:border-box}'
    + '.fm-pw-toggle{position:absolute;top:50%;right:6px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:auto;height:min(32px,calc(100% - 4px));aspect-ratio:1;margin:0;padding:0;border:0;border-radius:6px;background:transparent;color:#5f6368;cursor:pointer}'
    + '.fm-pw-toggle:hover{background:rgba(60,64,67,.08);color:#202124}.fm-pw-toggle:focus-visible{outline:2px solid #1a73e8;outline-offset:1px}';

  function paint(button, shown) {
    const label = shown ? say('hide_password', 'Hide password') : say('show_password', 'Show password');
    button.innerHTML = shown ? EYE_OFF : EYE;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(shown));
    button.title = label;
  }

  function enhance(root) {
    const scope = root || document;
    const styleHost = scope.head || scope;
    if (styleHost && !styleHost.querySelector?.('style[data-fm-password-toggle]')) {
      const style = document.createElement('style');
      style.setAttribute('data-fm-password-toggle', '');
      style.textContent = CSS;
      styleHost.appendChild(style);
    }
    scope.querySelectorAll('input[type="password"]:not([data-fm-password-toggle])').forEach((input) => {
      input.setAttribute('data-fm-password-toggle', '');
      const wrap = document.createElement('span');
      wrap.className = 'fm-pw-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fm-pw-toggle';
      paint(button, false);
      // Keep the caret where it was while the field changes type.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const shown = input.type === 'password';
        input.type = shown ? 'text' : 'password';
        paint(button, shown);
      });
      // A submitted or reset form hides the password again.
      input.form?.addEventListener('submit', () => { input.type = 'password'; paint(button, false); });
      input.form?.addEventListener('reset', () => { input.type = 'password'; paint(button, false); });
      wrap.appendChild(button);
    });
  }

  window.FirstMatePasswordToggle = { enhance };
})();
