package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRunner.Response;
import ai.firstmeasure.mobile.OfflineUploadStore.Job;
import ai.firstmeasure.mobile.OfflineUploadStore.Request;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.function.BooleanSupplier;
import static org.junit.Assert.*;

public class OfflineUploadRunnerTest {
    private static final String ORIGIN = "https://dev.1m8.ai";
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private final long[] now = {1_700_000_000_000L};
    private final boolean[] connected = {true};
    private String cookies = "fm_platform_session=s1; fm_platform_session_csrf=tok%2Fen1";
    private File root;
    private OfflineUploadStore store;
    private CaptureStore captures;
    private FakeTransport transport;
    private OfflineUploadRunner runner;

    private final class FakeTransport implements OfflineUploadRunner.Transport {
        final Deque<Object> answers = new ArrayDeque<>();
        final List<String> sent = new ArrayList<>(), sessions = new ArrayList<>();
        Runnable during;
        @Override public Response send(Job job, File file, String cookieHeader, String csrf, String origin, BooleanSupplier stopped) throws IOException {
            assertTrue("the file is there while it is sent", file.isFile());
            assertEquals(ORIGIN, origin);
            sent.add(job.id); sessions.add(cookieHeader + " | " + csrf);
            if (during != null) during.run();
            if (stopped.getAsBoolean()) throw new OfflineUploadRunner.Stopped();
            Object next = answers.isEmpty() ? answer(201, "{\"ok\":true}") : answers.poll();
            if (next instanceof IOException) throw (IOException) next;
            return (Response) next;
        }
    }
    private static Response answer(int status, String body) { return new Response(status, body.getBytes(StandardCharsets.UTF_8), false); }

    @Before public void open() throws Exception {
        root = folder.newFolder("offline-uploads");
        transport = new FakeTransport();
        reopen();
    }
    private void reopen() {
        store = new OfflineUploadStore(root, () -> now[0], () -> Long.MAX_VALUE);
        captures = new CaptureStore(root, () -> now[0]);
        runner = new OfflineUploadRunner(store, ORIGIN, transport, url -> cookies, () -> connected[0]);
    }
    private void queue(String... ids) throws Exception {
        for (String id : ids) {
            store.put(id, 0, new byte[]{1, 2, 3}, true);
            store.enqueue(Request.parse(new JSONObject().put("id", id).put("source", new JSONObject().put("put", id))
                .put("url", ORIGIN + "/v1/platform/organizations/org_1/media").put("fileName", id + ".jpg").put("contentType", "image/jpeg")
                .put("csrfCookie", "fm_platform_session_csrf").put("headers", new JSONObject().put("Idempotency-Key", "fmo1-" + id)), new OriginPolicy(ORIGIN)), captures);
            now[0] += 10;
        }
    }
    private JSONObject status(String id) throws Exception { return store.status(Collections.singletonList(id)).getJSONObject(0); }
    private File file(String id) { return new File(new File(root, "jobs"), OfflineUploadRules.fileKey(id) + ".bin"); }

    @Test public void sendsOldestFirstWithTheSessionOfTheMomentAndRemovesWhatArrived() throws Exception {
        queue("a", "b", "c");
        assertFalse("nothing waits afterwards", runner.run(() -> false));
        assertEquals(Arrays.asList("a", "b", "c"), transport.sent);
        assertEquals("fm_platform_session=s1; fm_platform_session_csrf=tok%2Fen1 | tok/en1", transport.sessions.get(0));
        for (String id : new String[]{"a", "b", "c"}) {
            JSONObject job = status(id);
            assertEquals("done", job.getString("state")); assertEquals(201, job.getInt("status")); assertEquals("{\"ok\":true}", job.getString("body")); assertEquals(1, job.getInt("attempts"));
            assertFalse(file(id).exists());
        }
        // The session is not stored with the job: a later attempt reads it again.
        assertFalse(new String(Files.readAllBytes(new File(root, "jobs.json").toPath()), StandardCharsets.UTF_8).contains("tok"));
    }

    @Test public void aRefusedSessionStopsEverythingUntilSomeoneSignsIn() throws Exception {
        queue("a", "b", "c");
        transport.answers.add(answer(401, "{\"ok\":false,\"error\":\"authentication_required\"}"));
        assertFalse(runner.run(() -> false));
        assertEquals(Collections.singletonList("a"), transport.sent);
        assertEquals(401, status("a").getInt("status"));
        for (String id : new String[]{"a", "b", "c"}) { assertEquals("needs_sign_in", status(id).getString("state")); assertTrue(file(id).isFile()); }

        // The app is opened again: same cookies, nothing is sent; new cookies, everything goes.
        reopen();
        assertEquals(0, store.resume(runner::session));
        assertFalse(runner.run(() -> false));
        assertEquals(1, transport.sent.size());
        cookies = "fm_platform_session=s2; fm_platform_session_csrf=token2";
        assertEquals(3, store.resume(runner::session));
        assertFalse(runner.run(() -> false));
        assertEquals(Arrays.asList("a", "a", "b", "c"), transport.sent);
        assertTrue(transport.sessions.get(1).endsWith("| token2"));
        for (String id : new String[]{"a", "b", "c"}) assertEquals("done", status(id).getString("state"));
        assertEquals(2, status("a").getInt("attempts"));
    }

    @Test public void aMissingOrRefusedCsrfTokenAlsoWaitsForASignIn() throws Exception {
        queue("a", "b");
        transport.answers.add(answer(403, "{\"ok\":false,\"error\":\"csrf_required\"}"));
        runner.run(() -> false);
        assertEquals("needs_sign_in", status("a").getString("state")); assertEquals(403, status("a").getInt("status"));
        assertEquals("needs_sign_in", status("b").getString("state"));

        queue("c");
        cookies = "unrelated=1";
        assertFalse(runner.run(() -> false));
        assertEquals("nothing is sent without a session", 1, transport.sent.size());
        assertEquals("needs_sign_in", status("c").getString("state")); assertTrue(status("c").isNull("status"));
        assertNull(runner.session(jobOf("c")));
        cookies = null;
        assertEquals(0, store.resume(runner::session));
    }
    private Job jobOf(String id) throws Exception {
        Job job = new Job();
        job.id = id; job.url = ORIGIN + "/v1/x"; job.csrfCookie = "fm_platform_session_csrf";
        return job;
    }

    @Test public void anUploadQueuedBySomeoneElseWaitsAloneWhileTheRestGoes() throws Exception {
        queue("theirs", "mine");
        transport.answers.add(answer(409, "{\"ok\":false,\"error\":\"offline_identity_mismatch\"}"));
        assertFalse(runner.run(() -> false));
        assertEquals(Arrays.asList("theirs", "mine"), transport.sent);
        assertEquals("needs_sign_in", status("theirs").getString("state")); assertEquals(409, status("theirs").getInt("status"));
        assertTrue(status("theirs").getString("body").contains("offline_identity_mismatch"));
        assertEquals("done", status("mine").getString("state"));
        assertEquals("not tried again under the session it was refused for", 0, store.resume(runner::session));
    }

    @Test public void serverErrorsWaitAndTheOtherUploadsStillGo() throws Exception {
        queue("a", "b");
        transport.answers.add(answer(503, "busy"));
        assertTrue("one upload waits for its next attempt", runner.run(() -> false));
        assertEquals(Arrays.asList("a", "b"), transport.sent);
        assertEquals("queued", status("a").getString("state")); assertEquals(503, status("a").getInt("status")); assertEquals("busy", status("a").getString("body"));
        assertEquals("done", status("b").getString("state"));
        assertTrue(runner.run(() -> false));
        assertEquals("not before its wait is over", 2, transport.sent.size());
        now[0] += 30_000;
        assertFalse(runner.run(() -> false));
        assertEquals("done", status("a").getString("state")); assertEquals(2, status("a").getInt("attempts"));

        queue("moved");
        transport.answers.add(answer(302, ""));
        assertTrue(runner.run(() -> false));
        assertEquals("a redirect is an answer to wait on, never followed", "queued", status("moved").getString("state"));
        assertEquals(302, status("moved").getInt("status"));
    }

    @Test public void aNetworkFailureEndsTheRunWithoutCountingAgainstTheUpload() throws Exception {
        queue("a", "b");
        transport.answers.add(new IOException("unreachable"));
        assertTrue(runner.run(() -> false));
        assertEquals(Collections.singletonList("a"), transport.sent);
        assertEquals("queued", status("a").getString("state")); assertTrue(status("a").isNull("status")); assertTrue(status("a").isNull("error"));
        assertEquals("queued", status("b").getString("state")); assertEquals(0, status("b").getInt("attempts"));
        // "b" is due at once, "a" after its wait: the next run sends "b" and comes back for "a".
        assertTrue(runner.run(() -> false));
        assertEquals(Arrays.asList("a", "b"), transport.sent);
        now[0] += 15_000;
        assertFalse(runner.run(() -> false));
        assertEquals("done", status("a").getString("state"));
    }

    @Test public void otherClientErrorsFailAndKeepTheFile() throws Exception {
        queue("a");
        transport.answers.add(answer(413, "{\"ok\":false,\"error\":\"media_too_large\"}"));
        assertFalse(runner.run(() -> false));
        assertEquals("failed", status("a").getString("state")); assertEquals(413, status("a").getInt("status"));
        assertTrue(status("a").getString("body").contains("media_too_large"));
        assertTrue(file("a").isFile());
        assertFalse(runner.run(() -> false));
        assertEquals("a failed upload is not retried by itself", 1, transport.sent.size());
    }

    @Test public void cancellingDuringAnUploadStopsItAndTheQueueContinues() throws Exception {
        queue("a", "b");
        transport.during = () -> { try { if (store.exists("a")) store.cancel("a"); } catch (Exception e) { throw new IllegalStateException(e); } };
        assertFalse(runner.run(() -> false));
        assertEquals(Arrays.asList("a", "b"), transport.sent);
        assertEquals(0, store.status(Collections.singletonList("a")).length());
        assertFalse(file("a").exists());
        assertEquals("done", status("b").getString("state"));
    }

    @Test public void aStopFromTheSystemLeavesTheUploadWaitingNotFailed() throws Exception {
        queue("a", "b");
        boolean[] stop = {false};
        transport.during = () -> stop[0] = true;
        assertTrue(runner.run(() -> stop[0]));
        assertEquals(Collections.singletonList("a"), transport.sent);
        assertEquals("queued", status("a").getString("state")); assertTrue(status("a").isNull("status"));
        assertTrue(file("a").isFile());
        transport.during = null;
        assertFalse(runner.run(() -> false));
        assertEquals("done", status("a").getString("state")); assertEquals("done", status("b").getString("state"));
    }

    @Test public void aKilledProcessLeavesNothingStuckAsUploading() throws Exception {
        queue("a");
        assertTrue(store.begin("a"));
        reopen();
        assertFalse(runner.run(() -> false));
        assertEquals("done", status("a").getString("state")); assertEquals(2, status("a").getInt("attempts"));
    }

    @Test public void nothingLeavesForAnotherOriginOrWithoutItsFile() throws Exception {
        queue("lost", "tampered");
        assertTrue(file("lost").delete());
        File index = new File(root, "jobs.json");
        String stored = new String(Files.readAllBytes(index.toPath()), StandardCharsets.UTF_8);
        int at = stored.lastIndexOf("https:\\/\\/dev.1m8.ai");
        String escaped = at >= 0 ? "https:\\/\\/dev.1m8.ai" : "https://dev.1m8.ai";
        at = stored.lastIndexOf(escaped);
        Files.write(index.toPath(), (stored.substring(0, at) + escaped.replace("dev.1m8.ai", "evil.test") + stored.substring(at + escaped.length())).getBytes(StandardCharsets.UTF_8));
        reopen();
        assertFalse(runner.run(() -> false));
        assertTrue("neither is sent", transport.sent.isEmpty());
        assertEquals("failed", status("lost").getString("state")); assertEquals("file_missing", status("lost").getString("error"));
        assertEquals("failed", status("tampered").getString("state")); assertEquals("untrusted_url", status("tampered").getString("error"));
    }
}
