import UIKit
import WebKit
import AuthenticationServices
import CryptoKit

final class PortalController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, ASWebAuthenticationPresentationContextProviding {
    private let policy = OriginPolicy(Bundle.main.object(forInfoDictionaryKey: "PortalOrigin") as? String ?? "https://dev.1m8.ai")
    private var web: WKWebView!
    private var downloads: [ObjectIdentifier: (URL, String?, String)] = [:]
    private let progress = UIProgressView(progressViewStyle: .bar)
    private var observation: NSKeyValueObservation?
    private var downloadIDs: [String: String] = [:]
    private var authentication: ASWebAuthenticationSession?
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { view.window! }
    private func nonce() -> String { var bytes = [UInt8](repeating: 0, count: 32); precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess); return encoded(Data(bytes)) }
    private func encoded(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.userContentController.add(WeakMessageHandler(self), name: "firstmeasure")
        // The bridge is installed globally by WebKit, but every call validates its actual frame origin.
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.customUserAgent = nil
        web.translatesAutoresizingMaskIntoConstraints = false
        web.accessibilityIdentifier = "firstmeasure.portal"
        progress.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web); view.addSubview(progress)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            progress.topAnchor.constraint(equalTo: web.topAnchor), progress.leadingAnchor.constraint(equalTo: view.leadingAnchor), progress.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        observation = web.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            self?.progress.progress = Float(web.estimatedProgress); self?.progress.isHidden = web.estimatedProgress >= 1
        }
        let cache = phoneDirectory()
        if let files = try? FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: [.contentModificationDateKey]) {
            for file in files where ((try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSinceNow ?? 0) < -86400 { try? FileManager.default.removeItem(at: file) }
        }
        loadPortal()
    }
    private func loadPortal() { web.load(URLRequest(url: policy.origin.appendingPathComponent("portal/"))) }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if policy.trusted(url) {
            if action.shouldPerformDownload { decisionHandler(.download) }
            else if action.targetFrame == nil { web.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        } else {
            if action.targetFrame?.isMainFrame != false && policy.external(url) { UIApplication.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard policy.trusted(response.response.url) else { decisionHandler(.cancel); return }
        if !response.canShowMIMEType || (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true {
            decisionHandler(.download)
        } else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { connectionError(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { connectionError(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
    private func connectionError(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        let alert = UIAlertController(title: "FirstMeasure", message: "Unable to connect. Check your connection and try again.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Try again", style: .default) { [weak self] _ in self?.loadPortal() })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if presentedViewController == nil { present(alert, animated: true) }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(frame.isMainFrame && trusted(origin) ? .prompt : .deny)
    }
    private func trusted(_ origin: WKSecurityOrigin) -> Bool { origin.protocol == "https" && origin.host.lowercased() == policy.origin.host?.lowercased() && (origin.port == 0 || origin.port == 443) }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, trusted(message.frameInfo.securityOrigin), policy.trusted(web.url),
              let raw = message.body as? String, raw.utf8.count <= 23 * 1024 * 1024,
              let data = raw.data(using: .utf8), let call = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = call["id"] as? String, id.count <= 64 else { return }
        guard call["version"] as? Int == 1 else { reply(id, error: "unsupported_version"); return }
        let payload = call["payload"] as? [String: Any] ?? [:]
        guard raw.utf8.count <= 32768 || call["method"] as? String == "saveFile" else { reply(id, error: "request_too_large"); return }
        switch call["method"] as? String {
        case "authenticate":
            let verifier = nonce(), state = nonce(), challenge = encoded(Data(SHA256.hash(data: Data(verifier.utf8))))
            let scheme = Bundle.main.bundleIdentifier!
            let url = URL(string: policy.origin.absoluteString + "/v1/mobile/auth/browser?challenge=\(challenge)&state=\(state)")!
            authentication = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
                DispatchQueue.main.async {
                    guard let self else { return }; self.authentication = nil
                    guard error == nil, let callback, let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
                          callback.scheme == scheme, callback.host == "auth", items.first(where: { $0.name == "state" })?.value == state,
                          let code = items.first(where: { $0.name == "code" })?.value, code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return }
                    var request = URLRequest(url: self.policy.origin.appendingPathComponent("v1/mobile/auth/exchange")); request.httpMethod = "POST"
                    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type"); request.httpBody = Data("code=\(code)&verifier=\(verifier)".utf8)
                    self.web.load(request)
                }
            }
            authentication?.presentationContextProvider = self
            if authentication?.start() == true { reply(id, result: true) } else { reply(id, error: "authentication_unavailable") }
        case "info": reply(id, result: ["bridgeVersion": 1, "platform": "ios", "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0.0", "environment": Bundle.main.object(forInfoDictionaryKey: "AppEnvironment") as? String ?? "development", "capabilities": ["files", "camera", "share", "download", "haptic", "settings"]])
        case "haptic": UIImpactFeedbackGenerator(style: .light).impactOccurred(); reply(id, result: true)
        case "settings": if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }; reply(id, result: true)
        case "share":
            var items: [Any] = []
            if let text = payload["text"] as? String, !text.isEmpty { items.append(text) }
            if let value = payload["url"] as? String, !value.isEmpty {
                guard let url = URL(string: value), url.scheme == "https", url.host != nil else { reply(id, error: "invalid_url"); return }
                items.append(url)
            }
            guard !items.isEmpty else { reply(id, error: "empty_share"); return }
            share(items); reply(id, result: true)
        case "download":
            guard let rawURL = payload["url"] as? String, let url = URL(string: rawURL), policy.trusted(url) else { reply(id, error: "untrusted_url"); return }
            guard downloadIDs[rawURL] == nil else { reply(id, error: "download_in_progress"); return }
            downloadIDs[rawURL] = id
            web.startDownload(using: URLRequest(url: url)) { [weak self] download in download.delegate = self }
        case "saveFile":
            guard let encoded = payload["data"] as? String, let bytes = Data(base64Encoded: encoded), bytes.count <= 16 * 1024 * 1024 else { reply(id, error: "invalid_file"); return }
            let name = URL(fileURLWithPath: payload["name"] as? String ?? "download").lastPathComponent
            let file = phoneDirectory().appendingPathComponent(UUID().uuidString + "-" + String(name.suffix(120)))
            do { try bytes.write(to: file, options: .atomic); share([file]); reply(id, result: true) } catch { reply(id, error: "save_failed") }
        default: reply(id, error: "unsupported")
        }
    }
    private func reply(_ id: String, result: Any = NSNull(), error: String? = nil) {
        var value: [String: Any] = ["id": id, "result": result]
        if let error { value["error"] = ["code": error, "message": "The phone action could not be completed."] }
        guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('fm:native:reply',{detail:\(json)}))", completionHandler: nil)
    }
    private func share(_ items: [Any]) {
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        if presentedViewController == nil { present(sheet, animated: true) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, trusted(frame.securityOrigin), presentedViewController == nil else { completionHandler(); return }
        let alert = UIAlertController(title: "FirstMeasure", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() }); present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, trusted(frame.securityOrigin), presentedViewController == nil else { completionHandler(false); return }
        let alert = UIAlertController(title: "FirstMeasure", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) }); present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard frame.isMainFrame, trusted(frame.securityOrigin), presentedViewController == nil else { completionHandler(nil); return }
        let alert = UIAlertController(title: "FirstMeasure", message: prompt, preferredStyle: .alert); alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(alert.textFields?.first?.text) }); present(alert, animated: true)
    }
    private func phoneDirectory() -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("FirstMeasure", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        guard policy.trusted(response.url), response.mimeType != "text/html", response.expectedContentLength <= 150 * 1024 * 1024,
              (response as? HTTPURLResponse)?.statusCode == 200 else { completionHandler(nil); return }
        let original = download.originalRequest?.url?.absoluteString ?? ""
        let file = phoneDirectory().appendingPathComponent(UUID().uuidString + "-" + URL(fileURLWithPath: suggestedFilename).lastPathComponent)
        downloads[ObjectIdentifier(download)] = (file, downloadIDs[original], original)
        completionHandler(file)
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) { decisionHandler(policy.trusted(request.url) ? .allow : .cancel) }
    func downloadDidFinish(_ download: WKDownload) {
        guard let (file, id, original) = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        downloadIDs.removeValue(forKey: original)
        share([file]); if let id { reply(id, result: true) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let entry = downloads.removeValue(forKey: ObjectIdentifier(download))
        let original = entry?.2 ?? download.originalRequest?.url?.absoluteString ?? ""
        let id = downloadIDs.removeValue(forKey: original)
        if let file = entry?.0 { try? FileManager.default.removeItem(at: file) }
        if let id { reply(id, error: "download_failed") }
        connectionError(error)
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?
    init(_ delegate: WKScriptMessageHandler) { self.delegate = delegate }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { delegate?.userContentController(userContentController, didReceive: message) }
}
