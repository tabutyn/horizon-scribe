import Foundation

/// Connection settings shared by manual setup, device provisioning, and Keychain.
public struct WorkerCredentials: Codable, Equatable {
    public let workerURL: String
    public let apiToken: String

    public init(workerURL: String, apiToken: String) throws {
        let value = workerURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = apiToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: value), url.scheme?.lowercased() == "https",
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw ProvisioningError.message("Worker URL must be a root HTTPS URL.")
        }
        guard token.range(of: "^[A-Za-z0-9_-]{32,256}$", options: .regularExpression) != nil else {
            throw ProvisioningError.message("API token must contain 32–256 URL-safe characters.")
        }
        self.workerURL = url.absoluteString
        self.apiToken = token
    }

    private enum CodingKeys: String, CodingKey { case workerURL, apiToken }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(workerURL: values.decode(String.self, forKey: .workerURL),
                      apiToken: values.decode(String.self, forKey: .apiToken))
    }
}

public enum ProvisioningError: LocalizedError {
    case message(String)
    public var errorDescription: String? {
        switch self { case .message(let message): return message }
    }
}

/// A one-time file copied through Xcode's paired-device connection, never bundled.
public struct DeviceProvisioningRequest: Decodable {
    public let requestID: String
    public let credentials: WorkerCredentials
    private enum CodingKeys: String, CodingKey { case schema, requestID, workerURL, apiToken }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(String.self, forKey: .schema) == "horizon-scribe-device-setup/v1" else {
            throw ProvisioningError.message("Unsupported iPad setup format. Rerun the Mac installer.")
        }
        requestID = try values.decode(String.self, forKey: .requestID)
        guard UUID(uuidString: requestID) != nil else {
            throw ProvisioningError.message("Invalid iPad setup request. Rerun the Mac installer.")
        }
        credentials = try WorkerCredentials(
            workerURL: values.decode(String.self, forKey: .workerURL),
            apiToken: values.decode(String.self, forKey: .apiToken)
        )
    }

    /// Consume only after credentials have been saved successfully. Failed Keychain
    /// writes retain the file for retry; invalid files never modify stored credentials.
    public static func consume(from url: URL, save: (WorkerCredentials) throws -> Void) throws -> Self? {
        let manager = FileManager.default
        guard manager.fileExists(atPath: url.path) else { return nil }
        let attributes = try manager.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue <= 16_384 else {
            throw ProvisioningError.message("Invalid iPad setup file. Rerun the Mac installer.")
        }
        let request: Self
        do {
            request = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        } catch {
            // Decoder diagnostics must not echo credential-bearing input.
            throw ProvisioningError.message("Invalid iPad setup file. Rerun the Mac installer.")
        }
        try save(request.credentials)
        try manager.removeItem(at: url)
        return request
    }
}
