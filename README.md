# HorizonScribe

**Label sea and sky on iPad. Save to your own cloud.**

HorizonScribe is an MIT-licensed, self-hosted image-labeling toolkit. Paint land, sea, and sky pixels with Apple Pencil or touch, keep local drafts, and sync reviewed masks to a private Cloudflare R2 bucket that you control. A companion desktop reviewer helps you inspect masks and choose the next images to label.

Repository: [github.com/tabutyn/horizon-scribe](https://github.com/tabutyn/horizon-scribe).

There is no hosted HorizonScribe account, subscription server, bundled photo collection, private production endpoint, or pretrained model. Bring your own Cloudflare account and photos. Cloudflare usage and Apple development requirements are separate from this project's MIT license.

## What is included

| Component | Location | Purpose |
| --- | --- | --- |
| Native iPad app | [`ios/`](ios/README.md) | Pencil/touch painting, undo/redo, approval, offline drafts and cached images, explicit conflict rebasing |
| Cloud API | [`cloudflare/`](docs/CLOUDFLARE.md) | Token-authenticated Worker, private R2 assets, conditional review writes and retained revisions |
| Photo importer | `desktop/import-photos.mjs` | Normalize orientation, remove metadata from upload copies, create blank base masks |
| Dataset builder | `desktop/prepare-dataset.mjs` | Validate images/masks, hash blobs, prepare an immutable dataset and upload plan |
| Desktop Next Round reviewer | [`desktop/review/`](docs/DESKTOP_REVIEW.md) | Compare original/overlay previews, filter and select candidates, reorder and save a batch |
| Cloud review exporter | `desktop/export-reviews.mjs` | Download saved full label rasters and current approval status |
| Upload tools | `desktop/wrangler-upload.mjs`, `desktop/upload-r2.mjs` | Publish datasets and next-round queues to your bucket |
| Synthetic demo | `scripts/create-demo.mjs` | Generate six simple scenes and deliberately imperfect masks; no real photos or trained model |
| Recording guide | [`docs/LINKEDIN_TUTORIAL.md`](docs/LINKEDIN_TUTORIAL.md) | Tutorial outline, commands, narration, demonstrations, and recording checkpoints |

## Start here

1. [Cloudflare setup](docs/CLOUDFLARE.md): create your bucket and Worker, configure the app token, verify the API.
2. [Datasets](docs/DATASETS.md): use your own photos or the synthetic demo, then upload a validated snapshot.
3. [Desktop review](docs/DESKTOP_REVIEW.md): inspect previews and publish the next labeling round.
4. [iPad build and use](ios/README.md): choose your Apple team, build HorizonScribe, and connect it to your Worker.
5. [Migration and release gate](docs/MIGRATION.md): preserve existing work before replacing an older app.
6. [Architecture and identifiers](docs/ARCHITECTURE.md): names, schemas, routes, storage, and trust boundaries.

## Prerequisites

- Node.js **22.12 or newer** and npm; Node 24 is also supported.
- Git and a terminal on Windows, macOS, or Linux for the desktop tools.
- Your own Cloudflare account with Workers and R2 enabled for cloud use.
- A Mac with Xcode 16 or newer, an Apple development team, and an iPad running iPadOS 16 or newer for device installation. Windows can prepare/review/upload datasets, but cannot build the native iPad target.

```shell
git clone https://github.com/tabutyn/horizon-scribe.git
cd horizon-scribe
npm ci
npm run check
npm test
```

Wrangler and image-processing dependencies are pinned in `package-lock.json`. Use `npm ci` for reproducible installs; do not substitute an arbitrary globally installed Wrangler.

## Try the desktop workflow without a cloud account

Generate a **new** demo folder; commands intentionally refuse to overwrite existing generated datasets:

```shell
npm run demo
node desktop/prepare-dataset.mjs --source data/demo/source.json --output snapshots
```

The second command prints a `datasetId`. Replace `DATASET_ID` below with that exact value:

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --predictions data/demo/predictions.json --output data/review-round-01
npm run review -- --bundle data/review-round-01
```

Open **http://127.0.0.1:4317**. Select images, compare overlays, and reorder the queue. Selection changes save in `data/review-round-01/next-batch.json`. This server listens on loopback only and performs **no cloud writes**. Press Ctrl+C to stop it.

Prepare the selected batch:

```shell
node desktop/prepare-next-batch.mjs --snapshot snapshots/DATASET_ID/manifest.json --selection data/review-round-01/next-batch.json --output data/publish-round-01
```

After completing [Cloudflare setup](docs/CLOUDFLARE.md), publish the dataset first, then the queue:

```shell
node desktop/wrangler-upload.mjs --plan snapshots/DATASET_ID/upload-plan.jsonl --bucket horizon-scribe
node desktop/wrangler-upload.mjs --plan data/publish-round-01/next-pass-upload-plan.jsonl --bucket horizon-scribe
```

These two commands write to your real bucket. `--bucket` must match the bucket you configured. For remote checksum verification and conditional immutable writes, use the S3 uploader described in [Datasets](docs/DATASETS.md).

## Use your own photos

```shell
node desktop/import-photos.mjs --input /path/to/your/photos --output data/my-photos --set coast-01
node desktop/prepare-dataset.mjs --source data/my-photos/source.json --output snapshots
```

In PowerShell, use a quoted path such as `"D:\My Photos\Coast"`. The input directory is read-only; normalized upload copies go to the output directory. Blank base masks mean “keep everything until reviewed,” not “the model already labeled this photo.”

If you already have base masks or predicted class masks, use the documented [source manifest contracts](docs/DATASETS.md) and [prediction-preview input](docs/DESKTOP_REVIEW.md#optional-model-predictions). No model is needed to start manual labeling.

## Cloud and iPad summary

The default deployment uses:

- Worker: `horizon-scribe`
- Private R2 bucket: `horizon-scribe`
- R2 binding: `HORIZON_SCRIBE_BUCKET`
- Worker secret: `HORIZON_SCRIBE_API_TOKEN`
- Object prefix: `production/horizon-scribe/v1`
- Xcode project and shared scheme: `HorizonScribe`

Follow the complete [Cloudflare guide](docs/CLOUDFLARE.md) rather than guessing at account IDs or credentials. The iPad receives only the root HTTPS Worker URL and the app token. R2 S3 keys stay on the desktop and never belong in the app.

## Development and verification

```shell
npm run check
npm test
npm run cloudflare:check
npm run test:browser
```

`cloudflare:check` is a dry-run build: it does not deploy. Browser-test setup is documented in [CONTRIBUTING.md](CONTRIBUTING.md).

On a Mac:

```shell
swift test --package-path ios/HorizonScribeCore
xcodebuild -project ios/HorizonScribe.xcodeproj -scheme HorizonScribe -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

GitHub Actions runs JavaScript tests on Windows/Linux and Swift tests plus an unsigned simulator build on macOS. These checks do not replace testing Pencil behavior, device memory, offline recovery, and real Cloudflare synchronization on an iPad.

## Ownership, privacy, and license

Code and bundled app artwork are under the [MIT License](LICENSE). Dependency licenses remain their own. User photos, annotation masks, generated snapshots, review bundles, trained weights, signing files, and credentials are not included in that code license and must not be committed here.

Authentication uses one shared bearer token per deployment, intended for an individual or small trusted team—not a public multi-tenant labeling service. See [SECURITY.md](SECURITY.md) and the [model/data boundary](docs/MODELS_AND_DATA.md).
