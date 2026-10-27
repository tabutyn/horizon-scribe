# Migration to HorizonScribe and iPad replacement gate

## Scope of this port

The public code was extracted from a private LabelLab workflow, briefly packaged under the working name Sea-Sky Masker, and renamed to **HorizonScribe**. This repository contains the standalone iPad client, Cloudflare API, desktop preparation/review/upload/export tools, and documentation. It is not a copy of the private server, identity system, photo collection, trained checkpoint, or full training orchestrator.

The desktop Next Round interface preserves the core comparison/selection workflow in a new local implementation. It is not a byte-for-byte port of the old authenticated website: private sign-in, server-specific model controls, and private directory conventions have been removed. Prediction masks and optional priorities can come from the private pinned FLAIR first-pass runner or a user's own external model pipeline.

## Rename coverage

| Previous surface | Replacement |
| --- | --- |
| LabelLab / Sea-Sky Masker display branding | HorizonScribe |
| `SeaSkyMasker` Swift types, modules, targets and files | `HorizonScribe` / `HorizonScribeCore` |
| `seaSkyMasker…` Swift color helpers | `horizonScribe…` |
| `sea-sky-masker` package/service/schema identity | `horizon-scribe` |
| `SEA_SKY_MASKER_*` configuration variables | `HORIZON_SCRIBE_*` |
| Example `org.example.seaskymasker` bundle IDs | `org.example.horizonscribe` and `.dev` |
| Old product Keychain/cache/draft namespace | Independent HorizonScribe namespace |
| Old Worker/bucket defaults and R2 prefix | New HorizonScribe defaults |
| Private server-linked desktop review | Loopback-only HorizonScribe Next Round app |

The [complete canonical inventory](ARCHITECTURE.md#canonical-naming-inventory) lists current identifiers. Older names appear here for migration explanation only, not as runtime endpoints or supported compatibility aliases.

## What is deliberately not automatic

Changing code names does not rename deployed Cloudflare resources, copy old bucket contents, translate existing schema JSON, migrate an installed app's sandbox, or revoke old credentials. The HorizonScribe release must be deployed into its own account-owned resources. No migration command contacts the previous private service.

R2 keys and schema identifiers have changed. Do not point the new Worker at an old prefix and expect its manifests/reviews to be accepted. Rebuild HorizonScribe snapshots from retained source photos and masks. Review revisions should be deliberately exported/imported, not rewritten by global search-and-replace inside a live bucket.

This is particularly important because changing the prefix changes the dataset identity. Old device drafts are not automatically valid against that new identity.

## Recover a verified LabelLab R2 backup

When a complete local object backup exists, the old workstation is not needed to recover the working photo collection. This is the resolution stored by the old application, which may be smaller than camera originals. Keep the backup unchanged and private.

The supported input has `inventory.json`, `inventory.sha256`, and `objects/` containing the exact R2 keys. The inventory schema is `ballroller-r2-local-backup/v1`; each object entry includes `key`, `size`, and `localSha256`. The importer checks the inventory digest and rehashes every object it consumes. It validates the active manifest and copies photos/masks without re-encoding, preserving existing set/image identities and pixel alignment.

From the repository root, use a new output directory:

```shell
node desktop/import-label-lab-backup.mjs --backup /path/to/verified-backup --output data/recovered-collection
node desktop/prepare-dataset.mjs --source data/recovered-collection/source.json --output snapshots
```

The importer writes `import-report.json`, a standard source manifest, baseline snapshot annotations, `reviews.json` containing newer full-raster cloud edits, and `next-batch.json` when the old queue exists. It does not publish anything. Use the new dataset ID printed by `prepare-dataset`; changing the prefix changes dataset identity. Partial imports without `import-report.json` are incomplete and must not be published. Start retries in a fresh directory.

Inspect counts in the import report, then follow the normal dataset uploader:

```shell
node desktop/wrangler-upload.mjs --plan snapshots/NEW_DATASET_ID/upload-plan.jsonl --bucket horizon-scribe
```

This activates the real collection in the new deployment after uploading its immutable objects. Keep the previous dataset's manifest/pointer for rollback and finish any previous device drafts first. Do not delete either dataset's objects during testing.

Restore the latest saved annotations through the authenticated Worker API. Set `HORIZON_SCRIBE_API_TOKEN` through your secret manager, then:

```shell
node desktop/restore-reviews.mjs --url https://YOUR_WORKER.workers.dev --dataset NEW_DATASET_ID --input data/recovered-collection/reviews.json --report data/recovered-collection/restore-report.json
```

The restore checks every image identity, size, and snapshot revision before writing. It preserves `approved` and `humanReviewed`, including unreviewed predictions. Saves use conditional revisions and are read back to compare all rows and flags. Rerunning skips exact matching saves and refuses to overwrite different edits. The report maps old revisions to their new HorizonScribe revisions. Original historical revisions remain in the backup; they are not rewritten or deleted.

If any old current pointer is not a complete `full-class-raster/v1` review, import stops rather than guessing missing pixels. Resolve that legacy representation explicitly before migration. Snapshot-only reviews remain available through their original class/effective masks and are not promoted into cloud approval by the restore tool.

Prepare the recovered queue against the new snapshot, then publish it:

```shell
node desktop/prepare-next-batch.mjs --snapshot snapshots/NEW_DATASET_ID/manifest.json --selection data/recovered-collection/next-batch.json --output data/recovered-queue
node desktop/wrangler-upload.mjs --plan data/recovered-queue/next-pass-upload-plan.jsonl --bucket horizon-scribe
```

Verify every photo/base-mask body, restored review rows/flags, and the exact queue through the authenticated API:

```shell
node desktop/verify-dataset.mjs --url https://YOUR_WORKER.workers.dev --snapshot snapshots/NEW_DATASET_ID/manifest.json --reviews data/recovered-collection/reviews.json --queue data/recovered-queue/next-pass.json --report data/recovered-collection/cloud-verification.json
```

The verifier reads the same `HORIZON_SCRIBE_API_TOKEN` environment variable; it makes no cloud writes. It downloads all photos and base masks, checks their sizes/SHA-256 digests, and writes a success report only after every requested check passes. This can take time for a large collection. Omit `--queue` if no queue was recovered. Stop labeling during migration verification so intentional new edits do not invalidate comparisons.

Check the live catalog's approval counts, export restored reviews using the normal exporter, and compare their PNG rasters with `reviews.json`. Refresh the iPad and run the device checklist on these real photos. A successful upload is not evidence that Pencil, offline recovery, or image alignment has passed.

## Before removing the old iPad app

Keep the old app installed until all applicable gates below are satisfied. Deleting it may delete locally stored drafts and cached data; a Keychain entry alone is not a backup.

1. **Preserve current work.** Open the old app online, sync every edited image, and confirm no unresolved conflicts or unsynced drafts remain. Export/back up the old server-side annotations and source files using its existing supported tools.
2. **Inventory the backup.** Record the datasets/images, dimensions, approval counts, and revisions expected to survive. Keep that inventory privately, not in this repository.
3. **Verify the new repository.** Confirm the intended commit is in `tabutyn/horizon-scribe` and its JavaScript, browser, Swift, and simulator checks are successful. A Windows-only test run does not establish that the iPad app builds.
4. **Create isolated cloud resources.** New Worker, private bucket/prefix, and token. Verify `/health`, authentication, dataset upload, and queue publication before pointing a device at them.
5. **Prepare a small smoke dataset.** Prefer the synthetic demo or a few non-sensitive photos. Do not begin with a destructive migration of the production collection.
6. **Build the new app with a distinct bundle ID.** This permits a side-by-side comparison where signing allows it. Choose a team-owned identifier; do not reuse the old app's bundle ID during validation.
7. **Run the device acceptance checklist on real data.** After the smoke test, publish the complete recovered collection and latest reviews. Check expected counts and queue order, compare downloaded photo/mask hashes with the backup, and compare exported review pixels and approval flags. Complete [iPad acceptance](../ios/README.md#device-acceptance-checklist) on representative real photos, including offline and conflict behavior and a round trip through the desktop export/reviewer. Synthetic images alone do not satisfy the replacement gate.
8. **Explicitly approve removal.** Only after backups and device testing are confirmed should the old app be removed. Uninstalling, revoking its credentials, deleting its Worker/bucket, and stopping its server are separate actions—not implied by publishing this repository.

If the chosen installation process requires removing the old app first, complete and verify the backup before doing so; never rely on later recovery of unsynced local drafts.

## Rollback

Keep old infrastructure and the old app available while validating the new deployment. Do not switch or delete the old bucket's active pointer. If HorizonScribe fails a device test, retain its draft/export evidence, stop new labeling, and return to the previous application without changing its data. HorizonScribe's distinct namespace is intended to make that possible.

This document is a procedure, not a claim that production data migration, iPad installation, device testing, or old-app removal has happened.
