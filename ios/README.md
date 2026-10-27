# HorizonScribe for iPad

Native SwiftUI client for the HorizonScribe Worker API.

The app has no Firebase, Google Sign-In, hosted identity service, or compiled endpoint. The Mac installer provisions the Worker URL and API token automatically, so nothing needs to be typed on the iPad. Credentials are stored in this device's Keychain. Catalogs, review states, selected photos, and masks are cached under Application Support with iOS file protection. Manual connection remains available for installations without provisioning.

Open `HorizonScribe.xcodeproj`, choose your development team, replace example bundle IDs, and run shared `HorizonScribe` scheme. Core raster tests run independently:

```shell
swift test --package-path HorizonScribeCore
```

App supports iPadOS 16 and later. No iPhone target is configured.

## Install and connect from a Mac

Complete [Cloudflare setup](../docs/CLOUDFLARE.md), upload a dataset, and publish its queue first. Connect and unlock your iPad, trust this Mac, and enable Developer Mode if prompted. Xcode must have your Apple account and development team configured.

Find the iPad's UDID with `xcrun xctrace list devices` or Xcode's **Window > Devices and Simulators**. Use the real iPad UDID, not a simulator identifier. Find your 10-character Team ID in your Apple developer account. Choose a bundle identifier prefix owned by that team; Debug adds `.dev`, while Release uses the prefix unchanged.

In the same Mac shell used for Cloudflare token creation, run this once from the repository root, replacing the four non-secret placeholders:

```shell
printf '%s' "$HORIZON_SCRIBE_TOKEN" | npm run ios:install -- \
  --worker-url https://horizon-scribe.YOUR-SUBDOMAIN.workers.dev \
  --team YOURTEAMID \
  --bundle-id-prefix com.yourorganization.horizonscribe \
  --device YOUR_IPAD_UDID \
  --token-stdin
unset HORIZON_SCRIBE_TOKEN
```

If your token already lives in Mac Keychain, omit the pipe and `--token-stdin`; supply `--keychain-service SERVICE --keychain-account ACCOUNT` to read that existing entry. Alternatively, supply `HORIZON_SCRIBE_API_TOKEN` through your secret manager's environment injection. No token argument is supported.

The command checks your live catalog, stores a supplied token in Mac Keychain, builds and signs the app, installs it, transfers connection settings through the paired-device connection, and launches it. The app imports those settings into iPad Keychain, deletes the transfer file, then opens the catalog. The installer verifies a receipt from that specific app launch before reporting success. No token or private endpoint is embedded in the app bundle or tracked source.

Mac settings are saved in ignored `.local/ios-device.json`; this file contains no token. Default Mac Keychain service is `org.horizon-scribe.installer`, account `api-token`. Subsequent installs need only:

```shell
npm run ios:install
```

For a signed Release build beside Debug:

```shell
npm run ios:install -- --configuration Release
```

The selected configuration is remembered. Pass `--configuration Debug` to switch back. Save current edits before reinstalling: installation restarts the app. Existing app data stays in its container. After provisioning, ordinary app launches restore the Keychain connection without the Mac present.

If Keychain access or device trust needs approval, macOS/Xcode may prompt on the Mac. If setup is interrupted, unlock the iPad and rerun the command. A failed import can leave the transfer file in the app's private `Library/Caches` until a successful retry; it is never copied into Documents or the compiled bundle. **Forget connection** removes the saved iPad connection and does not automatically reprovision it; rerun the installer to reconnect.

## Build manually in Xcode

1. On a Mac, clone `https://github.com/tabutyn/horizon-scribe.git` and open `ios/HorizonScribe.xcodeproj` in Xcode 16 or newer.
2. Choose the **HorizonScribe** scheme and the connected iPad as destination.
3. Under **Signing & Capabilities**, select your own Apple development team. Follow Xcode's account/device provisioning prompts. The repository contains no signing certificate, provisioning profile, or developer-team ID.
4. Replace the example bundle identifiers in **both Debug and Release** with identifiers owned by your team, such as `com.yourorganization.horizonscribe.dev` and `com.yourorganization.horizonscribe`. These examples are not registered identifiers supplied by the project.
5. Build and run. Complete the iPad's developer-mode/trust prompts if required by your device and signing setup.
6. Debug displays **HorizonScribe Dev**; Release displays **HorizonScribe**. The executable, scheme, module, and project use the HorizonScribe names in both configurations.

No app installation occurs from Windows. GitHub CI's unsigned simulator build validates compilation only; it is not a signed device build or App Store/TestFlight release.

## Connect to your cloud

The Mac installer above performs connection setup automatically. For a manual Xcode installation, enter the **root HTTPS Worker URL** and **HORIZON_SCRIBE_API_TOKEN** value on the connection screen. Do not enter the desktop review URL, an R2 endpoint, an S3 access key, or a URL ending in `/v1`.

The app validates catalog schemas and dataset-bound image identities. Image-state reads and saves include the current dataset ID, preventing a device loaded with one dataset from silently writing into another active dataset.

Credentials are stored under Keychain service `org.horizon-scribe.worker`. Drafts/cache use `HorizonScribe/Drafts` and `HorizonScribe/Cache` under the app's Application Support directory. These namespaces deliberately do not import another app's state automatically.

## Labeling workflow

- **Next Pass** shows the exact queue selected by the desktop **Next Round** reviewer and published to R2. The names refer to the same workflow.
- When the desktop round uses model predictions, run `npm run predictions:stage` before publishing its queue. This stores only selected predictions as unreviewed, unapproved cloud state; the iPad then opens those inferred labels as its editable baseline. Merely publishing `next-batch.json` does not transfer local prediction masks.
- Choose water/sea, cloud/sky, or land. Paint using Apple Pencil or supported touch input, adjust brush size and overlay opacity, and use undo/redo to correct strokes.
- Save a reviewed raster to the Worker. Approval is a separate judgment that the whole image is suitable for the next stage; a prediction or untouched base mask is not proof of correct labeling.
- Automatic pixels resolve against the base mask when saving. The binary base mask distinguishes kept land from removed pixels but does not distinguish sea from sky; explicitly label sky as needed.
- Cached images and local drafts support offline editing. Do not assume an image is available offline until the cache finishes loading it. Offline edits remain on the iPad until you reconnect and save.
- A stale revision produces a conflict instead of an overwrite. Inspect/rebase the local draft against the latest cloud state and review the result before saving again.
- Tap **Refresh queue** after a new dataset/queue is published. The app fetches the exact Next Pass and opens its first unfinished image when the previous image is no longer selected. A Worker may cache the current snapshot for up to 15 seconds.

## Device acceptance checklist

Start with a small isolated dataset and fresh Worker/bucket. Before replacing an existing application, repeat the checklist on the recovered real collection, including representative photos from different sets and each supported resolution. Record results, device model, OS version, and commit SHA privately. Preserve known-good annotations: use a designated unapproved image for genuine labeling, or an isolated copy for disposable paint/conflict tests. Do not overwrite approved ground truth just to exercise a control.

- [ ] Debug and Release build with your team's identifiers; the icon and display name identify HorizonScribe.
- [ ] Mac installer opens the catalog without iPad URL/token entry, reports the matching dataset, and consumes its transfer file. Close/reopen the app and confirm the Keychain connection restores.
- [ ] Correct URL/token opens the catalog. Wrong token is rejected; there is no fallback to an author-owned service.
- [ ] The explicit queue's image identities and order match the published selection.
- [ ] The full real collection's image/set counts, human approvals, and unreviewed predictions match the migration inventory; no prediction was promoted to human approval.
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
