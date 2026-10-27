# LinkedIn tutorial: your photos, your iPad, your Cloudflare

## Outcome and honest scope

At the end, a viewer should understand how to deploy HorizonScribe into **their own Cloudflare account**, store photos and masks in **their own private R2 bucket**, label pixels on iPad, and use the desktop reviewer to prepare the next labeling round.

Suggested title: **Build your own sea-and-sky labeling workflow with HorizonScribe, iPad, and Cloudflare R2**.

This is a recording plan and runnable walkthrough—not a finished video. Record the hardware/cloud demonstrations only after they pass the migration/device gates. Do not present a simulator build or synthetic screenshot as proof of production iPad behavior.

## Recording setup

- Use a separate demo Worker/bucket, for example `horizon-scribe-demo` and `horizon-scribe-demo-data`, in an account you control.
- Use the synthetic demo for the public walkthrough, or a small photo collection you have permission to publish. No private training collection is required.
- Use a clean browser profile and enlarge terminal/browser text. Close unrelated tabs and hide notifications.
- Stop recording for Cloudflare authentication, billing screens, secret entry, R2 key creation, and password-manager access. The Mac installer provisions iPad credentials automatically. Resume after success and use placeholders in slides.
- Record desktop and iPad separately; cut between them at the named checkpoints. Keep terminal commands available in the repository so viewers do not need to transcribe the video.
- Explain the three credentials: Wrangler login deploys/uploads; the app token authorizes the iPad; optional bucket-scoped S3 keys are desktop-only.

## Storyboard

Suggested pacing is an editorial guide; adjust to the platform's current upload requirements.

| Chapter | Show | Explain / expected evidence |
| --- | --- | --- |
| 1. The result | iPad painting sea/sky; desktop selected queue | “HorizonScribe lets me label pixels on iPad while keeping the photos and results in a cloud account I control.” |
| 2. The architecture | Repository and small desktop → Worker → R2 diagram | “This is MIT-licensed source, not a central photo-hosting service. Your bucket stays private.” |
| 3. Clone and install | Terminal, tests | “Desktop preparation works on Windows, macOS, or Linux. Building the iPad app needs Xcode on a Mac.” |
| 4. Cloudflare resources | Demo bucket and generated config | “One private bucket, one Worker, one app token. No public bucket URL.” |
| 5. Deploy | Successful deploy and `/health` | “The Worker exposes only the app's authenticated routes. Health alone does not prove photos are uploaded.” |
| 6. Prepare photos | Source manifest and dataset statistics | “We normalize copies, validate masks, and pin files by hash. The originals stay unchanged.” |
| 7. Desktop Next Round | Full-width original/overlay sheet, select, optional queue dialog | “Pick images that need attention. A prediction is a suggestion, not an approved label.” |
| 8. Publish | Dataset upload followed by queue upload | “Selection was local. These explicit commands publish it to my bucket.” |
| 9. iPad setup | Xcode project, signing, Worker connection | “Use your Apple team and your Worker URL. The iPad never receives an R2 S3 key.” |
| 10. Label and sync | Pencil/touch, undo, save, approve | “I mark land, sea, and sky, then save a complete raster. Conflicting edits are not silently overwritten.” |
| 11. Close the loop | Export PNGs/status, rebuild a new desktop round | “Bring the review results back to desktop, hide completed images, and choose the next batch.” |
| 12. Wrap-up | GitHub URL and docs | “Fork it, use your own photos and cloud, and keep model licenses separate from the app's MIT license.” |

## Command sheet: clone and check

```shell
git clone https://github.com/tabutyn/horizon-scribe.git
cd horizon-scribe
npm ci
npm run check
npm test
```

Checkpoint: tests pass. Explain that these run locally and do not touch Cloudflare.

## Command sheet: create the demo cloud deployment

```shell
node scripts/configure-cloudflare.mjs --worker horizon-scribe-demo --bucket horizon-scribe-demo-data
npx wrangler login
npx wrangler whoami
npx wrangler r2 bucket create horizon-scribe-demo-data
```

Pause capture for login/billing. Confirm the account before creating resources. Inspect the bucket's public-access setting: it should remain disabled.

Off camera, follow [the token-generation commands](CLOUDFLARE.md#4-create-the-app-token--off-camera) and retain the generated app token securely. Do not substitute your personal production token.

```shell
npm run cloudflare:check
npm run cloudflare:deploy
```

Checkpoint: open the printed URL plus `/health`; show `service: horizon-scribe`. An unauthenticated `/v1/catalog` should return 401. Explain that an authenticated catalog cannot load until a dataset exists.

## Command sheet: prepare demo scenes or your own photos

Reproducible, private-photo-free option:

```shell
npm run demo
node desktop/prepare-dataset.mjs --source data/demo/source.json --output snapshots
```

Say: **“These are generated example scenes with deliberately incorrect mask patches, not outputs from a trained model.”**

Alternative using owned photographs:

```shell
node desktop/import-photos.mjs --input /path/to/my/photos --output data/my-photos --set coast-01
node desktop/prepare-dataset.mjs --source data/my-photos/source.json --output snapshots
```

The importer creates blank base masks; no AI has labeled the images. If demonstrating the optional private FLAIR runner or another model, provide its prediction sidecar and disclose the model/license separately.

Copy the printed `datasetId` into the remaining commands. Explain that `DATASET_ID` is a placeholder, not a filename literally present in the repository.

## Command sheet: desktop review app

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --predictions data/demo/predictions.json --output data/review-round-01
npm run review -- --bundle data/review-round-01
```

For ordinary photos without prediction masks, omit `--predictions`.

At **http://127.0.0.1:4317**:

1. Identify the HorizonScribe title and “Local workspace” badge.
2. Explain the overlay legend. Base-mask orange is binary remove/keep; prediction masks distinguish land/sea/sky.
3. Show the pre-rendered 4×4 inferred-label sheet. Toggle the overlay off to expose the matching source-photo sheet.
4. Select the worst tile. Select another tile on the same sheet to show that it replaces the first choice.
5. Move to later sheets and select one image from each. Open **N selected** to adjust iPad order only if needed.
6. Reload once to prove the automatically saved queue persists.
7. Show **Download selection JSON** inside the selection dialog, but explain that the server has already saved `next-batch.json` locally.
8. Point out that no Cloudflare credential is in the browser and no upload has occurred.

Keep desktop preview selection separate from iPad pixel labeling in the narration: selecting a bad prediction does not change or approve its pixels.

## Command sheet: publish dataset and queue

```shell
node desktop/prepare-next-batch.mjs --snapshot snapshots/DATASET_ID/manifest.json --selection data/review-round-01/next-batch.json --output data/publish-round-01
node desktop/wrangler-upload.mjs --plan snapshots/DATASET_ID/upload-plan.jsonl --bucket horizon-scribe-demo-data
node desktop/wrangler-upload.mjs --plan data/publish-round-01/next-pass-upload-plan.jsonl --bucket horizon-scribe-demo-data
```

Checkpoint: uploads complete. Show the object layout in the demo bucket without exposing secrets or private image names. Explain that the queue references the uploaded dataset exactly and that upload order matters.

For a longer technical cut, show the S3 uploader's bucket-scoped credentials and remote checksum workflow using placeholders; do not show real keys. Do not claim the simpler Wrangler path performs those remote checks.

## iPad demonstration

On the Mac, follow [automatic iPad installation](../ios/README.md#install-and-connect-from-a-mac). Supply your team, owned bundle identifier prefix, iPad UDID, and Worker URL once. Pipe the demo token into the installer off camera. A Debug build appears as **HorizonScribe Dev**; subsequent updates use `npm run ios:install`.

No Worker URL/token entry is needed on the iPad. Resume after the installer confirms the catalog loaded:

1. Show the **Next Pass** queue containing the exact selected identities/order.
2. Zoom/pan, paint sea, paint sky, correct land, and adjust brush size/overlay opacity.
3. Undo and redo one stroke, then save.
4. Review the whole image before approving; distinguish “saved” from “approved.”
5. Reload/refresh and show that the approval persists.
6. If already validated on-device, show a brief offline draft/reconnect sequence. Do not disconnect before the image/cache has finished loading.

Use [the device checklist](../ios/README.md#device-acceptance-checklist) during rehearsal, not while discovering bugs in the final take. Do not uninstall the previous app before its unsynced work is backed up.

## Command sheet: review results and prepare round two

Off camera, set `HORIZON_SCRIBE_API_TOKEN` in the current desktop environment to the demo app token. Do not paste it into the command line or video description.

```shell
npm run reviews:export -- --url https://YOUR_DEMO_WORKER.YOUR_SUBDOMAIN.workers.dev --output data/export-round-01
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --predictions data/demo/predictions.json --reviews data/export-round-01/catalog.json --output data/review-round-02
npm run review -- --bundle data/review-round-02
```

Stop the first reviewer before using the same port, or specify another port. Show exported label PNGs and their identity manifest. In the new reviewer, show **Hide approved** excluding the images you finished. Choose another batch, prepare it into `data/publish-round-02`, upload that queue, and refresh the iPad.

Explain: the images stay in the same dataset; the selected round changes. Training/inference is an optional external step, not something this app secretly performs in Cloudflare.

## Suggested post text

> I open-sourced HorizonScribe: a native iPad tool for labeling land, sea, and sky pixels, backed by your own Cloudflare Worker and private R2 bucket.
>
> This walkthrough covers deployment, photo preparation, Apple Pencil labeling, and the desktop review app for selecting the next round. The code is MIT licensed; you supply your own photos and cloud account.
>
> Code and setup guide: https://github.com/tabutyn/horizon-scribe

Adjust any claims to match the device/cloud steps actually demonstrated. Do not imply that user photos, a pretrained model, hosting, or Apple distribution are included in the repository.

## Recording completion checklist

- [ ] Fresh-clone setup succeeded using only repository instructions.
- [ ] Demo bucket remains private; unauthenticated asset access fails.
- [ ] No secrets, unrelated private images, or password-manager content appear in the recording.
- [ ] The real iPad saved/approved a label and the desktop exporter retrieved the same revision.
- [ ] The next-round queue published from desktop appeared correctly on iPad.
- [ ] Synthetic scenes/model claims are described accurately.
- [ ] Captions, legible commands, GitHub link, and documentation links are included.
- [ ] Any demo cleanup happens separately after required data is exported; nothing deletes the author's live deployment.
