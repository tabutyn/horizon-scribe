import CoreGraphics
import HorizonScribeCore
import SwiftUI
import UIKit

enum HorizonScribeCanvasMode: Hashable {
    case result
    case labels
    case source
}

struct HorizonScribeCanvasView: UIViewRepresentable {
    @ObservedObject var editor: MaskRasterEditor
    let sourceImage: UIImage
    let baseLabels: [UInt8]
    let selectedLabel: UInt8?
    let brushDiameter: Double
    let maskOpacity: Double
    let viewMode: HorizonScribeCanvasMode
    let isEditable: Bool
    let navigationResetToken: Int
    let onStrokeBegan: () -> Void
    let onStrokeFinished: (Bool) -> Void
    let onUndo: () -> Void
    let onRedo: () -> Void

    func makeUIView(context: Context) -> MaskCanvasUIView {
        let view = MaskCanvasUIView()
        view.backgroundColor = UIColor(red: 0.05, green: 0.07, blue: 0.07, alpha: 1)
        view.sourceImage = sourceImage
        view.editor = editor
        view.baseLabels = baseLabels
        view.selectedLabel = selectedLabel
        view.brushDiameter = brushDiameter
        view.maskOpacity = maskOpacity
        view.viewMode = viewMode
        view.isEditable = isEditable
        view.navigationResetToken = navigationResetToken
        view.onStrokeBegan = onStrokeBegan
        view.onStrokeFinished = onStrokeFinished
        view.onUndo = onUndo
        view.onRedo = onRedo
        let pinch = UIPinchGestureRecognizer(target: view, action: #selector(MaskCanvasUIView.handlePinch(_:)))
        pinch.delegate = view
        pinch.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        view.addGestureRecognizer(pinch)
        let pan = UIPanGestureRecognizer(target: view, action: #selector(MaskCanvasUIView.handlePan(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 2
        pan.delegate = view
        pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        view.addGestureRecognizer(pan)
        let undo = UITapGestureRecognizer(target: view, action: #selector(MaskCanvasUIView.handleUndoTap(_:)))
        undo.numberOfTouchesRequired = 2
        undo.delegate = view
        view.addGestureRecognizer(undo)
        let redo = UITapGestureRecognizer(target: view, action: #selector(MaskCanvasUIView.handleRedoTap(_:)))
        redo.numberOfTouchesRequired = 3
        redo.delegate = view
        view.addGestureRecognizer(redo)
        let hover = UIHoverGestureRecognizer(target: view, action: #selector(MaskCanvasUIView.handleHover(_:)))
        view.addGestureRecognizer(hover)
        return view
    }

    func updateUIView(_ view: MaskCanvasUIView, context: Context) {
        view.sourceImage = sourceImage
        view.editor = editor
        view.baseLabels = baseLabels
        view.selectedLabel = selectedLabel
        view.brushDiameter = brushDiameter
        view.maskOpacity = maskOpacity
        view.viewMode = viewMode
        view.isEditable = isEditable
        view.navigationResetToken = navigationResetToken
        view.onStrokeBegan = onStrokeBegan
        view.onStrokeFinished = onStrokeFinished
        view.onUndo = onUndo
        view.onRedo = onRedo
        view.setNeedsDisplay()
    }
}

final class MaskCanvasUIView: UIView, UIGestureRecognizerDelegate {
    private struct OverlayTile {
        let image: UIImage
        let width: Int
        let height: Int
    }

    private static let checkerBackground: UIColor = {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24), format: UIGraphicsImageRendererFormat.default())
        let image = renderer.image { context in
            UIColor(red: 0.039, green: 0.059, blue: 0.055, alpha: 1).setFill()
            context.cgContext.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
            UIColor(red: 0.063, green: 0.094, blue: 0.086, alpha: 1).setFill()
            context.cgContext.fill(CGRect(x: 0, y: 0, width: 12, height: 12))
            context.cgContext.fill(CGRect(x: 12, y: 12, width: 12, height: 12))
        }
        return UIColor(patternImage: image)
    }()

    var sourceImage: UIImage? { didSet { setNeedsDisplay() } }
    var editor: MaskRasterEditor? {
        didSet {
            if oldValue !== editor {
                oldValue?.cancelStroke()
                activeTouch = nil
                strokeActive = false
                invalidateOverlay()
                zoomScale = 1
                panOffset = .zero
            }
            setNeedsDisplay()
        }
    }
    var baseLabels: [UInt8] = []
    var selectedLabel: UInt8?
    var brushDiameter = 32.0
    var maskOpacity = 0.65 { didSet { setNeedsDisplay() } }
    var viewMode: HorizonScribeCanvasMode = .result { didSet { if oldValue != viewMode { invalidateOverlay(); setNeedsDisplay() } } }
    var isEditable = false
    var navigationResetToken = 0 {
        didSet { if oldValue != navigationResetToken { resetNavigation() } }
    }
    var onStrokeBegan: (() -> Void)?
    var onStrokeFinished: ((Bool) -> Void)?
    var onUndo: (() -> Void)?
    var onRedo: (() -> Void)?

    private var strokeActive = false
    private var activeTouch: UITouch?
    private let overlayTileSize = 256
    private var overlayRevision = -1
    private var overlayWidth = 0
    private var overlayHeight = 0
    private var overlayColumns = 0
    private var overlayRows = 0
    private var overlayTiles: [Int: OverlayTile] = [:]
    private var renderedOpacity = -1.0
    private var renderedMode: HorizonScribeCanvasMode?
    private var pendingOverlayBounds: MaskRasterBounds?
    private var pendingOverlayBaseRevision: Int?
    private var pendingOverlayTargetRevision: Int?
    private var zoomScale: CGFloat = 1
    private var panOffset = CGPoint.zero
    private var panOrigin = CGPoint.zero
    private var pinchOriginScale: CGFloat = 1
    private var pinchAnchor = CGPoint.zero
    private var pinchAnchorFraction = CGPoint.zero
    private var cursorPoint: CGPoint?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        isMultipleTouchEnabled = true
    }

    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        Self.checkerBackground.setFill()
        context.fill(bounds)
        guard let sourceImage, let editor else { return }

        let imageRect = fittedRect(width: editor.width, height: editor.height)
        sourceImage.draw(in: imageRect)
        synchronizeOverlay(with: editor)
        drawOverlay(in: imageRect, dirtyRect: rect, context: context)
        if isEditable, let cursorPoint {
            let radius = CGFloat(brushDiameter / 2) * imageRect.width / CGFloat(editor.width)
            context.saveGState()
            context.setStrokeColor(UIColor(red: 0.847, green: 1, blue: 0.349, alpha: 1).cgColor)
            context.setFillColor(UIColor(red: 0.847, green: 1, blue: 0.349, alpha: 0.12).cgColor)
            context.setLineWidth(2)
            let cursor = CGRect(x: cursorPoint.x - radius, y: cursorPoint.y - radius, width: radius * 2, height: radius * 2)
            context.fillEllipse(in: cursor)
            context.strokeEllipse(in: cursor)
            context.restoreGState()
        }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard (event?.allTouches?.filter { $0.phase != .ended && $0.phase != .cancelled }.count ?? 1) == 1 else {
            finishStroke(cancel: true)
            return
        }
        guard isEditable, !strokeActive, let touch = touches.first,
              touch.type == .pencil || touch.type == .indirectPointer,
              let editor else { return }
        do {
            try editor.beginStroke(label: selectedLabel, radius: max(0.5, brushDiameter / 2))
            strokeActive = true
            activeTouch = touch
            onStrokeBegan?()
            apply([touch], to: editor)
        } catch {
            onStrokeFinished?(false)
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard strokeActive, let touch = activeTouch, touches.contains(touch), let editor else { return }
        apply(event?.coalescedTouches(for: touch) ?? [touch], to: editor)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = activeTouch, touches.contains(touch) else { return }
        if let editor { apply([touch], to: editor) }
        finishStroke(cancel: false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        finishStroke(cancel: true)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }

    @objc func handlePinch(_ gesture: UIPinchGestureRecognizer) {
        if gesture.state == .began {
            finishStroke(cancel: true)
            let rect = fittedRect(width: editor?.width ?? 1, height: editor?.height ?? 1)
            guard rect.width > 0, rect.height > 0 else { return }
            pinchOriginScale = zoomScale
            pinchAnchor = gesture.location(in: self)
            pinchAnchorFraction = CGPoint(
                x: (pinchAnchor.x - rect.minX) / rect.width,
                y: (pinchAnchor.y - rect.minY) / rect.height
            )
        } else if gesture.state == .changed {
            zoomScale = min(64, max(0.02, pinchOriginScale * gesture.scale))
            let size = fittedSize(width: editor?.width ?? 1, height: editor?.height ?? 1)
            let scaled = CGSize(width: size.width * zoomScale, height: size.height * zoomScale)
            panOffset = CGPoint(
                x: pinchAnchor.x - pinchAnchorFraction.x * scaled.width - (bounds.midX - scaled.width / 2),
                y: pinchAnchor.y - pinchAnchorFraction.y * scaled.height - (bounds.midY - scaled.height / 2)
            )
            setNeedsDisplay()
        }
    }

    @objc func handlePan(_ gesture: UIPanGestureRecognizer) {
        if gesture.state == .began { finishStroke(cancel: true); panOrigin = panOffset }
        if gesture.state == .changed {
            let translation = gesture.translation(in: self)
            panOffset = CGPoint(x: panOrigin.x + translation.x, y: panOrigin.y + translation.y)
            setNeedsDisplay()
        }
    }

    @objc func handleUndoTap(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended, isEditable else { return }
        onUndo?()
    }

    @objc func handleRedoTap(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended, isEditable else { return }
        onRedo?()
    }

    @objc func handleHover(_ gesture: UIHoverGestureRecognizer) {
        if gesture.state == .began || gesture.state == .changed {
            let point = gesture.location(in: self)
            let imageRect = fittedRect(width: editor?.width ?? 1, height: editor?.height ?? 1)
            cursorPoint = imageRect.contains(point) ? point : nil
        } else {
            cursorPoint = nil
        }
        setNeedsDisplay()
    }

    private func apply(_ touches: [UITouch], to editor: MaskRasterEditor) {
        guard !touches.isEmpty else { return }
        let imageRect = fittedRect(width: editor.width, height: editor.height)
        guard imageRect.width > 0, imageRect.height > 0 else { return }
        let previousCursor = cursorPoint
        let points = touches.map { touch -> (x: Double, y: Double) in
            let viewPoint = touch.location(in: self)
            cursorPoint = viewPoint
            return (
                Double((viewPoint.x - imageRect.minX) * CGFloat(editor.width) / imageRect.width),
                Double((viewPoint.y - imageRect.minY) * CGFloat(editor.height) / imageRect.height)
            )
        }
        let changed = (try? editor.extendStroke(points: points)) == true
        var dirtyRect = cursorDisplayRect(at: previousCursor, editor: editor)
            .union(cursorDisplayRect(at: cursorPoint, editor: editor))
        if changed,
           editor.lastMutationRevision == editor.revision,
           let changedBounds = editor.lastMutationBounds {
            accumulateOverlayMutation(changedBounds, targetRevision: editor.revision)
            dirtyRect = dirtyRect.union(displayRect(for: changedBounds, editor: editor))
        }
        setNeedsDisplay(dirtyRect.intersection(bounds))
    }

    private func finishStroke(cancel: Bool) {
        guard strokeActive, let editor else { return }
        strokeActive = false
        activeTouch = nil
        if cancel {
            let previousRevision = editor.revision
            editor.cancelStroke()
            if editor.revision != previousRevision,
               editor.lastMutationRevision == editor.revision,
               let changedBounds = editor.lastMutationBounds {
                accumulateOverlayMutation(changedBounds, targetRevision: editor.revision)
            }
            onStrokeFinished?(false)
        } else {
            let changed = (try? editor.finishStroke()) ?? false
            onStrokeFinished?(changed)
        }
        setNeedsDisplay()
    }

    private func fittedRect(width: Int, height: Int) -> CGRect {
        let fit = fittedSize(width: width, height: height)
        let size = CGSize(width: fit.width * zoomScale, height: fit.height * zoomScale)
        return CGRect(x: bounds.midX + panOffset.x - size.width / 2, y: bounds.midY + panOffset.y - size.height / 2, width: size.width, height: size.height)
    }

    private func fittedSize(width: Int, height: Int) -> CGSize {
        let availableWidth = max(1, bounds.width - 56)
        let availableHeight = max(1, bounds.height - 56)
        let scale = min(availableWidth / CGFloat(width), availableHeight / CGFloat(height), 1)
        return CGSize(width: CGFloat(width) * scale, height: CGFloat(height) * scale)
    }

    private func resetNavigation() {
        zoomScale = 1
        panOffset = .zero
        setNeedsDisplay()
    }

    private func invalidateOverlay() {
        overlayRevision = -1
        overlayWidth = 0
        overlayHeight = 0
        overlayColumns = 0
        overlayRows = 0
        overlayTiles.removeAll(keepingCapacity: true)
        renderedOpacity = -1
        renderedMode = nil
        pendingOverlayBounds = nil
        pendingOverlayBaseRevision = nil
        pendingOverlayTargetRevision = nil
    }

    private func synchronizeOverlay(with editor: MaskRasterEditor) {
        guard viewMode != .source else {
            if !overlayTiles.isEmpty { invalidateOverlay() }
            overlayRevision = editor.revision
            return
        }
        let configurationChanged = overlayWidth != editor.width
            || overlayHeight != editor.height
            || renderedOpacity != maskOpacity
            || renderedMode != viewMode
        if configurationChanged {
            rebuildFullOverlay(with: editor)
            return
        }
        guard overlayRevision != editor.revision else { return }

        if pendingOverlayBaseRevision == overlayRevision,
           pendingOverlayTargetRevision == editor.revision,
           let pendingOverlayBounds {
            rebuildOverlayTiles(intersecting: pendingOverlayBounds, with: editor)
        } else if editor.lastMutationRevision == editor.revision,
                  editor.revision == overlayRevision + 1,
                  let changedBounds = editor.lastMutationBounds {
            rebuildOverlayTiles(intersecting: changedBounds, with: editor)
        } else {
            rebuildFullOverlay(with: editor)
            return
        }
        overlayRevision = editor.revision
        clearPendingOverlayMutation()
    }

    private func rebuildFullOverlay(with editor: MaskRasterEditor) {
        let pixels = editor.pixels
        overlayWidth = editor.width
        overlayHeight = editor.height
        overlayColumns = (editor.width + overlayTileSize - 1) / overlayTileSize
        overlayRows = (editor.height + overlayTileSize - 1) / overlayTileSize
        renderedOpacity = maskOpacity
        renderedMode = viewMode
        overlayTiles.removeAll(keepingCapacity: true)
        for tileY in 0..<overlayRows {
            for tileX in 0..<overlayColumns {
                rebuildOverlayTile(x: tileX, y: tileY, pixels: pixels)
            }
        }
        overlayRevision = editor.revision
        clearPendingOverlayMutation()
    }

    private func rebuildOverlayTiles(intersecting bounds: MaskRasterBounds, with editor: MaskRasterEditor) {
        let pixels = editor.pixels
        let minTileX = max(0, bounds.minX / overlayTileSize)
        let minTileY = max(0, bounds.minY / overlayTileSize)
        let maxTileX = min(overlayColumns - 1, bounds.maxX / overlayTileSize)
        let maxTileY = min(overlayRows - 1, bounds.maxY / overlayTileSize)
        guard minTileX <= maxTileX, minTileY <= maxTileY else { return }
        for tileY in minTileY...maxTileY {
            for tileX in minTileX...maxTileX {
                rebuildOverlayTile(x: tileX, y: tileY, pixels: pixels)
            }
        }
    }

    private func rebuildOverlayTile(x tileX: Int, y tileY: Int, pixels: [UInt8]) {
        let key = tileY * overlayColumns + tileX
        if let image = makeOverlayTile(x: tileX, y: tileY, pixels: pixels) {
            overlayTiles[key] = OverlayTile(
                image: UIImage(cgImage: image),
                width: image.width,
                height: image.height
            )
        } else {
            overlayTiles.removeValue(forKey: key)
        }
    }

    private func makeOverlayTile(x tileX: Int, y tileY: Int, pixels: [UInt8]) -> CGImage? {
        let originX = tileX * overlayTileSize
        let originY = tileY * overlayTileSize
        let tileWidth = min(overlayTileSize, overlayWidth - originX)
        let tileHeight = min(overlayTileSize, overlayHeight - originY)
        guard tileWidth > 0, tileHeight > 0 else { return nil }
        let byteCount = tileWidth * tileHeight * 4
        let storage = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 64)
        storage.initializeMemory(as: UInt8.self, repeating: 0, count: byteCount)
        let rgba = storage.assumingMemoryBound(to: UInt8.self)
        let alpha = UInt8((min(1, max(0, maskOpacity)) * 255).rounded())
        let softAlpha = UInt8((Double(alpha) * 0.52).rounded())
        let strongAlpha = UInt8(min(245, Int(alpha) + 35))
        let labels = baseLabels
        let hasBaseLabels = labels.count == pixels.count
        let mode = viewMode
        var hasColor = false
        for localY in 0..<tileHeight {
            let sourceY = originY + localY
            for localX in 0..<tileWidth {
                let sourceX = originX + localX
                let index = sourceY * overlayWidth + sourceX
                let value = pixels[index]
                let baseLand = hasBaseLabels && labels[index] == MaskRasterEditor.land
                let offset = (localY * tileWidth + localX) * 4
                switch mode {
                case .source:
                    continue
                case .result:
                    let kept = value == MaskRasterEditor.land || (value == MaskRasterEditor.automatic && baseLand)
                    guard !kept else { continue }
                    if value == MaskRasterEditor.sky {
                        rgba[offset] = 156
                        rgba[offset + 1] = 131
                        rgba[offset + 2] = 255
                    } else {
                        rgba[offset] = 255
                        rgba[offset + 1] = 48
                        rgba[offset + 2] = 48
                    }
                    rgba[offset + 3] = alpha
                case .labels:
                    if value == MaskRasterEditor.automatic {
                        guard !baseLand else { continue }
                        rgba[offset] = 255
                        rgba[offset + 1] = 122
                        rgba[offset + 2] = 97
                        rgba[offset + 3] = softAlpha
                    } else {
                        if value == MaskRasterEditor.land {
                            rgba[offset] = 125
                            rgba[offset + 1] = 255
                            rgba[offset + 2] = 146
                        } else if value == MaskRasterEditor.sea {
                            rgba[offset] = 33
                            rgba[offset + 1] = 212
                            rgba[offset + 2] = 208
                        } else {
                            rgba[offset] = 156
                            rgba[offset + 1] = 131
                            rgba[offset + 2] = 255
                        }
                        rgba[offset + 3] = strongAlpha
                    }
                }
                hasColor = true
            }
        }
        guard hasColor else {
            storage.deallocate()
            return nil
        }
        guard let provider = CGDataProvider(
            dataInfo: nil,
            data: storage,
            size: byteCount,
            releaseData: { _, data, _ in UnsafeMutableRawPointer(mutating: data).deallocate() }
        ) else {
            storage.deallocate()
            return nil
        }
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        return CGImage(
            width: tileWidth,
            height: tileHeight,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: tileWidth * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: info,
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    private func drawOverlay(in imageRect: CGRect, dirtyRect: CGRect, context: CGContext) {
        guard viewMode != .source, overlayWidth > 0, overlayHeight > 0 else { return }
        context.saveGState()
        context.interpolationQuality = .none
        for (key, tile) in overlayTiles {
            let tileX = key % overlayColumns
            let tileY = key / overlayColumns
            let sourceX = tileX * overlayTileSize
            let sourceY = tileY * overlayTileSize
            let destination = CGRect(
                x: imageRect.minX + CGFloat(sourceX) * imageRect.width / CGFloat(overlayWidth),
                y: imageRect.minY + CGFloat(sourceY) * imageRect.height / CGFloat(overlayHeight),
                width: CGFloat(tile.width) * imageRect.width / CGFloat(overlayWidth),
                height: CGFloat(tile.height) * imageRect.height / CGFloat(overlayHeight)
            )
            guard destination.intersects(dirtyRect) else { continue }
            tile.image.draw(in: destination)
        }
        context.restoreGState()
    }

    private func accumulateOverlayMutation(_ bounds: MaskRasterBounds, targetRevision: Int) {
        if pendingOverlayBaseRevision == nil { pendingOverlayBaseRevision = overlayRevision }
        if pendingOverlayBounds == nil {
            pendingOverlayBounds = bounds
        } else {
            pendingOverlayBounds?.formUnion(bounds)
        }
        pendingOverlayTargetRevision = targetRevision
    }

    private func clearPendingOverlayMutation() {
        pendingOverlayBounds = nil
        pendingOverlayBaseRevision = nil
        pendingOverlayTargetRevision = nil
    }

    private func displayRect(for bounds: MaskRasterBounds, editor: MaskRasterEditor) -> CGRect {
        let imageRect = fittedRect(width: editor.width, height: editor.height)
        return CGRect(
            x: imageRect.minX + CGFloat(bounds.minX) * imageRect.width / CGFloat(editor.width),
            y: imageRect.minY + CGFloat(bounds.minY) * imageRect.height / CGFloat(editor.height),
            width: CGFloat(bounds.maxX - bounds.minX + 1) * imageRect.width / CGFloat(editor.width),
            height: CGFloat(bounds.maxY - bounds.minY + 1) * imageRect.height / CGFloat(editor.height)
        ).insetBy(dx: -3, dy: -3)
    }

    private func cursorDisplayRect(at point: CGPoint?, editor: MaskRasterEditor) -> CGRect {
        guard let point else { return .null }
        let imageRect = fittedRect(width: editor.width, height: editor.height)
        let radius = CGFloat(brushDiameter / 2) * imageRect.width / CGFloat(editor.width) + 3
        return CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
    }
}
