"""Build an immutable, self-describing REIN production model bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


ROLES = ("first", "second", "third")
REQUIRED_HISTORY_COLUMNS = {
    "race_id", "race_date", "racecourse", "race_class", "surface",
    "distance_m", "going", "horse_id", "finish_position", "finish_status",
    "gate", "horse_number", "sex", "age", "weight_carried", "jockey_id",
    "finish_time", "corner_positions", "avg_1f", "horse_weight",
    "horse_weight_change", "trainer_id", "popularity", "lap_times",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_record(path: Path, relative: str) -> dict[str, object]:
    return {"path": relative, "sha256": sha256(path), "size_bytes": path.stat().st_size}


def build(history: Path, model_dir: Path, output: Path, version: str,
          source_commit: str, metrics: Path | None) -> dict[str, object]:
    schema_path = model_dir / "schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    if schema.get("version") != "rein-role-v4":
        raise ValueError("Unexpected model schema version")
    if len(schema.get("feature_order", [])) != 106:
        raise ValueError("REIN v4 must contain exactly 106 ordered features")

    history_frame = pd.read_parquet(history)
    missing = sorted(REQUIRED_HISTORY_COLUMNS - set(history_frame.columns))
    if missing:
        raise ValueError(f"History is missing required columns: {', '.join(missing)}")
    dates = pd.to_datetime(history_frame["race_date"], errors="raise")

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary) / version
        (root / "models").mkdir(parents=True)
        (root / "data").mkdir(parents=True)
        shutil.copy2(schema_path, root / "schema.json")
        for role in ROLES:
            source = model_dir / f"{role}.txt"
            if not source.is_file():
                raise FileNotFoundError(source)
            shutil.copy2(source, root / "models" / source.name)

        # The compact parquet is the exact historical input needed to rebuild
        # every time-safe feature. It remains private in Supabase Storage.
        history_frame.to_parquet(
            root / "data" / "history.parquet", index=False,
            compression="zstd", compression_level=12,
        )
        if metrics and metrics.is_file():
            shutil.copy2(metrics, root / "metrics.json")

        files = []
        for path in sorted(root.rglob("*")):
            if path.is_file():
                files.append(file_record(path, str(path.relative_to(root))))
        manifest = {
            "schema_version": 1,
            "version": version,
            "model_family": "rein-role-v4",
            "roles": list(ROLES),
            "feature_count": len(schema["feature_order"]),
            "trained_through": schema["trained_through"],
            "history_from": str(dates.min().date()),
            "history_through": str(dates.max().date()),
            "history_rows": int(len(history_frame)),
            "history_races": int(history_frame["race_id"].nunique()),
            "source_commit": source_commit,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "files": files,
        }
        (root / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(output, "w:gz", compresslevel=9) as archive:
            archive.add(root, arcname=version)
        external_manifest = output.with_suffix("").with_suffix(".manifest.json")
        external_manifest.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return {
        **manifest,
        "bundle_path": str(output),
        "bundle_sha256": sha256(output),
        "bundle_size_bytes": output.stat().st_size,
        "manifest_path": str(external_manifest),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--metrics", type=Path)
    args = parser.parse_args()
    result = build(args.history, args.model_dir, args.output, args.version,
                   args.source_commit, args.metrics)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
