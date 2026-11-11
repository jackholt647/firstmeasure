package ai.firstmeasure.mobile;

import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.util.*;
import java.util.function.LongSupplier;

/**
 * Native camera captures in private app storage, with the token map on disk so a
 * capture survives the process being killed before the page reads or queues it.
 * A capture is removed when the page releases it, when its upload is queued
 * (the file moves to the job) or after 30 days.
 */
final class CaptureStore {
    private final File directory, index;
    private final LongSupplier clock;
    private Map<String, JSONObject> entries;

    CaptureStore(File root, LongSupplier clock) {
        directory = new File(root, "captures"); index = new File(root, "captures.json"); this.clock = clock;
    }

    synchronized File newFile(String extension) throws IOException {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Capture storage unavailable");
        return new File(directory, "capture-" + UUID.randomUUID() + extension);
    }

    /** Records a finished capture and answers what the page receives. */
    synchronized JSONObject add(File file, String mime, long duration) throws Exception {
        if (file.length() > OfflineUploadRules.MAX_FILE_BYTES) { file.delete(); throw new IOException("File too large"); }
        load();
        String token = UUID.randomUUID().toString();
        entries.put(token, new JSONObject().put("file", file.getName()).put("name", file.getName()).put("mime", mime)
            .put("size", file.length()).put("duration", duration).put("createdAt", clock.getAsLong()));
        save();
        return new JSONObject().put("token", token).put("name", file.getName()).put("mime", mime).put("size", file.length()).put("duration", duration);
    }

    synchronized File file(String token) {
        load();
        JSONObject entry = token == null ? null : entries.get(token);
        if (entry == null) return null;
        File file = new File(directory, entry.optString("file"));
        return file.isFile() ? file : null;
    }
    synchronized String mime(String token) { load(); JSONObject entry = entries.get(token); return entry == null ? null : entry.optString("mime"); }
    synchronized String name(String token) { load(); JSONObject entry = entries.get(token); return entry == null ? null : entry.optString("name"); }

    synchronized void release(String token) {
        load();
        JSONObject entry = entries.remove(token);
        if (entry == null) return;
        new File(directory, entry.optString("file")).delete();
        save();
    }
    /** The file has moved to an upload job; only the token is dropped. */
    synchronized void forget(String token) { load(); if (entries.remove(token) != null) save(); }

    synchronized int prune() {
        load();
        long now = clock.getAsLong();
        int removed = 0;
        Set<String> kept = new HashSet<>();
        for (Iterator<Map.Entry<String, JSONObject>> all = entries.entrySet().iterator(); all.hasNext();) {
            JSONObject entry = all.next().getValue();
            File file = new File(directory, entry.optString("file"));
            if (!file.isFile() || now - entry.optLong("createdAt") > OfflineUploadRules.CAPTURE_TTL) { file.delete(); all.remove(); removed++; }
            else kept.add(file.getName());
        }
        // A file without a token is a capture that never finished.
        File[] files = directory.listFiles();
        if (files != null) for (File file : files)
            if (!kept.contains(file.getName()) && now - file.lastModified() > OfflineUploadRules.ORPHAN_TTL) file.delete();
        if (removed > 0) save();
        return removed;
    }

    private void load() {
        if (entries != null) return;
        entries = new LinkedHashMap<>();
        try {
            JSONObject stored = new JSONObject(OfflineUploadStore.read(index));
            for (Iterator<String> keys = stored.keys(); keys.hasNext();) { String key = keys.next(); JSONObject entry = stored.optJSONObject(key); if (entry != null) entries.put(key, entry); }
        } catch (Exception ignored) { /* No index yet, or unreadable: untracked files are pruned after a day. */ }
    }
    private void save() {
        try {
            JSONObject stored = new JSONObject();
            for (Map.Entry<String, JSONObject> entry : entries.entrySet()) stored.put(entry.getKey(), entry.getValue());
            OfflineUploadStore.writeAtomically(index, stored.toString());
        } catch (Exception ignored) { /* The capture stays readable in this process; it is lost to the next one. */ }
    }
}
