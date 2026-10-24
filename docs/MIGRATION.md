# Migration to HorizonScribe and iPad replacement gate

## Scope of this port

The public code was extracted from a private LabelLab workflow, briefly packaged under the working name Sea-Sky Masker, and renamed to **HorizonScribe**. This repository contains the standalone iPad client, Cloudflare API, desktop preparation/review/upload/export tools, and documentation. It is not a copy of the private server, identity system, photo collection, trained checkpoint, or full training orchestrator.

The desktop Next Round interface preserves the core comparison/selection workflow in a new local implementation. It is not a byte-for-byte port of the old authenticated website: private sign-in, server-specific model controls, and private directory conventions have been removed. Prediction masks and optional priorities can come from a user's own external model pipeline.

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

## Before removing the old iPad app

Keep the old app installed until all applicable gates below are satisfied. Deleting it may delete locally stored drafts and cached data; a Keychain entry alone is not a backup.

1. **Preserve current work.** Open the old app online, sync every edited image, and confirm no unresolved conflicts or unsynced drafts remain. Export/back up the old server-side annotations and source files using its existing supported tools.
2. **Inventory the backup.** Record the datasets/images, dimensions, approval counts, and revisions expected to survive. Keep that inventory privately, not in this repository.
3. **Verify the new repository.** Confirm the intended commit is in `tabutyn/horizon-scribe` and its JavaScript, browser, Swift, and simulator checks are successful. A Windows-only test run does not establish that the iPad app builds.
4. **Create isolated cloud resources.** New Worker, private bucket/prefix, and token. Verify `/health`, authentication, dataset upload, and queue publication before pointing a device at them.
5. **Prepare a small smoke dataset.** Prefer the synthetic demo or a few non-sensitive photos. Do not begin with a destructive migration of the production collection.
6. **Build the new app with a distinct bundle ID.** This permits a side-by-side comparison where signing allows it. Choose a team-owned identifier; do not reuse the old app's bundle ID during validation.
7. **Run the device acceptance checklist.** Complete [iPad acceptance](../ios/README.md#device-acceptance-checklist), including offline and conflict behavior and a round trip through the desktop export/reviewer.
8. **Explicitly approve removal.** Only after backups and device testing are confirmed should the old app be removed. Uninstalling, revoking its credentials, deleting its Worker/bucket, and stopping its server are separate actions—not implied by publishing this repository.

If the chosen installation process requires removing the old app first, complete and verify the backup before doing so; never rely on later recovery of unsynced local drafts.

## Rollback

Keep old infrastructure and the old app available while validating the new deployment. Do not switch or delete the old bucket's active pointer. If HorizonScribe fails a device test, retain its draft/export evidence, stop new labeling, and return to the previous application without changing its data. HorizonScribe's distinct namespace is intended to make that possible.

This document is a procedure, not a claim that production data migration, iPad installation, device testing, or old-app removal has happened.
