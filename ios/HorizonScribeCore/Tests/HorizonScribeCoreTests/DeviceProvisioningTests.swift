import XCTest
@testable import HorizonScribeCore

final class DeviceProvisioningTests: XCTestCase {
    private let token = String(repeating: "a", count: 43)

    private func requestData(overrides: [String: String] = [:]) throws -> Data {
        var values = ["schema": "horizon-scribe-device-setup/v1", "requestID": UUID().uuidString,
                      "workerURL": "https://example.workers.dev", "apiToken": token]
        values.merge(overrides) { _, new in new }
        return try JSONSerialization.data(withJSONObject: values)
    }

    func testTransferSavedThenRemovedAndNotReimportedAfterForget() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try requestData().write(to: file)
        var saved: WorkerCredentials?
        let request = try DeviceProvisioningRequest.consume(from: file) {
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
            saved = $0
        }
        XCTAssertEqual(saved?.apiToken, token)
        XCTAssertEqual(request?.credentials, saved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        saved = nil // Simulate Forget connection: the transfer cannot sign in again.
        XCTAssertNil(try DeviceProvisioningRequest.consume(from: file) { saved = $0 })
        XCTAssertNil(saved)
    }

    func testKeychainFailurePreservesTransferForRetry() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try requestData().write(to: file)
        XCTAssertThrowsError(try DeviceProvisioningRequest.consume(from: file) { _ in
            throw ProvisioningError.message("Keychain unavailable")
        })
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNotNil(try DeviceProvisioningRequest.consume(from: file) { _ in })
    }

    func testInvalidTransferCannotOverwriteExistingCredentials() throws {
        for overrides in [
            ["schema": "unknown"], ["requestID": "not-a-uuid"], ["apiToken": "short"],
            ["workerURL": "http://example.com"], ["workerURL": "https://example.com/v1"],
            ["workerURL": "https://user:password@example.com"],
            ["workerURL": "https://example.com/?token=secret"],
            ["workerURL": "https://example.com/#fragment"]
        ] {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: file) }
            try requestData(overrides: overrides).write(to: file)
            XCTAssertThrowsError(try DeviceProvisioningRequest.consume(from: file) { _ in
                XCTFail("Invalid setup must not touch Keychain")
            })
        }
    }

    func testOversizedTransferRejectedBeforeSave() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data(repeating: 32, count: 16_385).write(to: file)
        XCTAssertThrowsError(try DeviceProvisioningRequest.consume(from: file) { _ in XCTFail() })
    }

    func testManualAndKeychainSettingsUseSameValidation() throws {
        let credentials = try WorkerCredentials(workerURL: " https://example.com/ \n", apiToken: token + "\n")
        XCTAssertEqual(credentials.workerURL, "https://example.com/")
        XCTAssertEqual(credentials.apiToken, token)
        XCTAssertEqual(try JSONDecoder().decode(WorkerCredentials.self, from: JSONEncoder().encode(credentials)), credentials)
        XCTAssertThrowsError(try JSONDecoder().decode(WorkerCredentials.self, from: requestData(overrides: ["apiToken": "bad"])))
    }
}
