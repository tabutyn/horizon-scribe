import XCTest
@testable import HorizonScribeCore

final class MaskRasterEditorTests: XCTestCase {
    @MainActor func testBrushAtOutsideEdgesDoesNotCrashOrPaint() throws {
        let editor = try MaskRasterEditor(width: 4, height: 4, initialPixels: Array(repeating: 0, count: 16))
        for (x, y) in [(4.8, 2.0), (2.0, 4.8), (-0.8, 2.0), (2.0, -0.8)] {
            try editor.beginStroke(label: 2, radius: 0.5)
            _ = try editor.extendStroke(x: x, y: y)
            XCTAssertFalse(try editor.finishStroke())
        }
        XCTAssertFalse(editor.isDirty)
    }

    @MainActor func testBrushRadiusCannotOverflowIntegerConversion() throws {
        let editor = try MaskRasterEditor(width: 1, height: 1, initialPixels: [0])
        for radius in [Double.greatestFiniteMagnitude, .infinity, .nan, 0, -1] {
            XCTAssertThrowsError(try editor.beginStroke(label: 2, radius: radius))
        }
    }

    @MainActor func testUndoRedoCancelAndRestorePreserveBaseline() throws {
        let editor = try MaskRasterEditor(width: 3, height: 1, initialPixels: [1, 0, 3])
        try editor.beginStroke(label: 2, radius: 0.5)
        _ = try editor.extendStroke(x: 0, y: 0)
        _ = try editor.extendStroke(x: 2, y: 0)
        XCTAssertTrue(try editor.finishStroke())
        XCTAssertEqual(editor.pixels, [2, 2, 2])
        XCTAssertTrue(editor.isDirty)
        XCTAssertTrue(editor.undo())
        XCTAssertEqual(editor.pixels, [1, 0, 3])
        XCTAssertFalse(editor.isDirty)
        XCTAssertTrue(editor.redo())
        try editor.beginStroke(label: nil, radius: 0.5)
        _ = try editor.extendStroke(x: 1, y: 0)
        editor.cancelStroke()
        XCTAssertEqual(editor.pixels, [2, 2, 2])
        try editor.beginStroke(label: nil, radius: 4)
        _ = try editor.extendStroke(x: 1, y: 0)
        XCTAssertTrue(try editor.finishStroke())
        XCTAssertEqual(editor.pixels, [1, 0, 3])
        XCTAssertFalse(editor.isDirty)
    }

    @MainActor func testSaveBaselineCanPreserveUndoHistory() throws {
        let editor = try MaskRasterEditor(width: 2, height: 1, initialPixels: [0, 0])
        try editor.beginStroke(label: 2, radius: 0.5)
        _ = try editor.extendStroke(x: 0, y: 0)
        XCTAssertTrue(try editor.finishStroke())
        editor.acceptCurrentAsBaseline(preservingHistory: true)
        XCTAssertFalse(editor.isDirty)
        XCTAssertTrue(editor.canUndo)
        XCTAssertTrue(editor.undo())
        XCTAssertEqual(editor.pixels, [0, 0])
        XCTAssertTrue(editor.isDirty)
        XCTAssertTrue(editor.redo())
        XCTAssertEqual(editor.pixels, [2, 0])
        XCTAssertFalse(editor.isDirty)
    }

    @MainActor func testRowsRoundTripAndRejectMalformedRuns() throws {
        let pixels: [UInt8] = [0, 1, 1, 2, 3, 0, 0, 3]
        let editor = try MaskRasterEditor(width: 4, height: 2, initialPixels: pixels)
        XCTAssertEqual(try MaskRasterEditor.decodeRows(editor.encodedRows(), width: 4, height: 2), pixels)
        for rows in [
            [CorrectionRow(y: 0, runs: [[0, 5, 1]])],
            [CorrectionRow(y: 0, runs: [[0, 2, 1], [1, 3, 2]])],
            [CorrectionRow(y: 0, runs: [[0, 1, 4]])],
            [CorrectionRow(y: 0, runs: [[0, 1, 1]]), CorrectionRow(y: 0, runs: [[1, 2, 2]])]
        ] {
            XCTAssertThrowsError(try MaskRasterEditor.decodeRows(rows, width: 4, height: 2))
        }
    }

    @MainActor func testFullRowsResolveAutomaticPixelsAndCoverEveryPixel() throws {
        let editor = try MaskRasterEditor(width: 4, height: 2, initialPixels: [
            0, 3, 0, 2,
            0, 0, 1, 0
        ])
        let rows = try editor.encodedFullRows(resolvingAutomaticWith: [
            1, 1, 2, 1,
            2, 2, 1, 1
        ])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].runs, [[0, 1, 1], [1, 2, 3], [2, 4, 2]])
        XCTAssertEqual(rows[1].runs, [[0, 2, 2], [2, 4, 1]])
        XCTAssertEqual(
            try MaskRasterEditor.decodeRows(rows, width: 4, height: 2),
            [1, 3, 2, 2, 2, 2, 1, 1]
        )
        XCTAssertThrowsError(try editor.encodedFullRows(resolvingAutomaticWith: Array(repeating: 0, count: 8)))
    }

    @MainActor func testCoalescedSamplesPublishOneMutationAndUndo() throws {
        let editor = try MaskRasterEditor(width: 12, height: 1, initialPixels: Array(repeating: 0, count: 12))
        try editor.beginStroke(label: MaskRasterEditor.sea, radius: 0.5)
        XCTAssertTrue(try editor.extendStroke(points: [(1, 0), (5, 0), (10, 0)]))
        XCTAssertEqual(editor.revision, 1)
        XCTAssertTrue(try editor.finishStroke())
        XCTAssertTrue(editor.undo())
        XCTAssertEqual(editor.pixels, Array(repeating: 0, count: 12))
        XCTAssertFalse(editor.isDirty)
    }

    @MainActor func testLargeBrushUndoRestoresEveryTouchedPixel() throws {
        let width = 512
        let height = 512
        let editor = try MaskRasterEditor(
            width: width,
            height: height,
            initialPixels: Array(repeating: 0, count: width * height)
        )
        try editor.beginStroke(label: MaskRasterEditor.land, radius: 128)
        XCTAssertTrue(try editor.extendStroke(points: [(128, 256), (384, 256)]))
        XCTAssertEqual(
            editor.lastMutationBounds,
            MaskRasterBounds(minX: 0, minY: 128, maxX: 511, maxY: 384)
        )
        XCTAssertTrue(try editor.finishStroke())
        XCTAssertGreaterThan(editor.pixels.filter { $0 == MaskRasterEditor.land }.count, 100_000)
        XCTAssertTrue(editor.undo())
        XCTAssertEqual(
            editor.lastMutationBounds,
            MaskRasterBounds(minX: 0, minY: 128, maxX: 511, maxY: 384)
        )
        XCTAssertEqual(editor.pixels, Array(repeating: 0, count: width * height))
        XCTAssertFalse(editor.isDirty)
    }

    func testDraftIsolationAndDeletion() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try AnnotationDraftStore(directoryURL: directory)
        let draft = AnnotationDocument(ownerUID: "owner", datasetID: "dataset", setID: "set", imageName: "image", localBaseRevision: nil, cloudBaseRevision: nil, approved: false, rows: [CorrectionRow(y: 0, runs: [[0, 1, 2]])])
        try await store.save(draft)
        let loaded = try await store.load(ownerUID: "owner", datasetID: "dataset", setID: "set", imageName: "image")
        XCTAssertEqual(loaded?.rows.first?.runs, [[0, 1, 2]])
        XCTAssertNil(loaded?.cloudBaseRevision)
        let other = try await store.load(ownerUID: "other", datasetID: "dataset", setID: "set", imageName: "image")
        XCTAssertNil(other)
        try await store.delete(ownerUID: "owner", datasetID: "dataset", setID: "set", imageName: "image")
        let deleted = try await store.load(ownerUID: "owner", datasetID: "dataset", setID: "set", imageName: "image")
        XCTAssertNil(deleted)
    }

    func testFirstCloudSaveEncodesExplicitNullRevisions() throws {
        let edit = CloudReviewEdit(localBaseRevision: nil, cloudBaseRevision: nil, approved: false, rows: [])
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(edit)) as? [String: Any])
        XCTAssertTrue(json["localBaseRevision"] is NSNull)
        XCTAssertTrue(json["cloudBaseRevision"] is NSNull)
        XCTAssertEqual(json["representation"] as? String, "full-class-raster/v1")
        XCTAssertEqual(json["humanReviewed"] as? Bool, true)
    }

    func testExplicitNextPassResolvesExactSetImagePairsInRankOrder() throws {
        let data = Data(#"""
        {
          "schema":"horizon-scribe-cloud-catalog/v1",
          "datasetId":"dataset",
          "nextPass":{
            "schema":"horizon-scribe-next-pass-selection/v1",
            "datasetId":"dataset",
            "revision":"revision",
            "selectedImages":[
              {"setId":"first","image":"unique.JPG","rank":9},
              {"setId":"second","image":"duplicate.JPG","rank":4}
            ]
          },
          "sets":[
            {
              "id":"first","label":"First","sourceProfile":"water-v1",
              "images":[
                {"name":"duplicate.JPG","width":2,"height":1,"approved":false,"snapshotApproved":false,"imageUrl":"/first/duplicate","baseMaskUrl":"/first/base"},
                {"name":"unique.JPG","width":2,"height":1,"approved":false,"snapshotApproved":false,"imageUrl":"/first/unique","baseMaskUrl":"/first/base"}
              ],
              "review":{"approved":0,"edited":0,"total":2,"complete":false}
            },
            {
              "id":"second","label":"Second","sourceProfile":"water-v1",
              "images":[
                {"name":"duplicate.JPG","width":2,"height":1,"approved":false,"snapshotApproved":false,"imageUrl":"/second/duplicate","baseMaskUrl":"/second/base"}
              ],
              "review":{"approved":0,"edited":0,"total":1,"complete":false}
            }
          ]
        }
        """#.utf8)
        let catalog = try JSONDecoder().decode(HorizonScribeCatalog.self, from: data)
        XCTAssertTrue(catalog.hasValidExplicitNextPass)
        XCTAssertEqual(
            catalog.resolvedNextPass.map { [$0.set.id, $0.image.name, String($0.rank ?? -1)] },
            [["second", "duplicate.JPG", "4"], ["first", "unique.JPG", "9"]]
        )
    }
}
