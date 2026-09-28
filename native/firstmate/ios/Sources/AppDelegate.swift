import UIKit
import UserNotifications

@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?
    private var pushCallback: ((String?) -> Void)?
    private var pushToken: String?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let categories = ["LEADS", "MESSAGES", "MENTIONS", "TASKS", "SCHEDULING", "PAYMENTS", "CELEBRATIONS", "MEASUREMENTS", "SYSTEM"]
        center.setNotificationCategories(Set(categories.map { UNNotificationCategory(identifier: "FIRSTMATE_\($0)", actions: [], intentIdentifiers: []) }))
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = PortalController()
        window.makeKeyAndVisible()
        self.window = window
        if let notification = options?[.remoteNotification] as? [String: Any], let id = notification["notification_id"] as? String {
            (window.rootViewController as? PortalController)?.openNotification(id)
        }
        return true
    }
    func registerPush(_ callback: @escaping (String?) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { [weak self] granted, _ in
            DispatchQueue.main.async {
                guard let self else { callback(nil); return }
                guard granted else { callback(nil); return }
                self.pushCallback = callback
                UIApplication.shared.registerForRemoteNotifications()
                if UIApplication.shared.isRegisteredForRemoteNotifications, let token = self.pushToken {
                    self.pushCallback = nil; callback(token)
                }
            }
        }
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        pushToken = token
        let callback = pushCallback; pushCallback = nil; callback?(token)
    }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        let callback = pushCallback; pushCallback = nil; callback?(nil)
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["notification_id"] as? String {
            (window?.rootViewController as? PortalController)?.openNotification(id)
        }
        completionHandler()
    }
}
