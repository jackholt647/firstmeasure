import XCTest
@testable import FirstMate

private func code(_ body: () throws -> Void) -> String? {
    do { try body(); return nil } catch let error as OfflineUploadRejected { return error.code } catch { return "\(error)" }
}

final class OfflineUploadRulesTests: XCTestCase {
    private let policy = OriginPolicy("https://dev.1m8.ai")

    func testUploadsOnlyGoToThePortalOriginUnderV1() throws {
        for value in ["https://dev.1m8.ai/v1/platform/organizations/org_1/media", "https://DEV.1M8.AI/v1/x?y=1", "https://dev.1m8.ai:443/v1/x"] {
            XCTAssertEqual(try OfflineUploadRules.uploadURL(value, policy: policy).absoluteString, value)
        }
        let refused: [Any?] = ["https://1m8.ai/v1/x", "http://dev.1m8.ai/v1/x", "https://dev.1m8.ai.evil.test/v1/x", "https://dev.1m8.ai@evil.test/v1/x",
            "https://dev.1m8.ai/portal/", "https://dev.1m8.ai/v1/../portal/", "https://dev.1m8.ai/v1/%2e%2e/portal", "https://dev.1m8.ai/v1/a%2Fb", "https://dev.1m8.ai/v1/x#f",
            "https://dev.1m8.ai:8443/v1/x", "/v1/x", "", nil, 7, "https://dev.1m8.ai/v1/" + String(repeating: "a", count: 2100)]
        for value in refused { XCTAssertEqual(code { _ = try OfflineUploadRules.uploadURL(value, policy: self.policy) }, "untrusted_url", "\(String(describing: value))") }
    }

    func testOnlyTheQueuesOwnHeadersAreAcceptedAndTheKeyIsRequired() throws {
        let sent: [String: Any] = ["idempotency-key": "fmo1-1", "X-FM-Offline-User": "user_1", "x-fm-offline-org": "org_1", "X-FM-Offline-Replay": 1, "Accept": "application/json"]
        let headers = try OfflineUploadRules.headers(sent)
        XCTAssertEqual(headers, ["Idempotency-Key": "fmo1-1", "X-FM-Offline-User": "user_1", "X-FM-Offline-Org": "org_1", "X-FM-Offline-Replay": "1", "Accept": "application/json"])
        for name in ["Cookie", "X-Platform-CSRF", "Origin", "Authorization", "Host", "Content-Type"] {
            XCTAssertEqual(code { _ = try OfflineUploadRules.headers(["Idempotency-Key": "k", name: "x"]) }, "header_not_allowed", name)
        }
        XCTAssertEqual(code { _ = try OfflineUploadRules.headers(["Accept": "application/json"]) }, "idempotency_key_required")
        XCTAssertEqual(code { _ = try OfflineUploadRules.headers(nil) }, "idempotency_key_required")
        XCTAssertEqual(code { _ = try OfflineUploadRules.headers(["Idempotency-Key": "a\r\nCookie: x"]) }, "invalid_request")
        XCTAssertEqual(code { _ = try OfflineUploadRules.headers(["Idempotency-Key": String(repeating: "k", count: 257)]) }, "invalid_request")
        XCTAssertEqual(code { _ = try OfflineUploadRules.headers("text") }, "invalid_request")
    }

    func testFieldsIdsNamesAndTypes() throws {
        let sent: [String: Any] = ["owner_type": "project", "replace_slot": false, "count": 3, "ratio": 1.5, "metadata": "{\"taken_at\":\"2026-11-10T10:00:00Z\"}"]
        let fields = try OfflineUploadRules.fields(sent)
        XCTAssertEqual(fields,["owner_type": "project", "replace_slot": "false", "count": "3", "ratio": "1.5", "metadata": "{\"taken_at\":\"2026-11-10T10:00:00Z\"}"])
        XCTAssertEqual(try OfflineUploadRules.fields(nil), [:])
        XCTAssertEqual(code { _ = try OfflineUploadRules.fields(["a\"b": "x"]) }, "invalid_request")
        XCTAssertEqual(code { _ = try OfflineUploadRules.fields(["line\n": "x"]) }, "invalid_request")
        let nested: [String: Any] = ["nested": ["a": 1]]
        XCTAssertEqual(code { _ = try OfflineUploadRules.fields(nested) }, "invalid_request")

        XCTAssertEqual(try OfflineUploadRules.id("fmo1-3f2a:1.b_c"), "fmo1-3f2a:1.b_c")
        let ids: [Any?] = ["", "a b", "a/b", "../x", "ok\n", String(repeating: "a", count: 129), nil, 5]
        for value in ids { XCTAssertEqual(code { _ = try OfflineUploadRules.id(value) }, "invalid_request") }
        XCTAssertNotEqual(OfflineUploadRules.fileKey("Photo-1"), OfflineUploadRules.fileKey("photo-1"))
        XCTAssertNotNil(OfflineUploadRules.fileKey("../../etc").range(of: "^[0-9a-f]{40}\\z", options: .regularExpression))
        // The same key as the Android host computes (SHA-256, first 20 bytes, hex).
        XCTAssertEqual(OfflineUploadRules.fileKey("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a3")

        XCTAssertEqual(OfflineUploadRules.fileName("fa\u{e7}ade front.jpg", fallback: "upload"), "fa\u{e7}ade front.jpg")
        XCTAssertEqual(OfflineUploadRules.fileName("a\"b\\c/d\n.jpg", fallback: "upload"), "a_b_c_d_.jpg")
        XCTAssertEqual(OfflineUploadRules.fileName("   ", fallback: "upload"), "upload")
        XCTAssertEqual(OfflineUploadRules.fileName(nil, fallback: "upload"), "upload")
        let long = OfflineUploadRules.fileName(String(repeating: "x", count: 300) + ".jpeg", fallback: "upload")
        XCTAssertEqual(long.count, 120); XCTAssertTrue(long.hasSuffix(".jpeg"))

        XCTAssertEqual(OfflineUploadRules.contentType("Image/JPEG", fallback: "application/octet-stream"), "image/jpeg")
        XCTAssertEqual(OfflineUploadRules.contentType("video/webm; codecs=vp9", fallback: "application/octet-stream"), "video/webm")
        XCTAssertEqual(OfflineUploadRules.contentType("image/jpeg\r\nX: y", fallback: "application/octet-stream"), "application/octet-stream")
        XCTAssertEqual(try OfflineUploadRules.fileField(nil), "file")
        XCTAssertEqual(code { _ = try OfflineUploadRules.fileField("a\"b") }, "invalid_request")
        XCTAssertEqual(try OfflineUploadRules.csrfCookie("fm_platform_session_csrf"), "fm_platform_session_csrf")
        XCTAssertEqual(code { _ = try OfflineUploadRules.csrfCookie("a;b") }, "invalid_request")
    }

    func testCsrfTokenAndCookieHeaderFollowBrowserRules() {
        let header = "fm_platform_session=abc; fm_platform_session_csrf=to%2Bken%3D%3D; other=fm_platform_session_csrf=wrong"
        XCTAssertEqual(OfflineUploadRules.cookieValue(header: header, name: "fm_platform_session_csrf"), "to+ken==")
        XCTAssertEqual(OfflineUploadRules.cookieValue(header: header, name: "fm_platform_session"), "abc")
        XCTAssertNil(OfflineUploadRules.cookieValue(header: header, name: "session_csrf"))
        XCTAssertNil(OfflineUploadRules.cookieValue(header: nil, name: "x"))

        func cookie(_ name: String, _ value: String, domain: String, path: String = "/", secure: Bool = true, expires: Date? = nil) -> HTTPCookie {
            var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain, .path: path]
            if secure { properties[.secure] = "TRUE" }
            if let expires { properties[.expires] = expires }
            return HTTPCookie(properties: properties)!
        }
        let now = Date()
        let cookies = [
            cookie("fm_platform_session", "s1", domain: "dev.1m8.ai"), cookie("fm_platform_session_csrf", "tok", domain: "dev.1m8.ai"),
            cookie("parent", "p", domain: ".1m8.ai"), cookie("other_host", "x", domain: "1m8.ai"), cookie("elsewhere", "x", domain: "evil.test"),
            cookie("portal_only", "x", domain: "dev.1m8.ai", path: "/portal"), cookie("api", "a", domain: "dev.1m8.ai", path: "/v1"),
            cookie("old", "x", domain: "dev.1m8.ai", expires: now.addingTimeInterval(-60))
        ]
        let sent = OfflineUploadRules.cookieHeader(cookies, for: URL(string: "https://dev.1m8.ai/v1/platform/organizations/org_1/media")!, now: now)
        XCTAssertEqual(Set((sent ?? "").components(separatedBy: "; ")), ["fm_platform_session=s1", "fm_platform_session_csrf=tok", "parent=p", "api=a"])
        XCTAssertNil(OfflineUploadRules.cookieHeader(cookies, for: URL(string: "https://example.org/v1/x")!, now: now))
        XCTAssertNil(OfflineUploadRules.cookieHeader([cookie("s", "1", domain: "dev.1m8.ai")], for: URL(string: "http://dev.1m8.ai/v1/x")!, now: now), "a Secure cookie never goes over http")
    }

    func testRequestHeadersCarryTheSessionAndOnlyAllowedJobHeaders() {
        let headers = OfflineUploadRules.requestHeaders(["Idempotency-Key": "fmo1-1", "Cookie": "evil=1", "accept": "text/plain"], cookies: "a=b", csrf: "token", origin: "https://dev.1m8.ai", contentType: "multipart/form-data; boundary=x")
        XCTAssertEqual(headers, ["Accept": "text/plain", "Idempotency-Key": "fmo1-1", "Cookie": "a=b", "X-Platform-CSRF": "token", "Origin": "https://dev.1m8.ai", "Content-Type": "multipart/form-data; boundary=x"])
    }

    func testAnswersDecideWhatHappensNext() {
        XCTAssertEqual(OfflineUploadRules.classify(status: 201, body: "{\"ok\":true}"), .done)
        XCTAssertEqual(OfflineUploadRules.classify(status: 401, body: "{\"ok\":false,\"error\":\"authentication_required\"}"), .needsSignIn)
        XCTAssertEqual(OfflineUploadRules.classify(status: 403, body: "{\"ok\":false,\"error\":\"csrf_required\"}"), .needsSignIn)
        XCTAssertEqual(OfflineUploadRules.classify(status: 403, body: "{\"ok\":false,\"error\":\"permission_denied\"}"), .failed)
        XCTAssertEqual(OfflineUploadRules.classify(status: 403, body: "<html>csrf_required</html>"), .failed)
        XCTAssertEqual(OfflineUploadRules.classify(status: 409, body: "{\"error\":\"offline_identity_mismatch\"}"), .needsSignIn)
        XCTAssertEqual(OfflineUploadRules.classify(status: 409, body: "{\"error\":\"idempotency_in_progress\"}"), .retry)
        XCTAssertEqual(OfflineUploadRules.classify(status: 409, body: "{\"error\":\"revision_conflict\"}"), .failed)
        XCTAssertEqual(OfflineUploadRules.classify(status: 422, body: "{\"error\":\"idempotency_key_reused\"}"), .failed)
        XCTAssertEqual(OfflineUploadRules.classify(status: 400, body: nil), .failed)
        for status in [408, 425, 429, 500, 502, 503, 504, 301, 302, 307, 308] { XCTAssertEqual(OfflineUploadRules.classify(status: status, body: ""), .retry, "\(status)") }
        XCTAssertTrue(OfflineUploadRules.sessionRefused(status: 401, body: ""))
        XCTAssertTrue(OfflineUploadRules.sessionRefused(status: 403, body: "{\"error\":\"csrf_required\"}"))
        XCTAssertFalse(OfflineUploadRules.sessionRefused(status: 409, body: "{\"error\":\"offline_identity_mismatch\"}"))
        XCTAssertFalse(OfflineUploadRules.sessionRefused(status: 500, body: ""))
    }

    func testWaitsDoubleUpToTheirCap() {
        XCTAssertEqual(OfflineUploadRules.retryDelay(server: true, consecutive: 1), 30_000)
        XCTAssertEqual(OfflineUploadRules.retryDelay(server: true, consecutive: 7), 1_920_000)
        XCTAssertEqual(OfflineUploadRules.retryDelay(server: true, consecutive: 8), 3_600_000)
        XCTAssertEqual(OfflineUploadRules.retryDelay(server: true, consecutive: 500), 3_600_000)
        XCTAssertEqual(OfflineUploadRules.retryDelay(server: false, consecutive: 0), 15_000)
        XCTAssertEqual(OfflineUploadRules.retryDelay(server: false, consecutive: 4), 120_000)
        XCTAssertEqual(OfflineUploadRules.retryDelay(server: false, consecutive: 99), 900_000)
    }

    func testMultipartBodyFileIsFieldsThenTheFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let source = directory.appendingPathComponent("source"), body = directory.appendingPathComponent("body")
        let content = Data((0..<3_000_000).map { UInt8(truncatingIfNeeded: $0 &* 7) })
        try content.write(to: source)
        try OfflineMultipart.write(to: body, source: source, fields: ["owner_id": "proj_1", "id": "media_9"], fileField: "file", fileName: "roof \u{e9}.jpg", contentType: "image/jpeg", boundary: "BOUNDARY")
        let written = try Data(contentsOf: body)
        let head = "--BOUNDARY\r\nContent-Disposition: form-data; name=\"id\"\r\n\r\nmedia_9\r\n"
            + "--BOUNDARY\r\nContent-Disposition: form-data; name=\"owner_id\"\r\n\r\nproj_1\r\n"
            + "--BOUNDARY\r\nContent-Disposition: form-data; name=\"file\"; filename=\"roof \u{e9}.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n"
        XCTAssertEqual(written, Data(head.utf8) + content + Data("\r\n--BOUNDARY--\r\n".utf8))
        XCTAssertNotNil(OfflineMultipart.boundary().range(of: "^----FirstMateUpload[0-9a-f]{32}\\z", options: .regularExpression))
        XCTAssertEqual(code { _ = try OfflineMultipart.head(fields: ["note": "has BOUNDARY inside"], fileField: "file", fileName: "a.jpg", contentType: "image/jpeg", boundary: "BOUNDARY") }, "invalid_request")
    }
}

final class OfflineUploadStoreTests: XCTestCase {
    private let policy = OriginPolicy("https://dev.1m8.ai")
    private var root: URL!
    private var now: Int64 = 1_700_000_000_000
    private var free = Int64.max
    private var store: OfflineUploadStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("offline-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        reopen()
    }
    override func tearDown() { try? FileManager.default.removeItem(at: root) }
    private func reopen() { store = OfflineUploadStore(root: root, clock: { [unowned self] in self.now }, freeSpace: { [unowned self] in self.free }) }

    private func bytes(_ count: Int, _ seed: Int) -> Data { Data((0..<count).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ seed) }) }
    private func payload(_ id: String, source: [String: Any]?) -> [String: Any] {
        var value: [String: Any] = ["id": id, "url": "https://dev.1m8.ai/v1/platform/organizations/org_1/media", "fileField": "file", "fileName": "roof.jpg",
            "contentType": "image/jpeg", "csrfCookie": "fm_platform_session_csrf", "fields": ["id": "media_" + id, "owner_type": "project"],
            "headers": ["Idempotency-Key": "fmo1-" + id, "X-FM-Offline-User": "user_1", "X-FM-Offline-Org": "org_1", "X-FM-Offline-Replay": "1"]]
        if let source { value["source"] = source }
        return value
    }
    @discardableResult private func enqueuePut(_ id: String, _ content: Data) throws -> [String: Any] {
        _ = try store.put(id: id, offset: 0, data: content, done: true)
        return try store.enqueue(OfflineUploadStore.Request(payload(id, source: ["put": id]), policy: policy))
    }
    private func status(_ id: String) -> [String: Any]? { store.status([id]).first }
    private func jobFile(_ id: String) -> URL { root.appendingPathComponent("jobs").appendingPathComponent(OfflineUploadRules.fileKey(id) + ".bin") }
    private func exists(_ url: URL?) -> Bool { url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false }

    func testAFileArrivesInChunksAndResumesWhereItStopped() throws {
        let first = bytes(OfflineUploadRules.chunkBytes, 1), second = bytes(1000, 2)
        var answer = try store.put(id: "p1", offset: 0, data: Data(), done: false)
        XCTAssertEqual(answer["size"] as? Int64, 0); XCTAssertEqual(answer["done"] as? Bool, false); XCTAssertEqual(answer["accepted"] as? Bool, true)
        XCTAssertEqual(try store.put(id: "p1", offset: 0, data: first, done: false)["size"] as? Int64, Int64(first.count))

        // A new process asks where to continue; a wrong offset writes nothing and says where.
        reopen()
        XCTAssertEqual(try store.put(id: "p1", offset: 0, data: Data(), done: false)["size"] as? Int64, Int64(first.count))
        answer = try store.put(id: "p1", offset: 5, data: second, done: false)
        XCTAssertEqual(answer["accepted"] as? Bool, false); XCTAssertEqual(answer["size"] as? Int64, Int64(first.count))
        XCTAssertNil(store.putFile("p1"))

        answer = try store.put(id: "p1", offset: first.count, data: second, done: true)
        XCTAssertEqual(answer["accepted"] as? Bool, true); XCTAssertEqual(answer["done"] as? Bool, true); XCTAssertEqual(answer["size"] as? Int64, Int64(first.count + 1000))
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(store.putFile("p1"))), first + second)

        // Complete: more data is refused, repeating `done` is harmless, offset 0 starts the file again.
        XCTAssertEqual(try store.put(id: "p1", offset: first.count + 1000, data: second, done: false)["accepted"] as? Bool, false)
        XCTAssertEqual(try store.put(id: "p1", offset: first.count + 1000, data: Data(), done: true)["accepted"] as? Bool, true)
        answer = try store.put(id: "p1", offset: 0, data: second, done: false)
        XCTAssertEqual(answer["accepted"] as? Bool, true); XCTAssertEqual(answer["done"] as? Bool, false); XCTAssertEqual(answer["size"] as? Int64, 1000)
        XCTAssertNil(store.putFile("p1"))

        XCTAssertEqual(code { _ = try self.store.put(id: "p2", offset: 0, data: Data(count: OfflineUploadRules.chunkBytes + 1), done: false) }, "chunk_too_large")
        XCTAssertEqual(code { _ = try self.store.put(id: "../p2", offset: 0, data: Data([1]), done: false) }, "invalid_request")
        XCTAssertEqual(code { _ = try self.store.put(id: "p2", offset: -1, data: Data([1]), done: false) }, "invalid_request")
        XCTAssertEqual(code { _ = try self.store.put(id: "p2", offset: 0, data: Data(), done: true) }, "empty_file")
        free = OfflineUploadRules.freeSpaceReserve
        XCTAssertEqual(code { _ = try self.store.put(id: "p2", offset: 0, data: Data([1]), done: false) }, "storage_full")
    }

    func testEnqueueTakesTheFileAndTheSameIdAgainChangesNothing() throws {
        let content = bytes(5000, 3)
        let created = try enqueuePut("j1", content)
        XCTAssertEqual(created["created"] as? Bool, true); XCTAssertEqual(created["state"] as? String, "queued")
        XCTAssertNil(store.putFile("j1"), "the handed-over file moved into the job")
        let job = try XCTUnwrap(store.queued().first)
        XCTAssertEqual(try Data(contentsOf: store.file(job)), content)
        XCTAssertEqual(job.fileName, "roof.jpg"); XCTAssertEqual(job.contentType, "image/jpeg"); XCTAssertEqual(job.fields["id"], "media_j1")
        XCTAssertEqual(job.headers["Idempotency-Key"], "fmo1-j1"); XCTAssertEqual(job.size, 5000)

        _ = try store.put(id: "other", offset: 0, data: bytes(10, 9), done: true)
        var changed = payload("j1", source: ["put": "other"]); changed["fileName"] = "changed.jpg"
        let again = try store.enqueue(OfflineUploadStore.Request(changed, policy: policy))
        XCTAssertEqual(again["created"] as? Bool, false); XCTAssertEqual(again["requeued"] as? Bool, false)
        XCTAssertNotNil(store.putFile("other"), "a no-op must not consume its source")

        // Everything is on disk: a new process sees the same job and file.
        reopen()
        let seen = try XCTUnwrap(status("j1"))
        XCTAssertEqual(seen["state"] as? String, "queued"); XCTAssertTrue(seen["status"] is NSNull); XCTAssertTrue(seen["body"] is NSNull); XCTAssertEqual(seen["attempts"] as? Int, 0)
        XCTAssertEqual(store.queued().first?.fileName, "roof.jpg")
        XCTAssertNoThrow(try JSONSerialization.data(withJSONObject: store.status(nil)), "the answer goes to the page as JSON")
    }

    func testEnqueueRefusesWhatItCannotSendSafely() throws {
        XCTAssertEqual(code { _ = try self.store.enqueue(OfflineUploadStore.Request(self.payload("j1", source: ["put": "missing"]), policy: self.policy)) }, "unknown_source")
        _ = try store.put(id: "half", offset: 0, data: bytes(10, 1), done: false)
        XCTAssertEqual(code { _ = try self.store.enqueue(OfflineUploadStore.Request(self.payload("j1", source: ["put": "half"]), policy: self.policy)) }, "put_incomplete")
        XCTAssertEqual(code { _ = try self.store.enqueue(OfflineUploadStore.Request(self.payload("j1", source: ["cameraToken": "t"]), policy: self.policy)) }, "unknown_source", "iOS has no native camera")
        XCTAssertEqual(code { _ = try self.store.enqueue(OfflineUploadStore.Request(self.payload("j1", source: nil), policy: self.policy)) }, "unknown_source")
        _ = try store.put(id: "whole", offset: 0, data: bytes(10, 1), done: true)
        var request = payload("j1", source: ["put": "whole"]); request["size"] = 11
        XCTAssertEqual(code { _ = try self.store.enqueue(OfflineUploadStore.Request(request, policy: self.policy)) }, "size_mismatch")
        request = payload("j1", source: ["put": "whole"]); request["url"] = "https://evil.test/v1/x"
        XCTAssertEqual(code { _ = try OfflineUploadStore.Request(request, policy: self.policy) }, "untrusted_url")
        request = payload("j1", source: ["put": "whole"]); request["headers"] = ["Idempotency-Key": "k", "Cookie": "a=b"]
        XCTAssertEqual(code { _ = try OfflineUploadStore.Request(request, policy: self.policy) }, "header_not_allowed")
        request = payload("j1", source: ["file": "/private/x"])
        XCTAssertEqual(code { _ = try OfflineUploadStore.Request(request, policy: self.policy) }, "invalid_request")
        XCTAssertNotNil(store.putFile("whole"), "a refused enqueue leaves the file for a corrected one")
        XCTAssertFalse(store.exists("j1"))
    }

    func testAnswersAreKeptUntilAcknowledgedAndCancelRemovesEverything() throws {
        try enqueuePut("j1", bytes(100, 1)); try enqueuePut("j2", bytes(100, 2))
        XCTAssertTrue(store.begin("j1", session: "s"))
        XCTAssertEqual(status("j1")?["state"] as? String, "uploading"); XCTAssertEqual(status("j1")?["attempts"] as? Int, 1)
        XCTAssertEqual(store.queued().map { $0.id }, ["j2"])
        now += 5000
        store.finish("j1", status: 201, body: Data("{\"ok\":true}".utf8), truncated: false)
        XCTAssertFalse(exists(jobFile("j1")), "the file is removed once the server has it")

        reopen()
        let done = try XCTUnwrap(status("j1"))
        XCTAssertEqual(done["state"] as? String, "done"); XCTAssertEqual(done["status"] as? Int, 201); XCTAssertEqual(done["body"] as? String, "{\"ok\":true}")
        XCTAssertEqual(done["updatedAt"] as? Int64, now); XCTAssertEqual(store.status(nil).count, 2)
        XCTAssertEqual(try store.ack(["j1", "j2", "nope"]), ["j1"])
        XCTAssertNil(status("j1")); XCTAssertEqual(status("j2")?["state"] as? String, "queued")

        XCTAssertTrue(try store.cancel("j2"))
        XCTAssertFalse(exists(jobFile("j2"))); XCTAssertFalse(store.exists("j2"))
        _ = try store.put(id: "p9", offset: 0, data: bytes(10, 1), done: false)
        XCTAssertTrue(try store.cancel("p9")); XCTAssertFalse(try store.cancel("p9"))
    }

    func testStatusLeavesOutBodiesBeyondOneMegabyte() throws {
        let large = Data(repeating: 120, count: OfflineUploadRules.maxBodyBytes)
        for i in 0..<5 { try enqueuePut("j\(i)", bytes(10, i)); _ = store.begin("j\(i)", session: "s"); store.finish("j\(i)", status: 200, body: large, truncated: i == 0) }
        let all = store.status(nil)
        XCTAssertEqual(all.filter { $0["body"] is String }.count, 4)
        XCTAssertEqual(all.filter { $0["bodyOmitted"] as? Bool == true }.count, 1)
        XCTAssertEqual(all.first?["bodyTruncated"] as? Bool, true)
        XCTAssertTrue(store.status(["j4"]).first?["body"] is String, "asking for the one left out returns it")
    }

    func testServerFailuresBackOffAndFailAfterEightNetworkFailuresNever() throws {
        try enqueuePut("j1", bytes(100, 1))
        for failure in 1..<OfflineUploadRules.maxServerFailures {
            XCTAssertTrue(store.begin("j1", session: "s"))
            XCTAssertTrue(store.retry("j1", status: 503, body: Data("busy".utf8), truncated: false, server: true, connected: true))
            let job = try XCTUnwrap(store.queued().first)
            XCTAssertEqual(job.nextAttemptAt - now, OfflineUploadRules.retryDelay(server: true, consecutive: failure))
            now = job.nextAttemptAt
        }
        XCTAssertTrue(store.begin("j1", session: "s"))
        XCTAssertFalse(store.retry("j1", status: 502, body: nil, truncated: false, server: true, connected: true))
        XCTAssertEqual(status("j1")?["state"] as? String, "failed"); XCTAssertEqual(status("j1")?["status"] as? Int, 502)
        XCTAssertEqual(status("j1")?["error"] as? String, "retries_exhausted"); XCTAssertEqual(status("j1")?["attempts"] as? Int, 8)
        XCTAssertTrue(exists(jobFile("j1")), "a failed job keeps its file")

        try enqueuePut("j2", bytes(100, 2))
        for i in 0..<40 {
            XCTAssertTrue(store.begin("j2", session: "s"))
            XCTAssertTrue(store.retry("j2", status: 0, body: nil, truncated: false, server: false, connected: i % 2 == 0))
            XCTAssertEqual(status("j2")?["state"] as? String, "queued")
        }
        XCTAssertTrue(status("j2")?["status"] is NSNull)

        // A failed job is queued again by enqueue with the new request, and keeps its file.
        var request = payload("j1", source: nil); request["fileName"] = "fixed.jpg"
        let again = try store.enqueue(OfflineUploadStore.Request(request, policy: policy))
        XCTAssertEqual(again["requeued"] as? Bool, true); XCTAssertEqual(again["state"] as? String, "queued")
        XCTAssertEqual(store.job("j1")?.fileName, "fixed.jpg"); XCTAssertTrue(status("j1")?["status"] is NSNull); XCTAssertEqual(store.job("j1")?.size, 100)
    }

    func testUploadsWaitForASignInUntilTheSessionChanges() throws {
        try enqueuePut("j1", bytes(10, 1)); try enqueuePut("j2", bytes(10, 2)); try enqueuePut("j3", bytes(10, 3))
        XCTAssertTrue(store.begin("j1", session: "old")); XCTAssertTrue(store.begin("j2", session: "old"))
        store.park("j1", status: 401, body: Data("{\"ok\":false,\"error\":\"authentication_required\"}".utf8), truncated: false, refused: "old")
        store.parkWaiting(refused: "old", includingSent: true)
        for id in ["j1", "j2", "j3"] { XCTAssertEqual(status(id)?["state"] as? String, "needs_sign_in") }
        XCTAssertEqual(status("j1")?["status"] as? Int, 401); XCTAssertTrue(store.queued().isEmpty)

        reopen()
        XCTAssertEqual(store.resume { _ in "old" }, 0, "the same refused session changes nothing")
        XCTAssertEqual(store.resume { _ in nil }, 0)
        XCTAssertEqual(store.resume { _ in "new" }, 3)
        XCTAssertEqual(store.queued().map { $0.id }, ["j1", "j2", "j3"])
        XCTAssertTrue(exists(jobFile("j1")))
    }

    func testTransfersTheSystemLostWaitAgainAndPruneKeepsWhatMatters() throws {
        try enqueuePut("lost", bytes(10, 1)); try enqueuePut("live", bytes(10, 2)); try enqueuePut("done", bytes(10, 3)); try enqueuePut("failed", bytes(10, 4))
        for id in ["lost", "live", "done", "failed"] { XCTAssertTrue(store.begin(id, session: "s")) }
        store.finish("done", status: 200, body: Data("{}".utf8), truncated: false)
        store.fail("failed", status: 400, body: nil, truncated: false, error: "")
        store.requeueUploading(except: ["live"])
        XCTAssertEqual(status("lost")?["state"] as? String, "queued"); XCTAssertEqual(status("live")?["state"] as? String, "uploading")
        store.interrupted("live")
        XCTAssertEqual(status("live")?["state"] as? String, "queued")

        _ = try store.put(id: "abandoned", offset: 0, data: bytes(10, 5), done: false)
        now = Int64(Date().timeIntervalSince1970 * 1000) + OfflineUploadRules.resultTTL + 60_000
        store.prune()
        XCTAssertFalse(store.exists("done"), "an answer nobody read for 30 days")
        XCTAssertEqual(try store.put(id: "abandoned", offset: 0, data: Data(), done: false)["size"] as? Int64, 0, "a handed-over file nobody queued")
        XCTAssertTrue(store.exists("failed")); XCTAssertTrue(exists(jobFile("failed")), "a failed upload is the person's photo: it stays")
        XCTAssertTrue(exists(jobFile("lost"))); XCTAssertTrue(exists(jobFile("live")))
    }

    func testAnUnreadableIndexIsSetAsideAndFilesAreTakenUpAgain() throws {
        try enqueuePut("j1", bytes(25, 1))
        try Data("{not json".utf8).write(to: root.appendingPathComponent("jobs.json"))
        reopen()
        XCTAssertFalse(store.exists("j1"))
        let created = try store.enqueue(OfflineUploadStore.Request(payload("j1", source: nil), policy: policy))
        XCTAssertEqual(created["created"] as? Bool, true); XCTAssertEqual(store.job("j1")?.size, 25)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).filter { $0.hasPrefix("jobs.unreadable-") }.count, 1)
    }
}
