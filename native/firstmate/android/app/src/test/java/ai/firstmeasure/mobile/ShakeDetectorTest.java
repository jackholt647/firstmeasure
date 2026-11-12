package ai.firstmeasure.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.function.LongToDoubleFunction;
import org.junit.Test;

/** The same cases as public/v1/tests/dev-tray.test.mjs: the web and Android rules must agree. */
public class ShakeDetectorTest {
    private static int run(LongToDoubleFunction wave, long ms, boolean gravity) {
        int[] shakes = { 0 };
        ShakeDetector d = new ShakeDetector(() -> shakes[0]++);
        for (long t = 0; t <= ms; t += 16) d.sample(wave.applyAsDouble(t), 0, gravity ? 9.81 : 0.2, t, gravity);
        return shakes[0];
    }
    private static LongToDoubleFunction sine(double amp, double hz) { return t -> amp * Math.sin(2 * Math.PI * hz * t / 1000.0); }

    @Test public void oneQuickHardShakeFiresOnceThenCoolsDown() {
        LongToDoubleFunction shake = sine(25, 4);
        assertEquals(1, run(t -> t < 500 ? shake.applyAsDouble(t) : 0, 600, false));
        int n = run(shake, 3000, false);
        assertTrue("fired " + n, n >= 1 && n <= 2);
    }

    @Test public void ordinaryHandlingDoesNotFire() {
        assertEquals("walking", 0, run(sine(6, 2), 5000, false));
        assertEquals("gentle shake", 0, run(sine(12, 4), 3000, false));
        assertEquals("bump and rebound", 0, run(t -> t >= 100 && t < 140 ? 30 : t >= 140 && t < 180 ? -18 : 0, 600, false));
        assertEquals("slow swings", 0, run(sine(25, 1), 1500, false));
    }

    @Test public void rawReadingsWithGravityWork() {
        LongToDoubleFunction shake = sine(28, 4);
        assertEquals(1, run(t -> t < 400 ? 0 : t < 900 ? shake.applyAsDouble(t) : 0, 1000, true));
        assertEquals(0, run(t -> 0, 2000, true));
    }
}
