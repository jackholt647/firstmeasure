package ai.firstmeasure.mobile;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class CaptureStoreTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private final long[] now = {System.currentTimeMillis()};

    private File capture(CaptureStore store, String extension, int length) throws Exception {
        File file = store.newFile(extension);
        Files.write(file.toPath(), new byte[length]);
        return file;
    }

    @Test public void aCaptureSurvivesTheProcessAndIsRemovedOnRelease() throws Exception {
        File root = folder.newFolder("offline-uploads");
        CaptureStore store = new CaptureStore(root, () -> now[0]);
        File photo = capture(store, ".jpg", 1234);
        assertEquals(new File(root, "captures"), photo.getParentFile());
        JSONObject saved = store.add(photo, "image/jpeg", 0);
        String token = saved.getString("token");
        assertTrue(token.matches("[a-f0-9-]{36}"));
        assertEquals(1234, saved.getLong("size")); assertEquals("image/jpeg", saved.getString("mime")); assertEquals(photo.getName(), saved.getString("name"));

        // A new process: the token still names the file.
        CaptureStore later = new CaptureStore(root, () -> now[0]);
        assertEquals(photo, later.file(token));
        assertEquals("image/jpeg", later.mime(token)); assertEquals(photo.getName(), later.name(token));
        assertNull(later.file("unknown")); assertNull(later.file(null));

        later.release(token);
        assertFalse(photo.exists());
        assertNull(later.file(token));
        assertNull(new CaptureStore(root, () -> now[0]).file(token));
    }

    @Test public void forgetKeepsTheFileThatMovedToAnUpload() throws Exception {
        CaptureStore store = new CaptureStore(folder.newFolder("offline-uploads"), () -> now[0]);
        File video = capture(store, ".mp4", 10);
        String token = store.add(video, "video/mp4", 2500).getString("token");
        store.forget(token);
        assertNull(store.mime(token));
        assertTrue(video.exists());
    }

    @Test public void capturesExpireAfterThirtyDaysAndUnfinishedFilesAfterOne() throws Exception {
        File root = folder.newFolder("offline-uploads");
        CaptureStore store = new CaptureStore(root, () -> now[0]);
        File old = capture(store, ".jpg", 10);
        String oldToken = store.add(old, "image/jpeg", 0).getString("token");
        File unfinished = capture(store, ".mp4", 10);

        now[0] += OfflineUploadRules.CAPTURE_TTL - 60_000;
        File recent = capture(store, ".jpg", 10);
        String recentToken = store.add(recent, "image/jpeg", 0).getString("token");
        assertEquals(0, store.prune());
        assertFalse("a file without a token for more than a day never finished", unfinished.exists());
        assertNotNull(store.file(oldToken));

        now[0] += 120_000;
        assertEquals(1, store.prune());
        assertNull(store.file(oldToken)); assertFalse(old.exists());
        assertEquals(recent, new CaptureStore(root, () -> now[0]).file(recentToken));
    }

    @Test public void oversizedCapturesAreRefused() throws Exception {
        CaptureStore store = new CaptureStore(folder.newFolder("offline-uploads"), () -> now[0]);
        File file = capture(store, ".mp4", 16);
        try (java.io.RandomAccessFile sparse = new java.io.RandomAccessFile(file, "rw")) { sparse.setLength(OfflineUploadRules.MAX_FILE_BYTES + 1); }
        try { store.add(file, "video/mp4", 1000); fail("Too large"); } catch (java.io.IOException expected) {}
        assertFalse(file.exists());
    }
}
