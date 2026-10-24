# Desktop Next Round review

The reviewer answers **“Which images should I label or correct next?”** It is a local selection tool, not another pixel-painting editor, cloud deployment service, or model trainer. Pixel editing and approval happen in the iPad app.

It replaces the private server-dependent selection workflow with a standalone local one: prepare comparisons, inspect candidates, choose an exact ordered queue, then publish it explicitly. It does not need an author-owned account or service.

## 1. Build a comparison bundle

Prepare a dataset first using [Datasets](DATASETS.md). Keep its upload plan and source files on this computer.

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --output data/review-round-01
```

This validates the manifest against the plan, checks source hashes, and creates compact JPEG original/overlay previews up to 640 × 400 pixels. It does not copy full-resolution photos into the bundle. The output directory must be new, preventing accidental replacement of an existing selection.

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

`priority` is any finite number; higher values sort first. It can come from your uncertainty/heuristic scoring pipeline. HorizonScribe does not compute confidence or claim that a high score proves a mistake. Missing values default to zero. Unknown or duplicate set/image identities are rejected. Images without predictions fall back to the base-mask comparison.

```shell
npm run review:build -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --predictions /path/to/predictions.json --output data/review-round-01
```

Prediction previews are **local-only**. They are not automatically uploaded, inserted into the iPad's labels, or approved as ground truth. This separation lets you prioritize images without replacing existing human work.

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

1. Choose a set or search by image name.
2. Sort by **Priority first** or image name.
3. Toggle **Show overlay** to compare the model/base result against the original.
4. Leave **Hide approved** on for new work. Turn it off to intentionally revisit a previously approved image.
5. Click a card to add/remove it. Selected cards have a highlighted border and a checkmark.
6. Use the right-hand queue's up/down buttons to set the exact iPad order.
7. Use **Selected only** to inspect the final selection.
8. Wait for **Saved locally as next-batch.json** before closing.

The queue permits at most 500 images. A local empty selection is valid while choosing, but cannot be published as a labeling batch. Clicking a candidate does not approve or edit its pixels.

Selections persist in `BUNDLE/next-batch.json` and restore when you reopen the server. **Download selection JSON** provides a copy. If another browser tab saves first, an outdated save is rejected; download your unsaved selection before reloading and reconcile intentionally. Do not assume simultaneous tabs merge their selections.

## 5. Publish only after reviewing the selection

Stop the local server or leave it running; publication does not depend on it:

```shell
node desktop/prepare-next-batch.mjs --snapshot snapshots/DATASET_ID/manifest.json --selection data/review-round-01/next-batch.json --output data/publish-round-01
node desktop/wrangler-upload.mjs --plan data/publish-round-01/next-pass-upload-plan.jsonl --bucket horizon-scribe
```

Use the S3 uploader instead if that is your configured upload path. The batch references exact existing set/image names; it does not upload photographs again. Upload the dataset before its queue.

Refresh the iPad catalog. The app's **Next Pass** view should contain the selected identities in the chosen rank order. A new queue on the same dataset preserves its existing review revisions.

## 6. Repeat the loop

Label/approve on iPad → export cloud reviews → optionally run your own model externally → build a new comparison bundle with fresh status → select a new batch → publish → refresh the iPad.

For a video-ready rehearsal without real photographs, use `npm run demo` and `data/demo/predictions.json`. These are synthetic scenes with deliberately wrong patches, not predictions made by a trained model.
