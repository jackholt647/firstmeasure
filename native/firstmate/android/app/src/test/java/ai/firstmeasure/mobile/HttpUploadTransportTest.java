package ai.firstmeasure.mobile;

import ai.firstmeasure.mobile.OfflineUploadRunner.Response;
import ai.firstmeasure.mobile.OfflineUploadStore.Job;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.*;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import static org.junit.Assert.*;

/** The real transport against a local HTTP server: what goes over the wire, and what comes back. */
public class HttpUploadTransportTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();
    private ServerSocket server;
    private Thread thread;
    private final List<Received> received = new CopyOnWriteArrayList<>();
    private final Deque<byte[]> answers = new ArrayDeque<>();

    private static final class Received {
        String line; final Map<String, String> headers = new HashMap<>(); byte[] body = new byte[0];
    }

    @Before public void start() throws Exception {
        server = new ServerSocket(0, 10, InetAddress.getLoopbackAddress());
        thread = new Thread(() -> {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    InputStream in = new BufferedInputStream(socket.getInputStream());
                    Received request = new Received();
                    request.line = line(in);
                    for (String header = line(in); !header.isEmpty(); header = line(in)) {
                        int at = header.indexOf(':');
                        request.headers.put(header.substring(0, at).trim().toLowerCase(Locale.ROOT), header.substring(at + 1).trim());
                    }
                    int length = Integer.parseInt(request.headers.getOrDefault("content-length", "0"));
                    ByteArrayOutputStream body = new ByteArrayOutputStream();
                    byte[] buffer = new byte[8192];
                    while (body.size() < length) { int count = in.read(buffer, 0, Math.min(buffer.length, length - body.size())); if (count < 0) break; body.write(buffer, 0, count); }
                    request.body = body.toByteArray();
                    received.add(request);
                    byte[] answer;
                    synchronized (answers) { answer = answers.isEmpty() ? http(201, "", "{\"ok\":true}".getBytes(StandardCharsets.UTF_8)) : answers.poll(); }
                    socket.getOutputStream().write(answer);
                    socket.getOutputStream().flush();
                } catch (IOException ignored) { /* closed, or the client went away */ }
            }
        });
        thread.setDaemon(true);
        thread.start();
    }
    @After public void stop() throws Exception { server.close(); thread.join(2000); }

    private static String line(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int c = in.read(); c != -1 && c != '\n'; c = in.read()) if (c != '\r') out.write(c);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }
    private static byte[] http(int status, String headers, byte[] body) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(("HTTP/1.1 " + status + " X\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n" + headers + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.write(body);
        return out.toByteArray();
    }
    private Job job(String path) {
        Job job = new Job();
        job.id = "j1"; job.url = "http://127.0.0.1:" + server.getLocalPort() + path;
        job.fileField = "file"; job.fileName = "roof.jpg"; job.contentType = "image/jpeg"; job.csrfCookie = "fm_platform_session_csrf";
        job.fields.put("id", "media_1"); job.fields.put("metadata", "{\"taken_at\":\"2026-11-10T10:00:00Z\"}");
        job.headers.put("Idempotency-Key", "fmo1-j1"); job.headers.put("X-FM-Offline-User", "user_1"); job.headers.put("X-FM-Offline-Org", "org_1"); job.headers.put("X-FM-Offline-Replay", "1");
        return job;
    }
    private File file(int length) throws IOException {
        byte[] content = new byte[length];
        for (int i = 0; i < length; i++) content[i] = (byte) (i * 7);
        File file = folder.newFile();
        Files.write(file.toPath(), content);
        return file;
    }
    private static int indexOf(byte[] all, byte[] part) {
        outer: for (int i = 0; i <= all.length - part.length; i++) { for (int j = 0; j < part.length; j++) if (all[i + j] != part[j]) continue outer; return i; }
        return -1;
    }

    @Test public void sendsOneMultipartPostWithTheSessionAndQueueHeaders() throws Exception {
        File file = file(200_000);
        Response response = new HttpUploadTransport().send(job("/v1/platform/organizations/org_1/media"), file, "fm_platform_session=s1; fm_platform_session_csrf=tok", "tok", "https://dev.1m8.ai", () -> false);
        assertEquals(201, response.status); assertEquals("{\"ok\":true}", new String(response.body, StandardCharsets.UTF_8)); assertFalse(response.truncated);

        assertEquals(1, received.size());
        Received request = received.get(0);
        assertEquals("POST /v1/platform/organizations/org_1/media HTTP/1.1", request.line);
        assertEquals("fm_platform_session=s1; fm_platform_session_csrf=tok", request.headers.get("cookie"));
        assertEquals("tok", request.headers.get("x-platform-csrf"));
        assertEquals("https://dev.1m8.ai", request.headers.get("origin"));
        assertEquals("fmo1-j1", request.headers.get("idempotency-key"));
        assertEquals("user_1", request.headers.get("x-fm-offline-user")); assertEquals("org_1", request.headers.get("x-fm-offline-org")); assertEquals("1", request.headers.get("x-fm-offline-replay"));
        assertEquals("application/json", request.headers.get("accept"));
        String type = request.headers.get("content-type");
        assertTrue(type, type.startsWith("multipart/form-data; boundary=----FirstMateUpload"));
        String boundary = type.substring(type.indexOf('=') + 1);
        assertEquals(String.valueOf(request.body.length), request.headers.get("content-length"));

        String text = new String(request.body, StandardCharsets.ISO_8859_1);
        assertTrue(text.startsWith("--" + boundary + "\r\nContent-Disposition: form-data; name=\"id\"\r\n\r\nmedia_1\r\n"));
        assertTrue(text.contains("name=\"metadata\"\r\n\r\n{\"taken_at\":\"2026-11-10T10:00:00Z\"}\r\n"));
        byte[] fileHeader = ("Content-Disposition: form-data; name=\"file\"; filename=\"roof.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n").getBytes(StandardCharsets.UTF_8);
        int start = indexOf(request.body, fileHeader) + fileHeader.length;
        assertArrayEquals(Files.readAllBytes(file.toPath()), Arrays.copyOfRange(request.body, start, start + 200_000));
        assertEquals("\r\n--" + boundary + "--\r\n", text.substring(start + 200_000));
    }

    @Test public void aRedirectIsAnsweredNotFollowed() throws Exception {
        synchronized (answers) { answers.add(http(302, "Location: http://127.0.0.1:" + server.getLocalPort() + "/elsewhere\r\n", new byte[0])); }
        Response response = new HttpUploadTransport().send(job("/v1/x"), file(10), "a=b", "tok", "https://dev.1m8.ai", () -> false);
        assertEquals(302, response.status);
        Thread.sleep(200);
        assertEquals("no second request", 1, received.size());
    }

    @Test public void errorAnswersAreReadAndLongOnesCut() throws Exception {
        synchronized (answers) { answers.add(http(403, "", "{\"ok\":false,\"error\":\"csrf_required\"}".getBytes(StandardCharsets.UTF_8))); }
        Response refused = new HttpUploadTransport().send(job("/v1/x"), file(10), "a=b", "tok", "https://dev.1m8.ai", () -> false);
        assertEquals(403, refused.status);
        assertEquals("csrf_required", OfflineUploadRules.errorCode(new String(refused.body, StandardCharsets.UTF_8)));

        byte[] large = new byte[OfflineUploadRules.MAX_BODY_BYTES + 5000];
        Arrays.fill(large, (byte) 'x');
        synchronized (answers) { answers.add(http(200, "", large)); }
        Response cut = new HttpUploadTransport().send(job("/v1/x"), file(10), "a=b", "tok", "https://dev.1m8.ai", () -> false);
        assertEquals(200, cut.status); assertEquals(OfflineUploadRules.MAX_BODY_BYTES, cut.body.length); assertTrue(cut.truncated);
    }

    @Test public void stopsBetweenBlocksAndReportsAnUnreachableServer() throws Exception {
        try { new HttpUploadTransport().send(job("/v1/x"), file(500_000), "a=b", "tok", "https://dev.1m8.ai", () -> true); fail("Must stop"); }
        catch (OfflineUploadRunner.Stopped expected) {}
        Job unreachable = job("/v1/x");
        server.close();
        try { new HttpUploadTransport().send(unreachable, file(10), "a=b", "tok", "https://dev.1m8.ai", () -> false); fail("Must fail"); }
        catch (OfflineUploadRunner.Stopped unexpected) { fail("Not a stop"); }
        catch (IOException expected) {}
    }
}
