import XCTest

final class PortalUITests: XCTestCase {
    func testPortalLaunchAndRotation() {
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(app.webViews.firstMatch.exists)
        XCUIDevice.shared.orientation = .portrait
        app.terminate(); app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
    }
}
