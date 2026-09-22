/* apps/management-mobile/app.js
 * Native-app-friendly management portal bootstrap.
 *
 * This wrapper owns standalone auth only. After login it reuses the existing
 * PHP/session-compatible management dashboard at /portal/.
 */
(function(){
  const APP = window.__APP || {};
  const root = document.getElementById('app');

  function clean(value){
    return String(value ?? '').trim();
  }

  function portalPath(){
    return clean(APP.portalPath || '/portal/') || '/portal/';
  }

  function escapeHtml(value){
    return clean(value).replace(/[&<>"']/g, (match) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[match]));
  }

  function setError(message){
    const node = document.getElementById('authError');
    if (!node) return;
    node.textContent = clean(message);
    node.classList.toggle('visible', !!clean(message));
  }

  function renderAuth(message = ''){
    root.innerHTML = `
      <section class="auth-card" aria-labelledby="authTitle">
        <div class="auth-head">
          <img src="/images/logo_red.png" alt="FirstMate">
          <h1 id="authTitle">FirstMate</h1>
          <p>Log in to order FirstMeasure reports and manage projects.</p>
        </div>
        <div class="auth-body">
          <form id="authForm">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="email" required>
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
            <button class="primary-btn" id="loginBtn" type="submit">Log In</button>
            <div class="auth-error ${message ? 'visible' : ''}" id="authError">${escapeHtml(message)}</div>
            <p class="hint">This wrapper signs into the Platform API, then opens the existing management portal.</p>
          </form>
        </div>
      </section>
    `;
    document.getElementById('authForm').addEventListener('submit', login);
  }

  function openPortal(){
    window.location.replace(portalPath());
  }

  async function login(event){
    event.preventDefault();
    setError('');
    const button = document.getElementById('loginBtn');
    button.disabled = true;
    button.textContent = 'Logging In...';
    try {
      await window.PlatformAPI.auth.login({
        email: document.getElementById('email').value,
        password: document.getElementById('password').value
      });
      openPortal();
    } catch (error) {
      setError(error.message || 'Login failed.');
      button.disabled = false;
      button.textContent = 'Log In';
    }
  }

  async function boot(){
    if (!window.PlatformAPI?.auth) {
      renderAuth('Platform API is not available.');
      return;
    }
    try {
      const session = await window.PlatformAPI.auth.session();
      if (session?.authenticated) {
        openPortal();
        return;
      }
    } catch {}
    renderAuth();
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => renderAuth(error.message || 'Could not start the app.'));
  });
})();

