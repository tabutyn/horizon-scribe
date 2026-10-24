import CryptoKit
import Foundation
import HorizonScribeCore

actor HorizonScribeOfflineCache {
    private struct AssetRecord: Codable {
        let byteCount: Int
        let sha256: String
    }

    private let rootURL: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let assetBudget = 512 * 1024 * 1024

    init() throws {
        rootURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("HorizonScribe/Cache", isDirectory: true)
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true, attributes: nil)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: rootURL.path
        )
    }

    func saveCatalog(_ catalog: HorizonScribeCatalog, ownerUID: String) throws {
        try saveMetadata(encoder.encode(catalog), ownerUID: ownerUID, key: "catalog")
    }

    func loadCatalog(ownerUID: String) throws -> HorizonScribeCatalog? {
        guard let data = try loadMetadata(ownerUID: ownerUID, key: "catalog") else { return nil }
        return try decoder.decode(HorizonScribeCatalog.self, from: data)
    }

    func saveReviewState(_ state: CloudReviewState, ownerUID: String) throws {
        let key = "review/\(state.datasetId)/\(state.setId)/\(state.image)"
        try saveMetadata(encoder.encode(state), ownerUID: ownerUID, key: key)
    }

    func loadReviewState(ownerUID: String, datasetID: String, setID: String, imageName: String) throws -> CloudReviewState? {
        let key = "review/\(datasetID)/\(setID)/\(imageName)"
        guard let data = try loadMetadata(ownerUID: ownerUID, key: key) else { return nil }
        return try decoder.decode(CloudReviewState.self, from: data)
    }

    func saveAsset(_ data: Data, ownerUID: String, datasetID: String, setID: String, imageName: String, artifact: String) throws {
        let key = "\(datasetID)/\(setID)/\(imageName)/\(artifact)"
        let directory = ownerDirectory(ownerUID).appendingPathComponent("Assets", isDirectory: true)
        try prepareDirectory(directory)
        let baseName = digest(key)
        let blobURL = directory.appendingPathComponent(baseName).appendingPathExtension("blob")
        let recordURL = directory.appendingPathComponent(baseName).appendingPathExtension("json")
        try evictAssets(in: directory, adding: data.count, keeping: blobURL)
        try data.write(to: blobURL, options: .atomic)
        let record = AssetRecord(byteCount: data.count, sha256: digest(data))
        try encoder.encode(record).write(to: recordURL, options: .atomic)
        protect(blobURL)
        protect(recordURL)
    }

    func loadAsset(ownerUID: String, datasetID: String, setID: String, imageName: String, artifact: String) throws -> Data? {
        let key = "\(datasetID)/\(setID)/\(imageName)/\(artifact)"
        let directory = ownerDirectory(ownerUID).appendingPathComponent("Assets", isDirectory: true)
        let baseName = digest(key)
        let blobURL = directory.appendingPathComponent(baseName).appendingPathExtension("blob")
        let recordURL = directory.appendingPathComponent(baseName).appendingPathExtension("json")
        guard FileManager.default.fileExists(atPath: blobURL.path),
              let recordData = try? Data(contentsOf: recordURL),
              let record = try? decoder.decode(AssetRecord.self, from: recordData) else { return nil }
        let data = try Data(contentsOf: blobURL, options: [.mappedIfSafe])
        guard data.count == record.byteCount, digest(data) == record.sha256 else {
            try? FileManager.default.removeItem(at: blobURL)
            try? FileManager.default.removeItem(at: recordURL)
            return nil
        }
        return data
    }

    func hasAsset(ownerUID: String, datasetID: String, setID: String, imageName: String, artifact: String) throws -> Bool {
        let key = "\(datasetID)/\(setID)/\(imageName)/\(artifact)"
        let directory = ownerDirectory(ownerUID).appendingPathComponent("Assets", isDirectory: true)
        let baseName = digest(key)
        let blobURL = directory.appendingPathComponent(baseName).appendingPathExtension("blob")
        let recordURL = directory.appendingPathComponent(baseName).appendingPathExtension("json")
        guard let recordData = try? Data(contentsOf: recordURL),
              let record = try? decoder.decode(AssetRecord.self, from: recordData),
              FileManager.default.fileExists(atPath: blobURL.path) else { return false }
        return (try blobURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) == record.byteCount
    }

    private func saveMetadata(_ data: Data, ownerUID: String, key: String) throws {
        let directory = ownerDirectory(ownerUID).appendingPathComponent("Metadata", isDirectory: true)
        try prepareDirectory(directory)
        let url = directory.appendingPathComponent(digest(key)).appendingPathExtension("json")
        try data.write(to: url, options: .atomic)
        protect(url)
    }

    private func loadMetadata(ownerUID: String, key: String) throws -> Data? {
        let url = ownerDirectory(ownerUID)
            .appendingPathComponent("Metadata", isDirectory: true)
            .appendingPathComponent(digest(key))
            .appendingPathExtension("json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try Data(contentsOf: url, options: [.mappedIfSafe])
    }

    private func ownerDirectory(_ ownerUID: String) -> URL {
        rootURL.appendingPathComponent(digest(ownerUID), isDirectory: true)
    }

    private func prepareDirectory(_ directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: nil)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: directory.path
        )
    }

    private func protect(_ url: URL) { try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path) }

    private func evictAssets(in directory: URL, adding byteCount: Int, keeping url: URL) throws {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        let urls = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ).filter { $0.pathExtension == "blob" && $0 != url }
        let records = try urls.map { candidate in
            (url: candidate, size: try candidate.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0,
             modified: try candidate.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast)
        }
        var total = records.reduce(0) { $0 + $1.size }
        guard byteCount < assetBudget else { throw HorizonScribeIdentityError.message("Asset exceeds the on-device cache limit.") }
        for record in records.sorted(by: { $0.modified < $1.modified }) where total + byteCount > assetBudget {
            try FileManager.default.removeItem(at: record.url)
            try? FileManager.default.removeItem(at: record.url.deletingPathExtension().appendingPathExtension("json"))
            total -= record.size
        }
    }

    private func digest(_ value: String) -> String { digest(Data(value.utf8)) }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
