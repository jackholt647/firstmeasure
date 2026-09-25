package ai.firstmeasure.mobile;

import java.net.URI;

/** Shared trust decision for navigation, bridge messages and authenticated downloads. */
public final class OriginPolicy {
    private final URI origin;
    public OriginPolicy(String value) {
        origin = URI.create(value);
        if (!"https".equals(origin.getScheme()) || origin.getHost() == null || origin.getUserInfo() != null || origin.getPort() != -1)
            throw new IllegalArgumentException("An HTTPS origin without credentials or port is required");
    }
    public boolean trusted(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && origin.getHost().equalsIgnoreCase(uri.getHost())
                && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (Exception ignored) { return false; }
    }
    public static boolean external(String value) {
        try { URI u=URI.create(value); return ("https".equals(u.getScheme()) && u.getHost()!=null && u.getUserInfo()==null)
            || "tel".equals(u.getScheme()) || "mailto".equals(u.getScheme()); }
        catch (Exception ignored) { return false; }
    }
}
