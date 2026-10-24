# Code, data, predictions, and model weights

## What MIT covers here

The repository's original application code, scripts, documentation, and bundled app artwork are licensed under MIT. Third-party dependencies retain their own licenses. Photos, locally generated annotations, user-supplied predictions, and model weights are not implicitly licensed by the repository's `LICENSE` file.

No pretrained checkpoint, training photo collection, cloud account, R2 bucket contents, or production endpoint is distributed in this repository. Generated demo scenes are procedural fixtures created by the included MIT-licensed script, not the author's private photographs.

## Use a model you are entitled to use

HorizonScribe does not need a model for manual labeling. To review predictions, produce same-size single-channel PNGs using the class mapping in [Datasets](DATASETS.md#mask-encodings-do-not-confuse-them) and describe them with the [prediction sidecar](DESKTOP_REVIEW.md#optional-model-predictions).

To distribute a fine-tuned model separately, document the base checkpoint and its license, modifications, training-data rights, class mapping, preprocessing, evaluation, and known limitations. Do not assume an MIT application license re-licenses an upstream checkpoint. Keep any model release license/model card alongside that artifact, whether hosted on a model hub or a separate release.

This repository's training-manifest route and PNG exporter provide integration data, not a bundled training engine, inference service, or claim of model quality. Desktop prediction previews are not automatically accepted as human labels.

## Data ownership and sharing

Users choose which images to upload to their own bucket. The photo importer writes normalized, metadata-stripped copies while leaving original input files unchanged; a manually supplied source manifest may still reference images with embedded metadata. Review and sanitize any material before sharing it publicly.

Keep generated data under ignored `data/` and `snapshots/` directories or outside the repository. Model extensions are ignored as an extra guard, not proof that every possible private artifact is excluded. Inspect staged files before publishing changes.
