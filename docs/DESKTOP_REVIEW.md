# Desktop Next Round review

The reviewer answers **“Which images should I label or correct next?”** It is a local selection tool, not another pixel-painting editor, cloud deployment service, or model trainer. Pixel editing and approval happen in the iPad app.

It replaces the private server-dependent selection workflow with a standalone local one: prepare comparisons, inspect candidates, choose an exact ordered queue, then publish it explicitly. It does not need an author-owned account or service.

## 1. Build a comparison bundle

Prepare a dataset first using [Datasets](DATASETS.md). Keep its upload plan and source files on this computer.

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --output data/review-round-01
```

This validates the manifest against the plan, checks source hashes, and pre-renders fixed 4×4 JPEG contact sheets for both original photos and overlays. Approved images are omitted. It does not copy full-resolution photos into the bundle. The output directory must be new, preventing accidental replacement of an existing selection.

Without predictions, the overlay highlights the base mask's removed pixels in orange. A binary mask cannot distinguish sea from sky. This is useful for finding poorly masked boundaries but is not a three-class model evaluation.

## Optional model predictions

Provide a sidecar JSON file using `horizon-scribe-predictions-source/v1`:

```json
{
  "schema": "horizon-scribe-predictions-source/v1",
  "modelId": "my-model-version",
  "runId": "my-inference-run",
  "predictionSetId": "my-prediction-batch",
  "images": [
    {"setId": "coast-01", "image": "frame-001.jpg", "classMask": "masks/frame-001.labels.png", "priority": 0.8}
  ]
}
```

Optionally include `datasetId`; when present it must match. Paths are relative to this JSON. Each mask must be an 8-bit, one-channel PNG matching the photo's width and height. Values are `0=automatic/transparent`, `1=land`, `2=sea`, `3=sky`. Convert zero-based three-class model outputs before importing; do not pass colorized visualization images.

`priority` is any finite number; higher values appear on earlier pre-rendered sheets. It can come from your uncertainty/heuristic scoring pipeline. HorizonScribe does not compute confidence or claim that a high score proves a mistake. Missing values default to zero. Unknown or duplicate set/image identities are rejected. Images without predictions fall back to the base-mask comparison.

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --predictions /path/to/predictions.json --output data/review-round-01
```

Prediction previews are **local-only**. They are not automatically uploaded, inserted into the iPad's labels, or approved as ground truth. This separation lets you prioritize images without replacing existing human work.

For a model-error review, use `--candidates predictions` to include only images with supplied three-class predictions. This avoids mixing inferred labels with binary base-mask fallbacks. The default `--candidates all` retains the existing all-image comparison behavior.

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --predictions /path/to/predictions.json --candidates predictions --reviews data/export-round-01/catalog.json --output data/review-round-01
```

### Rehearse with recovered, unreviewed predictions

A completed cloud review export may contain saved predictions explicitly marked `humanReviewed: false`. Recover only those as preview inputs:

```shell
node desktop/predictions-from-export.mjs --input data/export-round-01 --output data/recovered-predictions
```

Use the resulting `data/recovered-predictions/predictions.json` with `--predictions` and `--candidates predictions` above. The converter verifies image/revision identities and checks every label PNG against its saved rows. It excludes human-reviewed masks and refuses to overwrite an existing output folder. The UI identifies these as recovered saved predictions, not a new inference run; the original model identity is not inferred or invented.

This rehearsal tests real-image comparison and selection, but does **not** test fresh model inference. To make a fresh private sea-only first pass, use the pinned [FLAIR-INC runner](MODELS_AND_DATA.md#private-flair-inc-first-pass), then supply its `predictions.json` here. The checkpoint stays in ignored local data. Missing predictions are not equivalent to inferred labels.

## 2. Include fresh approval status

The immutable snapshot records approval at the time it was built. To reflect subsequent iPad work, first [export cloud reviews](DATASETS.md#export-saved-cloud-reviews), then add:

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --predictions /path/to/predictions.json --reviews data/export-round-01/catalog.json --output data/review-round-02
```

The cloud catalog must belong to the same dataset. The UI displays whether status comes from the snapshot alone or an exported cloud catalog. It is a point-in-time view, not live synchronization; rebuild a fresh bundle after another labeling round.

## 3. Open the local app

```shell
npm run review -- --bundle data/review-round-01
```

Visit **http://127.0.0.1:4317** on the same computer. To choose another port:

```shell
npm run review -- --bundle data/review-round-01 --port 4318
```

Keep the terminal open. Stop with Ctrl+C. It is deliberately bound to `127.0.0.1`, checks the Host/Origin, and serves only fixed UI assets and bundle preview paths. It is not designed for public hosting or exposing through a tunnel. No Cloudflare token is needed to inspect a local bundle.

## 4. Inspect, select, and rank

1. Review one pre-rendered **4×4 contact sheet** per page. Each sheet contains up to 16 unapproved images in fixed priority order.
2. Toggle **Show overlay** to swap between the pre-rendered inferred-label sheet and matching source-photo sheet.
3. Click the worst tile. Exactly one image can be selected from each sheet; choosing another tile on that sheet replaces the previous choice.
4. Move to the next sheet and repeat. The contact sheet uses the full browser width.
5. Selection changes save automatically. Open the compact **N selected** dialog only when you need to inspect, reorder, remove, or download the queue.

The queue permits at most 500 images and at most one selection from each contact sheet. A local empty selection is valid while choosing, but cannot be published as a labeling batch. Clicking a candidate does not approve or edit its pixels.

Selections persist in `BUNDLE/next-batch.json` and restore when you reopen the server. The **N selected** dialog contains **Download selection JSON**. If another browser tab saves first, an outdated save is rejected and an error appears; use the dialog to download the unsaved selection before reloading and reconcile intentionally. Do not assume simultaneous tabs merge their selections.

## 5. Stage selected predictions for editing

The comparison bundle is local-only. Before publishing its queue, stage the exact selected prediction rasters as unreviewed cloud state so the iPad opens the inferred labels instead of the older base masks:

```shell
npm run predictions:stage -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --selection data/review-round-01/next-batch.json --predictions /path/to/predictions.json --report data/publish-round-01/prediction-staging-report.json
```

This command uses the Worker URL and Mac Keychain entry already saved by `npm run ios:install`; no URL or token is entered on the iPad. Alternatively, provide `--url` and inject `HORIZON_SCRIBE_API_TOKEN` into the process. Never pass a token as a command argument.

Prediction value `0` means automatic, so staging resolves it against the snapshot's immutable binary base mask exactly as the iPad does when saving. Values `1`, `2`, and `3` remain land, sea, and sky. Staged results use `humanReviewed: false` and `approved: false`. Existing approved or human-reviewed state aborts the whole preflight. An existing unreviewed prediction may be replaced, but a concurrent iPad edit causes a revision conflict instead of an overwrite. The command reads every result back and writes a resumable report.

Stage predictions before publishing the queue. If staging stops, rerun the same command; do not publish a partial queue.

## 6. Publish only after reviewing the selection

Stop the local server or leave it running; publication does not depend on it:

```shell
node desktop/prepare-next-batch.mjs --snapshot snapshots/DATASET_ID/manifest.json --selection data/review-round-01/next-batch.json --output data/publish-round-01
node desktop/wrangler-upload.mjs --plan data/publish-round-01/next-pass-upload-plan.jsonl --bucket horizon-scribe
```

Use the S3 uploader instead if that is your configured upload path. The batch references exact existing set/image names; it does not upload photographs again. Upload the dataset before its queue.

On the iPad, tap **Refresh queue**. The app's **Next Pass** view should contain the selected identities in the chosen rank order and open the first unfinished prediction when the previous image is no longer selected. A new queue on the same dataset preserves its existing review revisions.

## 7. Repeat the loop

Label/approve on iPad → export cloud reviews → optionally run the private FLAIR first pass or your own external model → build a new comparison bundle with fresh status → select a new batch → publish → refresh the iPad.

For a video-ready rehearsal without real photographs, use `npm run demo` and `data/demo/predictions.json`. These are synthetic scenes with deliberately wrong patches, not predictions made by a trained model.
