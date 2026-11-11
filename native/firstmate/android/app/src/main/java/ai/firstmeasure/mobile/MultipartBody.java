package ai.firstmeasure.mobile;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** multipart/form-data around one file: the text fields first, the file last, streamed without holding it in memory. */
final class MultipartBody {
    final String boundary;
    final byte[] head, tail;
    final long fileLength;

    private MultipartBody(String boundary, byte[] head, byte[] tail, long fileLength) {
        this.boundary = boundary; this.head = head; this.tail = tail; this.fileLength = fileLength;
    }
    String contentType() { return "multipart/form-data; boundary=" + boundary; }
    long length() { return head.length + fileLength + tail.length; }

    static String boundary() {
        byte[] bytes = new byte[16];
        new java.security.SecureRandom().nextBytes(bytes);
        StringBuilder out = new StringBuilder("----FirstMateUpload");
        for (byte b : bytes) out.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }

    /** Names and the file name must already be validated (OfflineUploadRules): they are written inside quotes as they are. */
    static MultipartBody build(Map<String, String> fields, String fileField, String fileName, String contentType, long fileLength, String boundary) {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        for (Map.Entry<String, String> field : fields.entrySet()) {
            if (field.getValue().contains(boundary)) throw new IllegalArgumentException("Boundary occurs in a field");
            write(head, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + field.getKey() + "\"\r\n\r\n" + field.getValue() + "\r\n");
        }
        write(head, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + fileField + "\"; filename=\"" + fileName + "\"\r\nContent-Type: " + contentType + "\r\n\r\n");
        return new MultipartBody(boundary, head.toByteArray(), ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8), fileLength);
    }
    private static void write(ByteArrayOutputStream out, String text) {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        out.write(bytes, 0, bytes.length);
    }
}
