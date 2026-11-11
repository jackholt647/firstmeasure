package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRules.Outcome;
import ai.firstmeasure.mobile.OfflineUploadRules.Rejected;
import org.json.JSONObject;
import org.junit.Test;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeMap;
import static org.junit.Assert.*;

public class OfflineUploadRulesTest {
    private final OriginPolicy policy = new OriginPolicy("https://dev.1m8.ai");

    private static String rejected(ThrowingRunnable action) {
        try { action.run(); } catch (Rejected e) { return e.code; } catch (Exception e) { return e.getClass().getSimpleName(); }
        return null;
    }
    interface ThrowingRunnable { void run() throws Exception; }

    @Test public void uploadsOnlyGoToThePortalOriginUnderV1() throws Exception {
        for (String url : new String[]{"https://dev.1m8.ai/v1/platform/organizations/org_1/media", "https://DEV.1M8.AI/v1/x?y=1", "https://dev.1m8.ai:443/v1/x"})
            assertEquals(url, OfflineUploadRules.uploadUrl(policy, url));
        for (Object url : new Object[]{"https://1m8.ai/v1/x", "http://dev.1m8.ai/v1/x", "https://dev.1m8.ai.evil.test/v1/x", "https://dev.1m8.ai@evil.test/v1/x",
            "https://dev.1m8.ai/portal/", "https://dev.1m8.ai/v1/../portal/", "https://dev.1m8.ai/v1/%2e%2e/portal", "https://dev.1m8.ai/v1/a%2Fb", "https://dev.1m8.ai/v1/x#f",
            "https://dev.1m8.ai:8443/v1/x", "/v1/x", "", null, 7, "https://dev.1m8.ai/v1/" + "a".repeat(2100)})
            assertEquals(String.valueOf(url), "untrusted_url", rejected(() -> OfflineUploadRules.uploadUrl(policy, url)));
    }

    @Test public void onlyTheQueuesOwnHeadersAreAcceptedAndTheKeyIsRequired() throws Exception {
        Map<String, String> headers = OfflineUploadRules.headers(new JSONObject()
            .put("idempotency-key", "fmo1-1").put("X-FM-Offline-User", "user_1").put("x-fm-offline-org", "org_1").put("X-FM-Offline-Replay", 1).put("Accept", "application/json"));
        assertEquals("fmo1-1", headers.get("Idempotency-Key"));
        assertEquals("org_1", headers.get("X-FM-Offline-Org"));
        assertEquals("1", headers.get("X-FM-Offline-Replay"));
        assertEquals(5, headers.size());
        for (String name : new String[]{"Cookie", "X-Platform-CSRF", "Origin", "Authorization", "Host", "Content-Type", "X-Forwarded-For"})
            assertEquals(name, "header_not_allowed", rejected(() -> OfflineUploadRules.headers(new JSONObject().put("Idempotency-Key", "k").put(name, "x"))));
        assertEquals("idempotency_key_required", rejected(() -> OfflineUploadRules.headers(new JSONObject().put("Accept", "application/json"))));
        assertEquals("idempotency_key_required", rejected(() -> OfflineUploadRules.headers(null)));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.headers(new JSONObject().put("Idempotency-Key", "a\r\nCookie: x"))));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.headers(new JSONObject().put("Idempotency-Key", "k".repeat(257)))));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.headers(new JSONObject().put("Idempotency-Key", new JSONObject()))));
    }

    @Test public void fieldsAreTextWithPlainNames() throws Exception {
        Map<String, String> fields = OfflineUploadRules.fields(new JSONObject().put("owner_type", "project").put("replace_slot", false).put("count", 3)
            .put("ratio", 1.5).put("metadata", "{\"taken_at\":\"2026-11-10T10:00:00Z\"}"));
        assertEquals("project", fields.get("owner_type"));
        assertEquals("false", fields.get("replace_slot"));
        assertEquals("3", fields.get("count"));
        assertEquals("1.5", fields.get("ratio"));
        assertEquals("{\"taken_at\":\"2026-11-10T10:00:00Z\"}", fields.get("metadata"));
        assertTrue(OfflineUploadRules.fields(null).isEmpty());
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.fields(new JSONObject().put("a\"b", "x"))));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.fields(new JSONObject().put("a\r\nb", "x"))));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.fields(new JSONObject().put("nested", new JSONObject()))));
    }

    @Test public void idsNamesAndTypesAreBounded() throws Exception {
        assertEquals("fmo1-3f2a:1.b_c", OfflineUploadRules.id("fmo1-3f2a:1.b_c"));
        for (Object id : new Object[]{"", "a b", "a/b", "../x", "a".repeat(129), null, 5}) assertEquals("invalid_request", rejected(() -> OfflineUploadRules.id(id)));
        assertNotEquals(OfflineUploadRules.fileKey("Photo-1"), OfflineUploadRules.fileKey("photo-1"));
        assertTrue(OfflineUploadRules.fileKey("../../etc").matches("[0-9a-f]{40}"));
        // The same key as the iOS host computes (SHA-256, first 20 bytes, hex).
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a3", OfflineUploadRules.fileKey("abc"));

        assertEquals("façade front.jpg", OfflineUploadRules.fileName("façade front.jpg", "upload"));
        assertEquals("a_b_c_d_.jpg", OfflineUploadRules.fileName("a\"b\\c/d\n.jpg", "upload"));
        assertEquals("upload", OfflineUploadRules.fileName("   ", "upload"));
        assertEquals("upload", OfflineUploadRules.fileName(null, "upload"));
        String longName = OfflineUploadRules.fileName("x".repeat(300) + ".jpeg", "upload");
        assertEquals(120, longName.length());
        assertTrue(longName.endsWith(".jpeg"));

        assertEquals("image/jpeg", OfflineUploadRules.contentType("Image/JPEG", "application/octet-stream"));
        assertEquals("video/webm", OfflineUploadRules.contentType("video/webm; codecs=vp9", "application/octet-stream"));
        assertEquals("application/octet-stream", OfflineUploadRules.contentType("image/jpeg\r\nX: y", "application/octet-stream"));
        assertEquals("application/octet-stream", OfflineUploadRules.contentType(null, "application/octet-stream"));

        assertEquals("file", OfflineUploadRules.fileField(null));
        assertEquals("photo", OfflineUploadRules.fileField("photo"));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.fileField("a\"b")));
        assertEquals("fm_platform_session_csrf", OfflineUploadRules.csrfCookie("fm_platform_session_csrf"));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.csrfCookie("a;b")));
        assertEquals("invalid_request", rejected(() -> OfflineUploadRules.csrfCookie(null)));
    }

    @Test public void csrfTokenComesFromTheNamedCookieDecoded() {
        String header = "fm_platform_session=abc; fm_platform_session_csrf=to%2Bken%3D%3D; other=fm_platform_session_csrf=wrong";
        assertEquals("to+ken==", OfflineUploadRules.cookieValue(header, "fm_platform_session_csrf"));
        assertEquals("abc", OfflineUploadRules.cookieValue(header, "fm_platform_session"));
        assertNull(OfflineUploadRules.cookieValue(header, "session_csrf"));
        assertNull(OfflineUploadRules.cookieValue(null, "x"));
        assertEquals("a+b", OfflineUploadRules.percentDecode("a+b"));
        assertEquals("café", OfflineUploadRules.percentDecode("caf%C3%A9"));
        assertEquals("bad%zz", OfflineUploadRules.percentDecode("bad%zz"));
    }

    @Test public void requestHeadersCarryTheSessionAndOnlyAllowedJobHeaders() {
        Map<String, String> job = new TreeMap<>();
        job.put("Idempotency-Key", "fmo1-1"); job.put("Cookie", "evil=1"); job.put("accept", "text/plain");
        Map<String, String> headers = OfflineUploadRules.requestHeaders(job, "a=b", "token", "https://dev.1m8.ai", "multipart/form-data; boundary=x");
        assertEquals("a=b", headers.get("Cookie"));
        assertEquals("token", headers.get("X-Platform-CSRF"));
        assertEquals("https://dev.1m8.ai", headers.get("Origin"));
        assertEquals("text/plain", headers.get("Accept"));
        assertEquals("fmo1-1", headers.get("Idempotency-Key"));
        assertEquals("multipart/form-data; boundary=x", headers.get("Content-Type"));
        assertEquals(6, headers.size());
    }

    @Test public void answersDecideWhatHappensNext() {
        assertEquals(Outcome.DONE, OfflineUploadRules.classify(201, "{\"ok\":true}"));
        assertEquals(Outcome.DONE, OfflineUploadRules.classify(200, ""));
        assertEquals(Outcome.NEEDS_SIGN_IN, OfflineUploadRules.classify(401, "{\"ok\":false,\"error\":\"authentication_required\"}"));
        assertEquals(Outcome.NEEDS_SIGN_IN, OfflineUploadRules.classify(403, "{\"ok\":false,\"error\":\"csrf_required\"}"));
        assertEquals(Outcome.FAILED, OfflineUploadRules.classify(403, "{\"ok\":false,\"error\":\"permission_denied\"}"));
        assertEquals(Outcome.FAILED, OfflineUploadRules.classify(403, "<html>csrf_required</html>"));
        assertEquals(Outcome.NEEDS_SIGN_IN, OfflineUploadRules.classify(409, "{\"error\":\"offline_identity_mismatch\"}"));
        assertEquals(Outcome.RETRY, OfflineUploadRules.classify(409, "{\"error\":\"idempotency_in_progress\"}"));
        assertEquals(Outcome.FAILED, OfflineUploadRules.classify(409, "{\"error\":\"revision_conflict\"}"));
        assertEquals(Outcome.FAILED, OfflineUploadRules.classify(422, "{\"error\":\"idempotency_key_reused\"}"));
        assertEquals(Outcome.FAILED, OfflineUploadRules.classify(400, null));
        assertEquals(Outcome.FAILED, OfflineUploadRules.classify(413, ""));
        for (int status : new int[]{408, 425, 429, 500, 502, 503, 504, 301, 302, 307, 308}) assertEquals(String.valueOf(status), Outcome.RETRY, OfflineUploadRules.classify(status, ""));
        assertTrue(OfflineUploadRules.sessionRefused(401, ""));
        assertTrue(OfflineUploadRules.sessionRefused(403, "{\"error\":\"csrf_required\"}"));
        assertFalse(OfflineUploadRules.sessionRefused(409, "{\"error\":\"offline_identity_mismatch\"}"));
        assertFalse(OfflineUploadRules.sessionRefused(500, ""));
    }

    @Test public void waitsDoubleUpToTheirCap() {
        assertEquals(30_000, OfflineUploadRules.retryDelay(true, 1));
        assertEquals(60_000, OfflineUploadRules.retryDelay(true, 2));
        assertEquals(1_920_000, OfflineUploadRules.retryDelay(true, 7));
        assertEquals(3_600_000, OfflineUploadRules.retryDelay(true, 8));
        assertEquals(3_600_000, OfflineUploadRules.retryDelay(true, 500));
        assertEquals(15_000, OfflineUploadRules.retryDelay(false, 0));
        assertEquals(15_000, OfflineUploadRules.retryDelay(false, 1));
        assertEquals(120_000, OfflineUploadRules.retryDelay(false, 4));
        assertEquals(900_000, OfflineUploadRules.retryDelay(false, 7));
        assertEquals(900_000, OfflineUploadRules.retryDelay(false, 99));
    }

    @Test public void multipartBodyIsFieldsThenTheFile() {
        Map<String, String> fields = new TreeMap<>();
        fields.put("owner_id", "proj_1"); fields.put("id", "media_9");
        MultipartBody body = MultipartBody.build(fields, "file", "roof é.jpg", "image/jpeg", 5, "BOUNDARY");
        String head = new String(body.head, StandardCharsets.UTF_8), tail = new String(body.tail, StandardCharsets.UTF_8);
        assertEquals("--BOUNDARY\r\nContent-Disposition: form-data; name=\"id\"\r\n\r\nmedia_9\r\n"
            + "--BOUNDARY\r\nContent-Disposition: form-data; name=\"owner_id\"\r\n\r\nproj_1\r\n"
            + "--BOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"roof é.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n", head);
        assertEquals("\r\n--BOUNDARY--\r\n", tail);
        assertEquals("multipart/form-data; boundary=BOUNDARY", body.contentType());
        assertEquals(body.head.length + 5 + body.tail.length, body.length());
        assertTrue(MultipartBody.boundary().matches("----FirstMateUpload[0-9a-f]{32}"));
        assertNotEquals(MultipartBody.boundary(), MultipartBody.boundary());
        fields.put("note", "has BOUNDARY inside");
        try { MultipartBody.build(fields, "file", "a.jpg", "image/jpeg", 5, "BOUNDARY"); fail("A boundary inside a field must be refused"); } catch (IllegalArgumentException expected) {}
    }
}
