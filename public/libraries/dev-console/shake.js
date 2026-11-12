/* public/libraries/dev-console/shake.js
 *
 * Shake to open the dev tray (docs/architecture/dev-console.md, "Quick tray"). One quick, hard shake: three strokes of
 * at least STROKE m/s² (gravity removed), each the opposite way to the one before, within WINDOW ms. Ordinary handling
 * (walking, setting the phone down, a bump and its rebound) makes one or two strokes, or weaker ones. The Android host
 * runs the same rule natively (native/firstmate ShakeDetector.java, same constants); iOS uses the system shake gesture.
 *
 * watchShake() listens to the host's fm:native:shake (apps with the `shake` capability) and to the browser's
 * devicemotion (Android Chrome and Android's web view: no prompt; iOS Safari: needs requestMotionPermission() from a tap).
 */
export const SHAKE = Object.freeze({ STROKE: 12, RELEASE: 5, STROKES: 3, WINDOW: 800, COOLDOWN: 1500, GRAVITY_MS: 250 });

/**
 * Feed samples with sample(x, y, z, t, { gravity }); calls onShake once per shake. A stroke is a run of readings of at
 * least STROKE m/s² pointing roughly the same way. It ends when the reading drops under RELEASE or, without a dip, as
 * soon as a strong reading points the other way: a fast real shake can reverse between two sensor samples without ever
 * reading near zero.
 */
export function createShakeDetector(onShake, rules = SHAKE) {
  let g = null, last = 0, stroke = null, strokes = [], quietUntil = 0;
  const reset = () => { stroke = null; strokes = []; };
  // Keep the stroke if it went the other way to the one before (within the window); otherwise it starts a new run.
  const finish = (t) => {
    const prev = strokes[strokes.length - 1];
    const reversed = prev && dot(prev.v, stroke.v) < 0 && stroke.t - strokes[0].t <= rules.WINDOW;
    strokes = reversed ? [...strokes, stroke] : [stroke];
    stroke = null;
    if (strokes.length < rules.STROKES) return false;
    reset(); quietUntil = t + rules.COOLDOWN; onShake?.(); return true;
  };
  return {
    reset,
    sample(x, y, z, t, { gravity = false } = {}) {
      if (![x, y, z, t].every(Number.isFinite)) return false;
      if (gravity) {
        // Low-pass the raw reading to estimate gravity, then take it away.
        if (!g) g = [x, y, z];
        else { const a = 1 - Math.exp(-Math.max(1, t - last) / rules.GRAVITY_MS); g = g.map((v, i) => v + ([x, y, z][i] - v) * a); }
        last = t; x -= g[0]; y -= g[1]; z -= g[2];
      }
      if (t < quietUntil) return false;
      const m = Math.hypot(x, y, z), v = [x, y, z];
      if (strokes.length && t - strokes[0].t > rules.WINDOW && !stroke) strokes = [];
      if (stroke) {
        if (m >= rules.STROKE && dot(v, stroke.v) < 0) {
          // Reversed without a dip: this reading starts the next stroke.
          if (finish(t)) return true;
          stroke = { t, m, v };
          return false;
        }
        if (m > stroke.m) Object.assign(stroke, { m, v });
        if (m < rules.RELEASE) return finish(t);
        return false;
      }
      if (m >= rules.STROKE) stroke = { t, m, v };
      return false;
    }
  };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Whether this browser can report motion at all (the native app reports `shake` instead). */
export function motionAvailable(win = window) { return typeof win.DeviceMotionEvent === 'function'; }
/** iOS Safari asks before reporting motion; it must be called from a tap. Resolves true when motion will be reported. */
export async function requestMotionPermission(win = window) {
  const ask = win.DeviceMotionEvent?.requestPermission;
  if (typeof ask !== 'function') return motionAvailable(win);
  try { return (await ask.call(win.DeviceMotionEvent)) === 'granted'; } catch (_) { return false; }
}

/** Calls onShake for each shake, from the app when it reports `shake`, else from devicemotion. Returns a stop function. */
export function watchShake(onShake, win = window) {
  let native = false;
  const detector = createShakeDetector(onShake);
  const fromApp = () => onShake();
  // In the app both may fire for one shake; the tray ignores a shake while it is open, and the detector's cooldown
  // keeps devicemotion from firing twice. Listening to both means a host whose own detector misses still works.
  const fromBrowser = (event) => {
    const linear = event.acceleration, raw = event.accelerationIncludingGravity;
    const t = Number(event.timeStamp) || Date.now();
    if (linear && Number.isFinite(linear.x)) detector.sample(linear.x, linear.y, linear.z, t);
    else if (raw && Number.isFinite(raw.x)) detector.sample(raw.x, raw.y, raw.z, t, { gravity: true });
  };
  const check = () => { native = !!win.PhoneFeatures?.supports?.('shake'); };
  check();
  win.PhoneFeatures?.ready?.then?.(check, () => {});
  win.addEventListener('fm:phone:ready', check);
  win.addEventListener('fm:native:shake', fromApp);
  win.addEventListener('devicemotion', fromBrowser);
  return () => {
    win.removeEventListener('fm:phone:ready', check);
    win.removeEventListener('fm:native:shake', fromApp);
    win.removeEventListener('devicemotion', fromBrowser);
  };
}
