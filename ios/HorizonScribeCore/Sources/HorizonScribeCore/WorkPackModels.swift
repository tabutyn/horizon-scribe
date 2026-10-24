import Foundation

/// Matches the API-token-gated HorizonScribe Worker's catalog response.
public struct HorizonScribeCatalog: Codable, Sendable {
    public let schema: String
    public let datasetId: String
    public let nextPass: HorizonScribeNextPass?
    public let sets: [HorizonScribeSet]
}

public struct HorizonScribeNextPass: Codable, Sendable {
    public let schema: String
    public let datasetId: String
    public let revision: String
    public let runId: String?
    public let modelId: String?
    public let predictionSetId: String?
    public let updatedAt: String?
    public let selectedImages: [HorizonScribeNextPassImage]
}

public struct HorizonScribeNextPassImage: Codable, Sendable {
    public let setId: String
    public let image: String
    public let rank: Int
}

public struct HorizonScribeReviewJob: Identifiable, Sendable {
    public let set: HorizonScribeSet
    public let image: HorizonScribeImage
    public let rank: Int?

    public var id: String { "\(set.id)/\(image.name)" }
}

public extension HorizonScribeCatalog {
    /// Resolves the dataset-bound explicit queue by exact set/image identity.
    /// Older catalogs retain the legacy one-image-per-set behavior.
    var resolvedNextPass: [HorizonScribeReviewJob] {
        guard let nextPass else {
            return sets.compactMap { set in
                guard let image = set.images.first(where: { $0.snapshotApproved != true }) else { return nil }
                return HorizonScribeReviewJob(set: set, image: image, rank: nil)
            }
        }
        guard nextPass.schema == "horizon-scribe-next-pass-selection/v1",
              nextPass.datasetId == datasetId else { return [] }
        return nextPass.selectedImages.sorted {
            if $0.rank != $1.rank { return $0.rank < $1.rank }
            if $0.setId != $1.setId { return $0.setId < $1.setId }
            return $0.image < $1.image
        }.compactMap { selected in
            guard let set = sets.first(where: { $0.id == selected.setId }),
                  let image = set.images.first(where: { $0.name == selected.image }) else { return nil }
            return HorizonScribeReviewJob(set: set, image: image, rank: selected.rank)
        }
    }

    var hasValidExplicitNextPass: Bool {
        guard let nextPass else { return true }
        let identities = nextPass.selectedImages.map { "\($0.setId)\n\($0.image)" }
        return nextPass.schema == "horizon-scribe-next-pass-selection/v1"
            && nextPass.datasetId == datasetId
            && nextPass.selectedImages.allSatisfy { $0.rank >= 0 }
            && Set(identities).count == identities.count
            && resolvedNextPass.count == nextPass.selectedImages.count
    }
}

public struct HorizonScribeSet: Codable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let sourceProfile: String
    public let images: [HorizonScribeImage]
    public let review: HorizonScribeSetReview
}

public struct HorizonScribeSetReview: Codable, Sendable {
    public let approved: Int
    public let edited: Int
    public let total: Int
    public let complete: Bool
}

public struct HorizonScribeImage: Codable, Identifiable, Sendable {
    public let name: String
    public let width: Int
    public let height: Int
    public let revision: String?
    public let localRevision: String?
    public let approved: Bool
    /// Approval captured by the immutable dataset snapshot. The web Next Pass
    /// queue uses this value so the membership of an active pass does not move.
    public let snapshotApproved: Bool?
    public let cloudRevision: String?
    public let imageUrl: String
    public let baseMaskUrl: String

    public var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, width, height, revision, localRevision, approved, snapshotApproved, cloudRevision
        case imageUrl
        case baseMaskUrl
    }
}

/// Labels use dataset IDs: automatic=0, land=1, sea=2, sky=3.
public struct CorrectionRow: Codable, Sendable {
    public let y: Int
    /// Triples use [startX, endXExclusive, classID], matching R2 cloud-review v1.
    public let runs: [[Int]]

    public init(y: Int, runs: [[Int]]) {
        self.y = y
        self.runs = runs
    }
}

public struct CloudReviewCorrection: Codable, Sendable {
    public let revision: String?
    public let localBaseRevision: String?
    public let parentRevision: String?
    public let rows: [CorrectionRow]
    public let parentRows: [CorrectionRow]
    public let approved: Bool
    public let initialClassMask: Bool
    public let source: String
    public let representation: String?
    public let humanReviewed: Bool?
}

public struct CloudReviewState: Codable, Sendable {
    public let schema: String
    public let datasetId: String
    public let setId: String
    public let image: String
    public let width: Int
    public let height: Int
    public let correction: CloudReviewCorrection
}

/// Request accepted by PUT /v1/sets/{set}/images/{image}.
public struct CloudReviewEdit: Encodable, Sendable {
    public let schema = "horizon-scribe-cloud-review-edit/v1"
    public let representation = "full-class-raster/v1"
    public let humanReviewed = true
    public let localBaseRevision: String?
    public let cloudBaseRevision: String?
    public let operationId: String
    public let approved: Bool
    public let rows: [CorrectionRow]

    public init(localBaseRevision: String?, cloudBaseRevision: String?, operationId: String = UUID().uuidString, approved: Bool, rows: [CorrectionRow]) {
        self.localBaseRevision = localBaseRevision
        self.cloudBaseRevision = cloudBaseRevision
        self.operationId = operationId
        self.approved = approved
        self.rows = rows
    }

    enum CodingKeys: String, CodingKey {
        case schema, representation, humanReviewed
        case localBaseRevision, cloudBaseRevision, operationId, approved, rows
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schema, forKey: .schema)
        try container.encode(representation, forKey: .representation)
        try container.encode(humanReviewed, forKey: .humanReviewed)
        if let localBaseRevision { try container.encode(localBaseRevision, forKey: .localBaseRevision) }
        else { try container.encodeNil(forKey: .localBaseRevision) }
        if let cloudBaseRevision { try container.encode(cloudBaseRevision, forKey: .cloudBaseRevision) }
        else { try container.encodeNil(forKey: .cloudBaseRevision) }
        try container.encode(operationId, forKey: .operationId)
        try container.encode(approved, forKey: .approved)
        try container.encode(rows, forKey: .rows)
    }
}

/// Locally durable, Worker-scoped offline correction. Kept separate from canonical R2 state.
public struct AnnotationDocument: Codable, Identifiable, Sendable {
    public let schemaVersion: Int
    public let ownerUID: String
    public let datasetID: String
    public let setID: String
    public let imageName: String
    public let localBaseRevision: String?
    public let cloudBaseRevision: String?
    public let approved: Bool
    public let updatedAt: Date
    public let rows: [CorrectionRow]

    public var id: String { "\(ownerUID)/\(datasetID)/\(setID)/\(imageName)" }

    public init(schemaVersion: Int = 1, ownerUID: String, datasetID: String, setID: String, imageName: String, localBaseRevision: String?, cloudBaseRevision: String?, approved: Bool, updatedAt: Date = .now, rows: [CorrectionRow]) {
        self.schemaVersion = schemaVersion
        self.ownerUID = ownerUID
        self.datasetID = datasetID
        self.setID = setID
        self.imageName = imageName
        self.localBaseRevision = localBaseRevision
        self.cloudBaseRevision = cloudBaseRevision
        self.approved = approved
        self.updatedAt = updatedAt
        self.rows = rows
    }
}
