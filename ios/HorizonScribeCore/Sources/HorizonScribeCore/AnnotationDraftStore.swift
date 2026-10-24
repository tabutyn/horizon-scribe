import CryptoKit
import Foundation

/// Atomic on-device storage for annotation drafts, available without network access.
public actor AnnotationDraftStore {
    private let directoryURL: URL
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(directoryURL: URL? = nil) throws {
        let root = directoryURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("HorizonScribe/Drafts", isDirectory: true)
        self.directoryURL = root

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: nil)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: root.path
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        self.encoder = encoder
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        self.decoder = decoder
    }

    public func save(_ draft: AnnotationDocument) throws {
        let url = fileURL(for: draft.id)
        try encoder.encode(draft).write(to: url, options: .atomic)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: url.path
        )
    }

    public func load(ownerUID: String, datasetID: String, setID: String, imageName: String) throws -> AnnotationDocument? {
        let url = fileURL(for: "\(ownerUID)/\(datasetID)/\(setID)/\(imageName)")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(AnnotationDocument.self, from: Data(contentsOf: url))
    }

    public func list(ownerUID: String, datasetID: String? = nil) throws -> [AnnotationDocument] {
        let urls = try FileManager.default.contentsOfDirectory(
            at: directoryURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        return try urls
            .filter { $0.pathExtension == "json" }
            .compactMap { try decoder.decode(AnnotationDocument.self, from: Data(contentsOf: $0)) }
            .filter { $0.ownerUID == ownerUID }
            .filter { datasetID == nil || $0.datasetID == datasetID }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    public func delete(ownerUID: String, datasetID: String, setID: String, imageName: String) throws {
        let url = fileURL(for: "\(ownerUID)/\(datasetID)/\(setID)/\(imageName)")
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private func fileURL(for documentID: String) -> URL {
        let digest = SHA256.hash(data: Data(documentID.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return directoryURL.appendingPathComponent(digest).appendingPathExtension("json")
    }
}
