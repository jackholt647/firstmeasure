import Foundation

struct OriginPolicy {
    let origin: URL
    init(_ value: String) {
        guard let url = URL(string: value), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.port == nil else { preconditionFailure("Invalid portal origin") }
        origin = url
    }
    func trusted(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host?.lowercased() == origin.host?.lowercased()
            && url.user == nil && url.password == nil && (url.port == nil || url.port == 443)
    }
    func external(_ url: URL) -> Bool {
        ["tel", "mailto"].contains(url.scheme ?? "") || (url.scheme == "https" && url.host != nil && url.user == nil && url.password == nil)
    }
}
