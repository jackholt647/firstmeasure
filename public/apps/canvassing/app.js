/* apps/canvassing/app.js
 * Standalone canvassing wrapper.
 *
 * This file owns auth and app bootstrapping only. Shared map/pin/manager UI
 * lives in libraries/canvassing-app/canvassing-app.js.
 */
(function(){
  const APP = window.__APP || {};
  const state = {
    session: null,
    canvassingApp: null
  };

  const $ = (sel, root=document) => root.querySelector(sel);
  const escapeHtml = (value) => (window.FirstMateCanvassingApp?.escapeHtml || ((v) => String(v ?? '')))(value);

  function injectCss(){
    if (document.querySelector('style[data-canvassing-wrapper]')) return;
    const style = document.createElement('style');
    style.dataset.canvassingWrapper = '1';
    style.textContent = `
      *{box-sizing:border-box}
      html,body,#app{height:100%;margin:0;overflow:hidden;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;color:#111827}
      button,input,select{font:inherit;border-radius:8px}
      button{border:1px solid #d1d5db;background:#fff;padding:11px;font-weight:950;cursor:pointer}
      button.primary{background:#d93025;border-color:#d93025;color:#fff}
      input,select{width:100%;border:1px solid #d1d5db;padding:10px;background:#fff}
      label{font-size:11px;text-transform:uppercase;font-weight:950;color:#6b7280;display:block;margin:9px 0 5px}
      .auth-screen{min-height:100%;display:grid;place-items:center;padding:18px;background:linear-gradient(135deg,#f8fafc 0%,#f1f5f9 55%,#fee2e2 100%)}
      .auth-card{width:min(440px,100%);background:#fff;border:1px solid rgba(0,0,0,.08);border-radius:14px;box-shadow:0 24px 80px rgba(15,23,42,.16);overflow:hidden}
      .auth-head{padding:24px 24px 18px;background:#d93025;color:#fff}
      .auth-head h1{font-size:25px;margin:0;font-weight:1000;letter-spacing:0}
      .auth-head p{margin:7px 0 0;color:rgba(255,255,255,.86);font-weight:750;line-height:1.35}
      .auth-body{padding:20px 22px}
      .seg{display:grid;grid-template-columns:1fr 1fr;gap:6px;background:#f3f4f6;border-radius:10px;padding:4px;margin-bottom:14px}
      .seg button{border:0;background:transparent;padding:9px;border-radius:8px}
      .seg button.active{background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.08)}
      .hint{font-size:12px;color:#6b7280;font-weight:750;line-height:1.4;margin-top:8px}
      .error{display:none;margin:10px 0 0;padding:10px;border-radius:8px;background:#fef2f2;color:#991b1b;font-size:13px;font-weight:850}
      .error.show{display:block}
      .boot-error{padding:20px;font-weight:900;color:#991b1b}
      @media(max-width:680px){.auth-card{border-radius:12px}}
    `;
    document.head.appendChild(style);
  }

  function setError(message){
    const error = $('#authError');
    if (!error) return;
    error.textContent = message || '';
    error.classList.toggle('show', !!message);
  }

  function branchId(){
    return String(state.session?.membership?.branch_id || APP.userBranchId || 'default').trim() || 'default';
  }

  async function loadSession(){
    try {
      const session = await window.PlatformAPI.auth.session();
      if (session?.authenticated) {
        state.session = session;
        return true;
      }
    } catch {}
    state.session = null;
    return false;
  }

  function renderAuth(mode = 'login'){
    state.canvassingApp?.destroy?.();
    state.canvassingApp = null;
    document.body.className = 'auth';
    $('#app').innerHTML = `
      <main class="auth-screen">
        <section class="auth-card">
          <div class="auth-head">
            <h1>FirstMate Canvassing</h1>
            <p>Drop pins, track doors, and turn field conversations into leads.</p>
          </div>
          <div class="auth-body">
            <div class="seg">
              <button id="loginTab" class="${mode === 'login' ? 'active' : ''}">Log In</button>
              <button id="signupTab" class="${mode === 'signup' ? 'active' : ''}">Sign Up</button>
            </div>
            <form id="authForm"></form>
            <div class="error" id="authError"></div>
          </div>
        </section>
      </main>
    `;
    $('#loginTab').onclick = () => renderAuth('login');
    $('#signupTab').onclick = () => renderAuth('signup');
    renderAuthForm(mode);
  }

  function renderAuthForm(mode){
    const form = $('#authForm');
    if (mode === 'login') {
      form.innerHTML = `
        <label>Email</label><input id="email" type="email" autocomplete="email" required>
        <label>Password</label><input id="password" type="password" autocomplete="current-password" required>
        <button class="primary" style="width:100%;margin-top:14px" type="submit">Log In</button>
        <div class="hint">Use your existing FirstMate account, or sign up to create a standalone canvassing organization.</div>
      `;
      form.onsubmit = login;
      return;
    }
    form.innerHTML = `
      <label>Name</label><input id="name" autocomplete="name" required>
      <label>Email</label><input id="email" type="email" autocomplete="email" required>
      <label>Password</label><input id="password" type="password" autocomplete="new-password" required>
      <label>Organization</label><input id="company" placeholder="Company or team name" required>
      <label>Use</label>
      <select id="signupType">
        <option value="standalone">Standalone canvassing app</option>
        <option value="organization">Create a FirstMate organization</option>
      </select>
      <button class="primary" style="width:100%;margin-top:14px" type="submit">Create Account</button>
      <div class="hint">Both options create an organization and branch behind the scenes. Standalone accounts simply start with canvassing enabled and no billing setup.</div>
    `;
    form.onsubmit = signup;
  }

  async function login(event){
    event.preventDefault();
    setError('');
    try {
      await window.PlatformAPI.auth.login({ email: $('#email').value, password: $('#password').value });
      await bootAuthed();
    } catch (error) {
      setError(error.message || 'Login failed.');
    }
  }

  async function signup(event){
    event.preventDefault();
    setError('');
    try {
      const type = $('#signupType').value;
      await window.PlatformAPI.auth.register({
        email: $('#email').value,
        password: $('#password').value,
        name: $('#name').value,
        company: $('#company').value,
        membership: {
          role: 'owner',
          roles: ['canvasser', 'canvassing_manager'],
          permissions: { '*': true, manage_canvassing: true, manage_company_users: true },
          metadata: { signup_app: 'canvassing', signup_type: type }
        },
        organization: {
          metadata: { signup_app: 'canvassing', signup_type: type }
        },
        global: {
          product_mode: type === 'standalone' ? 'canvassing_standalone' : 'platform',
          app_flags: {
            canvassing: { app: true }
          },
          credits_balance: 0,
          billing: { status: 'not_required_for_canvassing' }
        }
      });
      await bootAuthed();
    } catch (error) {
      setError(error.message || 'Signup failed.');
    }
  }

  async function logout(){
    try { await window.PlatformAPI.auth.logout(); } catch {}
    state.session = null;
    renderAuth('login');
  }

  async function bootAuthed(){
    await loadSession();
    if (!state.session) {
      renderAuth('login');
      return;
    }
    document.body.className = 'canvassing';
    state.canvassingApp?.destroy?.();
    state.canvassingApp = await window.FirstMateCanvassingApp.mount({
      root: $('#app'),
      session: state.session,
      platformApi: window.PlatformAPI,
      canvassingApi: window.CanvassingAPI,
      branchId: branchId(),
      title: 'Canvassing',
      onLogout: logout
    });
  }

  async function boot(){
    injectCss();
    if (await loadSession()) await bootAuthed();
    else renderAuth('login');
  }

  document.addEventListener('DOMContentLoaded', () => boot().catch((error) => {
    $('#app').innerHTML = `<div class="boot-error">Canvassing failed: ${escapeHtml(error.message)}</div>`;
  }));
})();
