import Foundation
import WebKit

/// Background uploads for the whole app: the store, and a background URLSession that sends
/// what is queued, also after the app is closed (native/firstmate/README.md, "Offline").
///
/// A background session uploads from a file and cannot be handed a stream, so each job's
/// multipart body is written to a file first and removed when the transfer ends. The system
/// owns a transfer once it is handed over: it waits for a connection by itself and relaunches
/// the app in the background to deliver the answer.
final class OfflineUploader: NSObject, URLSessionDataDelegate {
    static let shared = OfflineUploader()

    let store: OfflineUploadStore
    private let policy: OriginPolicy
    private let bodies: URL
    /// Every change to uploads happens on this queue; the session's delegate calls arrive on it too.
    private let work = DispatchQueue(label: "ai.firstmeasure.mobile.offline-uploads")
    private var session: URLSession!
    private var answers: [Int: Data] = [:]
    private var truncated = Set<Int>()
    private var backgroundCompletion: (() -> Void)?
    /// Bodies are copies of the files: only a few transfers are handed over at a time.
    private static let maxLiveTasks = 6
    private static let maxLiveBytes: Int64 = 200 * 1024 * 1024

    private override init() {
        policy = OriginPolicy(Bundle.main.object(forInfoDictionaryKey: "PortalOrigin") as? String ?? "https://dev.1m8.ai")
        var root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("OfflineUploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // Queued photos are not something to restore onto another phone; the server is where they belong.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? root.setResourceValues(values)
        store = OfflineUploadStore(root: root)
        bodies = root.appendingPathComponent("bodies", isDirectory: true)
        super.init()
        let configuration = URLSessionConfiguration.background(withIdentifier: (Bundle.main.bundleIdentifier ?? "ai.firstmeasure.mobile") + ".offline-uploads")
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        // The session never keeps or sends cookies by itself: each request carries the web view's cookies for the portal origin.
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = 7 * 86_400
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.underlyingQueue = work
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    }

    // MARK: Lifecycle

    /// App start: remove what expired, take back transfers the system no longer has, continue what was waiting.
    func start() {
        work.async { self.store.prune() }
        // Answers of transfers that finished while the app was not running are delivered first; a few
        // seconds later whatever is still marked as sent without a transfer behind it is waiting again.
        work.asyncAfter(deadline: .now() + 3) {
            self.session.getAllTasks { tasks in
                // Every transfer the session still lists will report its end, so its job is left alone.
                let listed = Set(tasks.compactMap { $0.taskDescription })
                self.store.requeueUploading(except: listed)
                for task in tasks {
                    let known = task.taskDescription.map({ self.store.exists($0) }) ?? false
                    if !known { task.cancel() }
                }
                let kept = Set(listed.map { OfflineUploadRules.fileKey($0) + ".multipart" })
                let stored = (try? FileManager.default.contentsOfDirectory(at: self.bodies, includingPropertiesForKeys: nil)) ?? []
                for body in stored where !kept.contains(body.lastPathComponent) { try? FileManager.default.removeItem(at: body) }
                self.sessionChanged()
            }
        }
    }

    /// A page finished loading or the app came to the front: uploads refused for their session go
    /// again once the session is another one, and waiting uploads are handed to the system.
    func sessionChanged() {
        cookies { header in
            self.store.resume { job in
                guard let csrf = OfflineUploadRules.cookieValue(header: header(job.url), name: job.csrfCookie), !csrf.isEmpty else { return nil }
                return OfflineUploadRules.hash(csrf)
            }
            self.pump(header)
        }
    }

    /// The app was relaunched in the background because transfers finished.
    func handleEvents(completion: @escaping () -> Void) {
        work.async { self.backgroundCompletion = completion }
    }
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = backgroundCompletion
        backgroundCompletion = nil
        DispatchQueue.main.async { completion?() }
    }

    // MARK: Bridge

    /// One offline bridge call. `completion` is called on the main queue with the result or an error code.
    func perform(_ method: String, payload: [String: Any], completion: @escaping (Any?, String?) -> Void) {
        let finish: (Any?, String?) -> Void = { result, error in DispatchQueue.main.async { completion(result, error) } }
        work.async {
            do {
                switch method {
                case "offlineUploads.put":
                    guard let data = Data(base64Encoded: payload["data"] as? String ?? "") else { throw OfflineUploadRejected("invalid_request") }
                    finish(try self.store.put(id: payload["id"], offset: payload["offset"], data: data, done: payload["done"] as? Bool ?? false), nil)
                case "offlineUploads.enqueue":
                    let request = try OfflineUploadStore.Request(payload, policy: self.policy)
                    // The copy is made first, from the file as it is handed over, and only when this call creates the job.
                    guard request.saveToPhotos, !self.store.exists(request.id) else { finish(try self.enqueue(request, saved: false, photosError: nil), nil); return }
                    let source = try self.store.source(request)
                    PhotoLibrarySaver.save(file: source, fileName: request.fileName, contentType: request.contentType) { photosError in
                        self.work.async {
                            do { finish(try self.enqueue(request, saved: photosError == nil, photosError: photosError), nil) }
                            catch { finish(nil, Self.code(error)) }
                        }
                    }
                case "offlineUploads.status":
                    finish(self.store.status(try Self.ids(payload, required: false)), nil)
                case "offlineUploads.ack":
                    finish(["acked": try self.store.ack(try Self.ids(payload, required: true) ?? [])], nil)
                case "offlineUploads.cancel":
                    let cancelled = try self.store.cancel(payload["id"])
                    if let id = payload["id"] as? String {
                        self.session.getAllTasks { tasks in tasks.filter { $0.taskDescription == id }.forEach { $0.cancel() } }
                    }
                    finish(["cancelled": cancelled], nil)
                case "photoLibrarySave":
                    // iOS has no native camera, so only a handed-over file can be saved.
                    guard let put = payload["put"] as? String, let file = self.store.putFile(try OfflineUploadRules.id(put)) else { throw OfflineUploadRejected("unknown_source") }
                    PhotoLibrarySaver.save(file: file, fileName: payload["fileName"] as? String, contentType: payload["contentType"] as? String) { photosError in
                        if let photosError { finish(nil, photosError) } else { finish(["saved": true], nil) }
                    }
                default:
                    finish(nil, "unsupported")
                }
            } catch { finish(nil, Self.code(error)) }
        }
    }
    private func enqueue(_ request: OfflineUploadStore.Request, saved: Bool, photosError: String?) throws -> [String: Any] {
        var answer = try store.enqueue(request)
        answer["savedToPhotos"] = saved
        answer["photosError"] = photosError ?? NSNull()
        sessionChanged()
        return answer
    }
    private static func code(_ error: Error) -> String { (error as? OfflineUploadRejected)?.code ?? "storage_failed" }
    private static func ids(_ payload: [String: Any], required: Bool) throws -> [String]? {
        guard let raw = payload["ids"], !(raw is NSNull) else {
            if required { throw OfflineUploadRejected("invalid_request") }
            return nil
        }
        guard let list = raw as? [Any], list.count <= 500 else { throw OfflineUploadRejected("invalid_request") }
        return try list.map { try OfflineUploadRules.id($0) }
    }

    // MARK: Sending

    /// The Cookie header the web view would send to a URL. WebKit is asked on the main thread; the answer comes on the work queue.
    private func cookies(_ completion: @escaping (@escaping (String) -> String?) -> Void) {
        DispatchQueue.main.async {
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { all in
                self.work.async {
                    completion { url in URL(string: url).flatMap { OfflineUploadRules.cookieHeader(all, for: $0) } }
                }
            }
        }
    }

    /// Hands waiting jobs to the system, oldest first, until enough are in flight.
    private func pump(_ header: @escaping (String) -> String?) {
        session.getAllTasks { tasks in
            let live = tasks.filter { $0.state == .running || $0.state == .suspended }
            var liveIds = Set(live.compactMap { $0.taskDescription })
            var liveBytes = live.reduce(Int64(0)) { $0 + max(0, $1.countOfBytesExpectedToSend) }
            for job in self.store.queued() where !liveIds.contains(job.id) {
                if liveIds.count >= Self.maxLiveTasks || (!liveIds.isEmpty && liveBytes + job.size > Self.maxLiveBytes) { break }
                // Checked when queued; checked again here because this is where cookies leave the device.
                guard let url = URL(string: job.url), self.policy.trusted(url) else {
                    self.store.fail(job.id, status: 0, body: nil, truncated: false, error: "untrusted_url")
                    continue
                }
                let source = self.store.file(job)
                guard FileManager.default.fileExists(atPath: source.path) else {
                    self.store.fail(job.id, status: 0, body: nil, truncated: false, error: "file_missing")
                    continue
                }
                guard let cookie = header(job.url), let csrf = OfflineUploadRules.cookieValue(header: cookie, name: job.csrfCookie), !csrf.isEmpty else {
                    // Nobody is signed in: nothing is sent until someone is.
                    self.store.parkWaiting(refused: "", includingSent: false)
                    break
                }
                // No room for a second copy of the file right now: tried again at the next page load or finished transfer.
                guard self.store.freeSpace() > job.size + OfflineUploadRules.freeSpaceReserve else { break }
                let body = self.bodies.appendingPathComponent(job.key + ".multipart")
                let boundary = OfflineMultipart.boundary()
                do {
                    try FileManager.default.createDirectory(at: self.bodies, withIntermediateDirectories: true)
                    try OfflineMultipart.write(to: body, source: source, fields: job.fields, fileField: job.fileField, fileName: job.fileName, contentType: job.contentType, boundary: boundary)
                } catch {
                    try? FileManager.default.removeItem(at: body)
                    break
                }
                guard self.store.begin(job.id, session: OfflineUploadRules.hash(csrf)) else {
                    try? FileManager.default.removeItem(at: body)
                    continue
                }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.httpShouldHandleCookies = false
                let origin = self.policy.origin.absoluteString
                for (name, value) in OfflineUploadRules.requestHeaders(job.headers, cookies: cookie, csrf: csrf, origin: origin, contentType: "multipart/form-data; boundary=" + boundary) {
                    request.setValue(value, forHTTPHeaderField: name)
                }
                let task = self.session.uploadTask(with: request, fromFile: body)
                task.taskDescription = job.id
                let wait = Double(job.nextAttemptAt - self.store.now()) / 1000
                if wait > 1 { task.earliestBeginDate = Date().addingTimeInterval(wait) }
                task.resume()
                liveIds.insert(job.id)
                liveBytes += job.size
            }
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var kept = answers[dataTask.taskIdentifier] ?? Data()
        let room = OfflineUploadRules.maxBodyBytes - kept.count
        if data.count > room { truncated.insert(dataTask.taskIdentifier) }
        if room > 0 { kept.append(data.prefix(room)) }
        answers[dataTask.taskIdentifier] = kept
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = answers.removeValue(forKey: task.taskIdentifier)
        let cut = truncated.remove(task.taskIdentifier) != nil
        guard let id = task.taskDescription else { return }
        try? FileManager.default.removeItem(at: bodies.appendingPathComponent(OfflineUploadRules.fileKey(id) + ".multipart"))
        // Cancelled by the page: the job is gone and so is its file. A job that waits again (app start
        // took it back before this answer was delivered) still takes its answer.
        guard let job = store.job(id), job.state == .uploading || job.state == .queued else { return }
        defer { sessionChanged() }
        if let error = error as NSError? {
            // Cancelled by the system (the app was force-quit) is not a failed attempt; anything else is the network.
            if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { store.interrupted(id) }
            else { store.retry(id, status: 0, body: nil, truncated: false, server: false, connected: true) }
            return
        }
        guard let response = task.response as? HTTPURLResponse else {
            store.retry(id, status: 0, body: nil, truncated: false, server: false, connected: true)
            return
        }
        // A background session follows redirects by itself and cannot be told not to (URLSessionTaskDelegate:
        // "Tasks in background sessions automatically follow redirects"). An answer from anywhere but the URL
        // the upload was sent to is not the upload's answer.
        let sent = task.originalRequest?.url?.absoluteString
        if sent == nil || response.url?.absoluteString != sent || task.currentRequest?.url?.absoluteString != sent {
            store.retry(id, status: 0, body: nil, truncated: false, server: true, connected: true, note: "redirected")
            return
        }
        let text = body.map { String(decoding: $0, as: UTF8.self) } ?? ""
        switch OfflineUploadRules.classify(status: response.statusCode, body: text) {
        case .done: store.finish(id, status: response.statusCode, body: body, truncated: cut)
        case .failed: store.fail(id, status: response.statusCode, body: body, truncated: cut, error: "")
        case .retry: store.retry(id, status: response.statusCode, body: body, truncated: cut, server: true, connected: true)
        case .needsSignIn:
            store.park(id, status: response.statusCode, body: body, truncated: cut, refused: job.session)
            guard OfflineUploadRules.sessionRefused(status: response.statusCode, body: text) else { return }
            // The session is refused for everyone: stop what was already handed over with it.
            store.parkWaiting(refused: job.session, includingSent: true)
            session.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
        }
    }
}
