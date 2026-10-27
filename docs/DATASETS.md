# Photos, masks, datasets, and review exports

## The complete loop

```text
Your photos + optional masks
  → normalized local source manifest
  → immutable dataset + upload plan
  → private R2 bucket / Worker
  → iPad labels and approvals
  → desktop export and comparison review
  → exact next-round selection
  → publish queue → iPad again
```

Preparing a folder never uploads it. Upload commands are explicit. Keep originals, prepared datasets, and review exports backed up outside Git.

For an existing verified LabelLab R2 object backup, use the [recovery/import workflow](MIGRATION.md#recover-a-verified-labellab-r2-backup). It preserves the backed-up working images and restores newer annotations separately through the normal API; no access to the original workstation is required.

## Start from an ordinary photo folder

Create the parent `data` folder if it does not exist (`mkdir data`), then:

```shell
node desktop/import-photos.mjs --input /path/to/photos --output data/coast-01 --set coast-01
```

The importer reads JPEG, PNG, and WebP files directly in the input directory, without recursing. It creates a new output directory, rotates upload copies to their visible orientation, strips metadata by default, converts copies to quality-95 JPEG, and generates same-size white base masks. Original files are never edited. Name normalization prevents path separators from becoming image identities; numbered names preserve uniqueness.

The app accepts dimensions up to 8192 on either side. Large images use substantial iPad memory; begin with a small test collection. Resize and normalize photos **before** producing matching masks if you need smaller inputs.

## Supply an existing source manifest

`desktop/source.example.json` demonstrates `horizon-scribe-source/v1`. Paths are relative to that JSON file, not the current working directory. A minimal example:

```json
{
  "schema": "horizon-scribe-source/v1",
  "sets": [{
    "id": "coast-01",
    "label": "Coastal survey",
    "images": [{
      "name": "frame-001.jpg",
      "width": 1600,
      "height": 1200,
      "photo": "photos/frame-001.jpg",
      "baseMask": "masks/frame-001.base.png"
    }]
  }]
}
```

Set IDs must be unique. Image names must be unique within a set. Both reject path separators/control characters and are limited to 200 characters. Photos must be in normal pixel orientation, not dependent on EXIF rotation. Dimensions and actual image content are checked.

## Mask encodings: do not confuse them

| Artifact | Encoding | Interpretation |
| --- | --- | --- |
| Base mask | 8-bit single-channel PNG, values `0` or `255` | `255` keeps foreground/land, `0` removes sea/sky; does not distinguish sea from sky |
| Editor class raster | `0`, `1`, `2`, `3` | Automatic/base, land, sea, sky |
| Saved cloud full raster | `1`, `2`, `3` | All automatic pixels resolved; every pixel has a concrete class |
| Effective binary mask | 8-bit single-channel PNG, values `0` or `255` | Binary keep/remove result after corrections |
| Desktop prediction-preview mask | 8-bit single-channel PNG, values `0`–`3` | Same class mapping as the editor; `0` renders transparently |

RGB-colored overlays are **not** label masks. Likewise, a model producing `0=land, 1=sea, 2=sky` requires remapping to `1=land, 2=sea, 3=sky` before its result can be used as a HorizonScribe prediction-preview mask. Dimensions must exactly match the source photo. Never resize class IDs with a smoothing interpolator; use nearest-neighbor if a deliberate coordinate conversion is required.

An optional `review` object can import an existing reviewed class mask and effective mask with a 64-character SHA-256 `revision`, an `approved` flag, and optional metadata. See `desktop/source.example.json`. Do not mark predictions human-approved. On iPad, automatic pixels inherit the base mask's land/remove classification; binary removed pixels initially resolve to sea until the user labels sky explicitly.

## Build an immutable snapshot

```shell
node desktop/prepare-dataset.mjs --source data/coast-01/source.json --output snapshots
```

Output includes `datasetId`, `manifest`, `uploadPlan`, and statistics. Dataset identity is derived from canonical content, including names, dimensions, file hashes, labels, and prefix. Identical blobs are deduplicated.

The builder refuses to reuse an existing dataset output folder. Reuse its existing manifest/plan, or choose another output parent if rebuilding is intentional. If source files change after preparation, upload/review-building checks reject the stale plan; prepare a new snapshot instead.

Use `--prefix production/horizon-scribe/v1` explicitly when needed. A nondefault prefix must also match the Worker variable and S3 uploader environment.

```text
PREFIX/
  blobs/sha256/ab/abcdef...                 immutable photo/mask blobs
  snapshots/DATASET_ID/manifest.json        immutable dataset manifest
  current.json                             active dataset pointer
  next-pass/DATASET_ID/current.json         exact ordered queue
  cloud-reviews/DATASET_ID/.../current.json current image review
  cloud-reviews/DATASET_ID/.../revisions/   retained immutable review records
  cloud-reviews/DATASET_ID/index.json       approval/catalog index
```

Manifests are SHA-256-pinned, **not cryptographically signed**. The bucket owner and upload credentials are trusted to publish them.

## Upload and resume

Convenient interactive-login path:

```shell
node desktop/wrangler-upload.mjs --plan snapshots/DATASET_ID/upload-plan.jsonl --bucket horizon-scribe
```

It validates local hashes, uploads immutable records before mutable pointers, and saves a `*.wrangler-state.json` resume journal beside the plan. The journal records completed requests, not an independent audit of current remote state. Do not reuse it after deleting/mutating remote objects. This path uses remote `put --force`; it does not enforce remote immutability or checksum evidence. Use one publisher and keep content-addressed keys immutable by convention.

Stronger remote verification:

```shell
node desktop/upload-r2.mjs check
node desktop/upload-r2.mjs upload --plan snapshots/DATASET_ID/upload-plan.jsonl
```

After configuring [bucket-scoped credentials](CLOUDFLARE.md#7-optional-use-bucket-scoped-s3-credentials), this checks remote size/SHA-256 metadata, skips matching objects, refuses mismatched existing immutable objects, and verifies writes. Mutable pointers intentionally replace the current published selection; use a single dataset/batch publisher. Remote metadata verifies consistency with the upload plan, not an independent full-body rehash.

Upload plans contain workstation-local absolute paths. Do not commit them or move source media while a plan is in use.

For independent full-body verification after either uploader, set `HORIZON_SCRIBE_API_TOKEN` privately and run:

```shell
node desktop/verify-dataset.mjs --url https://YOUR_WORKER.workers.dev --snapshot snapshots/DATASET_ID/manifest.json --report data/cloud-verification.json
```

This read-only check downloads every photo and base mask through the app's authenticated API and compares its size and SHA-256 with the local snapshot. It also checks catalog image identities, dimensions, and snapshot revisions. A success report is written only when all checks pass. `--concurrency` accepts 1–12 (default 6). This does not replace device testing or a backup of review history.

## Prepare and publish the next round

Use the [desktop reviewer](DESKTOP_REVIEW.md), or write `horizon-scribe-next-batch-source/v1` manually:

```json
{
  "schema": "horizon-scribe-next-batch-source/v1",
  "datasetId": "REPLACE_WITH_THE_64_CHARACTER_DATASET_ID",
  "images": [
    {"setId": "coast-01", "image": "frame-001.jpg", "rank": 0}
  ]
}
```

The desktop reviewer includes the dataset ID automatically. For manually authored files it is optional for compatibility, but strongly recommended. An explicit wrong ID is rejected. Items must exist in the exact snapshot; duplicates, invalid/duplicate ranks, empty published queues, and more than 500 images are rejected.

```shell
node desktop/prepare-next-batch.mjs --snapshot snapshots/DATASET_ID/manifest.json --selection data/review-round-01/next-batch.json --output data/publish-round-01
node desktop/wrangler-upload.mjs --plan data/publish-round-01/next-pass-upload-plan.jsonl --bucket horizon-scribe
```

The output directory holds `next-pass.json` and `next-pass-upload-plan.jsonl`. Use a fresh round directory for each publication to preserve your local history. Refresh the iPad catalog after publication. Changing the batch does not change the dataset or erase saved labels.

## Export saved cloud reviews

Set `HORIZON_SCRIBE_API_TOKEN` in the desktop environment privately, then:

```shell
npm run reviews:export -- --url https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev --output data/export-round-01
```

Output directory must not already exist. The exporter downloads:

- `catalog.json`: current cloud approval status and dataset identity;
- `training-manifest.json`: the API's eligible-image summary;
- numbered `*.state.json` files and single-channel `*.labels.png` masks for cloud-saved full rasters;
- `manifest.json`: exact mapping from numbered files to set/image/revision identities, written only after successful completion.

It does not download source photographs or duplicate snapshot-only imported masks. It checks that each exported state matches the catalog revision; if a user edits during export, stop editing and retry to a fresh folder. A partial directory without `manifest.json` is not a completed export.

Use the exported `catalog.json` with `review:build --reviews ...` to hide approved images when choosing the next round. Keep your original snapshot and source media: exports alone are not a complete dataset backup.

## Training is a separate integration

The repository exports machine-readable masks, accepts prediction previews, and includes an optional pinned [FLAIR-INC sea-only first-pass runner](MODELS_AND_DATA.md#private-flair-inc-first-pass). It does not include model training. Other model pipelines remain external and retain their own licenses. A saved or approved mask is not evidence of model accuracy; validate trained models on independent data before relying on them.
