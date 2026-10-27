#!/usr/bin/env python3
"""Run pinned IGN FLAIR-INC zero-shot sea inference over a HorizonScribe snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
from PIL import Image


REPOSITORY = "IGNF/FLAIR-INC_rgb_15cl_resnet34-unet"
REVISION = "d8a81bc5bc46357677ba0569e83c4c68d3f78b89"
FILENAME = "FLAIR-INC_rgb_15cl_resnet34-unet_weights.pth"
CHECKPOINT_SHA256 = "d0033871116361360fa6d2024cc4425a01858afdff1bef2ed1d35514cd48a015"
MODEL_LICENSE = "Etalab-2.0"
TILE_SIZE = 512
DEFAULT_STRIDE = 256
MEAN = np.asarray((105.08, 110.87, 101.82), dtype=np.float32).reshape(1, 1, 3)
STD = np.asarray((52.17, 45.38, 44.0), dtype=np.float32).reshape(1, 1, 3)
WATER_CLASSES = (4, 12)
EXPECTED_MAPPED_KEYS = 278
CLASS_NAMES = (
    "building", "pervious", "impervious", "bare_soil", "water", "coniferous",
    "deciduous", "brushwood", "vineyard", "herbaceous", "agricultural",
    "greenhouse", "swimming_pool", "snow", "source_15_disabled",
    "source_16_disabled", "source_17_disabled", "unknown_18", "source_19_disabled",
)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=path.parent,
                                     prefix=f".{path.name}-", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_png(path: Path, pixels: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.stem}-", suffix=".png",
                                     delete=False) as handle:
        temporary = Path(handle.name)
    try:
        Image.fromarray(pixels.astype(np.uint8)).save(temporary, format="PNG", optimize=True)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def tile_origins(length: int, tile_size: int = TILE_SIZE, stride: int = DEFAULT_STRIDE) -> list[int]:
    if length <= 0 or tile_size <= 0 or stride <= 0 or stride > tile_size:
        raise ValueError("Invalid tiling dimensions")
    if length <= tile_size:
        return [0]
    origins = list(range(0, length - tile_size + 1, stride))
    final = length - tile_size
    if origins[-1] != final:
        origins.append(final)
    return origins


def blending_window(tile_size: int = TILE_SIZE) -> np.ndarray:
    axis = np.maximum(np.hanning(tile_size).astype(np.float32), np.float32(1e-3))
    return np.maximum(np.outer(axis, axis), np.float32(1e-6))


def pad_rgb(rgb: np.ndarray) -> tuple[np.ndarray, tuple[int, int]]:
    height, width = rgb.shape[:2]
    pad_height, pad_width = max(0, TILE_SIZE - height), max(0, TILE_SIZE - width)
    if not pad_height and not pad_width:
        return rgb, (height, width)
    mode = "reflect" if height > 1 and width > 1 else "edge"
    return np.pad(rgb, ((0, pad_height), (0, pad_width), (0, 0)), mode=mode), (height, width)


def remap_state_dict(raw: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    mapped, ignored, unknown = {}, [], []
    for key, value in raw.items():
        if key == "criterion.weight":
            ignored.append(key)
        elif key.startswith("model.seg_model."):
            mapped[key.removeprefix("model.seg_model.")] = value
        else:
            unknown.append(key)
    if unknown:
        raise RuntimeError(f"Unrecognized FLAIR-INC checkpoint keys: {unknown[:8]}")
    if ignored != ["criterion.weight"]:
        raise RuntimeError("FLAIR-INC checkpoint did not contain its one expected criterion tensor")
    return mapped, ignored


def resolve_device(requested: str, torch: Any) -> str:
    if requested != "auto":
        if requested == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("MPS requested but unavailable")
        if requested == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but unavailable")
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_model(cache: Path, device: str) -> tuple[Any, Path, list[str]]:
    import segmentation_models_pytorch as smp
    import torch
    from huggingface_hub import hf_hub_download

    checkpoint = Path(hf_hub_download(repo_id=REPOSITORY, filename=FILENAME,
                                      revision=REVISION, cache_dir=str(cache)))
    observed = sha256_file(checkpoint)
    if observed != CHECKPOINT_SHA256:
        raise RuntimeError(f"Checkpoint SHA-256 mismatch: {observed}")
    model = smp.create_model(arch="unet", encoder_name="resnet34", encoder_weights=None,
                             in_channels=3, classes=len(CLASS_NAMES))
    raw = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if isinstance(raw, dict) and set(raw) == {"state_dict"}:
        raw = raw["state_dict"]
    if not isinstance(raw, dict):
        raise RuntimeError("Unexpected checkpoint object")
    state, ignored = remap_state_dict(raw)
    if len(state) != EXPECTED_MAPPED_KEYS:
        raise RuntimeError(f"Expected {EXPECTED_MAPPED_KEYS} model tensors, got {len(state)}")
    incompatible = model.load_state_dict(state, strict=False)
    if incompatible.missing_keys or incompatible.unexpected_keys:
        raise RuntimeError(f"Checkpoint/model mismatch: {incompatible}")
    model.eval().to(device)
    return model, checkpoint, ignored


def infer_logits(model: Any, rgb: np.ndarray, device: str, stride: int, batch_size: int) -> np.ndarray:
    import torch

    padded, original = pad_rgb(rgb)
    height, width = padded.shape[:2]
    origins = [(y, x) for y in tile_origins(height, stride=stride)
               for x in tile_origins(width, stride=stride)]
    window = blending_window()
    logits_sum = np.zeros((len(CLASS_NAMES), height, width), dtype=np.float32)
    weights_sum = np.zeros((height, width), dtype=np.float32)
    with torch.inference_mode():
        for start in range(0, len(origins), batch_size):
            batch_origins = origins[start:start + batch_size]
            tiles = np.stack([
                ((padded[y:y + TILE_SIZE, x:x + TILE_SIZE].astype(np.float32) - MEAN) / STD)
                .transpose(2, 0, 1)
                for y, x in batch_origins
            ])
            output = model(torch.from_numpy(tiles).to(device))
            if isinstance(output, dict):
                output = output.get("out")
            if not isinstance(output, torch.Tensor):
                raise RuntimeError("Unexpected model output")
            values = output.detach().float().cpu().numpy()
            if values.shape != (len(batch_origins), len(CLASS_NAMES), TILE_SIZE, TILE_SIZE):
                raise RuntimeError(f"Unexpected logits shape {values.shape}")
            for (y, x), tile_logits in zip(batch_origins, values):
                logits_sum[:, y:y + TILE_SIZE, x:x + TILE_SIZE] += tile_logits * window[None]
                weights_sum[y:y + TILE_SIZE, x:x + TILE_SIZE] += window
    if np.any(weights_sum <= 0):
        raise RuntimeError("Tiling left uncovered pixels")
    logits_sum /= weights_sum[None]
    return logits_sum[:, :original[0], :original[1]]


def sea_class_mask(logits: np.ndarray) -> np.ndarray:
    labels = np.argmax(logits, axis=0)
    return np.where(np.isin(labels, WATER_CLASSES), 2, 0).astype(np.uint8)


def disagreement_priority(class_mask: np.ndarray, base_keep: np.ndarray) -> tuple[float, dict[str, Any]]:
    predicted_sea = class_mask == 2
    base_removed = ~base_keep
    disagreement = predicted_sea != base_removed
    return float(np.mean(disagreement)), {
        "predictedSeaPixels": int(np.count_nonzero(predicted_sea)),
        "predictedSeaFraction": float(np.mean(predicted_sea)),
        "baseRemovedPixels": int(np.count_nonzero(base_removed)),
        "disagreementPixels": int(np.count_nonzero(disagreement)),
        "disagreementFraction": float(np.mean(disagreement)),
    }


def read_inputs(snapshot_path: Path, plan_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    raw = snapshot_path.read_bytes()
    snapshot = json.loads(raw)
    if snapshot.get("schema") != "horizon-scribe-r2-snapshot/v1" or len(snapshot.get("datasetId", "")) != 64:
        raise RuntimeError("Invalid HorizonScribe snapshot")
    records = [json.loads(line) for line in plan_path.read_text(encoding="utf-8").splitlines() if line]
    by_key = {row.get("key"): row for row in records}
    if len(by_key) != len(records):
        raise RuntimeError("Duplicate upload-plan key")
    manifest_key = f"{snapshot['prefix']}/snapshots/{snapshot['datasetId']}/manifest.json"
    if by_key.get(manifest_key, {}).get("sha256") != sha256_bytes(raw):
        raise RuntimeError("Snapshot does not match upload plan")
    images = []
    identities = set()
    for group in snapshot.get("sets", []):
        for image in group.get("images", []):
            identity = (group["id"], image["name"])
            if identity in identities:
                raise RuntimeError("Duplicate image identity")
            identities.add(identity)
            photo, base = by_key.get(image["photo"]["key"]), by_key.get(image["baseMask"]["key"])
            if not photo or photo.get("sha256") != image["photo"]["sha256"]:
                raise RuntimeError(f"Missing photo evidence for {identity}")
            if not base or base.get("sha256") != image["baseMask"]["sha256"]:
                raise RuntimeError(f"Missing base-mask evidence for {identity}")
            images.append({"setId": group["id"], "image": image["name"], "width": image["width"],
                           "height": image["height"], "photo": photo, "baseMask": base})
    return snapshot, images, by_key


def verified_path(record: dict[str, Any]) -> Path:
    path = Path(record["localPath"]).resolve(strict=True)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != record["bytes"]:
        raise RuntimeError(f"Invalid local artifact: {path}")
    if sha256_file(path) != record["sha256"]:
        raise RuntimeError(f"Changed local artifact: {path}")
    return path


def runtime_versions(torch: Any, smp: Any) -> dict[str, Any]:
    import PIL
    import huggingface_hub
    return {"python": platform.python_version(), "platform": platform.platform(),
            "torch": torch.__version__, "segmentationModelsPytorch": smp.__version__,
            "numpy": np.__version__, "Pillow": PIL.__version__,
            "huggingfaceHub": huggingface_hub.__version__}


def run(args: argparse.Namespace) -> dict[str, Any]:
    import segmentation_models_pytorch as smp
    import torch

    snapshot_path, plan_path = args.snapshot.resolve(strict=True), args.plan.resolve(strict=True)
    output, cache = args.output.resolve(), args.cache.resolve()
    snapshot, images, _ = read_inputs(snapshot_path, plan_path)
    if args.limit is not None:
        images = images[:args.limit]
    if output.exists() and any(output.iterdir()) and not args.resume:
        raise RuntimeError(f"Refusing non-empty output {output}; use --resume")
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    config = {"datasetId": snapshot["datasetId"], "repository": REPOSITORY, "revision": REVISION,
              "checkpointSha256": CHECKPOINT_SHA256, "tileSize": TILE_SIZE, "stride": args.stride,
              "decision": "raw argmax classes water(4) or swimming_pool(12)",
              "outputClasses": {"automatic": 0, "sea": 2}, "imageCount": len(images)}
    run_id = sha256_bytes(canonical(config))
    state_path = output / "run.json"
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
        if state.get("runId") != run_id or state.get("configuration") != config:
            raise RuntimeError("Existing output belongs to a different inference configuration")
    else:
        state = {"schema": "horizon-scribe-flair-inc-run/v1", "runId": run_id,
                 "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 "configuration": config, "status": "running", "runtime": None,
                 "checkpoint": None, "images": []}
        atomic_json(state_path, state)
    completed = {(row["setId"], row["image"]): row for row in state["images"]}
    device = resolve_device(args.device, torch)
    model, checkpoint, ignored = load_model(cache, device)
    state["runtime"] = {**runtime_versions(torch, smp), "device": device, "batchSize": args.batch_size}
    state["checkpoint"] = {"path": str(checkpoint), "sha256": CHECKPOINT_SHA256,
                           "license": MODEL_LICENSE, "ignoredCheckpointKeys": ignored}
    atomic_json(state_path, state)
    started = time.perf_counter()
    for index, image in enumerate(images, 1):
        identity = (image["setId"], image["image"])
        if identity in completed:
            continue
        image_started = time.perf_counter()
        photo_path, base_path = verified_path(image["photo"]), verified_path(image["baseMask"])
        with Image.open(photo_path) as opened:
            rgb = np.asarray(opened.convert("RGB"))
        with Image.open(base_path) as opened:
            if opened.mode != "L" or opened.size != (image["width"], image["height"]):
                raise RuntimeError(f"Base-mask dimensions differ for {identity}")
            base_keep = np.asarray(opened) >= 128
        if rgb.shape != (image["height"], image["width"], 3):
            raise RuntimeError(f"Photo dimensions differ for {identity}")
        mask = sea_class_mask(infer_logits(model, rgb, device, args.stride, args.batch_size))
        priority, metrics = disagreement_priority(mask, base_keep)
        mask_name = f"{sha256_bytes(canonical(list(identity)))[:24]}.labels.png"
        mask_path = output / "masks" / mask_name
        atomic_png(mask_path, mask)
        row = {"setId": image["setId"], "image": image["image"],
               "classMask": f"masks/{mask_name}", "priority": priority,
               "seconds": time.perf_counter() - image_started, **metrics}
        state["images"].append(row)
        atomic_json(state_path, state)
        elapsed = time.perf_counter() - started
        remaining = (elapsed / max(1, index - len(completed))) * (len(images) - index)
        print(f"[{index}/{len(images)}] {image['setId']}/{image['image']} "
              f"{row['seconds']:.2f}s; ETA {remaining / 60:.1f}m", flush=True)
    prediction_set_id = sha256_bytes(canonical({"runId": run_id, "images": [
        [row["setId"], row["image"], row["classMask"]] for row in state["images"]]}))
    predictions = {"schema": "horizon-scribe-predictions-source/v1",
                   "datasetId": snapshot["datasetId"], "modelId": sha256_bytes(canonical({
                       "repository": REPOSITORY, "revision": REVISION,
                       "checkpointSha256": CHECKPOINT_SHA256})),
                   "runId": run_id, "predictionSetId": prediction_set_id,
                   "provenance": {"kind": "zero-shot-flair-inc-argmax-sea",
                       "repository": REPOSITORY, "revision": REVISION,
                       "checkpointSha256": CHECKPOINT_SHA256, "license": MODEL_LICENSE,
                       "note": "Fresh private FLAIR-INC zero-shot inference. Red pixels are raw-argmax water or swimming pool; other pixels remain automatic. Priority is disagreement with the legacy base mask, not an accuracy score."},
                   "images": [{key: row[key] for key in ("setId", "image", "classMask", "priority")}
                              for row in state["images"]]}
    atomic_json(output / "predictions.json", predictions)
    state["status"] = "complete"
    state["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state["predictionSetId"] = prediction_set_id
    atomic_json(state_path, state)
    return {"output": str(output), "predictions": str(output / "predictions.json"),
            "datasetId": snapshot["datasetId"], "images": len(state["images"]),
            "device": device, "runId": run_id}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--snapshot", type=Path, required=True)
    result.add_argument("--plan", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--cache", type=Path, default=Path("data/model-cache"))
    result.add_argument("--device", choices=("auto", "mps", "cuda", "cpu"), default="auto")
    result.add_argument("--stride", type=int, default=DEFAULT_STRIDE)
    result.add_argument("--batch-size", type=int, default=4)
    result.add_argument("--limit", type=int)
    result.add_argument("--resume", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    if args.stride <= 0 or args.stride > TILE_SIZE or args.batch_size <= 0:
        raise SystemExit("stride must be 1..512 and batch-size must be positive")
    if args.limit is not None and args.limit <= 0:
        raise SystemExit("limit must be positive")
    print(json.dumps(run(args), indent=2))


if __name__ == "__main__":
    main()
