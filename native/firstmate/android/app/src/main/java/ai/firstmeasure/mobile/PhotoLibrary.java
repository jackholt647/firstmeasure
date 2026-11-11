package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRules.Rejected;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import java.io.*;

/**
 * An add-only copy of one photo or video in the phone's gallery (DCIM/FirstMate).
 * Nothing calls this unless the page asked: captures and uploads stay in private storage.
 * Android 10 and newer need no permission; older versions need WRITE_EXTERNAL_STORAGE,
 * which the activity requests before calling.
 */
final class PhotoLibrary {
    private static final String ALBUM = "FirstMate";
    private PhotoLibrary() {}

    static Uri save(Context context, File source, String fileName, String contentType) throws Rejected {
        String type = OfflineUploadRules.contentType(contentType, "");
        boolean video = type.startsWith("video/");
        if (!video && !type.startsWith("image/")) throw new Rejected("unsupported_media");
        if (source == null || !source.isFile()) throw new Rejected("unknown_source");
        String name = OfflineUploadRules.fileName(fileName, "FirstMate-" + System.currentTimeMillis()).replaceAll("[^A-Za-z0-9._ -]", "_");
        if (!name.contains(".")) {
            String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
            if (extension != null) name = name + "." + extension;
        }
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, type);
        values.put("datetaken", source.lastModified());
        Uri item = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/" + ALBUM);
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri collection = video ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY) : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                item = resolver.insert(collection, values);
                if (item == null) throw new IOException("Gallery unavailable");
                try (OutputStream out = resolver.openOutputStream(item)) {
                    if (out == null) throw new IOException("Gallery unavailable");
                    copy(source, out);
                }
                ContentValues published = new ContentValues();
                published.put(MediaStore.MediaColumns.IS_PENDING, 0);
                resolver.update(item, published, null, null);
                return item;
            }
            // Android 8 and 9: the file is written to shared storage first, then listed.
            File directory = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM), ALBUM);
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Gallery unavailable");
            File target = new File(directory, name);
            for (int copy = 1; target.exists() && copy < 1000; copy++) target = new File(directory, copy + "-" + name);
            try (OutputStream out = new FileOutputStream(target)) { copy(source, out); }
            catch (IOException e) { target.delete(); throw e; }
            values.put(MediaStore.MediaColumns.DATA, target.getAbsolutePath());
            item = resolver.insert(video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
            if (item == null) { target.delete(); throw new IOException("Gallery unavailable"); }
            return item;
        } catch (SecurityException e) {
            throw new Rejected("photos_permission_denied");
        } catch (Exception e) {
            if (item != null && Build.VERSION.SDK_INT >= 29) try { resolver.delete(item, null, null); } catch (Exception ignored) {}
            throw new Rejected("photos_save_failed");
        }
    }
    private static void copy(File source, OutputStream out) throws IOException {
        try (InputStream in = new FileInputStream(source)) {
            byte[] buffer = new byte[65536];
            int count;
            while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
        }
    }
}
