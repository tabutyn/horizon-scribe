import Foundation
import HorizonScribeCore
import Combine
import CoreFoundation
import ImageIO
import Security
import UIKit

@MainActor
final class HorizonScribeSession: ObservableObject {
    @Published private(set) var isBusy = false
    @Published private(set) var status = "Enter your Cloudflare Worker URL and API token."
    @Published private(set) var catalog: HorizonScribeCatalog?
    @Published private(set) var currentSetID: String?
    @Published private(set) var currentImageName: String?
    @Published private(set) var currentPhoto: UIImage?
    @Published private(set) var currentBaseLabels: [UInt8] = []
    @Published private(set) var currentEditor: MaskRasterEditor?
    @Published private(set) var currentReview: CloudReviewState?
    @Published private(set) var isLoadingImage = false
    @Published private(set) var isSavingReview = false
    @Published private(set) var isOffline = false
    @Published private(set) var hasRevisionConflict = false
    @Published private(set) var currentApproved = false
    @Published private(set) var isLoadingFullResolution = false
    @Published private(set) var isCachingOffline = false
    @Published private(set) var offlineCacheCompleted = 0
    @Published private(set) var offlineCacheTotal = 0
    @Published var selectedLabel = MaskRasterEditor.sea
    @Published var brushDiameter = 32.0
    @Published var maskOpacity = 0.58
    @Published var isErasing = false

    private let keychain = WorkerCredentialStore()
    private let draftStore = try? AnnotationDraftStore()
    private let offlineCache = try? HorizonScribeOfflineCache()
    private var accessToken = ""
    private var workerURL: URL?
    private var cloudAPI: HorizonScribeCloudAPI?
    private var draftLocalBaseRevision: String?
    private var draftCloudBaseRevision: String?
    private var currentPreviewPhoto: UIImage?
    private var currentPhotoData: Data?
    private var currentFullPhoto: UIImage?
    private var draftPersistenceTask: Task<Void, Never>?
    private let photoThumbnailCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 96
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()

    private var ownerUID: String? { workerURL?.absoluteString }
    var isSignedIn: Bool { cloudAPI != nil }
    var draftStorageAvailable: Bool { draftStore != nil }
    var hasPendingChanges: Bool {
        currentEditor?.isDirty == true || currentApproved != (currentReview?.correction.approved ?? false)
    }

    func restoreSession() async {
        guard let credentials = keychain.read() else { return }
        await connect(workerURL: credentials.workerURL, apiToken: credentials.apiToken)
    }

    func connect(workerURL value: String, apiToken token: String) async {
        guard !isBusy else { return }
        let trimmedURL = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmedURL), url.scheme?.lowercased() == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            status = "Worker URL must be a root HTTPS URL."
            return
        }
        guard trimmedToken.range(of: "^[A-Za-z0-9_-]{32,256}$", options: .regularExpression) != nil else {
            status = "API token must contain 32–256 URL-safe characters."
            return
        }
        isBusy = true
        defer { isBusy = false }
        guard await persistCurrentDraft() else { return }
        clearWorkspace()
        workerURL = url
        accessToken = trimmedToken
        cloudAPI = HorizonScribeCloudAPI(baseURL: url, token: trimmedToken)
        status = "Connecting to HorizonScribe…"
        do {
            try keychain.save(WorkerCredentials(workerURL: url.absoluteString, apiToken: trimmedToken))
            try await loadCatalog()
        } catch {
            if HorizonScribeIdentityError.permitsOfflineFallback(error), await restoreOfflineCatalog() { return }
            status = error.localizedDescription
        }
    }

    func refreshAccess() async {
        guard !isBusy, !isSavingReview, !isLoadingImage else { return }
        isBusy = true
        defer { isBusy = false }
        guard await persistCurrentDraft() else { return }
        do {
            guard cloudAPI != nil else {
                clearSession()
                throw HorizonScribeIdentityError.message("Connection settings are missing.")
            }
            try await loadCatalog()
        } catch {
            if HorizonScribeIdentityError.permitsOfflineFallback(error), await restoreOfflineCatalog() { return }
            status = error.localizedDescription
        }
    }

    func signOut() async {
        guard !isBusy, !isSavingReview, !isLoadingImage else { return }
        isBusy = true
        defer { isBusy = false }
        guard await persistCurrentDraft() else { return }
        clearSession()
        status = "Connection removed from this iPad."
    }

    private func clearSession() {
        keychain.delete()
        accessToken = ""
        workerURL = nil
        clearWorkspace()
    }

    private func clearWorkspace() {
        draftPersistenceTask?.cancel()
        draftPersistenceTask = nil
        catalog = nil
        currentSetID = nil
        currentImageName = nil
        currentPhoto = nil
        currentPreviewPhoto = nil
        currentPhotoData = nil
        currentFullPhoto = nil
        photoThumbnailCache.removeAllObjects()
        isLoadingFullResolution = false
        currentBaseLabels = []
        currentEditor = nil
        currentReview = nil
        currentApproved = false
        hasRevisionConflict = false
        draftLocalBaseRevision = nil
        draftCloudBaseRevision = nil
        isErasing = false
        isOffline = false
        isCachingOffline = false
        offlineCacheCompleted = 0
        offlineCacheTotal = 0
        cloudAPI = nil
    }

    func loadCatalog() async throws {
        guard let cloudAPI else { throw HorizonScribeIdentityError.message("HorizonScribe asset access is not ready.") }
        let value: HorizonScribeCatalog
        do {
            value = try await cloudAPI.catalog()
            isOffline = false
        } catch {
            guard HorizonScribeIdentityError.permitsOfflineFallback(error),
                  let ownerUID = self.ownerUID,
                  let cached = try await offlineCache?.loadCatalog(ownerUID: ownerUID) else { throw error }
            value = cached
            isOffline = true
        }
        guard value.schema == "horizon-scribe-cloud-catalog/v1", !value.sets.isEmpty else {
            throw HorizonScribeIdentityError.message("HorizonScribe catalog is empty or has an unsupported schema.")
        }
        guard value.hasValidExplicitNextPass else {
            throw HorizonScribeIdentityError.message("HorizonScribe Next Pass does not match this dataset or contains unresolved images.")
        }
        catalog = value
        if !isOffline, let ownerUID = self.ownerUID, let offlineCache {
            try? await offlineCache.saveCatalog(value, ownerUID: ownerUID)
        }
        let nextPass = Self.nextPass(in: value)
        let requested = value.sets.compactMap { set in
            set.images.first(where: { set.id == currentSetID && $0.name == currentImageName }).map { (set, $0) }
        }.first
        let initial = requested ?? nextPass.first(where: { !$0.1.approved }) ?? nextPass.first
            ?? value.sets.lazy.compactMap { set in set.images.first.map { (set, $0) } }.first
        guard let (initialSet, initialImage) = initial else {
            status = "Catalog contains no images."
            return
        }
        await selectImage(initialImage.name, in: initialSet.id)
        if !isOffline {
            Task { await self.cacheReviewLibraryForOffline() }
        }
    }

    func selectSet(_ setID: String) async {
        guard let set = catalog?.sets.first(where: { $0.id == setID }),
              let image = set.images.first(where: { !$0.approved }) ?? set.images.first else { return }
        await selectImage(image.name, in: set.id)
    }

    func selectImage(_ imageName: String, in setID: String? = nil, preserveDraft: Bool = true) async {
        guard !isLoadingImage, !isSavingReview,
              let targetSetID = setID ?? currentSetID ?? catalog?.sets.first?.id,
              catalog?.sets.first(where: { $0.id == targetSetID })?.images.contains(where: { $0.name == imageName }) == true,
              let ownerUID = self.ownerUID else { return }
        isLoadingImage = true
        defer { isLoadingImage = false }
        if preserveDraft, !(await persistCurrentDraft()) { return }
        hasRevisionConflict = false
        draftLocalBaseRevision = nil
        draftCloudBaseRevision = nil
        currentPhoto = nil
        currentPreviewPhoto = nil
        currentPhotoData = nil
        currentFullPhoto = nil
        isLoadingFullResolution = false
        currentBaseLabels = []
        currentEditor = nil
        currentReview = nil
        status = "Loading \(imageName)…"
        do {
            let state: CloudReviewState
            if !isOffline, let cloudAPI {
                do {
                    state = try await cloudAPI.imageState(datasetID: catalog?.datasetId ?? "", setID: targetSetID, imageName: imageName)
                    try? await offlineCache?.saveReviewState(state, ownerUID: ownerUID)
                } catch {
                    guard HorizonScribeIdentityError.permitsOfflineFallback(error),
                          let cached = try await offlineCache?.loadReviewState(ownerUID: ownerUID, datasetID: catalog?.datasetId ?? "", setID: targetSetID, imageName: imageName) else { throw error }
                    state = cached
                    isOffline = true
                }
            } else if let cached = try await offlineCache?.loadReviewState(ownerUID: ownerUID, datasetID: catalog?.datasetId ?? "", setID: targetSetID, imageName: imageName) {
                state = cached
                isOffline = true
            } else {
                throw HorizonScribeIdentityError.message("No cached image review state. Connect to R2 once to make this image available offline.")
            }
            guard state.schema == "horizon-scribe-cloud-review-state/v1",
                  state.datasetId == catalog?.datasetId, state.setId == targetSetID, state.image == imageName,
                  state.width > 0, state.height > 0,
                  state.width <= 8192, state.height <= 8192,
                  state.width == catalog?.sets.first(where: { $0.id == targetSetID })?.images.first(where: { $0.name == imageName })?.width,
                  state.height == catalog?.sets.first(where: { $0.id == targetSetID })?.images.first(where: { $0.name == imageName })?.height else {
                throw HorizonScribeIdentityError.message("Image dimensions do not match the R2 catalog.")
            }
            let photoData = try await loadAsset(ownerUID: ownerUID, datasetID: state.datasetId, setID: targetSetID, imageName: imageName, artifact: "photo")
            guard let photoDimensions = Self.imageDimensions(photoData),
                  photoDimensions.0 == state.width, photoDimensions.1 == state.height,
                  let previewPhoto = Self.decodeImage(photoData, maximumPixelSize: 1600) else {
                throw HorizonScribeIdentityError.message("Source image dimensions are unsupported or invalid.")
            }
            currentPhotoData = photoData
            currentPreviewPhoto = previewPhoto
            currentPhoto = previewPhoto
            let baseMask = try await loadAsset(ownerUID: ownerUID, datasetID: state.datasetId, setID: targetSetID, imageName: imageName, artifact: "baseMask")
            let baseLabels = try Self.decodeMask(baseMask, width: state.width, height: state.height)
                .map { $0 < 128 ? MaskRasterEditor.sea : MaskRasterEditor.land }
            let initialPixels: [UInt8]
            if state.correction.initialClassMask {
                let classMaskData = try await loadAsset(ownerUID: ownerUID, datasetID: state.datasetId, setID: targetSetID, imageName: imageName, artifact: "classMask")
                initialPixels = try Self.decodeMask(classMaskData, width: state.width, height: state.height)
                guard initialPixels.allSatisfy({ $0 <= MaskRasterEditor.sky }) else {
                    throw HorizonScribeIdentityError.message("Saved class mask contains an unknown label.")
                }
            } else {
                initialPixels = try MaskRasterEditor.decodeRows(state.correction.rows, width: state.width, height: state.height)
            }
            let editor = try MaskRasterEditor(width: state.width, height: state.height, initialPixels: initialPixels)
            currentSetID = targetSetID
            currentImageName = imageName
            currentBaseLabels = baseLabels
            currentReview = state
            currentEditor = editor
            currentApproved = state.correction.approved
            draftLocalBaseRevision = state.correction.localBaseRevision
            draftCloudBaseRevision = state.correction.revision
            if let ownerUID = self.ownerUID,
               let draftStore,
               let draft = try await draftStore.load(ownerUID: ownerUID, datasetID: state.datasetId, setID: targetSetID, imageName: imageName) {
                let localPixels = try MaskRasterEditor.decodeRows(draft.rows, width: state.width, height: state.height)
                try editor.replaceWorking(with: localPixels)
                currentApproved = draft.approved
                draftLocalBaseRevision = draft.localBaseRevision
                draftCloudBaseRevision = draft.cloudBaseRevision
                hasRevisionConflict = draft.localBaseRevision != state.correction.localBaseRevision
                    || draft.cloudBaseRevision != state.correction.revision
                status = hasRevisionConflict
                    ? "Revision conflict · local draft shown; rebase before syncing."
                    : "\(isOffline ? "Offline · restored" : "Restored") unsynced on-device draft."
            } else {
                status = "\(isOffline ? "Offline · cached" : "R2 · synced") · \(state.width) × \(state.height)."
            }
        } catch {
            status = error.localizedDescription
        }
    }

    func prepareFullResolutionPhoto() async {
        guard !isLoadingFullResolution,
              currentFullPhoto == nil,
              let data = currentPhotoData,
              let setID = currentSetID,
              let imageName = currentImageName else {
            if let currentFullPhoto { currentPhoto = currentFullPhoto }
            return
        }
        isLoadingFullResolution = true
        defer { isLoadingFullResolution = false }
        let decoded = await Task.detached(priority: .userInitiated) {
            Self.decodeImage(data, maximumPixelSize: nil)
        }.value
        guard setID == currentSetID, imageName == currentImageName, let decoded else { return }
        currentFullPhoto = decoded
        currentPhoto = decoded
    }

    func showPreviewPhoto() {
        if let currentPreviewPhoto { currentPhoto = currentPreviewPhoto }
    }

    /// Returns only an already-downloaded photo. Completed-grid scrolling never
    /// starts network work or decodes a full-resolution image.
    func localPhotoThumbnail(setID: String, imageName: String) async -> UIImage? {
        guard let ownerUID = self.ownerUID,
              let datasetID = catalog?.datasetId,
              let offlineCache else { return nil }
        let key = "\(ownerUID)/\(datasetID)/\(setID)/\(imageName)" as NSString
        if let cached = photoThumbnailCache.object(forKey: key) { return cached }
        guard let data = try? await offlineCache.loadAsset(
            ownerUID: ownerUID,
            datasetID: datasetID,
            setID: setID,
            imageName: imageName,
            artifact: "photo"
        ) else { return nil }
        let thumbnail = await Task.detached(priority: .utility) {
            Self.decodeImage(data, maximumPixelSize: 320)
        }.value
        guard let thumbnail,
              ownerUID == self.ownerUID,
              datasetID == catalog?.datasetId else { return nil }
        let cost = (thumbnail.cgImage?.bytesPerRow ?? 0) * (thumbnail.cgImage?.height ?? 0)
        photoThumbnailCache.setObject(thumbnail, forKey: key, cost: cost)
        return thumbnail
    }

    @discardableResult
    func persistCurrentDraft() async -> Bool {
        draftPersistenceTask?.cancel()
        draftPersistenceTask = nil
        guard let ownerUID = self.ownerUID,
              let datasetID = currentReview?.datasetId,
              let setID = currentSetID,
              let imageName = currentImageName,
              let editor = currentEditor,
              let review = currentReview else { return true }
        let needsSave = editor.isDirty || currentApproved != review.correction.approved || hasRevisionConflict
        guard let draftStore else {
            guard needsSave else { return true }
            status = "Local draft storage is unavailable; edits are not durable on this iPad."
            return false
        }
        let draft = AnnotationDocument(
            ownerUID: ownerUID,
            datasetID: datasetID,
            setID: setID,
            imageName: imageName,
            localBaseRevision: draftLocalBaseRevision,
            cloudBaseRevision: draftCloudBaseRevision,
            approved: currentApproved,
            rows: editor.encodedRows()
        )
        do {
            if needsSave {
                try await draftStore.save(draft)
                status = "Draft saved on this iPad."
            } else {
                try await draftStore.delete(ownerUID: ownerUID, datasetID: datasetID, setID: setID, imageName: imageName)
            }
            return true
        } catch {
            status = "Could not save local draft: \(error.localizedDescription)"
            return false
        }
    }

    func strokeFinished(changed: Bool) async {
        guard changed else { return }
        currentApproved = currentEditor?.isDirty == false
            ? (currentReview?.correction.approved ?? false)
            : false
        scheduleDraftPersistence()
    }

    func editingBegan() {
        draftPersistenceTask?.cancel()
        draftPersistenceTask = nil
    }

    private func scheduleDraftPersistence() {
        draftPersistenceTask?.cancel()
        draftPersistenceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000)
            guard !Task.isCancelled, let self else { return }
            self.draftPersistenceTask = nil
            _ = await self.persistCurrentDraft()
        }
    }

    func approveCurrentReview() async {
        await saveCurrentReview(approve: true)
    }

    func saveCurrentReview(approve: Bool = false) async {
        guard !isSavingReview, !isLoadingImage, !isBusy,
              let setID = currentSetID,
              let imageName = currentImageName,
              let review = currentReview,
              let editor = currentEditor else { return }
        guard !hasRevisionConflict else {
            status = "Revision conflict · rebase the local draft before syncing or approving."
            return
        }
        if approve { currentApproved = true }
        isSavingReview = true
        defer { isSavingReview = false }
        guard await persistCurrentDraft() else { return }
        guard !isOffline, let cloudAPI else {
            status = "Offline · draft saved on this iPad; reconnect to sync to R2."
            return
        }
        do {
            let edit = CloudReviewEdit(
                localBaseRevision: review.correction.localBaseRevision,
                cloudBaseRevision: review.correction.revision,
                approved: currentApproved,
                rows: try editor.encodedFullRows(resolvingAutomaticWith: currentBaseLabels)
            )
            let saved = try await cloudAPI.save(datasetID: review.datasetId, setID: setID, imageName: imageName, edit: edit)
            currentReview = saved
            currentApproved = saved.correction.approved
            draftLocalBaseRevision = saved.correction.localBaseRevision
            draftCloudBaseRevision = saved.correction.revision
            hasRevisionConflict = false
            editor.acceptCurrentAsBaseline(preservingHistory: true)
            if let ownerUID = self.ownerUID {
                try? await offlineCache?.saveReviewState(saved, ownerUID: ownerUID)
            }
            if let ownerUID = self.ownerUID, let draftStore {
                try? await draftStore.delete(ownerUID: ownerUID, datasetID: saved.datasetId, setID: setID, imageName: imageName)
            }
            if let refreshed = try? await cloudAPI.catalog() { catalog = refreshed }
            if let refreshed = catalog, let ownerUID = self.ownerUID {
                try? await offlineCache?.saveCatalog(refreshed, ownerUID: ownerUID)
            }
            status = saved.correction.approved ? "Review saved and approved in R2." : "Review saved in R2."
        } catch {
            if HorizonScribeIdentityError.isConflict(error) {
                hasRevisionConflict = true
                status = "Cloud revision changed elsewhere. Draft retained; rebase before syncing."
            } else {
                await persistCurrentDraft()
                status = "Cloud save failed; on-device draft retained. \(error.localizedDescription)"
            }
        }
    }

    func reloadCurrentReviewDiscardingDraft() async {
        guard !isLoadingImage, !isSavingReview,
              let ownerUID = self.ownerUID,
              let review = currentReview,
              let setID = currentSetID,
              let imageName = currentImageName else { return }
        if let draftStore {
            try? await draftStore.delete(
                ownerUID: ownerUID,
                datasetID: review.datasetId,
                setID: setID,
                imageName: imageName
            )
        }
        await selectImage(imageName, in: setID, preserveDraft: false)
    }

    func cacheReviewLibraryForOffline() async {
        guard !isCachingOffline, !isOffline,
              let catalog,
              let ownerUID = self.ownerUID,
              let cloudAPI,
              let offlineCache else { return }
        let jobs = Self.offlineReviewJobs(in: catalog)
        isCachingOffline = true
        offlineCacheCompleted = 0
        offlineCacheTotal = jobs.count
        defer { isCachingOffline = false }
        for (set, image) in jobs {
            if isOffline { break }
            do {
                if let cachedState = try await offlineCache.loadReviewState(
                    ownerUID: ownerUID,
                    datasetID: catalog.datasetId,
                    setID: set.id,
                    imageName: image.name
                ) {
                    let cachedArtifacts = cachedState.correction.initialClassMask
                        ? ["photo", "baseMask", "classMask"]
                        : ["photo", "baseMask"]
                    var complete = true
                    for artifact in cachedArtifacts where complete {
                        complete = try await offlineCache.hasAsset(
                            ownerUID: ownerUID,
                            datasetID: cachedState.datasetId,
                            setID: set.id,
                            imageName: image.name,
                            artifact: artifact
                        )
                    }
                    if complete {
                        offlineCacheCompleted += 1
                        continue
                    }
                }
                let state = try await cloudAPI.imageState(datasetID: catalog.datasetId, setID: set.id, imageName: image.name)
                try await offlineCache.saveReviewState(state, ownerUID: ownerUID)
                let artifacts = state.correction.initialClassMask
                    ? ["photo", "baseMask", "classMask"]
                    : ["photo", "baseMask"]
                for artifact in artifacts {
                    let data = try await cloudAPI.asset(
                        datasetID: state.datasetId,
                        setID: set.id,
                        imageName: image.name,
                        artifact: artifact
                    )
                    try await offlineCache.saveAsset(
                        data,
                        ownerUID: ownerUID,
                        datasetID: state.datasetId,
                        setID: set.id,
                        imageName: image.name,
                        artifact: artifact
                    )
                }
                offlineCacheCompleted += 1
            } catch {
                // Keep caching later jobs. The selected image still reports its own errors.
            }
        }
    }

    private static func nextPass(in catalog: HorizonScribeCatalog) -> [(HorizonScribeSet, HorizonScribeImage)] {
        catalog.resolvedNextPass.map { ($0.set, $0.image) }
    }

    private static func offlineReviewJobs(in catalog: HorizonScribeCatalog) -> [(HorizonScribeSet, HorizonScribeImage)] {
        var seen = Set<String>()
        return (nextPass(in: catalog) + catalog.sets.flatMap { set in
            set.images.filter(\.approved).map { (set, $0) }
        }).filter { set, image in
            seen.insert("\(set.id)/\(image.name)").inserted
        }
    }

    func rebaseCurrentDraft() async {
        guard hasRevisionConflict,
              !isSavingReview,
              !isOffline,
              let cloudAPI,
              let editor = currentEditor,
              let setID = currentSetID,
              let imageName = currentImageName else { return }
        isSavingReview = true
        defer { isSavingReview = false }
        let localPixels = editor.pixels
        let localApproval = currentApproved
        do {
            let latest = try await cloudAPI.imageState(datasetID: catalog?.datasetId ?? "", setID: setID, imageName: imageName)
            guard latest.schema == "horizon-scribe-cloud-review-state/v1",
                  latest.datasetId == currentReview?.datasetId, latest.setId == setID, latest.image == imageName,
                  latest.width == editor.width, latest.height == editor.height else {
                throw HorizonScribeIdentityError.message("Latest R2 review state has an unsupported schema.")
            }
            let remotePixels: [UInt8]
            if latest.correction.initialClassMask {
                guard let ownerUID = self.ownerUID else { throw HorizonScribeIdentityError.message("Reconnect before rebasing this draft.") }
                let mask = try await loadAsset(ownerUID: ownerUID, datasetID: latest.datasetId, setID: setID, imageName: imageName, artifact: "classMask")
                remotePixels = try Self.decodeMask(mask, width: latest.width, height: latest.height)
            } else {
                remotePixels = try MaskRasterEditor.decodeRows(latest.correction.rows, width: latest.width, height: latest.height)
            }
            try editor.replaceBaseline(with: remotePixels)
            try editor.replaceWorking(with: localPixels)
            currentReview = latest
            currentApproved = localApproval
            draftLocalBaseRevision = latest.correction.localBaseRevision
            draftCloudBaseRevision = latest.correction.revision
            hasRevisionConflict = false
            if let ownerUID = self.ownerUID {
                try? await offlineCache?.saveReviewState(latest, ownerUID: ownerUID)
                if editor.isDirty || currentApproved != latest.correction.approved {
                    await persistCurrentDraft()
                } else if let draftStore {
                    try? await draftStore.delete(ownerUID: ownerUID, datasetID: latest.datasetId, setID: setID, imageName: imageName)
                }
            }
            status = editor.isDirty || currentApproved != latest.correction.approved
                ? "Rebased on latest R2 revision. Review the overlay, then sync when ready."
                : "Local draft already matches R2; no changes remain."
        } catch {
            hasRevisionConflict = true
            status = "Could not rebase; local draft retained. \(error.localizedDescription)"
        }
    }

    private func restoreOfflineCatalog() async -> Bool {
        guard let ownerUID = self.ownerUID,
              let offlineCache,
              let value = try? await offlineCache.loadCatalog(ownerUID: ownerUID),
              let first = Self.nextPass(in: value).first(where: { !$0.1.approved })
                ?? Self.nextPass(in: value).first
                ?? value.sets.lazy.compactMap({ set in set.images.first.map { (set, $0) } }).first else { return false }
        catalog = value
        isOffline = true
        status = "Offline · loading last cached R2 catalog."
        await selectImage(first.1.name, in: first.0.id)
        return currentEditor != nil
    }

    private func loadAsset(ownerUID: String, datasetID: String, setID: String, imageName: String, artifact: String) async throws -> Data {
        if let cached = try? await offlineCache?.loadAsset(
            ownerUID: ownerUID,
            datasetID: datasetID,
            setID: setID,
            imageName: imageName,
            artifact: artifact
        ) {
            return cached
        }
        if !isOffline, let cloudAPI {
            let data = try await cloudAPI.asset(datasetID: datasetID, setID: setID, imageName: imageName, artifact: artifact)
            try? await offlineCache?.saveAsset(data, ownerUID: ownerUID, datasetID: datasetID, setID: setID, imageName: imageName, artifact: artifact)
            return data
        }
        throw HorizonScribeIdentityError.message("No cached \(artifact) image. Connect to R2 once to cache it for offline use.")
    }

    private static func decodeMask(_ data: Data, width: Int, height: Int) throws -> [UInt8] {
        guard let image = UIImage(data: data), let cgImage = image.cgImage,
              cgImage.width == width, cgImage.height == height,
              cgImage.bitsPerComponent == 8, cgImage.bitsPerPixel == 8,
              cgImage.colorSpace?.model == .monochrome,
              let providerData = cgImage.dataProvider?.data,
              let bytes = CFDataGetBytePtr(providerData) else {
            throw HorizonScribeIdentityError.message("Mask dimensions do not match the source image.")
        }
        var pixels = [UInt8](repeating: 0, count: width * height)
        let rowBytes = cgImage.bytesPerRow
        guard rowBytes >= width, CFDataGetLength(providerData) >= rowBytes * height else {
            throw HorizonScribeIdentityError.message("Mask pixel data is truncated.")
        }
        pixels.withUnsafeMutableBufferPointer { destination in
            guard let baseAddress = destination.baseAddress else { return }
            for row in 0..<height {
                baseAddress.advanced(by: row * width).update(from: bytes.advanced(by: row * rowBytes), count: width)
            }
        }
        return pixels
    }

    nonisolated private static func imageDimensions(_ data: Data) -> (Int, Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int else { return nil }
        return (width, height)
    }

    nonisolated private static func decodeImage(_ data: Data, maximumPixelSize: Int?) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [
            kCGImageSourceShouldCache: false
        ] as CFDictionary) else { return nil }
        let image: CGImage?
        if let maximumPixelSize {
            image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: false,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
                kCGImageSourceShouldCacheImmediately: true
            ] as CFDictionary)
        } else {
            image = CGImageSourceCreateImageAtIndex(source, 0, [
                kCGImageSourceShouldCacheImmediately: true
            ] as CFDictionary)
        }
        return image.map(UIImage.init(cgImage:))
    }


}

struct ServerError: Decodable { let error: String? }

enum HorizonScribeIdentityError: LocalizedError {
    case message(String)
    case httpStatus(Int, String?)

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
        case .httpStatus(let status, let code):
            switch status {
            case 401: return "Worker rejected the API token."
            case 403: return "Worker rejected this origin."
            default: return "HorizonScribe Worker returned HTTP \(status)\(code.map { " (\($0))" } ?? "")."
            }
        }
    }

    static func statusCode(_ error: Error) -> Int? {
        guard let identityError = error as? HorizonScribeIdentityError,
              case .httpStatus(let status, _) = identityError else { return nil }
        return status
    }

    static func permitsOfflineFallback(_ error: Error) -> Bool {
        if let status = statusCode(error) { return status >= 500 }
        guard let error = error as? URLError else { return false }
        return [.notConnectedToInternet, .networkConnectionLost, .timedOut,
                .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
                .internationalRoamingOff, .dataNotAllowed].contains(error.code)
    }

    static func isConflict(_ error: Error) -> Bool { statusCode(error) == 409 }
}

private struct WorkerCredentials: Codable {
    let workerURL: String
    let apiToken: String
}

private struct WorkerCredentialStore {
    private let service = "org.horizon-scribe.worker"
    private let account = "credentials"

    func read() -> WorkerCredentials? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return try? JSONDecoder().decode(WorkerCredentials.self, from: data)
    }

    func save(_ credentials: WorkerCredentials) throws {
        let data = try JSONEncoder().encode(credentials)
        let status = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var query = baseQuery
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw HorizonScribeIdentityError.message("Could not save Worker credentials in Keychain.") }
        } else if status != errSecSuccess {
            throw HorizonScribeIdentityError.message("Could not update Worker credentials in Keychain.")
        }
    }

    func delete() { SecItemDelete(baseQuery as CFDictionary) }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}
