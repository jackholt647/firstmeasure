(function () {
  'use strict';
  window.FirstMateExternalApps.define('geo', () => ({
    fullBleed: true,
    mount(context) {
      const root = context.roots?.main || context.root;
      root.innerHTML = `
        <section class="firstmate-geo" aria-label="FirstMate GEO">
          <style>
            .firstmate-geo{box-sizing:border-box;min-height:100%;padding:clamp(28px,6vw,88px);background:var(--bg,#f0f2f5);color:var(--text,#202124);font-family:inherit}
            .firstmate-geo *{box-sizing:border-box}
            .firstmate-geo .geo-eyebrow{color:var(--primary-readable,var(--primary,#d93025));font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
            .firstmate-geo h1{color:var(--secondary,#111111);font-size:clamp(36px,5vw,64px);line-height:1.08;letter-spacing:-.045em;margin:24px 0}
            .firstmate-geo p{max-width:560px;color:var(--muted,#5f6368);font-size:17px;line-height:1.7}
            .firstmate-geo .geo-status{display:inline-flex;align-items:center;gap:10px;margin-top:32px;background:var(--panel,#ffffff);border:1px solid var(--border,#dadce0);border-radius:30px;padding:10px 16px;font-size:13px;color:var(--text,#202124)}
            .firstmate-geo .geo-dot{width:7px;height:7px;border-radius:50%;background:var(--primary,#d93025)}
          </style>
          <div class="geo-eyebrow">FirstMate / GEO</div>
          <h1>A new perspective.</h1>
          <p>A space to explore what comes next. FirstMate GEO is ready for its first experiment.</p>
          <div class="geo-status"><span class="geo-dot"></span>Workspace ready</div>
        </section>`;
      return { destroy() { root.replaceChildren(); } };
    }
  }));
})();
