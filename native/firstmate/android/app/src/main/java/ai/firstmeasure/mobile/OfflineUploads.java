package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRules.Rejected;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.webkit.CookieManager;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import org.json.JSONObject;
import java.io.File;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/**
 * Background uploads for the whole process: the store, the camera captures and
 * the WorkManager work that sends what is queued, also after the app is closed.
 * One instance, because the activity and the worker share the files.
 */
final class OfflineUploads {
    static final String WORK = "offline-uploads";
    private static OfflineUploads instance;
    static synchronized OfflineUploads get(Context context) {
        if (instance == null) instance = new OfflineUploads(context.getApplicationContext());
        return instance;
    }

    final OfflineUploadStore store;
    final CaptureStore captures;
    private final Context context;
    private final OriginPolicy policy = new OriginPolicy(BuildConfig.PORTAL_ORIGIN);
    private final OfflineUploadRunner runner;
    private boolean running, again;

    private OfflineUploads(Context context) {
        this.context = context;
        File root = new File(context.getFilesDir(), "offline-uploads");
        store = new OfflineUploadStore(root, System::currentTimeMillis);
        captures = new CaptureStore(root, System::currentTimeMillis);
        runner = new OfflineUploadRunner(store, BuildConfig.PORTAL_ORIGIN, new HttpUploadTransport(),
            url -> CookieManager.getInstance().getCookie(url), this::connected);
    }

    private boolean connected() {
        try {
            ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
            NetworkCapabilities network = manager == null ? null : manager.getNetworkCapabilities(manager.getActiveNetwork());
            return network != null && network.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        } catch (Exception e) { return true; }
    }

    /** offlineUploads.enqueue. `photosAllowed` is false when the person refused the storage permission (Android 9 and older). */
    JSONObject enqueue(JSONObject payload, boolean photosAllowed) throws Exception {
        OfflineUploadStore.Request request = OfflineUploadStore.Request.parse(payload, policy);
        boolean saved = false;
        String photosError = null;
        // The copy is made first, from the file as it is handed over, and only when this call creates the job.
        if (request.saveToPhotos && !store.exists(request.id)) {
            if (!photosAllowed) photosError = "photos_permission_denied";
            else try {
                File source = store.source(request, captures);
                String type = request.contentType != null ? request.contentType : request.sourceCamera != null ? captures.mime(request.sourceCamera) : null;
                String name = request.fileName != null ? request.fileName : request.sourceCamera != null ? captures.name(request.sourceCamera) : null;
                PhotoLibrary.save(context, source, name, type);
                saved = true;
            } catch (Rejected e) { photosError = e.code; }
        }
        JSONObject answer = store.enqueue(request, captures);
        kick();
        return answer.put("savedToPhotos", saved).put("photosError", photosError == null ? JSONObject.NULL : photosError);
    }

    /** photoLibrarySave: an add-only copy of one capture or handed-over file. The source stays where it is. */
    JSONObject saveToPhotos(JSONObject payload) throws Exception {
        Object token = payload.opt("cameraToken"), put = payload.opt("put");
        File source; String name, type;
        if (token instanceof String) {
            source = captures.file((String) token); name = captures.name((String) token); type = captures.mime((String) token);
        } else if (put instanceof String) {
            source = store.putFile(OfflineUploadRules.id(put));
            name = payload.opt("fileName") instanceof String ? (String) payload.opt("fileName") : null;
            type = payload.opt("contentType") instanceof String ? (String) payload.opt("contentType") : null;
        } else throw new Rejected("invalid_request");
        if (source == null) throw new Rejected("unknown_source");
        PhotoLibrary.save(context, source, name, type);
        return new JSONObject().put("saved", true);
    }

    /** Starts the work unless it runs in this process already; then that run goes round once more. */
    void kick() {
        synchronized (this) { if (running) { again = true; return; } }
        try {
            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(OfflineUploadWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build();
            WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.REPLACE, request);
        } catch (Exception ignored) { /* The next app start or enqueue schedules it. */ }
    }

    /** The worker's body. Answers true when jobs still wait, so WorkManager comes back with its backoff. */
    boolean work(BooleanSupplier stopped) {
        synchronized (this) { if (running) { again = true; return false; } running = true; again = false; }
        boolean waiting = false;
        try {
            do { waiting = runner.run(stopped); } while (repeat() && !stopped.getAsBoolean());
        } finally { synchronized (this) { running = false; } }
        return waiting;
    }
    private synchronized boolean repeat() {
        if (again) { again = false; return true; }
        running = false;
        return false;
    }

    /** App start: remove what expired and continue what was waiting. */
    void start() {
        store.prune();
        captures.prune();
        sessionChanged();
    }
    /**
     * A page finished loading or the app came back: uploads refused for their session go again once
     * the session is another one, and whatever waits is tried now instead of at WorkManager's next backoff.
     */
    void sessionChanged() {
        try { store.resume(runner::session); } catch (Exception ignored) { /* Cookies unavailable: tried again at the next load. */ }
        if (store.waiting()) kick();
    }
}
