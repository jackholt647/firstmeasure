import Foundation
import CryptoKit
import Security

/// A request the bridge refuses; `code` is what the page receives.
struct OfflineUploadRejected: Error, Equatable {
    let code: String
    init(_ code: String) { self.code = code }
}

enum OfflineUploadOutcome: Equatable { case done, needsSignIn, retry, failed }

/// Limits, allow-lists and answer handling for background uploads (native/firstmate/README.md, "Offline").
/// The same rules as `OfflineUploadRules.java`; keep the two in step. No UIKit or WebKit, so unit tests cover it.
enum OfflineUploadRules {
    static let chunkBytes = 256 * 1024
    static let maxFileBytes: Int64 = 150 * 1024 * 1024
    static let maxBodyBytes = 256 * 1024
    static let statusBodyBudget = 1024 * 1024
    static let maxJobs = 2000
    static let maxServerFailures = 8
    static let freeSpaceReserve: Int64 = 16 * 1024 * 1024
    static let day: Int64 = 86_400_000
    static let resultTTL: Int64 = 30 * day, putTTL: Int64 = 7 * day

    private static let allowedHeaders = [
        "idempotency-key": "Idempotency-Key", "x-fm-offline-user": "X-FM-Offline-User", "x-fm-offline-org": "X-FM-Offline-Org",
        "x-fm-offline-replay": "X-FM-Offline-Replay", "accept": "Accept"
    ]

    /// Whole-string match. `\z`, not `$`: `$` also matches before a final line break.
    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: "^(?:" + pattern + ")\\z", options: .regularExpression) != nil
    }

    static func id(_ value: Any?) throws -> String {
        guard let text = value as? String, matches(text, "[A-Za-z0-9._:-]{1,128}") else { throw OfflineUploadRejected("invalid_request") }
        return text
    }

    /// File name for an id: ids differing only by case must not share a file.
    static func fileKey(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).prefix(20).map { String(format: "%02x", $0) }.joined()
    }
    static func hash(_ value: String) -> String { fileKey(value) }

    /// Uploads go to the portal origin under /v1/ and nowhere else.
    static func uploadURL(_ value: Any?, policy: OriginPolicy) throws -> URL {
        guard let text = value as? String, text.utf16.count <= 2048, let url = URL(string: text), policy.trusted(url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false), components.fragment == nil else { throw OfflineUploadRejected("untrusted_url") }
        let path = components.percentEncodedPath.lowercased()
        guard path.hasPrefix("/v1/"), !path.contains(".."), !path.contains("\\"), !path.contains("%2e"), !path.contains("%2f"), !path.contains("%5c") else {
            throw OfflineUploadRejected("untrusted_url")
        }
        return url
    }

    /// Only the queue's own headers; the host adds Cookie, X-Platform-CSRF, Origin and Content-Type itself.
    static func headers(_ value: Any?) throws -> [String: String] {
        var out: [String: String] = [:]
        if let value, !(value is NSNull) {
            guard let object = value as? [String: Any] else { throw OfflineUploadRejected("invalid_request") }
            for (key, raw) in object {
                guard let name = allowedHeaders[key.lowercased()] else { throw OfflineUploadRejected("header_not_allowed") }
                let text = try self.text(raw)
                guard !text.isEmpty, text.utf16.count <= 256, text.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7e }) else {
                    throw OfflineUploadRejected("invalid_request")
                }
                out[name] = text
            }
        }
        // The host retries without asking, so a repeat must be recognizable to the server.
        guard out["Idempotency-Key"] != nil else { throw OfflineUploadRejected("idempotency_key_required") }
        return out
    }

    static func fields(_ value: Any?) throws -> [String: String] {
        var out: [String: String] = [:]
        if let value, !(value is NSNull) {
            guard let object = value as? [String: Any], object.count <= 64 else { throw OfflineUploadRejected("invalid_request") }
            for (key, raw) in object {
                guard matches(key, "[A-Za-z0-9_.\\[\\]-]{1,100}") else { throw OfflineUploadRejected("invalid_request") }
                out[key] = try text(raw)
            }
        }
        return out
    }

    static func fileField(_ value: Any?) throws -> String {
        guard let value, !(value is NSNull) else { return "file" }
        guard let text = value as? String else { throw OfflineUploadRejected("invalid_request") }
        if text.isEmpty { return "file" }
        guard matches(text, "[A-Za-z0-9_.-]{1,64}") else { throw OfflineUploadRejected("invalid_request") }
        return text
    }

    static func csrfCookie(_ value: Any?) throws -> String {
        guard let text = value as? String, matches(text, "[A-Za-z0-9_.-]{1,128}") else { throw OfflineUploadRejected("invalid_request") }
        return text
    }

    /// A name safe inside a quoted Content-Disposition value; the end is kept because it holds the extension.
    static func fileName(_ value: Any?, fallback: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in ((value as? String) ?? "").unicodeScalars {
            let unsafe = scalar.value < 0x20 || scalar.value == 0x7f || scalar == "\"" || scalar == "\\" || scalar == "/"
            scalars.append(unsafe ? "_" : scalar)
        }
        var name = String(scalars).trimmingCharacters(in: .whitespaces)
        if name.count > 120 { name = String(name.suffix(120)) }
        return name.isEmpty ? fallback : name
    }

    /// The media type without parameters, or the fallback when it is not one.
    static func contentType(_ value: Any?, fallback: String) -> String {
        let whole = (value as? String) ?? ""
        let type = String(whole.prefix { $0 != ";" }).trimmingCharacters(in: .whitespaces).lowercased()
        return matches(type, "[a-z0-9!#$&^_.+-]{1,60}/[a-z0-9!#$&^_.+-]{1,60}") ? type : fallback
    }

    static func text(_ value: Any?) throws -> String {
        if let text = value as? String { return text }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            let double = number.doubleValue
            guard double.isFinite else { throw OfflineUploadRejected("invalid_request") }
            if double == double.rounded(), abs(double) < 1e15 { return String(Int64(double)) }
            return String(double)
        }
        throw OfflineUploadRejected("invalid_request")
    }

    /// The value of one cookie in a Cookie header, percent-decoded as the server's encodeURIComponent wrote it.
    static func cookieValue(header: String?, name: String) -> String? {
        guard let header else { return nil }
        for part in header.split(separator: ";") {
            guard let at = part.firstIndex(of: "=") else { continue }
            if part[..<at].trimmingCharacters(in: .whitespaces) == name {
                let raw = part[part.index(after: at)...].trimmingCharacters(in: .whitespaces)
                return raw.removingPercentEncoding ?? raw
            }
        }
        return nil
    }

    /// The Cookie header a browser would send to `url` from these cookies (domain, path, Secure and expiry rules), or nil.
    static func cookieHeader(_ cookies: [HTTPCookie], for url: URL, now: Date = Date()) -> String? {
        guard let host = url.host?.lowercased() else { return nil }
        let path = url.path.isEmpty ? "/" : url.path
        let matching = cookies.filter { cookie in
            if let expires = cookie.expiresDate, expires <= now { return false }
            if cookie.isSecure && url.scheme != "https" { return false }
            let domain = cookie.domain.lowercased()
            let bare = domain.hasPrefix(".") ? String(domain.dropFirst()) : domain
            // A cookie set with a Domain attribute (leading dot) also belongs to subdomains; one without is for that host only.
            guard host == bare || (domain.hasPrefix(".") && host.hasSuffix("." + bare)) else { return false }
            let cookiePath = cookie.path.isEmpty ? "/" : cookie.path
            return path == cookiePath || path.hasPrefix(cookiePath.hasSuffix("/") ? cookiePath : cookiePath + "/")
        }
        guard !matching.isEmpty else { return nil }
        return matching.map { $0.name + "=" + $0.value }.joined(separator: "; ")
    }

    /// The headers of one attempt. Session values are read fresh for every attempt and never stored with the job.
    static func requestHeaders(_ jobHeaders: [String: String], cookies: String, csrf: String, origin: String, contentType: String) -> [String: String] {
        var out = ["Accept": "application/json"]
        for (key, value) in jobHeaders { if let name = allowedHeaders[key.lowercased()] { out[name] = value } }
        out["Cookie"] = cookies
        out["X-Platform-CSRF"] = csrf
        out["Origin"] = origin
        out["Content-Type"] = contentType
        return out
    }

    /// The server's error code in a JSON answer ({ ok: false, error: "..." }), or "".
    static func errorCode(_ body: String?) -> String {
        guard let body, let data = body.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        return object["error"] as? String ?? ""
    }

    static func classify(status: Int, body: String?) -> OfflineUploadOutcome {
        if status >= 200 && status < 300 { return .done }
        if status == 401 { return .needsSignIn }
        let error = errorCode(body)
        if status == 403 && error == "csrf_required" { return .needsSignIn }
        if status == 409 && error == "offline_identity_mismatch" { return .needsSignIn }
        if status == 409 && error == "idempotency_in_progress" { return .retry }
        if status == 408 || status == 425 || status == 429 { return .retry }
        if status >= 400 && status < 500 { return .failed }
        // A redirect is never the upload's answer; like a 5xx it is the server not answering the upload.
        return .retry
    }
    /// A refused session stops every waiting upload; an upload queued by someone else only stops itself.
    static func sessionRefused(status: Int, body: String?) -> Bool {
        classify(status: status, body: body) == .needsSignIn && status != 409
    }

    /// Milliseconds to wait before the next attempt after `consecutive` failures of one kind:
    /// doubling, from 30 s to 1 h (server) or 15 s to 15 min (network).
    static func retryDelay(server: Bool, consecutive: Int) -> Int64 {
        let base: Int64 = server ? 30_000 : 15_000, cap: Int64 = server ? 3_600_000 : 900_000
        return min(cap, base << Int64(max(0, min(consecutive - 1, 20))))
    }
}

/// multipart/form-data around one file: the text fields first (sorted by name), the file last.
/// A background upload is sent from a file, so the whole body is written to one.
enum OfflineMultipart {
    static func boundary() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return "----FirstMateUpload" + bytes.map { String(format: "%02x", $0) }.joined()
    }
    /// Names and the file name must already be validated: they are written inside quotes as they are.
    static func head(fields: [String: String], fileField: String, fileName: String, contentType: String, boundary: String) throws -> Data {
        var text = ""
        for name in fields.keys.sorted() {
            let value = fields[name] ?? ""
            guard !value.contains(boundary) else { throw OfflineUploadRejected("invalid_request") }
            text += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n"
        }
        text += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(fileName)\"\r\nContent-Type: \(contentType)\r\n\r\n"
        return Data(text.utf8)
    }
    static func tail(boundary: String) -> Data { Data("\r\n--\(boundary)--\r\n".utf8) }

    static func write(to destination: URL, source: URL, fields: [String: String], fileField: String, fileName: String, contentType: String, boundary: String) throws {
        let start = try head(fields: fields, fileField: fileField, fileName: fileName, contentType: contentType, boundary: boundary)
        try? FileManager.default.removeItem(at: destination)
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        try output.write(contentsOf: start)
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        while let block = try input.read(upToCount: 1 << 20), !block.isEmpty { try output.write(contentsOf: block) }
        try output.write(contentsOf: tail(boundary: boundary))
    }
}
