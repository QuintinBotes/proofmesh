import XCTest

final class CalcCheck: XCTestCase {
    func testAdd() {
        XCTAssertEqual(Calc().add(1, 2), 3)
    }

    func make() -> Int {
        return Calc().add(0, 0)
    }
}
