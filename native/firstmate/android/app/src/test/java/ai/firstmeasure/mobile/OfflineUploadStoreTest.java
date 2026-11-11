package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRules.Rejected;
import ai.firstmeasure.mobile.OfflineUploadStore.Job;
import ai.firstmeasure.mobile.OfflineUploadStore.Request;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Collections;
import static org.junit.Assert.*;

public class OfflineUploadStoreTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private final OriginPolicy policy = new OriginPolicy("https://dev.1m8.ai");
    private final long[] now = {1_700_000_000_000L};
    private final long[] free = {Long.MAX_VALUE};
    private File root;
    private OfflineUploadStore store;
    private CaptureStore captures;

    @Before public void open() throws Exception { root = folder.newFolder("offline-uploads"); reopen(); }
    private void reopen() { store = new OfflineUploadStore(root, () -> now[0], () -> free[0]); captures = new CaptureStore(root, () -> now[0]); }

    private static byte[] bytes(int length, int seed) { byte[] out = new byte[length]; for (int i = 0; i < length; i++) out[i] = (byte) (i * 31 + seed); return out; }
    private static String code(OfflineUploadRulesTest.ThrowingRunnable action) {
        try { action.run(); } catch (Rejected e) { return e.code; } catch (Exception e) { return e.toString(); }
        return null;
    }
    private JSONObject payload(String id, JSONObject source) throws Exception {
        return new JSONObject().put("id", id).put("source", source).put("url", "https://dev.1m8.ai/v1/platform/organizations/org_1/media")
            .put("fileField", "file").put("fileName", "roof.jpg").put("contentType", "image/jpeg").put("csrfCookie", "fm_platform_session_csrf")
            .put("fields", new JSONObject().put("id", "media_" + id).put("owner_type", "project"))
            .put("headers", new JSONObject().put("Idempotency-Key", "fmo1-" + id).put("X-FM-Offline-User", "user_1").put("X-FM-Offline-Org", "org_1").put("X-FM-Offline-Replay", "1"));
    }
    private JSONObject enqueuePut(String id, byte[] content) throws Exception {
        store.put(id, 0, content, true);
        return store.enqueue(Request.parse(payload(id, new JSONObject().put("put", id)), policy), captures);
    }
    private JSONObject status(String id) throws Exception {
        JSONArray all = store.status(Collections.singletonList(id));
        return all.length() == 0 ? null : all.getJSONObject(0);
    }

    @Test public void aFileArrivesInChunksAndResumesWhereItStopped() throws Exception {
        byte[] first = bytes(OfflineUploadRules.CHUNK_BYTES, 1), second = bytes(1000, 2);
        JSONObject probe = store.put("p1", 0, new byte[0], false);
        assertEquals(0, probe.getLong("size")); assertFalse(probe.getBoolean("done")); assertTrue(probe.getBoolean("accepted"));
        assertEquals(first.length, store.put("p1", 0, first, false).getLong("size"));

        // A new process asks where to continue; a wrong offset writes nothing and says where.
        reopen();
        assertEquals(first.length, store.put("p1", 0, new byte[0], false).getLong("size"));
        JSONObject wrong = store.put("p1", 5, second, false);
        assertFalse(wrong.getBoolean("accepted")); assertEquals(first.length, wrong.getLong("size"));
        assertNull(store.putFile("p1"));

        JSONObject last = store.put("p1", first.length, second, true);
        assertTrue(last.getBoolean("accepted")); assertTrue(last.getBoolean("done")); assertEquals(first.length + 1000, last.getLong("size"));
        byte[] stored = Files.readAllBytes(store.putFile("p1").toPath());
        assertArrayEquals(first, Arrays.copyOf(stored, first.length));
        assertArrayEquals(second, Arrays.copyOfRange(stored, first.length, stored.length));

        // Complete: more data is refused, repeating `done` is harmless, offset 0 starts the file again.
        assertFalse(store.put("p1", stored.length, second, false).getBoolean("accepted"));
        JSONObject repeated = store.put("p1", stored.length, new byte[0], true);
        assertTrue(repeated.getBoolean("accepted")); assertTrue(repeated.getBoolean("done"));
        JSONObject restarted = store.put("p1", 0, second, false);
        assertTrue(restarted.getBoolean("accepted")); assertFalse(restarted.getBoolean("done")); assertEquals(1000, restarted.getLong("size"));
        assertNull(store.putFile("p1"));
    }

    @Test public void chunksFilesAndSpaceAreLimited() throws Exception {
        assertEquals("chunk_too_large", code(() -> store.put("p1", 0, new byte[OfflineUploadRules.CHUNK_BYTES + 1], false)));
        assertEquals("invalid_request", code(() -> store.put("../p1", 0, new byte[1], false)));
        assertEquals("invalid_request", code(() -> store.put("p1", -1, new byte[1], false)));
        assertEquals("empty_file", code(() -> store.put("p1", 0, new byte[0], true)));
        free[0] = OfflineUploadRules.FREE_SPACE_RESERVE;
        assertEquals("storage_full", code(() -> store.put("p1", 0, new byte[10], false)));
        free[0] = Long.MAX_VALUE;
        assertFalse(store.put("p1", 7, new byte[0], true).getBoolean("accepted"));
    }

    @Test public void enqueueTakesTheFileAndTheSameIdAgainChangesNothing() throws Exception {
        byte[] content = bytes(5000, 3);
        JSONObject created = enqueuePut("j1", content);
        assertTrue(created.getBoolean("created")); assertEquals("queued", created.getString("state"));
        assertNull("the handed-over file moved into the job", store.putFile("j1"));
        Job job = store.next();
        assertEquals("j1", job.id);
        assertArrayEquals(content, Files.readAllBytes(store.file(job).toPath()));
        assertEquals("roof.jpg", job.fileName); assertEquals("image/jpeg", job.contentType); assertEquals("media_j1", job.fields.get("id"));
        assertEquals("fmo1-j1", job.headers.get("Idempotency-Key")); assertEquals(5000, job.size);

        store.put("other", 0, bytes(10, 9), true);
        JSONObject again = store.enqueue(Request.parse(payload("j1", new JSONObject().put("put", "other")).put("fileName", "changed.jpg"), policy), captures);
        assertFalse(again.getBoolean("created")); assertFalse(again.getBoolean("requeued"));
        assertNotNull("a no-op must not consume its source", store.putFile("other"));
        assertEquals("roof.jpg", store.next().fileName);

        // Everything is on disk: a new process sees the same job and file.
        reopen();
        JSONObject seen = status("j1");
        assertEquals("queued", seen.getString("state")); assertTrue(seen.isNull("status")); assertTrue(seen.isNull("body")); assertEquals(0, seen.getInt("attempts"));
        assertArrayEquals(content, Files.readAllBytes(store.file(store.next()).toPath()));
    }

    @Test public void enqueueRefusesWhatItCannotSendSafely() throws Exception {
        assertEquals("unknown_source", code(() -> store.enqueue(Request.parse(payload("j1", new JSONObject().put("put", "missing")), policy), captures)));
        store.put("half", 0, bytes(10, 1), false);
        assertEquals("put_incomplete", code(() -> store.enqueue(Request.parse(payload("j1", new JSONObject().put("put", "half")), policy), captures)));
        assertEquals("unknown_source", code(() -> store.enqueue(Request.parse(payload("j1", new JSONObject().put("cameraToken", "nope")), policy), captures)));
        assertEquals("unknown_source", code(() -> store.enqueue(Request.parse(payload("j1", null), policy), captures)));
        store.put("whole", 0, bytes(10, 1), true);
        assertEquals("size_mismatch", code(() -> store.enqueue(Request.parse(payload("j1", new JSONObject().put("put", "whole")).put("size", 11), policy), captures)));
        assertEquals("untrusted_url", code(() -> Request.parse(payload("j1", new JSONObject().put("put", "whole")).put("url", "https://evil.test/v1/x"), policy)));
        assertEquals("header_not_allowed", code(() -> Request.parse(payload("j1", new JSONObject().put("put", "whole")).put("headers", new JSONObject().put("Idempotency-Key", "k").put("Cookie", "a=b")), policy)));
        assertEquals("idempotency_key_required", code(() -> Request.parse(payload("j1", new JSONObject().put("put", "whole")).put("headers", new JSONObject()), policy)));
        assertEquals("invalid_request", code(() -> Request.parse(payload("j1", new JSONObject().put("put", "whole")).put("fields", "text"), policy)));
        assertEquals("invalid_request", code(() -> Request.parse(payload("j1", new JSONObject().put("put", "whole")).put("csrfCookie", JSONObject.NULL), policy)));
        assertEquals("invalid_request", code(() -> Request.parse(payload("j1", new JSONObject().put("file", "/data/x")), policy)));
        assertNotNull("a refused enqueue leaves the file for a corrected one", store.putFile("whole"));
        assertFalse(store.exists("j1"));
        assertTrue(store.enqueue(Request.parse(payload("j1", new JSONObject().put("put", "whole")).put("size", 10), policy), captures).getBoolean("created"));
    }

    @Test public void aCameraCaptureMovesIntoItsJobAndKeepsItsNameAndType() throws Exception {
        File photo = captures.newFile(".jpg");
        Files.write(photo.toPath(), bytes(300, 4));
        String token = captures.add(photo, "image/jpeg", 0).getString("token");
        JSONObject request = payload("cam", new JSONObject().put("cameraToken", token));
        request.remove("fileName"); request.remove("contentType");
        assertTrue(store.enqueue(Request.parse(request, policy), captures).getBoolean("created"));
        assertNull("the token is spent", captures.file(token));
        assertFalse(photo.exists());
        Job job = store.next();
        assertEquals(photo.getName(), job.fileName); assertEquals("image/jpeg", job.contentType); assertEquals(300, store.file(job).length());
    }

    @Test public void anInterruptedEnqueueIsCompletedByTheNextOne() throws Exception {
        // The process died after the file moved under the job's name and before the job was written.
        File jobs = new File(root, "jobs");
        assertTrue(jobs.mkdirs());
        Files.write(new File(jobs, OfflineUploadRules.fileKey("j1") + ".bin").toPath(), bytes(40, 5));
        JSONObject created = store.enqueue(Request.parse(payload("j1", new JSONObject().put("put", "gone")), policy), captures);
        assertTrue(created.getBoolean("created"));
        assertEquals(40, store.next().size);
    }

    @Test public void answersAreKeptUntilAcknowledged() throws Exception {
        enqueuePut("j1", bytes(100, 1)); enqueuePut("j2", bytes(100, 2));
        Job job = store.next();
        assertTrue(store.begin(job.id));
        assertEquals("uploading", status("j1").getString("state")); assertEquals(1, status("j1").getInt("attempts"));
        now[0] += 5000;
        store.finish("j1", 201, "{\"ok\":true,\"media\":{\"id\":\"media_j1\"}}".getBytes(StandardCharsets.UTF_8), false);
        assertFalse("the file is removed once the server has it", store.file(job).exists());

        reopen();
        JSONObject done = status("j1");
        assertEquals("done", done.getString("state")); assertEquals(201, done.getInt("status"));
        assertEquals("{\"ok\":true,\"media\":{\"id\":\"media_j1\"}}", done.getString("body"));
        assertFalse(done.getBoolean("bodyTruncated")); assertEquals(now[0], done.getLong("updatedAt"));
        assertEquals(2, store.status(null).length());
        assertEquals("j1", store.status(null).getJSONObject(0).getString("id"));

        // Only finished jobs can be acknowledged; unknown ids are ignored.
        JSONArray acked = store.ack(Arrays.asList("j1", "j2", "nope"));
        assertEquals(1, acked.length()); assertEquals("j1", acked.getString(0));
        assertNull(status("j1")); assertEquals("queued", status("j2").getString("state"));
        reopen();
        assertFalse(store.exists("j1")); assertTrue(store.exists("j2"));
    }

    @Test public void statusLeavesOutBodiesBeyondOneMegabyte() throws Exception {
        byte[] large = new byte[OfflineUploadRules.MAX_BODY_BYTES];
        Arrays.fill(large, (byte) 'x');
        for (int i = 0; i < 5; i++) { enqueuePut("j" + i, bytes(10, i)); store.begin("j" + i); store.finish("j" + i, 200, large, i == 0); }
        JSONArray all = store.status(null);
        int withBody = 0, omitted = 0;
        for (int i = 0; i < all.length(); i++) { if (all.getJSONObject(i).isNull("body")) omitted++; else withBody++; if (all.getJSONObject(i).isNull("body")) assertTrue(all.getJSONObject(i).getBoolean("bodyOmitted")); }
        assertEquals(4, withBody); assertEquals(1, omitted);
        assertTrue(all.getJSONObject(0).getBoolean("bodyTruncated"));
        assertFalse("asking for the one left out returns it", store.status(Collections.singletonList("j4")).getJSONObject(0).isNull("body"));
    }

    @Test public void cancelRemovesTheJobItsFileAndAnUnqueuedFile() throws Exception {
        enqueuePut("j1", bytes(100, 1));
        File file = store.file(store.next());
        assertTrue(store.cancel("j1"));
        assertFalse(file.exists()); assertFalse(store.exists("j1")); assertNull(status("j1"));
        store.put("p9", 0, bytes(10, 1), false);
        assertTrue(store.cancel("p9"));
        assertEquals(0, store.put("p9", 0, new byte[0], false).getLong("size"));
        assertFalse(store.cancel("p9"));
        assertEquals("invalid_request", code(() -> store.cancel("../x")));
    }

    @Test public void serverFailuresBackOffAndFailAfterEightNetworkFailuresNever() throws Exception {
        enqueuePut("j1", bytes(100, 1));
        for (int failure = 1; failure < OfflineUploadRules.MAX_SERVER_FAILURES; failure++) {
            assertTrue(store.begin("j1"));
            assertTrue(store.retry("j1", 503, "busy".getBytes(StandardCharsets.UTF_8), false, true, true));
            assertNull("not due before its wait is over", store.next());
            assertTrue(store.waiting());
            now[0] += OfflineUploadRules.retryDelay(true, failure);
            assertEquals("j1", store.next().id);
        }
        assertTrue(store.begin("j1"));
        assertFalse(store.retry("j1", 502, null, false, true, true));
        JSONObject failed = status("j1");
        assertEquals("failed", failed.getString("state")); assertEquals(502, failed.getInt("status")); assertEquals("retries_exhausted", failed.getString("error"));
        assertEquals(8, failed.getInt("attempts"));
        assertTrue("a failed job keeps its file", new File(new File(root, "jobs"), OfflineUploadRules.fileKey("j1") + ".bin").isFile());
        assertFalse(store.waiting());

        enqueuePut("j2", bytes(100, 2));
        for (int i = 0; i < 40; i++) {
            assertTrue(store.begin("j2"));
            assertTrue(store.retry("j2", 0, null, false, false, i % 2 == 0));
            assertEquals("queued", status("j2").getString("state"));
            now[0] += 900_000;
        }
        assertTrue(status("j2").isNull("status"));
        // Without a connection the wait does not grow: the network constraint holds the work.
        store.begin("j2"); store.retry("j2", 0, null, false, false, false);
        now[0] += 15_000;
        assertEquals("j2", store.next().id);
    }

    @Test public void aFailedJobIsQueuedAgainByEnqueueWithTheNewRequest() throws Exception {
        enqueuePut("j1", bytes(100, 1));
        store.begin("j1");
        store.fail("j1", 400, "{\"ok\":false,\"error\":\"missing_media_file\"}".getBytes(StandardCharsets.UTF_8), false, "");
        assertEquals("failed", status("j1").getString("state")); assertEquals("{\"ok\":false,\"error\":\"missing_media_file\"}", status("j1").getString("body"));
        assertNull(store.next());

        JSONObject request = payload("j1", null).put("fileName", "fixed.jpg");
        request.getJSONObject("fields").put("owner_id", "proj_2");
        JSONObject again = store.enqueue(Request.parse(request, policy), captures);
        assertFalse(again.getBoolean("created")); assertTrue(again.getBoolean("requeued")); assertEquals("queued", again.getString("state"));
        Job job = store.next();
        assertEquals("fixed.jpg", job.fileName); assertEquals("proj_2", job.fields.get("owner_id")); assertEquals(100, store.file(job).length());
        assertTrue(status("j1").isNull("status")); assertTrue(status("j1").isNull("body"));
    }

    @Test public void uploadsWaitForASignInUntilTheSessionChanges() throws Exception {
        enqueuePut("j1", bytes(10, 1)); enqueuePut("j2", bytes(10, 2)); enqueuePut("j3", bytes(10, 3));
        store.begin("j1");
        store.park("j1", 401, "{\"ok\":false,\"error\":\"authentication_required\"}".getBytes(StandardCharsets.UTF_8), false, "old-session");
        store.parkQueued("old-session");
        for (String id : new String[]{"j1", "j2", "j3"}) assertEquals("needs_sign_in", status(id).getString("state"));
        assertEquals(401, status("j1").getInt("status")); assertTrue(status("j2").isNull("status"));
        assertNull(store.next()); assertFalse(store.waiting());

        reopen();
        assertEquals("the same refused session, or none, changes nothing", 0, store.resume(job -> "old-session"));
        assertEquals(0, store.resume(job -> null));
        assertEquals(3, store.resume(job -> "new-session"));
        assertEquals("j1", store.next().id);
        assertTrue(new File(new File(root, "jobs"), OfflineUploadRules.fileKey("j1") + ".bin").isFile());
    }

    @Test public void aStoppedOrKilledUploadWaitsAgain() throws Exception {
        enqueuePut("j1", bytes(10, 1)); enqueuePut("j2", bytes(10, 2));
        store.begin("j1");
        store.interrupted("j1");
        assertEquals("queued", status("j1").getString("state"));
        store.begin("j1"); store.begin("j2");
        reopen();
        assertNull("still marked as running by the process that died", store.next());
        store.recover();
        assertEquals("queued", status("j1").getString("state")); assertEquals("queued", status("j2").getString("state"));
        assertEquals("j1", store.next().id);
    }

    @Test public void pruneRemovesOnlyWhatNobodyWillAskFor() throws Exception {
        enqueuePut("done", bytes(10, 1)); enqueuePut("failed", bytes(10, 2)); enqueuePut("queued", bytes(10, 3));
        store.begin("done"); store.finish("done", 200, "{}".getBytes(StandardCharsets.UTF_8), false);
        store.begin("failed"); store.fail("failed", 400, null, false, "");
        store.put("abandoned", 0, bytes(10, 4), false);
        File jobs = new File(root, "jobs"), orphan = new File(jobs, "0123456789abcdef0123456789abcdef01234567.bin"), abandoned = new File(new File(root, "puts"), OfflineUploadRules.fileKey("abandoned") + ".part");
        Files.write(orphan.toPath(), bytes(10, 5));

        now[0] += OfflineUploadRules.PUT_TTL - 1000;
        store.prune();
        assertTrue(abandoned.isFile()); assertTrue(store.exists("done"));

        now[0] = System.currentTimeMillis() + OfflineUploadRules.RESULT_TTL + 60_000;
        store.prune();
        assertFalse("a handed-over file nobody queued", abandoned.exists());
        assertFalse("an answer nobody read for 30 days", store.exists("done"));
        assertFalse("a file without a job", orphan.exists());
        assertTrue("a failed upload is the person's photo: it stays", store.exists("failed"));
        assertTrue(new File(jobs, OfflineUploadRules.fileKey("failed") + ".bin").isFile());
        assertTrue(store.exists("queued"));
        assertTrue(new File(jobs, OfflineUploadRules.fileKey("queued") + ".bin").isFile());
    }

    @Test public void anUnreadableIndexIsSetAsideAndFilesAreTakenUpAgain() throws Exception {
        enqueuePut("j1", bytes(25, 1));
        Files.write(new File(root, "jobs.json").toPath(), "{not json".getBytes(StandardCharsets.UTF_8));
        reopen();
        assertFalse(store.exists("j1"));
        assertEquals(0, store.status(null).length());
        JSONObject created = store.enqueue(Request.parse(payload("j1", null), policy), captures);
        assertTrue(created.getBoolean("created"));
        assertEquals(25, store.next().size);
        String[] kept = root.list((directory, name) -> name.startsWith("jobs.unreadable-"));
        assertEquals(1, kept.length);
    }

    @Test public void theQueueHasAnUpperBound() throws Exception {
        assertEquals(2000, OfflineUploadRules.MAX_JOBS);
        assertEquals(150L * 1024 * 1024, OfflineUploadRules.MAX_FILE_BYTES);
        assertEquals(256 * 1024, OfflineUploadRules.MAX_BODY_BYTES);
    }
}
