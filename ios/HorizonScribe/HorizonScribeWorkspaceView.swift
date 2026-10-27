import HorizonScribeCore
import SwiftUI

private enum ReviewQueue: String {
    case next = "Next Pass"
    case completed = "Completed"
}

private struct ReviewJob: Identifiable {
    let set: HorizonScribeSet
    let image: HorizonScribeImage
    var id: String { "\(set.id)/\(image.name)" }
}

struct HorizonScribeWorkspaceView: View {
    @EnvironmentObject private var session: HorizonScribeSession
    @State private var queue: ReviewQueue = .next
    @State private var isEditing = false
    @State private var previewOpacity = 0.62
    @State private var navigationResetToken = 0
    @State private var showsReloadConfirmation = false
    @State private var showsEditorHelp = false

    private var nextPass: [ReviewJob] {
        session.catalog?.resolvedNextPass.map { ReviewJob(set: $0.set, image: $0.image) } ?? []
    }

    private var completed: [ReviewJob] {
        session.catalog?.sets.flatMap { set in
            set.images.filter(\.approved).map { ReviewJob(set: set, image: $0) }
        } ?? []
    }

    private var selectedJob: ReviewJob? {
        (queue == .next ? nextPass : completed).first {
            $0.set.id == session.currentSetID && $0.image.name == session.currentImageName
        }
    }

    var body: some View {
        Group {
            if isEditing {
                editor
            } else {
                HStack(spacing: 0) {
                    sidebar
                        .frame(width: 320)
                    Divider().overlay(Color.horizonScribeLine)
                    preview
                }
            }
        }
        .background(Color.horizonScribeBackground)
        .confirmationDialog(
            "Discard local changes and reload the saved revision?",
            isPresented: $showsReloadConfirmation,
            titleVisibility: .visible
        ) {
            Button("Discard and reload", role: .destructive) {
                Task { await session.reloadCurrentReviewDiscardingDraft() }
            }
            Button("Cancel", role: .cancel) { }
        }
        .sheet(isPresented: $showsEditorHelp) { editorHelp }
    }

    private var sidebar: some View {
        VStack(spacing: 14) {
            HStack(spacing: 0) {
                queueTab(.next)
                queueTab(.completed)
            }
            .overlay(alignment: .bottom) { Rectangle().fill(Color.horizonScribeLine).frame(height: 1) }

            if queue == .next {
                Text(nextPassProgress)
                    .font(.title2.bold().monospacedDigit())
                    .foregroundStyle(.white)

                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(nextPass.enumerated()), id: \.element.id) { index, job in
                            queueRow(job, number: index + 1)
                        }
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 1).stroke(Color.horizonScribeLine))
            } else {
                ScrollView {
                    LazyVGrid(
                        columns: [
                            GridItem(.flexible(), spacing: 8),
                            GridItem(.flexible(), spacing: 8)
                        ],
                        spacing: 8
                    ) {
                        ForEach(completed) { job in
                            HorizonScribeCompletedThumbnail(
                                job: job,
                                selected: job.id == selectedJob?.id
                            )
                        }
                    }
                    .padding(8)
                }
                .overlay(RoundedRectangle(cornerRadius: 1).stroke(Color.horizonScribeLine))
            }

            Button("Edit") {
                isEditing = true
                Task { await session.prepareFullResolutionPhoto() }
            }
                .buttonStyle(HorizonScribePrimaryButtonStyle())
                .frame(maxWidth: .infinity)
                .disabled(session.currentEditor == nil)

            VStack(alignment: .leading, spacing: 5) {
                if session.isCachingOffline {
                    ProgressView(value: Double(session.offlineCacheCompleted), total: Double(max(1, session.offlineCacheTotal)))
                        .tint(Color.horizonScribeSea)
                    Text("Keeping review library offline · \(session.offlineCacheCompleted)/\(session.offlineCacheTotal)")
                } else if session.offlineCacheTotal > 0 {
                    Label("\(session.offlineCacheCompleted) review photos offline", systemImage: "arrow.down.circle.fill")
                } else if session.isOffline {
                    Label("Offline", systemImage: "wifi.slash")
                }
            }
            .font(.caption)
            .foregroundStyle(Color.horizonScribeMuted)

            HStack {
                Button {
                    Task { await session.refreshAccess() }
                } label: {
                    Label("Refresh queue", systemImage: "arrow.clockwise")
                }
                Spacer()
                Button("Sign out") { Task { await session.signOut() } }
            }
            .foregroundStyle(Color.horizonScribeMuted)
            .frame(minHeight: 44)
            .disabled(session.isBusy || session.isSavingReview)
        }
        .padding(16)
        .background(Color.horizonScribePanel)
    }

    private func queueTab(_ value: ReviewQueue) -> some View {
        Button {
            queue = value
            isEditing = false
            selectDefault(for: value)
        } label: {
            Text(value.rawValue)
                .fontWeight(.bold)
                .foregroundStyle(queue == value ? .white : Color.horizonScribeMuted)
                .frame(maxWidth: .infinity, minHeight: 48)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(queue == value ? Color.horizonScribeLime : .clear).frame(height: 3)
                }
        }
        .buttonStyle(.plain)
    }

    private func queueRow(_ job: ReviewJob, number: Int) -> some View {
        let selected = job.id == selectedJob?.id
        return Button {
            isEditing = false
            Task { await session.selectImage(job.image.name, in: job.set.id) }
        } label: {
            HStack(spacing: 10) {
                Text(String(format: "%02d", number))
                    .foregroundStyle(Color.horizonScribeMuted)
                    .monospacedDigit()
                    .frame(width: 30, alignment: .leading)
                Text(job.set.label.isEmpty ? job.set.id : job.set.label)
                    .fontWeight(.bold)
                    .lineLimit(1)
                Spacer()
                Text(job.image.approved ? "✓" : "□")
                    .font(.title3)
                    .foregroundStyle(Color.horizonScribeSea)
            }
            .foregroundStyle(selected ? Color.horizonScribeLime : .white)
            .padding(.horizontal, 10)
            .frame(minHeight: 50)
            .background(selected ? Color(red: 0.078, green: 0.125, blue: 0.098) : .clear)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.horizonScribeLine).frame(height: 1) }
        }
        .buttonStyle(.plain)
        .disabled(session.isLoadingImage || session.isSavingReview)
    }

    private var preview: some View {
        VStack(spacing: 0) {
            canvas(
                editable: false,
                mode: .result,
                opacity: previewOpacity
            )
            if session.currentEditor != nil {
                HStack {
                    Slider(value: $previewOpacity, in: 0...1)
                        .tint(Color.horizonScribeLime)
                    Text("\(Int(previewOpacity * 100))%")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Color.horizonScribeMuted)
                }
                .padding(.horizontal, 20)
                .frame(height: 58)
                .background(Color.horizonScribePanel)
                .overlay(alignment: .top) { Rectangle().fill(Color.horizonScribeLine).frame(height: 1) }
            }
        }
    }

    private var editor: some View {
        VStack(spacing: 0) {
            editorActions
            HStack(spacing: 0) {
                toolRail
                canvas(editable: true, mode: .result)
            }
        }
    }

    private var editorActions: some View {
        HStack(spacing: 6) {
            Button("Review") { isEditing = false; session.showPreviewPhoto() }
                .buttonStyle(HorizonScribeEditorActionButtonStyle())
            Button("Fit") { navigationResetToken &+= 1 }
                .buttonStyle(HorizonScribeEditorActionButtonStyle())
            Button("Undo") { undo() }
                .buttonStyle(HorizonScribeEditorActionButtonStyle())
                .disabled(session.currentEditor?.canUndo != true || session.hasRevisionConflict)
            Button("Redo") { redo() }
                .buttonStyle(HorizonScribeEditorActionButtonStyle())
                .disabled(session.currentEditor?.canRedo != true || session.hasRevisionConflict)
            Button("Reload") { showsReloadConfirmation = true }
                .buttonStyle(HorizonScribeEditorActionButtonStyle())
            Spacer()
            Button { showsEditorHelp = true } label: {
                Image(systemName: "info.circle")
                    .font(.system(size: 18, weight: .semibold))
            }
            .buttonStyle(HorizonScribeEditorActionButtonStyle())
            .accessibilityLabel("Editor help")
            Button(session.isSavingReview ? "Saving…" : (session.isOffline ? "Save Offline" : "Save")) {
                Task { await session.saveCurrentReview(approve: true) }
            }
            .buttonStyle(HorizonScribeEditorActionButtonStyle(primary: true))
            .disabled(
                session.isSavingReview || session.isLoadingImage || session.hasRevisionConflict
                    || (session.currentApproved && !session.hasPendingChanges)
            )
        }
        .padding(.horizontal, 12)
        .frame(height: 56)
        .background(Color.horizonScribePanel)
        .overlay(alignment: .bottom) { Rectangle().fill(Color.horizonScribeLine).frame(height: 1) }
    }

    private var toolRail: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(spacing: 8) {
                labelButton("water.waves", label: MaskRasterEditor.sea, name: "Water", color: Color.horizonScribeSea)
                labelButton("cloud.fill", label: MaskRasterEditor.sky, name: "Cloud or sky", color: Color.horizonScribeSky)
                labelButton("mountain.2.fill", label: MaskRasterEditor.land, name: "Land", color: Color.horizonScribeLand)

                sliderControl(symbol: "circle.dotted") {
                    HorizonScribeVerticalSlider(
                        value: $session.brushDiameter,
                        range: 2...256,
                        step: 1,
                        logarithmic: true,
                        accessibilityLabel: "Brush size",
                        accessibilityValue: { "\(Int($0)) pixels" }
                    )
                }
                sliderControl(symbol: "eye") {
                    HorizonScribeVerticalSlider(
                        value: $session.maskOpacity,
                        range: 0...1,
                        step: 0.01,
                        logarithmic: false,
                        accessibilityLabel: "Overlay opacity",
                        accessibilityValue: { "\(Int(($0 * 100).rounded())) percent" }
                    )
                }
            }
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
        }
        .frame(width: 64)
        .background(Color.horizonScribePanel)
        .overlay(alignment: .trailing) { Rectangle().fill(Color.horizonScribeLine).frame(width: 1) }
        .disabled(session.isSavingReview || session.isLoadingImage || session.hasRevisionConflict)
    }

    private func sliderControl<Content: View>(symbol: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 4) {
            Image(systemName: symbol)
                .font(.system(size: 18))
                .foregroundStyle(Color.horizonScribeMuted)
                .frame(width: 28, height: 24)
            content()
                .frame(width: 44, height: 248)
        }
    }

    @ViewBuilder private func canvas(editable: Bool, mode: HorizonScribeCanvasMode, opacity: Double? = nil) -> some View {
        ZStack {
            Color(red: 0.012, green: 0.027, blue: 0.024)
            if let editor = session.currentEditor, let photo = session.currentPhoto {
                HorizonScribeCanvasView(
                    editor: editor,
                    sourceImage: photo,
                    baseLabels: session.currentBaseLabels,
                    selectedLabel: session.selectedLabel,
                    brushDiameter: session.brushDiameter,
                    maskOpacity: opacity ?? session.maskOpacity,
                    viewMode: mode,
                    isEditable: editable && !session.hasRevisionConflict,
                    navigationResetToken: navigationResetToken,
                    onStrokeBegan: { session.editingBegan() },
                    onStrokeFinished: { changed in Task { await session.strokeFinished(changed: changed) } },
                    onUndo: undo,
                    onRedo: redo
                )
            } else if let photo = session.currentPhoto {
                Image(uiImage: photo)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .padding(28)
            } else if session.isLoadingImage {
                ProgressView("Loading…").tint(Color.horizonScribeLime).foregroundStyle(Color.horizonScribeMuted)
            } else {
                Text(session.status).foregroundStyle(Color.horizonScribeMuted).multilineTextAlignment(.center).padding()
            }
            if editable {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Text(session.isLoadingFullResolution ? "Preparing full resolution…" : session.status)
                            .font(.caption)
                            .foregroundStyle(session.hasRevisionConflict ? Color(red: 1, green: 0.55, blue: 0.46) : Color.horizonScribeMuted)
                            .lineLimit(2)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 32)
                            .background(Color.horizonScribePanel.opacity(0.94), in: RoundedRectangle(cornerRadius: 8))
                    }
                    .padding(12)
                }
                .allowsHitTesting(false)
            }
        }
    }

    private func labelButton(_ symbol: String, label: UInt8, name: String, color: Color) -> some View {
        let selected = session.selectedLabel == label
        return Button {
            session.selectedLabel = label
            session.isErasing = false
        } label: {
            Image(systemName: symbol).frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(selected ? color : Color.horizonScribeMuted)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(selected ? color : Color.horizonScribeLine)
                .frame(height: selected ? 3 : 1)
        }
        .accessibilityLabel(name)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var editorHelp: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    helpRow("water.waves", "Water", "Paint ocean or water pixels.", Color.horizonScribeSea)
                    helpRow("cloud.fill", "Cloud or sky", "Paint sky or cloud pixels.", Color.horizonScribeSky)
                    helpRow("mountain.2.fill", "Land", "Paint pixels that should remain land or structure.", Color.horizonScribeLand)
                    helpRow("circle.dotted", "Brush size", "Drag vertically. Size changes exponentially from 2 to 256 pixels.", Color.horizonScribeMuted)
                    helpRow("eye", "Overlay opacity", "Drag vertically to change mask visibility without changing labels.", Color.horizonScribeMuted)
                    Divider().overlay(Color.horizonScribeLine)
                    Text("Apple Pencil draws. One-finger drag pans. Pinch zooms. Two-finger tap undoes; three-finger tap redoes. Fit restores the full image.")
                        .foregroundStyle(Color.horizonScribeMuted)
                    Divider().overlay(Color.horizonScribeLine)
                    Text("Review returns to the queue. Reload discards local changes after confirmation. Save syncs the current labels and marks the photo complete; offline saves remain on this iPad until reconnection.")
                        .foregroundStyle(Color.horizonScribeMuted)
                }
                .padding(24)
            }
            .background(Color.horizonScribeBackground)
            .navigationTitle("Editor controls")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showsEditorHelp = false }
                }
            }
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.medium, .large])
    }

    private func helpRow(_ symbol: String, _ title: String, _ detail: String, _ color: Color) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 20))
                .foregroundStyle(color)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).fontWeight(.bold)
                Text(detail).foregroundStyle(Color.horizonScribeMuted)
            }
        }
    }

    private var nextPassProgress: String {
        "\(nextPass.filter { $0.image.approved }.count)/\(nextPass.count)"
    }

    private func selectDefault(for value: ReviewQueue) {
        let jobs = value == .next ? nextPass : completed
        let job = value == .next ? (jobs.first(where: { !$0.image.approved }) ?? jobs.first) : jobs.first
        guard let job else { return }
        Task { await session.selectImage(job.image.name, in: job.set.id) }
    }

    private func undo() {
        guard !session.hasRevisionConflict, session.currentEditor?.undo() == true else { return }
        Task { await session.strokeFinished(changed: true) }
    }

    private func redo() {
        guard !session.hasRevisionConflict, session.currentEditor?.redo() == true else { return }
        Task { await session.strokeFinished(changed: true) }
    }
}

private struct HorizonScribeCompletedThumbnail: View {
    @EnvironmentObject private var session: HorizonScribeSession
    let job: ReviewJob
    let selected: Bool
    @State private var thumbnail: UIImage?

    var body: some View {
        Button {
            guard !selected else { return }
            Task { await session.selectImage(job.image.name, in: job.set.id) }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                ZStack {
                    Color.horizonScribeBackground
                    if let thumbnail {
                        Image(uiImage: thumbnail)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        ProgressView()
                            .tint(Color.horizonScribeMuted)
                    }
                }
                .frame(height: 92)
                .clipped()

                Text(job.set.label.isEmpty ? job.image.name : job.set.label)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(selected ? Color.horizonScribeLime : .white)
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                    .background(Color.horizonScribePanel)
            }
            .clipShape(RoundedRectangle(cornerRadius: 3))
            .overlay {
                RoundedRectangle(cornerRadius: 3)
                    .stroke(selected ? Color.horizonScribeLime : Color.horizonScribeLine, lineWidth: selected ? 3 : 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(session.isLoadingImage || session.isSavingReview)
        .accessibilityLabel(job.set.label.isEmpty ? job.image.name : job.set.label)
        .accessibilityValue(selected ? "Selected" : "")
        .task(id: job.id) {
            thumbnail = await session.localPhotoThumbnail(setID: job.set.id, imageName: job.image.name)
        }
    }
}

private struct HorizonScribeEditorActionButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(primary ? Color.horizonScribeLime : .white)
            .padding(.horizontal, 11)
            .frame(minWidth: 52, minHeight: 44)
            .background(configuration.isPressed ? Color.horizonScribeBackground : .clear)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(primary ? Color.horizonScribeLime : Color.horizonScribeLine)
                    .frame(height: primary ? 2 : 1)
            }
            .opacity(isEnabled ? 1 : 0.38)
    }
}

private struct HorizonScribeVerticalSlider: View {
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let logarithmic: Bool
    let accessibilityLabel: String
    let accessibilityValue: (Double) -> String

    var body: some View {
        GeometryReader { geometry in
            let height = max(44, geometry.size.height)
            let trackHeight = max(1, height - 44)
            let progress = fraction(for: value)
            let thumbY = height - 22 - trackHeight * progress

            ZStack {
                RoundedRectangle(cornerRadius: 13)
                    .fill(Color(red: 0.043, green: 0.125, blue: 0.153))
                    .overlay(RoundedRectangle(cornerRadius: 13).stroke(Color(red: 0.192, green: 0.318, blue: 0.353)))
                Capsule()
                    .fill(Color(red: 0.192, green: 0.318, blue: 0.353))
                    .frame(width: 2, height: trackHeight)
                VStack(spacing: 0) {
                    Spacer()
                    Capsule()
                        .fill(Color.horizonScribeSea)
                        .frame(width: 2, height: trackHeight * progress)
                        .padding(.bottom, 22)
                }
                RoundedRectangle(cornerRadius: 4)
                    .fill(Color.horizonScribeSea)
                    .frame(width: 28, height: 10)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color(red: 0.525, green: 0.918, blue: 0.871)))
                    .position(x: geometry.size.width / 2, y: thumbY)
            }
            .contentShape(RoundedRectangle(cornerRadius: 13))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { gesture in setValue(at: gesture.location.y, height: height) }
            )
        }
        .accessibilityElement()
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(accessibilityValue(value))
        .accessibilityAdjustableAction { direction in
            let delta: Double
            switch direction {
            case .increment: delta = 1
            case .decrement: delta = -1
            @unknown default: return
            }
            value = stepped(logarithmic ? value * pow(2, delta / 4) : value + delta * step)
        }
    }

    private func fraction(for value: Double) -> Double {
        let clamped = min(range.upperBound, max(range.lowerBound, value))
        if logarithmic, range.lowerBound > 0 {
            return log(clamped / range.lowerBound) / log(range.upperBound / range.lowerBound)
        }
        return (clamped - range.lowerBound) / (range.upperBound - range.lowerBound)
    }

    private func setValue(at y: CGFloat, height: CGFloat) {
        let trackHeight = max(1, height - 44)
        let progress = min(1, max(0, Double((height - 22 - y) / trackHeight)))
        let raw: Double
        if logarithmic, range.lowerBound > 0 {
            raw = range.lowerBound * exp(log(range.upperBound / range.lowerBound) * progress)
        } else {
            raw = range.lowerBound + (range.upperBound - range.lowerBound) * progress
        }
        value = stepped(raw)
    }

    private func stepped(_ raw: Double) -> Double {
        let rounded = range.lowerBound + ((raw - range.lowerBound) / step).rounded() * step
        return min(range.upperBound, max(range.lowerBound, rounded))
    }
}
