package ai.firstmeasure.mobile;

import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import java.util.regex.Pattern;

/**
 * Limits, allow-lists and answer handling for background uploads
 * (native/firstmate/README.md, "Offline"). No Android types, so JVM tests cover it.
 */
final class OfflineUploadRules {
    static final int CHUNK_BYTES = 256 * 1024;
    static final long MAX_FILE_BYTES = 150L * 1024 * 1024;
    static final int MAX_BODY_BYTES = 256 * 1024;
    static final int STATUS_BODY_BUDGET = 1024 * 1024;
    static final int MAX_JOBS = 2000;
    static final int MAX_SERVER_FAILURES = 8;
    static final long FREE_SPACE_RESERVE = 16L * 1024 * 1024;
    static final long DAY = 86_400_000L;
    static final long CAPTURE_TTL = 30 * DAY, RESULT_TTL = 30 * DAY, PUT_TTL = 7 * DAY, ORPHAN_TTL = DAY;

    /** A request the bridge refuses; the code is what the page receives. */
    static final class Rejected extends Exception {
        final String code;
        Rejected(String code) { super(code); this.code = code; }
    }
    enum Outcome { DONE, NEEDS_SIGN_IN, RETRY, FAILED }

    private static final Pattern ID = Pattern.compile("[A-Za-z0-9._:-]{1,128}");
    private static final Pattern FIELD_NAME = Pattern.compile("[A-Za-z0-9_.\\[\\]-]{1,100}");
    private static final Pattern FILE_FIELD = Pattern.compile("[A-Za-z0-9_.-]{1,64}");
    private static final Pattern COOKIE_NAME = Pattern.compile("[A-Za-z0-9_.-]{1,128}");
    private static final Pattern MEDIA_TYPE = Pattern.compile("[a-z0-9!#$&^_.+-]{1,60}/[a-z0-9!#$&^_.+-]{1,60}");
    private static final Map<String, String> HEADERS = new LinkedHashMap<>();
    static {
        for (String name : new String[]{"Idempotency-Key", "X-FM-Offline-User", "X-FM-Offline-Org", "X-FM-Offline-Replay", "Accept"})
            HEADERS.put(name.toLowerCase(Locale.ROOT), name);
    }
    private OfflineUploadRules() {}

    static String id(Object value) throws Rejected {
        if (!(value instanceof String) || !ID.matcher((String) value).matches()) throw new Rejected("invalid_request");
        return (String) value;
    }

    /** File name for an id: ids differing only by case must not share a file. */
    static String fileKey(String id) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(id.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < 20; i++) out.append(String.format(Locale.ROOT, "%02x", hash[i] & 255));
            return out.toString();
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    static String hash(String value) { return fileKey(value); }

    /** Uploads go to the portal origin under /v1/ and nowhere else. */
    static String uploadUrl(OriginPolicy policy, Object value) throws Rejected {
        if (!(value instanceof String)) throw new Rejected("untrusted_url");
        String url = (String) value;
        try {
            if (url.length() > 2048 || !policy.trusted(url)) throw new Rejected("untrusted_url");
            URI uri = URI.create(url);
            String path = uri.getRawPath(), lower = path == null ? "" : path.toLowerCase(Locale.ROOT);
            if (path == null || !path.startsWith("/v1/") || uri.getRawFragment() != null || lower.contains("..") || lower.contains("\\")
                || lower.contains("%2e") || lower.contains("%2f") || lower.contains("%5c")) throw new Rejected("untrusted_url");
            return uri.toString();
        } catch (IllegalArgumentException e) { throw new Rejected("untrusted_url"); }
    }

    /** Only the queue's own headers; the host adds Cookie, X-Platform-CSRF, Origin and Content-Type itself. */
    static Map<String, String> headers(JSONObject value) throws Rejected {
        Map<String, String> out = new TreeMap<>();
        if (value != null) for (Iterator<String> keys = value.keys(); keys.hasNext();) {
            String key = keys.next(), name = HEADERS.get(key.toLowerCase(Locale.ROOT));
            if (name == null) throw new Rejected("header_not_allowed");
            String text = text(value.opt(key));
            if (text.isEmpty() || text.length() > 256) throw new Rejected("invalid_request");
            for (int i = 0; i < text.length(); i++) if (text.charAt(i) < 0x20 || text.charAt(i) > 0x7e) throw new Rejected("invalid_request");
            out.put(name, text);
        }
        // The host retries without asking, so a repeat must be recognizable to the server.
        if (!out.containsKey("Idempotency-Key")) throw new Rejected("idempotency_key_required");
        return out;
    }

    static Map<String, String> fields(JSONObject value) throws Rejected {
        Map<String, String> out = new TreeMap<>();
        if (value != null) for (Iterator<String> keys = value.keys(); keys.hasNext();) {
            String key = keys.next();
            if (!FIELD_NAME.matcher(key).matches()) throw new Rejected("invalid_request");
            out.put(key, text(value.opt(key)));
        }
        if (out.size() > 64) throw new Rejected("invalid_request");
        return out;
    }

    static String fileField(Object value) throws Rejected {
        if (value == null || value == JSONObject.NULL || "".equals(value)) return "file";
        if (!(value instanceof String) || !FILE_FIELD.matcher((String) value).matches()) throw new Rejected("invalid_request");
        return (String) value;
    }

    static String csrfCookie(Object value) throws Rejected {
        if (!(value instanceof String) || !COOKIE_NAME.matcher((String) value).matches()) throw new Rejected("invalid_request");
        return (String) value;
    }

    /** A name safe inside a quoted Content-Disposition value; the end is kept because it holds the extension. */
    static String fileName(Object value, String fallback) {
        String name = value instanceof String ? (String) value : "";
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            out.append(c < 0x20 || c == 0x7f || c == '"' || c == '\\' || c == '/' ? '_' : c);
        }
        name = out.toString().trim();
        if (name.length() > 120) name = name.substring(name.length() - 120);
        if (!name.isEmpty() && Character.isLowSurrogate(name.charAt(0))) name = name.substring(1);
        return name.isEmpty() ? fallback : name;
    }

    /** The media type without parameters, or the fallback when it is not one. */
    static String contentType(Object value, String fallback) {
        String type = value instanceof String ? ((String) value).split(";", 2)[0].trim().toLowerCase(Locale.ROOT) : "";
        return MEDIA_TYPE.matcher(type).matches() ? type : fallback;
    }

    private static String text(Object value) throws Rejected {
        if (value instanceof String) return (String) value;
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Integer || value instanceof Long) return value.toString();
        if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) throw new Rejected("invalid_request");
            return number == Math.rint(number) && Math.abs(number) < 1e15 ? String.valueOf((long) number) : String.valueOf(number);
        }
        throw new Rejected("invalid_request");
    }

    /** The value of one cookie in a Cookie header, percent-decoded as the server's encodeURIComponent wrote it. */
    static String cookieValue(String header, String name) {
        if (header == null) return null;
        for (String part : header.split(";")) {
            int at = part.indexOf('=');
            if (at > 0 && part.substring(0, at).trim().equals(name)) return percentDecode(part.substring(at + 1).trim());
        }
        return null;
    }
    static String percentDecode(String value) {
        if (value.indexOf('%') < 0) return value;
        try {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                if (c == '%') { bytes.write(Integer.parseInt(value.substring(i + 1, i + 3), 16)); i += 2; }
                else { byte[] encoded = String.valueOf(c).getBytes(StandardCharsets.UTF_8); bytes.write(encoded, 0, encoded.length); }
            }
            return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        } catch (RuntimeException e) { return value; }
    }

    /** The headers of one attempt. Session values are read fresh for every attempt and never stored with the job. */
    static Map<String, String> requestHeaders(Map<String, String> jobHeaders, String cookies, String csrf, String origin, String contentType) {
        Map<String, String> out = new LinkedHashMap<>();
        out.put("Accept", "application/json");
        for (Map.Entry<String, String> header : jobHeaders.entrySet()) {
            String name = HEADERS.get(header.getKey().toLowerCase(Locale.ROOT));
            if (name != null) out.put(name, header.getValue());
        }
        out.put("Cookie", cookies);
        out.put("X-Platform-CSRF", csrf);
        out.put("Origin", origin);
        out.put("Content-Type", contentType);
        return out;
    }

    /** The server's error code in a JSON answer ({ ok: false, error: "..." }), or "". */
    static String errorCode(String body) {
        if (body == null || body.isEmpty()) return "";
        try { Object error = new JSONObject(body).opt("error"); return error instanceof String ? (String) error : ""; }
        catch (Exception e) { return ""; }
    }

    static Outcome classify(int status, String body) {
        if (status >= 200 && status < 300) return Outcome.DONE;
        if (status == 401) return Outcome.NEEDS_SIGN_IN;
        String error = errorCode(body);
        if (status == 403 && error.equals("csrf_required")) return Outcome.NEEDS_SIGN_IN;
        if (status == 409 && error.equals("offline_identity_mismatch")) return Outcome.NEEDS_SIGN_IN;
        if (status == 409 && error.equals("idempotency_in_progress")) return Outcome.RETRY;
        if (status == 408 || status == 425 || status == 429) return Outcome.RETRY;
        if (status >= 400 && status < 500) return Outcome.FAILED;
        // A redirect is never followed; like a 5xx it is the server not answering the upload.
        return Outcome.RETRY;
    }
    /** A refused session stops every waiting upload; an upload queued by someone else only stops itself. */
    static boolean sessionRefused(int status, String body) {
        return classify(status, body) == Outcome.NEEDS_SIGN_IN && !(status == 409);
    }

    /** Wait before the next attempt after `consecutive` failures of one kind: doubling, from 30 s to 1 h (server) or 15 s to 15 min (network). */
    static long retryDelay(boolean server, int consecutive) {
        long base = server ? 30_000L : 15_000L, cap = server ? 3_600_000L : 900_000L;
        int doublings = Math.max(0, Math.min(consecutive - 1, 20));
        return Math.min(cap, base << doublings);
    }
}
