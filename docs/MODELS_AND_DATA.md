# Code, data, predictions, and model weights

## What MIT covers here

The repository's original application code, scripts, documentation, and bundled app artwork are licensed under MIT. Third-party dependencies retain their own licenses. Photos, locally generated annotations, user-supplied predictions, and model weights are not implicitly licensed by the repository's `LICENSE` file.

No pretrained checkpoint, training photo collection, cloud account, R2 bucket contents, or production endpoint is distributed in this repository. Generated demo scenes are procedural fixtures created by the included MIT-licensed script, not the author's private photographs.

## Use a model you are entitled to use

HorizonScribe does not need a model for manual labeling. To review predictions, produce same-size single-channel PNGs using the class mapping in [Datasets](DATASETS.md#mask-encodings-do-not-confuse-them) and describe them with the [prediction sidecar](DESKTOP_REVIEW.md#optional-model-predictions).

## Private FLAIR-INC first pass

The optional `model/infer_flair_inc.py` runner downloads the revision- and SHA-256-pinned `IGNF/FLAIR-INC_rgb_15cl_resnet34-unet` checkpoint into ignored local `data/`, then runs overlapping 512-pixel inference over a prepared HorizonScribe snapshot. Nothing uploads the checkpoint or predictions. The model's raw-argmax `water` and `swimming_pool` classes become HorizonScribe `sea`; all other pixels remain `automatic`. This is proposal-only evidence and does not infer sky.

```shell
npm run model:setup
npm run model:infer -- --snapshot snapshots/DATASET_ID/manifest.json --plan snapshots/DATASET_ID/upload-plan.jsonl --output data/flair-inc-first-pass
```

Apple Silicon uses MPS automatically; CUDA is selected on a compatible machine, otherwise CPU is used. Interrupted runs are resumed by repeating the inference command with `--resume`. Each source photo and base mask is SHA-256 checked before use. Review priority is the fraction disagreeing with the legacy base mask; it is a triage hint, not measured accuracy.

The upstream checkpoint is distributed by Institut national de l'information géographique et forestière (IGN) under Etalab Open Licence 2.0. Source: [`IGNF/FLAIR-INC_rgb_15cl_resnet34-unet`](https://huggingface.co/IGNF/FLAIR-INC_rgb_15cl_resnet34-unet), pinned revision `d8a81bc5bc46357677ba0569e83c4c68d3f78b89`, model card last updated August 9, 2024. Keep this attribution, source, update date, revision, and license with any private copy or derived artifact. HorizonScribe's MIT license does not replace those terms.

To distribute a fine-tuned model separately, document the base checkpoint and its license, modifications, training-data rights, class mapping, preprocessing, evaluation, and known limitations. Do not assume an MIT application license re-licenses an upstream checkpoint. Keep any model release license/model card alongside that artifact, whether hosted on a model hub or a separate release.

This repository's training-manifest route and PNG exporter provide integration data, not a bundled training engine, inference service, or claim of model quality. Desktop prediction previews are not automatically accepted as human labels.

## Data ownership and sharing

Users choose which images to upload to their own bucket. The photo importer writes normalized, metadata-stripped copies while leaving original input files unchanged; a manually supplied source manifest may still reference images with embedded metadata. Review and sanitize any material before sharing it publicly.

Keep generated data under ignored `data/` and `snapshots/` directories or outside the repository. Model extensions are ignored as an extra guard, not proof that every possible private artifact is excluded. Inspect staged files before publishing changes.
