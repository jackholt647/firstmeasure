package ai.firstmeasure.mobile;

/**
 * One quick, hard shake opens the portal's dev tray (development builds only). The same rule as
 * public/libraries/dev-console/shake.js, with the same constants: three strokes of at least STROKE m/s² (gravity
 * removed), each the opposite way to the one before, within WINDOW ms; then quiet for COOLDOWN ms. Ordinary handling
 * (walking, setting the phone down, a bump and its rebound) makes one or two strokes, or weaker ones.
 * Plain Java so the JVM tests cover it; the activity feeds it sensor readings.
 */
final class ShakeDetector {
    static final double STROKE = 15, RELEASE = 7, GRAVITY_MS = 250;
    static final int STROKES = 3;
    static final long WINDOW = 800, COOLDOWN = 1500;

    interface Listener { void onShake(); }

    private final Listener listener;
    private double[] gravity;
    private long last, quietUntil;
    private Stroke stroke;
    private final java.util.ArrayList<Stroke> strokes = new java.util.ArrayList<>();

    private static final class Stroke { final long t; double m; double[] v; Stroke(long t, double m, double[] v) { this.t = t; this.m = m; this.v = v; } }

    ShakeDetector(Listener listener) { this.listener = listener; }

    void reset() { stroke = null; strokes.clear(); }

    /** One reading at time t (ms). withGravity: a raw accelerometer reading (gravity is estimated and removed). */
    boolean sample(double x, double y, double z, long t, boolean withGravity) {
        if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(z)) return false;
        if (withGravity) {
            if (gravity == null) gravity = new double[] { x, y, z };
            else {
                double a = 1 - Math.exp(-Math.max(1, t - last) / GRAVITY_MS);
                gravity[0] += (x - gravity[0]) * a; gravity[1] += (y - gravity[1]) * a; gravity[2] += (z - gravity[2]) * a;
            }
            last = t; x -= gravity[0]; y -= gravity[1]; z -= gravity[2];
        }
        if (t < quietUntil) return false;
        double m = Math.sqrt(x * x + y * y + z * z);
        if (stroke != null) {
            if (m > stroke.m) { stroke.m = m; stroke.v = new double[] { x, y, z }; }
            if (m >= RELEASE) return false;
            Stroke prev = strokes.isEmpty() ? null : strokes.get(strokes.size() - 1);
            boolean reversed = prev != null && dot(prev.v, stroke.v) < 0 && stroke.t - strokes.get(0).t <= WINDOW;
            if (!reversed) strokes.clear();
            strokes.add(stroke);
            stroke = null;
            if (strokes.size() >= STROKES) { reset(); quietUntil = t + COOLDOWN; if (listener != null) listener.onShake(); return true; }
            return false;
        }
        if (m >= STROKE) stroke = new Stroke(t, m, new double[] { x, y, z });
        if (!strokes.isEmpty() && t - strokes.get(0).t > WINDOW) strokes.clear();
        return false;
    }

    private static double dot(double[] a, double[] b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
}
