package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRules.Outcome;
import ai.firstmeasure.mobile.OfflineUploadStore.Job;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.function.BooleanSupplier;

/**
 * Sends the jobs that are due, oldest first, and records each answer. The session
 * (cookies and CSRF token) is read fresh for every attempt and never stored.
 * No Android types, so JVM tests cover the state transitions.
 */
final class OfflineUploadRunner {
    static final class Response {
        final int status; final byte[] body; final boolean truncated;
        Response(int status, byte[] body, boolean truncated) { this.status = status; this.body = body; this.truncated = truncated; }
    }
    /** Thrown by a transport when `stopped` turned true mid-transfer. */
    static final class Stopped extends IOException { Stopped() { super("Upload stopped"); } }
    interface Transport { Response send(Job job, File file, String cookies, String csrf, String origin, BooleanSupplier stopped) throws IOException; }
    /** The Cookie header the WebView would send to a URL, or null. */
    interface Cookies { String header(String url); }

    private final OfflineUploadStore store;
    private final OriginPolicy policy;
    private final String origin;
    private final Transport transport;
    private final Cookies cookies;
    private final BooleanSupplier connected;

    OfflineUploadRunner(OfflineUploadStore store, String origin, Transport transport, Cookies cookies, BooleanSupplier connected) {
        this.store = store; this.origin = origin; policy = new OriginPolicy(origin); this.transport = transport; this.cookies = cookies; this.connected = connected;
    }

    /** Answers true when jobs still wait for a later attempt. */
    boolean run(BooleanSupplier stopped) {
        store.recover();
        while (!stopped.getAsBoolean()) {
            Job job = store.next();
            if (job == null) break;
            // Checked when queued; checked again here because this is where cookies leave the device.
            if (!policy.trusted(job.url)) { store.fail(job.id, 0, null, false, "untrusted_url"); continue; }
            File file = store.file(job);
            if (!file.isFile()) { store.fail(job.id, 0, null, false, "file_missing"); continue; }
            String header = cookies.header(job.url), csrf = OfflineUploadRules.cookieValue(header, job.csrfCookie);
            if (csrf == null || csrf.isEmpty()) { store.parkQueued(""); break; }
            if (!store.begin(job.id)) continue;
            Response response;
            try {
                response = transport.send(job, file, header, csrf, origin, () -> stopped.getAsBoolean() || !store.exists(job.id));
            } catch (Stopped e) {
                store.interrupted(job.id);
                continue;
            } catch (IOException e) {
                if (!store.exists(job.id)) continue;
                store.retry(job.id, 0, null, false, false, connected.getAsBoolean());
                // Nothing else would get through either; the next run starts after the wait.
                break;
            }
            if (!store.exists(job.id)) continue;
            String text = response.body == null ? "" : new String(response.body, StandardCharsets.UTF_8);
            Outcome outcome = OfflineUploadRules.classify(response.status, text);
            if (outcome == Outcome.DONE) store.finish(job.id, response.status, response.body, response.truncated);
            else if (outcome == Outcome.FAILED) store.fail(job.id, response.status, response.body, response.truncated, "");
            else if (outcome == Outcome.RETRY) store.retry(job.id, response.status, response.body, response.truncated, true, true);
            else {
                String refused = OfflineUploadRules.hash(csrf);
                store.park(job.id, response.status, response.body, response.truncated, refused);
                if (OfflineUploadRules.sessionRefused(response.status, text)) { store.parkQueued(refused); break; }
            }
        }
        return store.waiting();
    }

    /** The hash `resume` compares: of the CSRF token the WebView holds now for a job's URL. */
    String session(Job job) {
        String csrf = OfflineUploadRules.cookieValue(cookies.header(job.url), job.csrfCookie);
        return csrf == null || csrf.isEmpty() ? null : OfflineUploadRules.hash(csrf);
    }
}
