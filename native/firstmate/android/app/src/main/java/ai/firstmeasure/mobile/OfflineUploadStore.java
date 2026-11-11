package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRules.Rejected;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.*;
import java.util.function.Function;
import java.util.function.LongSupplier;

/**
 * The durable record of background uploads: files the page handed over, the jobs
 * that send them and the server's answers until the page has read them. Everything
 * is under one private directory (filesDir, never the cache) and every change is
 * written before the bridge answers. No Android types, so JVM tests cover it.
 */
final class OfflineUploadStore {
    static final String QUEUED = "queued", UPLOADING = "uploading", DONE = "done", FAILED = "failed", NEEDS_SIGN_IN = "needs_sign_in";

    static final class Job {
        String id, key, url, fileField = "file", fileName = "upload", contentType = "application/octet-stream", csrfCookie = "";
        String state = QUEUED, error = "", refused = "";
        Map<String, String> fields = new TreeMap<>(), headers = new TreeMap<>();
        int status, attempts, serverFailures, networkFailures;
        long size, createdAt, updatedAt, nextAttemptAt;
        boolean hasBody, bodyTruncated;

        JSONObject toJson() throws Exception {
            JSONObject f = new JSONObject(), h = new JSONObject();
            for (Map.Entry<String, String> e : fields.entrySet()) f.put(e.getKey(), e.getValue());
            for (Map.Entry<String, String> e : headers.entrySet()) h.put(e.getKey(), e.getValue());
            return new JSONObject().put("id", id).put("url", url).put("fileField", fileField).put("fileName", fileName).put("contentType", contentType)
                .put("csrfCookie", csrfCookie).put("state", state).put("error", error).put("refused", refused).put("fields", f).put("headers", h)
                .put("status", status).put("attempts", attempts).put("serverFailures", serverFailures).put("networkFailures", networkFailures)
                .put("size", size).put("createdAt", createdAt).put("updatedAt", updatedAt).put("nextAttemptAt", nextAttemptAt)
                .put("hasBody", hasBody).put("bodyTruncated", bodyTruncated);
        }
        static Job fromJson(JSONObject o) throws Exception {
            Job job = new Job();
            job.id = o.getString("id"); job.key = OfflineUploadRules.fileKey(job.id); job.url = o.getString("url");
            job.fileField = o.optString("fileField", "file"); job.fileName = o.optString("fileName", "upload");
            job.contentType = o.optString("contentType", "application/octet-stream"); job.csrfCookie = o.optString("csrfCookie");
            job.state = o.optString("state", QUEUED); job.error = o.optString("error"); job.refused = o.optString("refused");
            copy(o.optJSONObject("fields"), job.fields); copy(o.optJSONObject("headers"), job.headers);
            job.status = o.optInt("status"); job.attempts = o.optInt("attempts"); job.serverFailures = o.optInt("serverFailures"); job.networkFailures = o.optInt("networkFailures");
            job.size = o.optLong("size"); job.createdAt = o.optLong("createdAt"); job.updatedAt = o.optLong("updatedAt"); job.nextAttemptAt = o.optLong("nextAttemptAt");
            job.hasBody = o.optBoolean("hasBody"); job.bodyTruncated = o.optBoolean("bodyTruncated");
            return job;
        }
        private static void copy(JSONObject from, Map<String, String> to) {
            if (from != null) for (Iterator<String> keys = from.keys(); keys.hasNext();) { String key = keys.next(); to.put(key, from.optString(key)); }
        }
        Job copy() { try { return fromJson(toJson()); } catch (Exception e) { throw new IllegalStateException(e); } }
    }

    /** One offlineUploads.enqueue call, validated. A null file name or content type means "the capture's own". */
    static final class Request {
        String id, url, fileField, fileName, contentType, csrfCookie, sourcePut, sourceCamera;
        Map<String, String> fields, headers;
        boolean saveToPhotos;
        long size = -1;

        static Request parse(JSONObject payload, OriginPolicy policy) throws Rejected {
            Request r = new Request();
            r.id = OfflineUploadRules.id(payload.opt("id"));
            r.url = OfflineUploadRules.uploadUrl(policy, payload.opt("url"));
            r.fileField = OfflineUploadRules.fileField(payload.opt("fileField"));
            r.fileName = payload.opt("fileName") instanceof String ? OfflineUploadRules.fileName(payload.opt("fileName"), "upload") : null;
            r.contentType = payload.opt("contentType") instanceof String ? OfflineUploadRules.contentType(payload.opt("contentType"), "application/octet-stream") : null;
            if (payload.has("fields") && !payload.isNull("fields") && payload.optJSONObject("fields") == null) throw new Rejected("invalid_request");
            if (payload.has("headers") && !payload.isNull("headers") && payload.optJSONObject("headers") == null) throw new Rejected("invalid_request");
            r.fields = OfflineUploadRules.fields(payload.optJSONObject("fields"));
            r.headers = OfflineUploadRules.headers(payload.optJSONObject("headers"));
            r.csrfCookie = OfflineUploadRules.csrfCookie(payload.opt("csrfCookie"));
            r.saveToPhotos = Boolean.TRUE.equals(payload.opt("saveToPhotos"));
            JSONObject source = payload.optJSONObject("source");
            if (source != null) {
                Object put = source.opt("put"), camera = source.opt("cameraToken");
                if (put instanceof String) r.sourcePut = OfflineUploadRules.id(put);
                else if (camera instanceof String && ((String) camera).length() <= 64) r.sourceCamera = (String) camera;
                else throw new Rejected("invalid_request");
            }
            Object size = payload.opt("size");
            if (size instanceof Number) r.size = ((Number) size).longValue();
            return r;
        }
    }

    private final File root, puts, files, index;
    private final LongSupplier clock, freeSpace;
    private LinkedHashMap<String, Job> jobs;

    OfflineUploadStore(File root, LongSupplier clock) { this(root, clock, root::getUsableSpace); }
    OfflineUploadStore(File root, LongSupplier clock, LongSupplier freeSpace) {
        this.root = root; puts = new File(root, "puts"); files = new File(root, "jobs"); index = new File(root, "jobs.json");
        this.clock = clock; this.freeSpace = freeSpace;
    }

    // ---- Files handed over by the page ------------------------------------------------------------------------

    /**
     * One step of a chunked transfer. Empty data without `done` only asks what is stored.
     * Data at offset 0 starts the file again; any other offset must equal the stored size,
     * otherwise nothing is written and the answer says where to continue.
     */
    synchronized JSONObject put(String id, long offset, byte[] data, boolean done) throws Exception {
        OfflineUploadRules.id(id);
        if (data.length > OfflineUploadRules.CHUNK_BYTES) throw new Rejected("chunk_too_large");
        if (offset < 0) throw new Rejected("invalid_request");
        String key = OfflineUploadRules.fileKey(id);
        File part = new File(puts, key + ".part"), whole = new File(puts, key + ".bin");
        boolean complete = whole.isFile();
        long size = complete ? whole.length() : part.isFile() ? part.length() : 0;
        if (data.length == 0 && !done) return putAnswer(size, complete, true);
        if (data.length > 0) {
            boolean restart = offset == 0;
            if (!restart && (complete || offset != size)) return putAnswer(size, complete, false);
            if ((restart ? 0 : size) + data.length > OfflineUploadRules.MAX_FILE_BYTES) { part.delete(); whole.delete(); throw new Rejected("file_too_large"); }
            if (freeSpace.getAsLong() < data.length + OfflineUploadRules.FREE_SPACE_RESERVE) throw new Rejected("storage_full");
            if (!puts.isDirectory() && !puts.mkdirs()) throw new IOException("Upload storage unavailable");
            if (restart) { whole.delete(); complete = false; }
            try (FileOutputStream out = new FileOutputStream(part, !restart)) { out.write(data); out.getFD().sync(); }
            size = part.length();
        } else if (complete || offset != size) return putAnswer(size, complete, complete && offset == size);
        if (done) {
            if (size == 0) throw new Rejected("empty_file");
            move(part, whole);
            complete = true;
        }
        return putAnswer(size, complete, true);
    }
    private static JSONObject putAnswer(long size, boolean done, boolean accepted) throws Exception {
        return new JSONObject().put("size", size).put("done", done).put("accepted", accepted);
    }
    /** A complete handed-over file, or null. */
    synchronized File putFile(String id) {
        File whole = new File(puts, OfflineUploadRules.fileKey(id) + ".bin");
        return whole.isFile() ? whole : null;
    }

    // ---- Bridge: jobs ----------------------------------------------------------------------------------------

    synchronized boolean exists(String id) { load(); return jobs.containsKey(id); }

    /** The file an enqueue would send, without moving it (for a camera-roll copy made first). */
    synchronized File source(Request r, CaptureStore captures) throws Rejected {
        File target = new File(files, OfflineUploadRules.fileKey(r.id) + ".bin");
        if (target.isFile()) return target;
        if (r.sourcePut != null) {
            File whole = putFile(r.sourcePut);
            if (whole != null) return whole;
            throw new Rejected(new File(puts, OfflineUploadRules.fileKey(r.sourcePut) + ".part").isFile() ? "put_incomplete" : "unknown_source");
        }
        File capture = r.sourceCamera == null ? null : captures.file(r.sourceCamera);
        if (capture == null) throw new Rejected("unknown_source");
        return capture;
    }

    /**
     * Records a job and takes its file. The same id again changes nothing, unless the job
     * failed or waits for a sign-in: then it is queued again with the new request.
     */
    synchronized JSONObject enqueue(Request r, CaptureStore captures) throws Exception {
        load();
        long now = clock.getAsLong();
        Job job = jobs.get(r.id);
        if (job != null) {
            if (!job.state.equals(FAILED) && !job.state.equals(NEEDS_SIGN_IN)) return answer(job, false, false);
            adopt(job, r, captures);
            job.state = QUEUED; job.status = 0; job.error = ""; job.refused = ""; job.serverFailures = 0; job.networkFailures = 0;
            job.nextAttemptAt = now; job.updatedAt = now;
            dropBody(job);
            save();
            return answer(job, false, true);
        }
        if (jobs.size() >= OfflineUploadRules.MAX_JOBS) throw new Rejected("queue_full");
        job = new Job();
        job.id = r.id; job.key = OfflineUploadRules.fileKey(r.id); job.createdAt = now; job.updatedAt = now; job.nextAttemptAt = now;
        adopt(job, r, captures);
        jobs.put(job.id, job);
        save();
        return answer(job, true, false);
    }
    private void adopt(Job job, Request r, CaptureStore captures) throws Exception {
        File target = file(job);
        String name = job.fileName, type = job.contentType;
        // A file already under the job's name is this job's own, or the one an interrupted enqueue moved.
        if (!target.isFile()) {
            File source = source(r, captures);
            if (r.sourceCamera != null) {
                String captured = captures.name(r.sourceCamera), mime = captures.mime(r.sourceCamera);
                if (captured != null && !captured.isEmpty()) name = captured;
                if (mime != null && !mime.isEmpty()) type = mime;
            }
            if (source.length() == 0) throw new Rejected("empty_file");
            if (source.length() > OfflineUploadRules.MAX_FILE_BYTES) throw new Rejected("file_too_large");
            if (r.size >= 0 && r.size != source.length()) throw new Rejected("size_mismatch");
            if (!files.isDirectory() && !files.mkdirs()) throw new IOException("Upload storage unavailable");
            move(source, target);
            if (r.sourceCamera != null) captures.forget(r.sourceCamera);
        } else if (r.size >= 0 && r.size != target.length()) throw new Rejected("size_mismatch");
        job.url = r.url; job.fileField = r.fileField; job.csrfCookie = r.csrfCookie;
        job.fileName = r.fileName != null ? r.fileName : name;
        job.contentType = r.contentType != null ? r.contentType : type;
        job.fields = new TreeMap<>(r.fields); job.headers = new TreeMap<>(r.headers);
        job.size = target.length();
    }
    private static JSONObject answer(Job job, boolean created, boolean requeued) throws Exception {
        return new JSONObject().put("id", job.id).put("state", job.state).put("created", created).put("requeued", requeued);
    }

    /** Jobs in the order they were queued; the named ones, or all. Answers stay until acknowledged. */
    synchronized JSONArray status(List<String> ids) throws Exception {
        load();
        List<Job> selected = new ArrayList<>();
        if (ids == null) selected.addAll(jobs.values());
        else for (String id : ids) { Job job = jobs.get(id); if (job != null && !selected.contains(job)) selected.add(job); }
        JSONArray out = new JSONArray();
        long budget = OfflineUploadRules.STATUS_BODY_BUDGET;
        for (Job job : selected) {
            JSONObject item = new JSONObject().put("id", job.id).put("state", job.state).put("status", job.status == 0 ? JSONObject.NULL : (Object) job.status)
                .put("attempts", job.attempts).put("size", job.size).put("createdAt", job.createdAt).put("updatedAt", job.updatedAt)
                .put("error", job.error.isEmpty() ? JSONObject.NULL : job.error).put("bodyTruncated", job.bodyTruncated);
            Object body = JSONObject.NULL;
            File stored = response(job);
            if (job.hasBody && stored.isFile()) {
                if (stored.length() <= budget) { body = read(stored); budget -= stored.length(); }
                else item.put("bodyOmitted", true);
            }
            out.put(item.put("body", body));
        }
        return out;
    }

    /** Forgets finished jobs whose answer the page has recorded. */
    synchronized JSONArray ack(List<String> ids) {
        load();
        JSONArray acked = new JSONArray();
        for (String id : ids) {
            Job job = jobs.get(id);
            if (job == null || !job.state.equals(DONE)) continue;
            remove(job);
            acked.put(id);
        }
        if (acked.length() > 0) save();
        return acked;
    }

    /** Removes a job and its file, and a handed-over file of the same id that was never queued. */
    synchronized boolean cancel(String id) throws Rejected {
        OfflineUploadRules.id(id);
        load();
        String key = OfflineUploadRules.fileKey(id);
        boolean removed = new File(puts, key + ".part").delete() | new File(puts, key + ".bin").delete();
        Job job = jobs.get(id);
        if (job != null) { remove(job); save(); removed = true; }
        return removed;
    }
    private void remove(Job job) { file(job).delete(); response(job).delete(); jobs.remove(job.id); }

    // ---- Uploader --------------------------------------------------------------------------------------------

    synchronized File file(Job job) { return new File(files, job.key + ".bin"); }
    private File response(Job job) { return new File(files, job.key + ".response"); }

    /** No request survives the process, so an upload still marked as running is waiting again. */
    synchronized void recover() {
        load();
        boolean changed = false;
        for (Job job : jobs.values()) if (job.state.equals(UPLOADING)) { job.state = QUEUED; job.nextAttemptAt = Math.min(job.nextAttemptAt, clock.getAsLong()); changed = true; }
        if (changed) save();
    }
    /** The oldest job that is due, or null. */
    synchronized Job next() {
        load();
        long now = clock.getAsLong();
        for (Job job : jobs.values()) if (job.state.equals(QUEUED) && job.nextAttemptAt <= now) return job.copy();
        return null;
    }
    synchronized boolean waiting() {
        load();
        for (Job job : jobs.values()) if (job.state.equals(QUEUED) || job.state.equals(UPLOADING)) return true;
        return false;
    }
    synchronized boolean begin(String id) {
        Job job = find(id);
        if (job == null || !job.state.equals(QUEUED)) return false;
        job.state = UPLOADING; job.attempts++; job.updatedAt = clock.getAsLong();
        save();
        return true;
    }
    synchronized void finish(String id, int status, byte[] body, boolean truncated) {
        Job job = find(id);
        if (job == null) return;
        answered(job, DONE, status, body, truncated, "");
        job.serverFailures = 0; job.networkFailures = 0;
        file(job).delete();
        save();
    }
    /** Keeps the file: the page cancels the job or queues it again. */
    synchronized void fail(String id, int status, byte[] body, boolean truncated, String error) {
        Job job = find(id);
        if (job == null) return;
        answered(job, FAILED, status, body, truncated, error);
        save();
    }
    /** Waits for a sign-in; `refused` identifies the session the server would not take. */
    synchronized void park(String id, int status, byte[] body, boolean truncated, String refused) {
        Job job = find(id);
        if (job == null) return;
        answered(job, NEEDS_SIGN_IN, status, body, truncated, "");
        job.refused = refused;
        save();
    }
    /** The session is not accepted (or there is none): nothing else is sent with it. */
    synchronized void parkQueued(String refused) {
        load();
        long now = clock.getAsLong();
        boolean changed = false;
        for (Job job : jobs.values()) if (job.state.equals(QUEUED)) { job.state = NEEDS_SIGN_IN; job.refused = refused; job.updatedAt = now; changed = true; }
        if (changed) save();
    }
    /**
     * Queued again after a wait. A server answer counts towards the limit of eight in a row,
     * after which the job is failed; a network failure never does. Answers false when it failed.
     */
    synchronized boolean retry(String id, int status, byte[] body, boolean truncated, boolean server, boolean connected) {
        Job job = find(id);
        if (job == null) return false;
        long now = clock.getAsLong();
        if (server) {
            job.serverFailures++; job.networkFailures = 0;
            if (job.serverFailures >= OfflineUploadRules.MAX_SERVER_FAILURES) { answered(job, FAILED, status, body, truncated, "retries_exhausted"); save(); return false; }
            answered(job, QUEUED, status, body, truncated, "");
            job.nextAttemptAt = now + OfflineUploadRules.retryDelay(true, job.serverFailures);
        } else {
            // Without a connection there is nothing to back off from: the network constraint holds the work.
            job.networkFailures = connected ? job.networkFailures + 1 : 1;
            job.state = QUEUED; job.updatedAt = now;
            job.nextAttemptAt = now + OfflineUploadRules.retryDelay(false, job.networkFailures);
        }
        save();
        return true;
    }
    /** The system stopped the work mid-transfer; that is not a failed attempt. */
    synchronized void interrupted(String id) {
        Job job = find(id);
        if (job == null || !job.state.equals(UPLOADING)) return;
        job.state = QUEUED; job.updatedAt = clock.getAsLong(); job.nextAttemptAt = job.updatedAt;
        save();
    }
    /**
     * Jobs waiting for a sign-in are queued again when the session is no longer the one
     * the server refused. `session` answers a hash of the job's current session, or null.
     */
    synchronized int resume(Function<Job, String> session) {
        load();
        long now = clock.getAsLong();
        int resumed = 0;
        for (Job job : jobs.values()) {
            if (!job.state.equals(NEEDS_SIGN_IN)) continue;
            String current = session.apply(job.copy());
            if (current == null || current.isEmpty() || current.equals(job.refused)) continue;
            job.state = QUEUED; job.refused = ""; job.serverFailures = 0; job.networkFailures = 0; job.nextAttemptAt = now; job.updatedAt = now;
            resumed++;
        }
        if (resumed > 0) save();
        return resumed;
    }

    /** Removes answers nobody read for 30 days, handed-over files never queued for 7, and files without a job. */
    synchronized void prune() {
        load();
        long now = clock.getAsLong();
        boolean changed = false;
        for (Job job : new ArrayList<>(jobs.values()))
            if (job.state.equals(DONE) && now - job.updatedAt > OfflineUploadRules.RESULT_TTL) { remove(job); changed = true; }
        if (changed) save();
        File[] handed = puts.listFiles();
        if (handed != null) for (File file : handed) if (now - file.lastModified() > OfflineUploadRules.PUT_TTL) file.delete();
        Set<String> keys = new HashSet<>();
        for (Job job : jobs.values()) keys.add(job.key);
        File[] stored = files.listFiles();
        if (stored != null) for (File file : stored) {
            String name = file.getName(), key = name.contains(".") ? name.substring(0, name.indexOf('.')) : name;
            if (!keys.contains(key) && now - file.lastModified() > OfflineUploadRules.RESULT_TTL) file.delete();
        }
    }

    private Job find(String id) { load(); return jobs.get(id); }
    private void answered(Job job, String state, int status, byte[] body, boolean truncated, String error) {
        job.state = state; job.status = status; job.error = error; job.updatedAt = clock.getAsLong();
        dropBody(job);
        if (body != null && body.length > 0) try {
            try (FileOutputStream out = new FileOutputStream(response(job))) { out.write(body, 0, Math.min(body.length, OfflineUploadRules.MAX_BODY_BYTES)); }
            job.hasBody = true; job.bodyTruncated = truncated || body.length > OfflineUploadRules.MAX_BODY_BYTES;
        } catch (IOException ignored) { /* The status alone still tells the page what happened. */ }
    }
    private void dropBody(Job job) { response(job).delete(); job.hasBody = false; job.bodyTruncated = false; }

    private void load() {
        if (jobs != null) return;
        jobs = new LinkedHashMap<>();
        if (!index.isFile()) return;
        try {
            JSONArray stored = new JSONObject(read(index)).getJSONArray("jobs");
            for (int i = 0; i < stored.length(); i++) { Job job = Job.fromJson(stored.getJSONObject(i)); jobs.put(job.id, job); }
        } catch (Exception e) {
            // Unreadable index: keep it for diagnosis. Job files stay and are taken up again when the page queues the same ids.
            jobs.clear();
            index.renameTo(new File(root, "jobs.unreadable-" + clock.getAsLong() + ".json"));
        }
    }
    private void save() {
        try {
            JSONArray stored = new JSONArray();
            for (Job job : jobs.values()) stored.put(job.toJson());
            writeAtomically(index, new JSONObject().put("version", 1).put("jobs", stored).toString());
        } catch (Exception e) { throw new IllegalStateException("Upload queue could not be saved", e); }
    }

    static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }
    /** Replaces the file in one step, so a crash leaves the old or the new content, never half of one. */
    static void writeAtomically(File file, String text) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Storage unavailable");
        File temporary = new File(parent, file.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temporary)) { out.write(text.getBytes(StandardCharsets.UTF_8)); out.getFD().sync(); }
        move(temporary, file);
    }
    static void move(File from, File to) throws IOException {
        try { Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
        catch (AtomicMoveNotSupportedException e) { Files.move(from.toPath(), to.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    }
}
