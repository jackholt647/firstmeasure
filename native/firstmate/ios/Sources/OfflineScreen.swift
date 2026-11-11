import UIKit

/// Shown in place of a blank web view when the portal could not be loaded: a short message and Retry.
/// It only covers the web view; nothing the web view stored is touched.
final class OfflineScreen: UIView {
    private let message = UILabel()
    private let retry = UIButton(type: .system)
    var onRetry: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .systemBackground
        isHidden = true
        accessibilityIdentifier = "firstmate.offline"
        message.text = NSLocalizedString("offline.no_connection", value: "No connection yet. Connect once to set this device up for offline use.", comment: "Shown when the app could not load and nothing is saved on the device yet")
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.textColor = .label
        message.textAlignment = .center
        message.numberOfLines = 0
        retry.setTitle(NSLocalizedString("offline.retry", value: "Retry", comment: "Button that loads the app again"), for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.addTarget(self, action: #selector(tapped), for: .touchUpInside)
        retry.accessibilityIdentifier = "firstmate.offline.retry"
        let stack = UIStackView(arrangedSubviews: [message, retry])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: layoutMarginsGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: layoutMarginsGuide.trailingAnchor, constant: -16)
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    @objc private func tapped() { onRetry?() }
}
