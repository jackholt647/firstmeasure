package ai.firstmeasure.mobile;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * Sends queued uploads when there is a connection, whether or not the app is open.
 * WorkManager keeps the work across process death and restarts; `retry` brings it
 * back with exponential backoff while jobs wait.
 */
public final class OfflineUploadWorker extends Worker {
    public OfflineUploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @NonNull @Override public Result doWork() {
        try {
            return OfflineUploads.get(getApplicationContext()).work(this::isStopped) ? Result.retry() : Result.success();
        } catch (RuntimeException e) {
            // For example the queue could not be written (storage full): nothing was lost, try again later.
            return Result.retry();
        }
    }
}
