# HorizonScribe for iPad

Native SwiftUI client for the HorizonScribe Worker API.

The app has no Firebase, Google Sign-In, hosted identity service, or compiled endpoint. On first launch, user enters a root HTTPS Worker URL and random API token. Token and URL are stored in this device's Keychain. Catalogs, review states, selected photos, and masks are cached under Application Support with iOS file protection.

Open `HorizonScribe.xcodeproj`, choose your development team, replace example bundle IDs, and run shared `HorizonScribe` scheme. Core raster tests run independently:

```shell
swift test --package-path HorizonScribeCore
```

App supports iPadOS 16 and later. No iPhone target is configured.

## Build for an iPad

1. On a Mac, clone `https://github.com/tabutyn/horizon-scribe.git` and open `ios/HorizonScribe.xcodeproj` in Xcode 16 or newer.
2. Choose the **HorizonScribe** scheme and the connected iPad as destination.
3. Under **Signing & Capabilities**, select your own Apple development team. Follow Xcode's account/device provisioning prompts. The repository contains no signing certificate, provisioning profile, or developer-team ID.
4. Replace the example bundle identifiers in **both Debug and Release** with identifiers owned by your team, such as `com.yourorganization.horizonscribe.dev` and `com.yourorganization.horizonscribe`. These examples are not registered identifiers supplied by the project.
5. Build and run. Complete the iPad's developer-mode/trust prompts if required by your device and signing setup.
6. Debug displays **HorizonScribe Dev**; Release displays **HorizonScribe**. The executable, scheme, module, and project use the HorizonScribe names in both configurations.

No app installation occurs from Windows. GitHub CI's unsigned simulator build validates compilation only; it is not a signed device build or App Store/TestFlight release.

## Connect to your cloud

Complete [Cloudflare setup](../docs/CLOUDFLARE.md), upload a dataset, and publish an exact next batch first. At launch, enter the **root HTTPS Worker URL** and **HORIZON_SCRIBE_API_TOKEN** value. Do not enter the desktop review URL, an R2 endpoint, an S3 access key, or a URL ending in `/v1`.

The app validates catalog schemas and dataset-bound image identities. Image-state reads and saves include the current dataset ID, preventing a device loaded with one dataset from silently writing into another active dataset.

Credentials are stored under Keychain service `org.horizon-scribe.worker`. Drafts/cache use `HorizonScribe/Drafts` and `HorizonScribe/Cache` under the app's Application Support directory. These namespaces deliberately do not import another app's state automatically.

## Labeling workflow

- **Next Pass** shows the exact queue selected by the desktop **Next Round** reviewer and published to R2. The names refer to the same workflow.
- Choose water/sea, cloud/sky, or land. Paint using Apple Pencil or supported touch input, adjust brush size and overlay opacity, and use undo/redo to correct strokes.
- Save a reviewed raster to the Worker. Approval is a separate judgment that the whole image is suitable for the next stage; a prediction or untouched base mask is not proof of correct labeling.
- Automatic pixels resolve against the base mask when saving. The binary base mask distinguishes kept land from removed pixels but does not distinguish sea from sky; explicitly label sky as needed.
- Cached images and local drafts support offline editing. Do not assume an image is available offline until the cache finishes loading it. Offline edits remain on the iPad until you reconnect and save.
- A stale revision produces a conflict instead of an overwrite. Inspect/rebase the local draft against the latest cloud state and review the result before saving again.
- Refresh the catalog after a new dataset/queue is published. A Worker may cache the current snapshot for up to 15 seconds.

## Device acceptance checklist

Use a small isolated dataset and fresh Worker/bucket. Record results, device model, OS version, and commit SHA privately.

- [ ] Debug and Release build with your team's identifiers; the icon and display name identify HorizonScribe.
- [ ] Correct URL/token opens the catalog. Wrong token is rejected; there is no fallback to an author-owned service.
- [ ] The explicit queue's image identities and order match the published selection.
- [ ] Source photo and base mask align at original resolution; zoom/pan and display scaling do not shift painted pixels.
- [ ] Pencil/touch painting changes the intended class; land, sea, sky, undo, redo, brush size, and opacity work.
- [ ] Save, reopen the image, and verify the same labels. Approve, refresh, and verify the approved state.
- [ ] Cache an image; go offline; edit; close/reopen the app; confirm the draft survives. Reconnect and save explicitly.
- [ ] Two devices/sessions editing the same base revision produce a conflict; rebasing does not silently discard local work.
- [ ] Publishing a different dataset causes old-dataset writes to be rejected, not relabeled into matching filenames in the new dataset.
- [ ] Export reviews on desktop; inspect the PNG mapping and confirm its revision equals the iPad/cloud state.
- [ ] Build a second desktop round with the exported catalog; hide approved images; publish another queue; confirm it appears on iPad.
- [ ] Large-photo memory/performance is acceptable on the actual target iPad.
- [ ] All previous-app drafts and annotations are backed up before considering uninstall.

See [Migration](../docs/MIGRATION.md) for the old-app removal gate. A successful source port or CI build alone does not authorize uninstalling an existing app or deleting its cloud resources.
