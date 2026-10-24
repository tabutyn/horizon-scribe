# Architecture, names, and service contracts

## Components and boundaries

```text
Desktop source photos / optional model outputs
    ├─ prepare-dataset → hashed blobs + snapshot + upload plan
    │                          └─ explicit uploader → private R2
    └─ build-review → loopback Next Round UI → selection JSON
                                 └─ prepare-next-batch → explicit uploader → R2 queue

iPad HorizonScribe ── HTTPS + app token ── Cloudflare Worker ── R2 binding ── private R2
       └─ Keychain credentials + protected local drafts/cache

Desktop export-reviews ── HTTPS + app token ── Worker → local states / label PNGs
```

The desktop reviewer does not proxy your cloud account. Cloudflare does not run the desktop preview process or neural-network training. GitHub contains source code, not a central dataset or credential store.

## Canonical naming inventory

| Surface | HorizonScribe name |
| --- | --- |
| Product/display name | `HorizonScribe` (`HorizonScribe Dev` in Debug) |
| GitHub repository | `tabutyn/horizon-scribe` |
| npm package identity | `horizon-scribe` (private package; no npm publishing configured) |
| Xcode project / target / shared scheme | `HorizonScribe` |
| Swift package and module | `HorizonScribeCore` |
| Swift unit-test target | `HorizonScribeCoreTests` |
| App classes / views | `HorizonScribeApp`, `HorizonScribeSession`, `HorizonScribeCloudAPI`, and `HorizonScribe…View` |
| Example release bundle ID | `org.example.horizonscribe` |
| Example debug bundle ID | `org.example.horizonscribe.dev` |
| Xcode display-name setting | `HORIZON_SCRIBE_DISPLAY_NAME` |
| Keychain service | `org.horizon-scribe.worker` |
| Application Support folders | `HorizonScribe/Drafts`, `HorizonScribe/Cache` |
| Default Worker and bucket names | `horizon-scribe` |
| Worker R2 binding | `HORIZON_SCRIBE_BUCKET` |
| Worker secret | `HORIZON_SCRIBE_API_TOKEN` |
| Worker object-prefix variable | `HORIZON_SCRIBE_PREFIX` |
| Desktop S3 variables | `HORIZON_SCRIBE_R2_*` |
| Default R2 object prefix | `production/horizon-scribe/v1` |
| `/health` service identifier | `horizon-scribe` |
| Versioned JSON schema prefix | `horizon-scribe-…/v1` |
| Desktop review title | `HorizonScribe · Next Round` |

Forks should use bundle identifiers owned by their Apple team. Changing a display name does not migrate Keychain entries, drafts, caches, bucket keys, or schema versions. See [Migration](MIGRATION.md).

## Worker API

All `/v1/` routes require `Authorization: Bearer APP_TOKEN`. No unauthenticated image endpoint exists. The token authorizes the entire deployment; it does not carry per-user roles. Health alone is public.

| Method | Route | Contract |
| --- | --- | --- |
| GET | `/health` | Service health, no storage validation |
| GET | `/v1/catalog` | Active dataset, sets, approvals, explicit queue |
| GET | `/v1/sets/{set}` | One set's catalog |
| GET | `/v1/sets/{set}/images/{image}` | Current cloud/snapshot correction state |
| PUT | `/v1/sets/{set}/images/{image}` | Complete raster edit with base revisions |
| GET / HEAD | `/v1/asset?set=…&image=…&artifact=…&dataset=…` | Manifest-listed asset, never an arbitrary R2 key |
| GET | `/v1/next-pass` | Current dataset-bound ordered queue |
| GET | `/v1/training-manifest` | Full-raster approved review eligibility and queue progress |

State/save/export requests can include `?dataset=DATASET_ID`; a mismatch returns `409 DATASET_STALE`. The iPad sends it on image-state and save requests. Asset reads also pin the dataset. Catalog/current pointers may be cached in a Worker isolate for up to 15 seconds, so a newly published dataset can take that long to appear. Wait and refresh during cutover; do not label against a dataset being switched by another publisher.

Save requests include `horizon-scribe-cloud-review-edit/v1`, `representation: full-class-raster/v1`, an operation ID, approval state, snapshot-base/cloud-base revisions, and complete rows. Runs are `[startX, endXExclusive, classID]`. Every row must cover the full width contiguously with class IDs 1–3. Invalid/incomplete rasters are rejected.

The per-image pointer uses an R2 conditional write; stale concurrent edits receive 409. The shared catalog index also uses conditional writes with bounded retries. Image revisions are retained; ordinary saves do not prune history. The index is a derived summary and can lag if its update fails after a pointer save; reconcile/retry before treating an export as complete. R2 is not a multi-object transaction database.

## Dataset and desktop schemas

- `horizon-scribe-source/v1`: local photo/mask sources.
- `horizon-scribe-r2-snapshot/v1`: immutable dataset manifest.
- `horizon-scribe-r2-current/v1`: active dataset pointer, including manifest SHA-256.
- `horizon-scribe-r2-upload-object/v1`: one local upload-plan record.
- `horizon-scribe-next-batch-source/v1`: desktop selection source.
- `horizon-scribe-next-pass-selection/v1`: published queue (existing API concept is called Next Pass).
- `horizon-scribe-predictions-source/v1`: optional local predicted masks/priorities.
- `horizon-scribe-review-bundle/v1`: compact local comparison previews and identities.
- `horizon-scribe-review-export/v1`: exported cloud state/mask inventory.

The plain `full-class-raster/v1`, `model-base-mask/v1`, and `source-image/v1` strings describe generic representations, not a previous product brand. They remain intentionally stable.
