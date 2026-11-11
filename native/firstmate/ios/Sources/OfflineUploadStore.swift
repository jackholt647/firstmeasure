import Foundation

/// The durable record of background uploads: files the page handed over, the jobs that
/// send them and the server's answers until the page has read them. Everything is under
/// one directory in Application Support (excluded from backup, never the caches) and every
/// change is written before the bridge answers. The same behaviour as
/// `OfflineUploadStore.java`; keep the two in step. No UIKit or WebKit, so unit tests cover it.
final class OfflineUploadStore {
    enum State: String, Codable { case queued, uploading, done, failed, needsSignIn = "needs_sign_in" }

    struct Job: Codable, Equatable {
        var id: String
        var url: String
        var fileField = "file"
        var fileName = "upload"
        var contentType = "application/octet-stream"
        var csrfCookie = ""
        var fields: [String: String] = [:]
        var headers: [String: String] = [:]
        var state = State.queued
        var error = ""
        /// A hash of the session the server would not take.
        var refused = ""
        /// A hash of the session the current attempt was sent with.
        var session = ""
        var status = 0
        var attempts = 0
        var serverFailures = 0
        var networkFailures = 0
        var size: Int64 = 0
        /// Milliseconds since 1970, as the bridge reports them.
        var createdAt: Int64 = 0
        var updatedAt: Int64 = 0
        var nextAttemptAt: Int64 = 0
        var hasBody = false
        var bodyTruncated = false

        var key: String { OfflineUploadRules.fileKey(id) }

        init(id: String, url: String) { self.id = id; self.url = url }
        /// Missing keys take their defaults, so a record written by an older build still loads.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            url = try c.decode(String.self, forKey: .url)
            fileField = try c.decodeIfPresent(String.self, forKey: .fileField) ?? "file"
            fileName = try c.decodeIfPresent(String.self, forKey: .fileName) ?? "upload"
            contentType = try c.decodeIfPresent(String.self, forKey: .contentType) ?? "application/octet-stream"
            csrfCookie = try c.decodeIfPresent(String.self, forKey: .csrfCookie) ?? ""
            fields = try c.decodeIfPresent([String: String].self, forKey: .fields) ?? [:]
            headers = try c.decodeIfPresent([String: String].self, forKey: .headers) ?? [:]
            state = try c.decodeIfPresent(State.self, forKey: .state) ?? .queued
            error = try c.decodeIfPresent(String.self, forKey: .error) ?? ""
            refused = try c.decodeIfPresent(String.self, forKey: .refused) ?? ""
            session = try c.decodeIfPresent(String.self, forKey: .session) ?? ""
            status = try c.decodeIfPresent(Int.self, forKey: .status) ?? 0
            attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
            serverFailures = try c.decodeIfPresent(Int.self, forKey: .serverFailures) ?? 0
            networkFailures = try c.decodeIfPresent(Int.self, forKey: .networkFailures) ?? 0
            size = try c.decodeIfPresent(Int64.self, forKey: .size) ?? 0
            createdAt = try c.decodeIfPresent(Int64.self, forKey: .createdAt) ?? 0
            updatedAt = try c.decodeIfPresent(Int64.self, forKey: .updatedAt) ?? 0
            nextAttemptAt = try c.decodeIfPresent(Int64.self, forKey: .nextAttemptAt) ?? 0
            hasBody = try c.decodeIfPresent(Bool.self, forKey: .hasBody) ?? false
            bodyTruncated = try c.decodeIfPresent(Bool.self, forKey: .bodyTruncated) ?? false
        }
    }

    /// One offlineUploads.enqueue call, validated. A nil file name or content type keeps what the job has.
    struct Request {
        var id: String
        var url: URL
        var fileField: String
        var fileName: String?
        var contentType: String?
        var csrfCookie: String
        var fields: [String: String]
        var headers: [String: String]
        var saveToPhotos: Bool
        var sourcePut: String?
        /// iOS has no native camera, so a camera token never names a file here; it is kept to answer `unknown_source`.
        var sourceCamera: String?
        var size: Int64?

        init(_ payload: [String: Any], policy: OriginPolicy) throws {
            id = try OfflineUploadRules.id(payload["id"])
            url = try OfflineUploadRules.uploadURL(payload["url"], policy: policy)
            fileField = try OfflineUploadRules.fileField(payload["fileField"])
            fileName = payload["fileName"] is String ? OfflineUploadRules.fileName(payload["fileName"], fallback: "upload") : nil
            contentType = payload["contentType"] is String ? OfflineUploadRules.contentType(payload["contentType"], fallback: "application/octet-stream") : nil
            fields = try OfflineUploadRules.fields(payload["fields"])
            headers = try OfflineUploadRules.headers(payload["headers"])
            csrfCookie = try OfflineUploadRules.csrfCookie(payload["csrfCookie"])
            saveToPhotos = (payload["saveToPhotos"] as? Bool) == true
            if let source = payload["source"], !(source is NSNull) {
                guard let object = source as? [String: Any] else { throw OfflineUploadRejected("invalid_request") }
                if let put = object["put"] as? String { sourcePut = try OfflineUploadRules.id(put) }
                else if let camera = object["cameraToken"] as? String, camera.count <= 64 { sourceCamera = camera }
                else { throw OfflineUploadRejected("invalid_request") }
            }
            size = (payload["size"] as? NSNumber)?.int64Value
        }
    }

    let root: URL
    private let puts: URL, files: URL, index: URL
    private let clock: () -> Int64
    private let space: () -> Int64
    private let lock = NSRecursiveLock()
    private var jobs: [Job] = []
    private var loaded = false

    init(root: URL, clock: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }, freeSpace: (() -> Int64)? = nil) {
        self.root = root
        puts = root.appendingPathComponent("puts", isDirectory: true)
        files = root.appendingPathComponent("jobs", isDirectory: true)
        index = root.appendingPathComponent("jobs.json")
        self.clock = clock
        space = freeSpace ?? { () -> Int64 in
            let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            return values?.volumeAvailableCapacityForImportantUsage ?? Int64.max
        }
    }

    func now() -> Int64 { clock() }
    func freeSpace() -> Int64 { space() }

    // MARK: Files handed over by the page

    /// One step of a chunked transfer. Empty data without `done` only asks what is stored.
    /// Data at offset 0 starts the file again; any other offset must equal the stored size,
    /// otherwise nothing is written and the answer says where to continue.
    func put(id rawId: Any?, offset rawOffset: Any?, data: Data, done: Bool) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let id = try OfflineUploadRules.id(rawId)
        guard data.count <= OfflineUploadRules.chunkBytes else { throw OfflineUploadRejected("chunk_too_large") }
        guard let offset = (rawOffset as? NSNumber)?.int64Value, offset >= 0 else { throw OfflineUploadRejected("invalid_request") }
        let key = OfflineUploadRules.fileKey(id)
        let part = puts.appendingPathComponent(key + ".part"), whole = puts.appendingPathComponent(key + ".bin")
        var complete = exists(whole)
        var size = complete ? length(whole) : length(part)
        func answer(_ accepted: Bool) -> [String: Any] { ["size": size, "done": complete, "accepted": accepted] }
        if data.isEmpty && !done { return answer(true) }
        if !data.isEmpty {
            let restart = offset == 0
            if !restart && (complete || offset != size) { return answer(false) }
            if (restart ? 0 : size) + Int64(data.count) > OfflineUploadRules.maxFileBytes {
                remove(part); remove(whole)
                throw OfflineUploadRejected("file_too_large")
            }
            if space() < Int64(data.count) + OfflineUploadRules.freeSpaceReserve { throw OfflineUploadRejected("storage_full") }
            try FileManager.default.createDirectory(at: puts, withIntermediateDirectories: true)
            if restart {
                remove(whole); complete = false
                try data.write(to: part, options: .atomic)
            } else {
                let handle = try FileHandle(forWritingTo: part)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
                try handle.synchronize()
            }
            size = length(part)
        } else if complete || offset != size {
            return answer(complete && offset == size)
        }
        if done {
            if size == 0 { throw OfflineUploadRejected("empty_file") }
            try move(part, whole)
            complete = true
        }
        return answer(true)
    }

    /// A complete handed-over file, or nil.
    func putFile(_ id: String) -> URL? {
        let whole = puts.appendingPathComponent(OfflineUploadRules.fileKey(id) + ".bin")
        return exists(whole) ? whole : nil
    }

    // MARK: Bridge: jobs

    func exists(_ id: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        load()
        return jobs.contains { $0.id == id }
    }
    func job(_ id: String) -> Job? {
        lock.lock(); defer { lock.unlock() }
        load()
        return jobs.first { $0.id == id }
    }

    /// The file an enqueue would send, without moving it (for a camera-roll copy made first).
    func source(_ request: Request) throws -> URL {
        let target = files.appendingPathComponent(OfflineUploadRules.fileKey(request.id) + ".bin")
        if exists(target) { return target }
        guard let put = request.sourcePut else { throw OfflineUploadRejected("unknown_source") }
        if let whole = putFile(put) { return whole }
        throw OfflineUploadRejected(exists(puts.appendingPathComponent(OfflineUploadRules.fileKey(put) + ".part")) ? "put_incomplete" : "unknown_source")
    }

    /// Records a job and takes its file. The same id again changes nothing, unless the job
    /// failed or waits for a sign-in: then it is queued again with the new request.
    func enqueue(_ request: Request) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        load()
        let time = clock()
        if let at = jobs.firstIndex(where: { $0.id == request.id }) {
            var job = jobs[at]
            guard job.state == .failed || job.state == .needsSignIn else { return answer(job, created: false, requeued: false) }
            try adopt(&job, request)
            job.state = .queued; job.status = 0; job.error = ""; job.refused = ""; job.serverFailures = 0; job.networkFailures = 0
            job.nextAttemptAt = time; job.updatedAt = time
            dropBody(&job)
            jobs[at] = job
            try save()
            return answer(job, created: false, requeued: true)
        }
        guard jobs.count < OfflineUploadRules.maxJobs else { throw OfflineUploadRejected("queue_full") }
        var job = Job(id: request.id, url: request.url.absoluteString)
        job.createdAt = time; job.updatedAt = time; job.nextAttemptAt = time
        try adopt(&job, request)
        jobs.append(job)
        try save()
        return answer(job, created: true, requeued: false)
    }
    private func adopt(_ job: inout Job, _ request: Request) throws {
        let target = file(job)
        // A file already under the job's name is this job's own, or the one an interrupted enqueue moved.
        if !exists(target) {
            let from = try source(request)
            let size = length(from)
            if size == 0 { throw OfflineUploadRejected("empty_file") }
            if size > OfflineUploadRules.maxFileBytes { throw OfflineUploadRejected("file_too_large") }
            if let expected = request.size, expected != size { throw OfflineUploadRejected("size_mismatch") }
            try FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
            try move(from, target)
        } else if let expected = request.size, expected != length(target) {
            throw OfflineUploadRejected("size_mismatch")
        }
        job.url = request.url.absoluteString; job.fileField = request.fileField; job.csrfCookie = request.csrfCookie
        if let name = request.fileName { job.fileName = name }
        if let type = request.contentType { job.contentType = type }
        job.fields = request.fields; job.headers = request.headers
        job.size = length(target)
    }
    private func answer(_ job: Job, created: Bool, requeued: Bool) -> [String: Any] {
        ["id": job.id, "state": job.state.rawValue, "created": created, "requeued": requeued]
    }

    /// Jobs in the order they were queued; the named ones, or all. Answers stay until acknowledged.
    func status(_ ids: [String]?) -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        load()
        var selected: [Job] = []
        if let ids {
            for id in ids { if let job = jobs.first(where: { $0.id == id }), !selected.contains(where: { $0.id == id }) { selected.append(job) } }
        } else { selected = jobs }
        var budget = Int64(OfflineUploadRules.statusBodyBudget)
        return selected.map { job -> [String: Any] in
            let status: Any = job.status == 0 ? NSNull() : job.status
            let error: Any = job.error.isEmpty ? NSNull() : job.error
            var item: [String: Any] = [
                "id": job.id, "state": job.state.rawValue, "status": status, "attempts": job.attempts,
                "size": job.size, "createdAt": job.createdAt, "updatedAt": job.updatedAt, "error": error,
                "bodyTruncated": job.bodyTruncated, "body": NSNull()
            ]
            let stored = response(job)
            if job.hasBody, exists(stored) {
                let size = length(stored)
                if size <= budget, let data = try? Data(contentsOf: stored) { item["body"] = String(decoding: data, as: UTF8.self); budget -= size }
                else { item["bodyOmitted"] = true }
            }
            return item
        }
    }

    /// Forgets finished jobs whose answer the page has recorded.
    func ack(_ ids: [String]) throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        load()
        var acked: [String] = []
        for id in ids {
            guard let job = jobs.first(where: { $0.id == id }), job.state == .done else { continue }
            discard(job)
            acked.append(id)
        }
        if !acked.isEmpty { try save() }
        return acked
    }

    /// Removes a job and its file, and a handed-over file of the same id that was never queued.
    func cancel(_ rawId: Any?) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let id = try OfflineUploadRules.id(rawId)
        load()
        let key = OfflineUploadRules.fileKey(id)
        let part = puts.appendingPathComponent(key + ".part"), whole = puts.appendingPathComponent(key + ".bin")
        var removed = exists(part) || exists(whole)
        remove(part); remove(whole)
        if let job = jobs.first(where: { $0.id == id }) { discard(job); try save(); removed = true }
        return removed
    }
    private func discard(_ job: Job) {
        remove(file(job)); remove(response(job))
        jobs.removeAll { $0.id == job.id }
    }

    // MARK: Uploader

    func file(_ job: Job) -> URL { files.appendingPathComponent(job.key + ".bin") }
    private func response(_ job: Job) -> URL { files.appendingPathComponent(job.key + ".response") }

    /// Jobs waiting to be handed to the system, oldest first.
    func queued() -> [Job] {
        lock.lock(); defer { lock.unlock() }
        load()
        return jobs.filter { $0.state == .queued }
    }
    /// Jobs marked as sent whose transfer the system no longer has (the app was force-quit): they wait again.
    func requeueUploading(except live: Set<String>) {
        change { jobs in
            var changed = false
            for at in jobs.indices where jobs[at].state == .uploading && !live.contains(jobs[at].id) {
                jobs[at].state = .queued; jobs[at].nextAttemptAt = min(jobs[at].nextAttemptAt, self.clock()); changed = true
            }
            return changed
        }
    }
    /// The job is handed to the system; `session` is a hash of the session it is sent with.
    func begin(_ id: String, session: String) -> Bool {
        var began = false
        change { jobs in
            guard let at = jobs.firstIndex(where: { $0.id == id }), jobs[at].state == .queued else { return false }
            jobs[at].state = .uploading; jobs[at].attempts += 1; jobs[at].session = session; jobs[at].updatedAt = self.clock()
            began = true
            return true
        }
        return began
    }
    func finish(_ id: String, status: Int, body: Data?, truncated: Bool) {
        update(id) { job in
            self.answered(&job, .done, status, body, truncated, "")
            job.serverFailures = 0; job.networkFailures = 0
            self.remove(self.file(job))
        }
    }
    /// Keeps the file: the page cancels the job or queues it again.
    func fail(_ id: String, status: Int, body: Data?, truncated: Bool, error: String) {
        update(id) { job in self.answered(&job, .failed, status, body, truncated, error) }
    }
    /// Waits for a sign-in; `refused` identifies the session the server would not take.
    func park(_ id: String, status: Int, body: Data?, truncated: Bool, refused: String) {
        update(id) { job in
            self.answered(&job, .needsSignIn, status, body, truncated, "")
            job.refused = refused
        }
    }
    /// The session is not accepted (or there is none): nothing else is sent with it.
    /// `includingSent` also covers jobs already handed to the system, whose transfers the caller cancels.
    func parkWaiting(refused: String, includingSent: Bool) {
        change { jobs in
            var changed = false
            for at in jobs.indices where jobs[at].state == .queued || (includingSent && jobs[at].state == .uploading) {
                jobs[at].state = .needsSignIn; jobs[at].refused = refused; jobs[at].updatedAt = self.clock(); changed = true
            }
            return changed
        }
    }
    /// Queued again after a wait. A server answer counts towards the limit of eight in a row,
    /// after which the job is failed; a network failure never does. Answers false when it failed.
    @discardableResult
    func retry(_ id: String, status: Int, body: Data?, truncated: Bool, server: Bool, connected: Bool, note: String = "") -> Bool {
        var waiting = false
        update(id) { job in
            let time = self.clock()
            if server {
                job.serverFailures += 1; job.networkFailures = 0
                if job.serverFailures >= OfflineUploadRules.maxServerFailures {
                    self.answered(&job, .failed, status, body, truncated, "retries_exhausted")
                    return
                }
                self.answered(&job, .queued, status, body, truncated, note)
                job.nextAttemptAt = time + OfflineUploadRules.retryDelay(server: true, consecutive: job.serverFailures)
            } else {
                job.networkFailures = connected ? job.networkFailures + 1 : 1
                job.state = .queued; job.updatedAt = time
                job.nextAttemptAt = time + OfflineUploadRules.retryDelay(server: false, consecutive: job.networkFailures)
            }
            waiting = true
        }
        return waiting
    }
    /// The system cancelled the transfer; that is not a failed attempt.
    func interrupted(_ id: String) {
        update(id) { job in
            guard job.state == .uploading else { return }
            job.state = .queued; job.updatedAt = self.clock(); job.nextAttemptAt = job.updatedAt
        }
    }
    /// Jobs waiting for a sign-in are queued again when the session is no longer the one
    /// the server refused. `session` answers a hash of the job's current session, or nil.
    @discardableResult
    func resume(_ session: (Job) -> String?) -> Int {
        var resumed = 0
        change { jobs in
            let time = self.clock()
            for at in jobs.indices where jobs[at].state == .needsSignIn {
                guard let current = session(jobs[at]), !current.isEmpty, current != jobs[at].refused else { continue }
                jobs[at].state = .queued; jobs[at].refused = ""; jobs[at].serverFailures = 0; jobs[at].networkFailures = 0
                jobs[at].nextAttemptAt = time; jobs[at].updatedAt = time
                resumed += 1
            }
            return resumed > 0
        }
        return resumed
    }

    /// Removes answers nobody read for 30 days, handed-over files never queued for 7, and files without a job.
    func prune() {
        lock.lock(); defer { lock.unlock() }
        load()
        let time = clock()
        let expired = jobs.filter { $0.state == .done && time - $0.updatedAt > OfflineUploadRules.resultTTL }
        if !expired.isEmpty { expired.forEach(discard); try? save() }
        for file in contents(puts) where time - modified(file) > OfflineUploadRules.putTTL { remove(file) }
        let keys = Set(jobs.map { $0.key })
        for file in contents(files) {
            let key = file.lastPathComponent.split(separator: ".").first.map { String($0) } ?? file.lastPathComponent
            if !keys.contains(key) && time - modified(file) > OfflineUploadRules.resultTTL { remove(file) }
        }
    }

    // MARK: Storage

    private func change(_ body: (inout [Job]) -> Bool) {
        lock.lock(); defer { lock.unlock() }
        load()
        if body(&jobs) { try? save() }
    }
    private func update(_ id: String, _ body: (inout Job) -> Void) {
        change { jobs in
            guard let at = jobs.firstIndex(where: { $0.id == id }) else { return false }
            body(&jobs[at])
            return true
        }
    }
    private func answered(_ job: inout Job, _ state: State, _ status: Int, _ body: Data?, _ truncated: Bool, _ error: String) {
        job.state = state; job.status = status; job.error = error; job.updatedAt = clock()
        dropBody(&job)
        guard let body, !body.isEmpty else { return }
        try? FileManager.default.createDirectory(at: files, withIntermediateDirectories: true)
        if (try? body.prefix(OfflineUploadRules.maxBodyBytes).write(to: response(job), options: .atomic)) != nil {
            job.hasBody = true
            job.bodyTruncated = truncated || body.count > OfflineUploadRules.maxBodyBytes
        }
    }
    private func dropBody(_ job: inout Job) { remove(response(job)); job.hasBody = false; job.bodyTruncated = false }

    private func load() {
        guard !loaded else { return }
        loaded = true
        jobs = []
        guard let data = try? Data(contentsOf: index) else { return }
        if let stored = try? JSONDecoder().decode(Stored.self, from: data) { jobs = stored.jobs; return }
        // Unreadable index: keep it for diagnosis. Job files stay and are taken up again when the page queues the same ids.
        try? FileManager.default.moveItem(at: index, to: root.appendingPathComponent("jobs.unreadable-\(clock()).json"))
    }
    private struct Stored: Codable { var version = 1; var jobs: [Job] }
    private func save() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try JSONEncoder().encode(Stored(jobs: jobs)).write(to: index, options: .atomic)
    }

    private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }
    private func length(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
    }
    private func modified(_ url: URL) -> Int64 {
        let date = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        return Int64((date ?? Date()).timeIntervalSince1970 * 1000)
    }
    private func contents(_ directory: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    }
    private func remove(_ url: URL) { try? FileManager.default.removeItem(at: url) }
    private func move(_ from: URL, _ to: URL) throws {
        remove(to)
        try FileManager.default.moveItem(at: from, to: to)
    }
}
