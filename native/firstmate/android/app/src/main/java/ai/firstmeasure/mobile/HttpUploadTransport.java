package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRunner.Response;
import ai.firstmeasure.mobile.OfflineUploadStore.Job;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * One multipart POST of a job's file. The file is streamed, a redirect is answered
 * to the caller and never followed, and at most 256 KB of the answer is kept.
 */
final class HttpUploadTransport implements OfflineUploadRunner.Transport {
    @Override public Response send(Job job, File file, String cookies, String csrf, String origin, BooleanSupplier stopped) throws IOException {
        MultipartBody body = MultipartBody.build(job.fields, job.fileField, job.fileName, job.contentType, file.length(), MultipartBody.boundary());
        HttpURLConnection connection = (HttpURLConnection) new URL(job.url).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(120000);
            connection.setUseCaches(false);
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length());
            for (Map.Entry<String, String> header : OfflineUploadRules.requestHeaders(job.headers, cookies, csrf, origin, body.contentType()).entrySet())
                connection.setRequestProperty(header.getKey(), header.getValue());
            try (OutputStream out = connection.getOutputStream(); InputStream in = new FileInputStream(file)) {
                out.write(body.head);
                byte[] buffer = new byte[65536];
                long sent = 0;
                int count;
                while ((count = in.read(buffer)) != -1) {
                    if (stopped.getAsBoolean()) throw new OfflineUploadRunner.Stopped();
                    sent += count;
                    // The file is the job's own and must not change; a different length would corrupt the request.
                    if (sent > body.fileLength) throw new IOException("File changed during upload");
                    out.write(buffer, 0, count);
                }
                if (sent != body.fileLength) throw new IOException("File changed during upload");
                out.write(body.tail);
            } catch (OfflineUploadRunner.Stopped e) {
                throw e;
            } catch (IOException e) {
                // A server that refuses early (401 before reading the file) closes the connection mid-body.
                // Its answer, when it can still be read, says more than the broken write does.
                int early;
                try { early = connection.getResponseCode(); } catch (IOException unread) { throw e; }
                if (early < 400) throw e;
            }
            int status = connection.getResponseCode();
            InputStream answer = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream kept = new ByteArrayOutputStream();
            boolean truncated = false;
            if (answer != null) try (InputStream in = answer) {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = in.read(buffer)) != -1) {
                    int room = OfflineUploadRules.MAX_BODY_BYTES - kept.size();
                    if (count > room) { kept.write(buffer, 0, room); truncated = true; break; }
                    kept.write(buffer, 0, count);
                }
            }
            return new Response(status, kept.toByteArray(), truncated);
        } finally { connection.disconnect(); }
    }
}
