import Foundation
import Combine

public enum MaskRasterError: LocalizedError {
    case invalidDimensions
    case invalidRows
    case strokeAlreadyActive
    case noActiveStroke

    public var errorDescription: String? {
        switch self {
        case .invalidDimensions: return "Image dimensions or pixel values are unsupported."
        case .invalidRows: return "Saved mask rows are malformed."
        case .strokeAlreadyActive: return "A mask stroke is already active."
        case .noActiveStroke: return "No mask stroke is active."
        }
    }
}

public struct MaskRasterBounds: Equatable, Sendable {
    public private(set) var minX: Int
    public private(set) var minY: Int
    public private(set) var maxX: Int
    public private(set) var maxY: Int

    public init(minX: Int, minY: Int, maxX: Int, maxY: Int) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }

    public mutating func formUnion(_ other: MaskRasterBounds) {
        minX = min(minX, other.minX)
        minY = min(minY, other.minY)
        maxX = max(maxX, other.maxX)
        maxY = max(maxY, other.maxY)
    }
}

/// Main-thread edit buffer with sparse per-stroke undo, avoiding full-mask history copies.
@MainActor
public final class MaskRasterEditor: ObservableObject {
    public static let automatic: UInt8 = 0
    public static let land: UInt8 = 1
    public static let sea: UInt8 = 2
    public static let sky: UInt8 = 3

    public let width: Int
    public let height: Int
    public private(set) var pixels: [UInt8]
    /// Monotonic raster version read directly by the canvas. It is intentionally
    /// not published: the canvas already schedules its own redraw for Pencil
    /// input, so publishing every coalesced sample would invalidate all SwiftUI
    /// controls while a stroke is in flight.
    public private(set) var revision = 0
    public private(set) var lastMutationRevision = 0
    public private(set) var lastMutationBounds: MaskRasterBounds?
    @Published public private(set) var isDirty = false
    @Published public private(set) var canUndo = false
    @Published public private(set) var canRedo = false

    private struct PixelChange {
        let index: Int
        let before: UInt8
        let after: UInt8
    }

    private struct PendingChange {
        let index: Int
        let before: UInt8
    }

    private struct HistoryEntry {
        let changes: [PixelChange]
        let bounds: MaskRasterBounds
    }

    private var baseline: [UInt8]
    private var pending: [PendingChange] = []
    private var pendingTouched: [UInt8]
    private var strokeActive = false
    private var pendingLabel: UInt8?
    private var pendingRadius = 1.0
    private var previousPoint: (x: Double, y: Double)?
    private var pendingBounds: MaskRasterBounds?
    private var undoStack: [HistoryEntry] = []
    private var redoStack: [HistoryEntry] = []
    private var differenceCount = 0
    private let historyLimit = 24

    public init(width: Int, height: Int, initialPixels: [UInt8]) throws {
        guard (1...8192).contains(width), (1...8192).contains(height),
              width <= Int.max / height, initialPixels.count == width * height,
              initialPixels.allSatisfy({ $0 <= Self.sky }) else {
            throw MaskRasterError.invalidDimensions
        }
        self.width = width
        self.height = height
        self.baseline = initialPixels
        self.pixels = initialPixels
        self.pendingTouched = [UInt8](repeating: 0, count: initialPixels.count)
    }

    public func beginStroke(label: UInt8?, radius: Double) throws {
        guard !strokeActive else { throw MaskRasterError.strokeAlreadyActive }
        if let label, !(Self.land...Self.sky).contains(label) { throw MaskRasterError.invalidDimensions }
        guard radius.isFinite, radius > 0, radius <= 8192 else {
            throw MaskRasterError.invalidDimensions
        }
        strokeActive = true
        pending.removeAll(keepingCapacity: true)
        pending.reserveCapacity(min(width * height, min(262_144, max(64, Int(Double.pi * radius * radius)))))
        pendingLabel = label
        pendingRadius = radius
        previousPoint = nil
        pendingBounds = nil
    }

    @discardableResult
    public func extendStroke(x: Double, y: Double) throws -> Bool {
        try extendStroke(points: [(x, y)])
    }

    /// Applies coalesced Pencil samples as one observable edit update.
    @discardableResult
    public func extendStroke(points: [(x: Double, y: Double)]) throws -> Bool {
        guard strokeActive else { throw MaskRasterError.noActiveStroke }
        guard points.allSatisfy({ $0.x.isFinite && $0.y.isFinite }) else { throw MaskRasterError.invalidRows }
        var changedBounds: MaskRasterBounds?
        for point in points {
            guard point.x >= -pendingRadius, point.y >= -pendingRadius,
                  point.x < Double(width) + pendingRadius, point.y < Double(height) + pendingRadius else {
                previousPoint = point
                continue
            }
            if let previousPoint {
                let dx = point.x - previousPoint.x
                let dy = point.y - previousPoint.y
                let distance = hypot(dx, dy)
                let step = max(1, pendingRadius * 0.45)
                if !distance.isFinite || distance > Double(max(width, height)) * 2 {
                    self.previousPoint = point
                    merge(stamp(x: point.x, y: point.y), into: &changedBounds)
                    continue
                }
                let count = max(1, Int(ceil(distance / step)))
                for index in 1...count {
                    let progress = Double(index) / Double(count)
                    merge(stamp(
                        x: previousPoint.x + dx * progress,
                        y: previousPoint.y + dy * progress
                    ), into: &changedBounds)
                }
            } else {
                merge(stamp(x: point.x, y: point.y), into: &changedBounds)
            }
            previousPoint = point
        }
        guard let changedBounds else { return false }
        merge(changedBounds, into: &pendingBounds)
        recordMutation(changedBounds)
        publishFlags()
        return true
    }

    @discardableResult
    public func finishStroke() throws -> Bool {
        guard strokeActive else { throw MaskRasterError.noActiveStroke }
        let changes = pending.compactMap { change -> PixelChange? in
            guard change.before != pixels[change.index] else { return nil }
            return PixelChange(index: change.index, before: change.before, after: pixels[change.index])
        }
        let bounds = pendingBounds
        resetPendingStroke()
        pendingLabel = nil
        previousPoint = nil
        guard !changes.isEmpty, let bounds else { return false }
        if undoStack.count == historyLimit { undoStack.removeFirst() }
        undoStack.append(HistoryEntry(changes: changes, bounds: bounds))
        redoStack.removeAll(keepingCapacity: true)
        publishFlags()
        return true
    }

    public func cancelStroke() {
        guard strokeActive else { return }
        var changed = false
        for change in pending where pixels[change.index] != change.before {
            updateDifferenceCount(index: change.index, oldValue: pixels[change.index], newValue: change.before)
            pixels[change.index] = change.before
            changed = true
        }
        let bounds = pendingBounds
        resetPendingStroke()
        pendingLabel = nil
        previousPoint = nil
        if changed, let bounds { recordMutation(bounds) }
        publishFlags()
    }

    @discardableResult
    public func undo() -> Bool {
        guard !strokeActive, let entry = undoStack.popLast() else { return false }
        for change in entry.changes {
            updateDifferenceCount(index: change.index, oldValue: pixels[change.index], newValue: change.before)
            pixels[change.index] = change.before
        }
        redoStack.append(entry)
        recordMutation(entry.bounds)
        publishFlags()
        return true
    }

    @discardableResult
    public func redo() -> Bool {
        guard !strokeActive, let entry = redoStack.popLast() else { return false }
        if undoStack.count == historyLimit { undoStack.removeFirst() }
        for change in entry.changes {
            updateDifferenceCount(index: change.index, oldValue: pixels[change.index], newValue: change.after)
            pixels[change.index] = change.after
        }
        undoStack.append(entry)
        recordMutation(entry.bounds)
        publishFlags()
        return true
    }

    public func replaceBaseline(with values: [UInt8]) throws {
        guard values.count == width * height, values.allSatisfy({ $0 <= Self.sky }) else {
            throw MaskRasterError.invalidDimensions
        }
        baseline = values
        pixels = values
        resetPendingStroke()
        undoStack.removeAll(keepingCapacity: true)
        redoStack.removeAll(keepingCapacity: true)
        differenceCount = 0
        recordMutation(fullBounds)
        publishFlags()
    }

    public func replaceWorking(with values: [UInt8]) throws {
        guard values.count == width * height, values.allSatisfy({ $0 <= Self.sky }) else {
            throw MaskRasterError.invalidDimensions
        }
        pixels = values
        resetPendingStroke()
        undoStack.removeAll(keepingCapacity: true)
        redoStack.removeAll(keepingCapacity: true)
        recordMutation(fullBounds)
        recountDifferences()
        publishFlags()
    }

    public func acceptCurrentAsBaseline(preservingHistory: Bool = false) {
        baseline = pixels
        resetPendingStroke()
        if !preservingHistory {
            undoStack.removeAll(keepingCapacity: true)
            redoStack.removeAll(keepingCapacity: true)
        }
        differenceCount = 0
        publishFlags()
    }

    public func encodedRows() -> [CorrectionRow] {
        var rows: [CorrectionRow] = []
        for y in 0..<height {
            var runs: [[Int]] = []
            var x = 0
            while x < width {
                let value = pixels[y * width + x]
                guard value != Self.automatic else { x += 1; continue }
                let start = x
                x += 1
                while x < width, pixels[y * width + x] == value { x += 1 }
                runs.append([start, x, Int(value)])
            }
            if !runs.isEmpty { rows.append(CorrectionRow(y: y, runs: runs)) }
        }
        return rows
    }

    /// Encodes the complete categorical raster required by the cloud review
    /// contract. Automatic pixels are resolved from the immutable model mask.
    public func encodedFullRows(resolvingAutomaticWith baseLabels: [UInt8]) throws -> [CorrectionRow] {
        guard baseLabels.count == pixels.count,
              baseLabels.allSatisfy({ (Self.land...Self.sky).contains($0) }) else {
            throw MaskRasterError.invalidDimensions
        }
        var rows: [CorrectionRow] = []
        rows.reserveCapacity(height)
        for y in 0..<height {
            var runs: [[Int]] = []
            var x = 0
            while x < width {
                let index = y * width + x
                let value = pixels[index] == Self.automatic ? baseLabels[index] : pixels[index]
                guard (Self.land...Self.sky).contains(value) else { throw MaskRasterError.invalidRows }
                let start = x
                x += 1
                while x < width {
                    let nextIndex = y * width + x
                    let next = pixels[nextIndex] == Self.automatic ? baseLabels[nextIndex] : pixels[nextIndex]
                    guard (Self.land...Self.sky).contains(next) else { throw MaskRasterError.invalidRows }
                    if next != value { break }
                    x += 1
                }
                runs.append([start, x, Int(value)])
            }
            rows.append(CorrectionRow(y: y, runs: runs))
        }
        return rows
    }

    public static func decodeRows(_ rows: [CorrectionRow], width: Int, height: Int) throws -> [UInt8] {
        guard (1...8192).contains(width), (1...8192).contains(height), width <= Int.max / height,
              rows.count <= height else { throw MaskRasterError.invalidDimensions }
        var values = [UInt8](repeating: automatic, count: width * height)
        var previousY = -1
        for row in rows {
            guard row.y >= 0, row.y < height, row.y > previousY, !row.runs.isEmpty else {
                throw MaskRasterError.invalidRows
            }
            var edge = 0
            var previousLabel = 0
            for run in row.runs {
                guard run.count == 3 else { throw MaskRasterError.invalidRows }
                let start = run[0], end = run[1], label = run[2]
                guard start >= edge, start >= 0, end > start, end <= width, (1...3).contains(label),
                      !(start == edge && label == previousLabel) else { throw MaskRasterError.invalidRows }
                values.replaceSubrange((row.y * width + start)..<(row.y * width + end), with: repeatElement(UInt8(label), count: end - start))
                edge = end
                previousLabel = label
            }
            previousY = row.y
        }
        return values
    }

    private var fullBounds: MaskRasterBounds {
        MaskRasterBounds(minX: 0, minY: 0, maxX: width - 1, maxY: height - 1)
    }

    private func stamp(x: Double, y: Double) -> MaskRasterBounds? {
        let radius = pendingRadius
        guard x >= -radius, y >= -radius,
              x < Double(width) + radius, y < Double(height) + radius else { return nil }
        let y0 = Int(max(0, floor(y - radius)))
        let y1 = Int(min(Double(height - 1), ceil(y + radius)))
        guard y0 <= y1 else { return nil }
        let radiusSquared = radius * radius
        var bounds: MaskRasterBounds?
        for py in y0...y1 {
            let dy = Double(py) - y
            let remaining = radiusSquared - dy * dy
            guard remaining >= 0 else { continue }
            let halfWidth = sqrt(remaining)
            let x0 = max(0, Int(ceil(x - halfWidth)))
            let x1 = min(width - 1, Int(floor(x + halfWidth)))
            guard x0 <= x1 else { continue }
            var rowChanged = false
            for px in x0...x1 {
                let index = py * width + px
                let target = pendingLabel ?? baseline[index]
                guard pixels[index] != target else { continue }
                if pendingTouched[index] == 0 {
                    pendingTouched[index] = 1
                    pending.append(PendingChange(index: index, before: pixels[index]))
                }
                updateDifferenceCount(index: index, oldValue: pixels[index], newValue: target)
                pixels[index] = target
                rowChanged = true
            }
            if rowChanged {
                let rowBounds = MaskRasterBounds(minX: x0, minY: py, maxX: x1, maxY: py)
                merge(rowBounds, into: &bounds)
            }
        }
        return bounds
    }

    private func resetPendingStroke() {
        for change in pending { pendingTouched[change.index] = 0 }
        pending.removeAll(keepingCapacity: true)
        pendingBounds = nil
        strokeActive = false
    }

    private func recordMutation(_ bounds: MaskRasterBounds) {
        revision &+= 1
        lastMutationRevision = revision
        lastMutationBounds = bounds
    }

    private func merge(_ bounds: MaskRasterBounds?, into accumulated: inout MaskRasterBounds?) {
        guard let bounds else { return }
        if accumulated == nil {
            accumulated = bounds
        } else {
            accumulated?.formUnion(bounds)
        }
    }

    private func updateDifferenceCount(index: Int, oldValue: UInt8, newValue: UInt8) {
        let base = baseline[index]
        if oldValue == base, newValue != base { differenceCount += 1 }
        if oldValue != base, newValue == base { differenceCount -= 1 }
    }

    private func recountDifferences() {
        differenceCount = zip(pixels, baseline).reduce(into: 0) { count, pair in
            if pair.0 != pair.1 { count += 1 }
        }
    }

    private func publishFlags() {
        let nextDirty = differenceCount > 0
        let nextCanUndo = !undoStack.isEmpty
        let nextCanRedo = !redoStack.isEmpty
        if isDirty != nextDirty { isDirty = nextDirty }
        if canUndo != nextCanUndo { canUndo = nextCanUndo }
        if canRedo != nextCanRedo { canRedo = nextCanRedo }
    }
}
