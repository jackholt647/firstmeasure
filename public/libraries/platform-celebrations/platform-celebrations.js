/* libraries/platform-celebrations/platform-celebrations.js
 * Small browser-only celebration effects for Platform workflows.
 *
 * Public API:
 *   PlatformCelebrations.configure({ mode: 'on' | 'small_only' | 'off' })
 *   PlatformCelebrations.loadConfig(orgId, branchId)
 *   PlatformCelebrations.celebrate('small' | 'large', { force?: boolean, text?: string })
 *   PlatformCelebrations.fromNotification(notification)
 */
(function(){
  const root = window;
  const MODULE_ID = 'project_configuration';
  const MODES = new Set(['on', 'small_only', 'off']);
  let config = { mode: 'on', loaded: false };
  let styleInjected = false;

  function clean(value){ return String(value || '').trim(); }
  function normalizeMode(value){
    const mode = clean(value || 'on');
    return MODES.has(mode) ? mode : 'on';
  }

  function configure(next = {}){
    config = {
      ...config,
      mode: normalizeMode(next.celebrations_mode || next.mode || next.celebrations?.mode || config.mode)
    };
    return { ...config };
  }

  async function loadConfig(orgId, branchId = 'default'){
    if (!root.PlatformAPI?.branchModules?.get || !orgId) return { ...config };
    try {
      const doc = await root.PlatformAPI.branchModules.get(orgId, branchId || 'default', MODULE_ID);
      configure(doc?.data || doc || {});
      config.loaded = true;
    } catch (error) {
      config.loaded = true;
    }
    return { ...config };
  }

  function ensureAudioContext(){
    const AudioCtx = root.AudioContext || root.webkitAudioContext;
    return AudioCtx ? new AudioCtx() : null;
  }

  function playTone(sequence){
    try {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(sequence.volume || 0.22, now + 0.02);
      master.gain.exponentialRampToValueAtTime(0.0001, now + sequence.duration);
      master.connect(ctx.destination);
      sequence.notes.forEach((note) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = note.type || 'sine';
        osc.frequency.setValueAtTime(note.freq, now + note.at);
        gain.gain.setValueAtTime(0.0001, now + note.at);
        gain.gain.exponentialRampToValueAtTime(note.gain || 0.8, now + note.at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.len);
        osc.connect(gain);
        gain.connect(master);
        osc.start(now + note.at);
        osc.stop(now + note.at + note.len + 0.04);
      });
      setTimeout(() => ctx.close?.().catch?.(() => null), Math.ceil((sequence.duration + 0.25) * 1000));
    } catch (error) {}
  }

  function playSmallSound(){
    playTone({
      volume: 0.23,
      duration: 1.05,
      notes: [
        { freq: 523.25, at: 0.00, len: 0.22, gain: 0.9 },
        { freq: 659.25, at: 0.11, len: 0.24, gain: 0.94 },
        { freq: 783.99, at: 0.23, len: 0.28, gain: 0.96 },
        { freq: 1046.50, at: 0.39, len: 0.42, gain: 0.98, type: 'triangle' }
      ]
    });
  }

  function playIndicatorSound(){
    playTone({
      volume: 0.24,
      duration: 0.54,
      notes: [
        { freq: 659.25, at: 0, len: 0.22, gain: 0.95 },
        { freq: 880.00, at: 0.09, len: 0.26, gain: 0.95 }
      ]
    });
  }

  function playLargeSound(){
    playTone({
      volume: 0.30,
      duration: 1.95,
      notes: [
        { freq: 392.00, at: 0.00, len: 0.24, gain: 0.72, type: 'triangle' },
        { freq: 523.25, at: 0.08, len: 0.28, gain: 0.9 },
        { freq: 659.25, at: 0.18, len: 0.30, gain: 0.95 },
        { freq: 783.99, at: 0.32, len: 0.34, gain: 1.0 },
        { freq: 1046.50, at: 0.52, len: 0.52, gain: 1.0, type: 'triangle' },
        { freq: 1318.51, at: 0.78, len: 0.18, gain: 0.72 },
        { freq: 1567.98, at: 0.92, len: 0.22, gain: 0.64 },
        { freq: 1046.50, at: 1.12, len: 0.48, gain: 0.82, type: 'triangle' }
      ]
    });
  }

  function injectStyle(){
    if (styleInjected) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.id = 'platformCelebrationsStyle';
    style.textContent = `
      .pc-confetti-layer{position:fixed;inset:0;pointer-events:none;z-index:100000;overflow:hidden}
      .pc-confetti-piece{position:absolute;top:-18px;width:9px;height:14px;border-radius:2px;opacity:.94;animation:pc-confetti-fall var(--pc-dur,1.2s) cubic-bezier(.2,.65,.38,1) forwards}
      .pc-toast{position:fixed;left:50%;top:28px;z-index:100001;max-width:min(560px,calc(100vw - 36px));transform:translate(-50%,-12px) scale(.98);opacity:0;border:1px solid rgba(255,255,255,.28);border-radius:18px;background:rgba(17,24,39,.88);color:#fff;padding:14px 18px;box-shadow:0 22px 60px rgba(15,23,42,.28);backdrop-filter:blur(16px);font:900 15px/1.35 Montserrat,Arial,sans-serif;text-align:center;pointer-events:none;transition:opacity .22s ease,transform .22s ease}
      .pc-toast.visible{opacity:1;transform:translate(-50%,0) scale(1)}
      .pc-toast.large{font-size:17px;padding:16px 22px;border-radius:20px}
      @keyframes pc-confetti-fall{
        0%{transform:translate3d(0,-22px,0) rotate(0deg);opacity:0}
        12%{opacity:.95}
        100%{transform:translate3d(var(--pc-x,0),105vh,0) rotate(var(--pc-rot,360deg));opacity:0}
      }
    `;
    document.head.appendChild(style);
  }

  function confetti(){
    injectStyle();
    const layer = document.createElement('div');
    layer.className = 'pc-confetti-layer';
    const colors = ['#d93025', '#f59e0b', '#16a34a', '#2563eb', '#a855f7', '#06b6d4'];
    const count = 86;
    for (let i = 0; i < count; i += 1) {
      const piece = document.createElement('span');
      piece.className = 'pc-confetti-piece';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[i % colors.length];
      piece.style.setProperty('--pc-x', `${(Math.random() - 0.5) * 220}px`);
      piece.style.setProperty('--pc-rot', `${(Math.random() * 720 + 160).toFixed(0)}deg`);
      piece.style.setProperty('--pc-dur', `${(0.95 + Math.random() * 0.65).toFixed(2)}s`);
      piece.style.animationDelay = `${(Math.random() * 0.18).toFixed(2)}s`;
      layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 1900);
  }

  function showCelebrationText(text, size = 'small'){
    const message = clean(text);
    if (!message) return;
    injectStyle();
    const prior = document.querySelector('.pc-toast');
    prior?.remove?.();
    const toast = document.createElement('div');
    toast.className = `pc-toast ${size === 'large' ? 'large' : 'small'}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('visible'));
    setTimeout(() => toast.classList.remove('visible'), size === 'large' ? 3600 : 2600);
    setTimeout(() => toast.remove(), size === 'large' ? 4000 : 3000);
  }

  function effectiveSize(size, options = {}){
    const requested = clean(size || 'small').toLowerCase() === 'large' ? 'large' : 'small';
    if (options.force) return requested;
    if (config.mode === 'off') return '';
    if (config.mode === 'small_only') return 'small';
    return requested;
  }

  function celebrate(size = 'small', options = {}){
    const finalSize = effectiveSize(size, options);
    if (!finalSize) return { ok: false, skipped: true, reason: 'disabled' };
    const text = options.text || options.message || options.title || '';
    if (finalSize === 'large') {
      playLargeSound();
      confetti();
    } else {
      playSmallSound();
    }
    showCelebrationText(text, finalSize);
    return { ok: true, size: finalSize };
  }

  function fromNotification(notification = {}){
    const celebration = notification.celebration || notification.context?.celebration || {};
    const size = celebration.size || notification.celebration_size || notification.context?.celebration_size || '';
    const text = celebration.text || celebration.message || notification.celebration_text || notification.context?.celebration_text || notification.body || '';
    if (!size) return { ok: false, skipped: true, reason: 'no_celebration' };
    return celebrate(size, { text });
  }

  root.PlatformCelebrations = {
    configure,
    loadConfig,
    celebrate,
    indicator(){ playIndicatorSound(); return { ok: true, size: 'indicator' }; },
    small(options = {}){ return celebrate('small', options); },
    large(options = {}){ return celebrate('large', options); },
    fromNotification,
    getConfig(){ return { ...config }; }
  };
})();
