import XCTest
@testable import FirstMate

final class OriginPolicyTests: XCTestCase {
    func testOriginBoundaries() {
        let policy = OriginPolicy("https://dev.1m8.ai")
        for value in ["https://dev.1m8.ai/portal/", "https://dev.1m8.ai:443/v1/mobile", "https://DEV.1M8.AI/portal/"] { XCTAssertTrue(policy.trusted(URL(string: value)), value) }
        for value in ["http://dev.1m8.ai/", "https://dev.1m8.ai.evil.test/", "https://evil.test/?next=https://dev.1m8.ai", "https://user@dev.1m8.ai/", "https://dev.1m8.ai:444/", "file:///private/data", "javascript:alert(1)"] { XCTAssertFalse(policy.trusted(URL(string: value)), value) }
    }
}
