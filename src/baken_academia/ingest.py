from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from .schema import REQUIRED_COLUMNS, validate_input


COLUMN_ALIASES = {
    "race_id": ["race_id", "レースID", "レースid", "レースキー", "race_key"],
    "race_date": ["race_date", "開催日", "日付", "年月日", "date"],
    "race_no": ["race_no", "レース番号", "R", "race_number"],
    "horse_id": ["horse_id", "馬ID", "馬id", "血統登録番号", "馬名"],
    "horse_name": ["horse_name", "馬名"],
    "finish_position": ["finish_position", "着順", "確定着順", "順位"],
    "racecourse": ["racecourse", "競馬場", "場名", "開催場"],
    "surface": ["surface", "芝ダ", "芝ダート", "コース種別", "馬場種別"],
    "distance_m": ["distance_m", "距離", "距離m", "距離（m）"],
    "horse_number": ["horse_number", "馬番", "馬番号"],
    "gate": ["gate", "枠番", "枠"],
    "age": ["age", "馬齢", "年齢"],
    "sex": ["sex", "性", "性別"],
    "weight_carried": ["weight_carried", "斤量", "負担重量"],
    "jockey_id": ["jockey_id", "騎手ID", "騎手id", "騎手コード", "騎手"],
    "trainer_id": ["trainer_id", "調教師ID", "調教師id", "調教師コード", "調教師"],
    "going": ["going", "馬場状態", "馬場"],
    "race_class": ["race_class", "クラス", "競走条件", "グレード"],
    "horse_weight": ["horse_weight", "馬体重"],
    "horse_weight_change": ["horse_weight_change", "馬体重増減", "増減"],
    "odds": ["odds", "単勝オッズ", "単勝"],
    "popularity": ["popularity", "人気", "人気順"],
}


def _read_bytes(path: Path) -> tuple[bytes, str]:
    raw = path.read_bytes()
    if path.suffix.lower() != ".zip":
        return raw, path.name

    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        candidates = [
            info for info in archive.infolist()
            if not info.is_dir() and Path(info.filename).suffix.lower() in {".csv", ".txt"}
        ]
        if len(candidates) != 1:
            raise ValueError(
                f"ZIP内のCSV/TXTは1ファイルにしてください（検出: {len(candidates)}）"
            )
        info = candidates[0]
        if info.file_size > 2_000_000_000:
            raise ValueError("展開後サイズが2GBを超えるため、年単位に分割してください")
        return archive.read(info), info.filename


def _read_csv(payload: bytes) -> tuple[pd.DataFrame, str]:
    failures = []
    for encoding in ("utf-8-sig", "cp932", "shift_jis", "utf-8"):
        try:
            return pd.read_csv(io.BytesIO(payload), encoding=encoding, low_memory=False), encoding
        except (UnicodeDecodeError, pd.errors.ParserError) as exc:
            failures.append(f"{encoding}: {exc}")
    raise ValueError("CSVを判定できませんでした: " + " / ".join(failures))


def _rename_columns(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, str]]:
    normalized = {str(column).strip(): column for column in df.columns}
    rename: dict[object, str] = {}
    mapping: dict[str, str] = {}
    used_source_columns: set[object] = set()
    for canonical, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            source = normalized.get(alias)
            if source is not None and source not in used_source_columns:
                rename[source] = canonical
                mapping[str(source)] = canonical
                used_source_columns.add(source)
                break
    return df.rename(columns=rename), mapping


def _number(series: pd.Series) -> pd.Series:
    return pd.to_numeric(
        series.astype(str).str.replace(r"[^0-9.+-]", "", regex=True).replace("", pd.NA),
        errors="coerce",
    )


def standardize(df: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, str]]:
    result, mapping = _rename_columns(df)

    if "surface" in result:
        result["surface"] = (
            result["surface"].astype(str).str.extract(r"(芝|ダート|障害)", expand=False)
        )
    for name in (
        "finish_position", "distance_m", "horse_number", "gate", "age",
        "weight_carried", "horse_weight_change", "odds", "popularity",
    ):
        if name in result:
            result[name] = _number(result[name])

    if "horse_weight" in result:
        original_weight = result["horse_weight"].astype(str)
        if "horse_weight_change" not in result:
            result["horse_weight_change"] = pd.to_numeric(
                original_weight.str.extract(r"\(([+-]?\d+)\)", expand=False), errors="coerce"
            )
        result["horse_weight"] = pd.to_numeric(
            original_weight.str.extract(r"(\d+)", expand=False), errors="coerce"
        )

    if "race_date" in result:
        result["race_date"] = pd.to_datetime(result["race_date"], errors="coerce")

    if "race_id" not in result and {"race_date", "racecourse", "race_no"} <= set(result):
        result["race_id"] = (
            result["race_date"].dt.strftime("%Y%m%d")
            + "-" + result["racecourse"].astype(str)
            + "-" + result["race_no"].astype(str).str.replace(r"\.0$", "", regex=True)
        )

    missing = sorted(REQUIRED_COLUMNS - set(result.columns))
    if missing:
        raise ValueError(
            "標準列へ変換できない必須項目があります: " + ", ".join(missing)
        )
    return result, mapping


def audit(df: pd.DataFrame, mapping: dict[str, str]) -> dict[str, object]:
    return {
        "rows": int(len(df)),
        "races": int(df["race_id"].nunique()),
        "horses": int(df["horse_id"].nunique()),
        "date_min": str(df["race_date"].min().date()),
        "date_max": str(df["race_date"].max().date()),
        "years": sorted(int(year) for year in df["race_date"].dt.year.dropna().unique()),
        "column_mapping": mapping,
        "missing_rate": {
            name: round(float(df[name].isna().mean()), 6) for name in sorted(df.columns)
        },
    }


def ingest(
    input_path: Path,
    output_path: Path,
    source_name: str,
    license_confirmed: bool,
) -> dict[str, object]:
    if not license_confirmed:
        raise ValueError("利用条件を確認後、--license-confirmed を付けてください")

    original_bytes = input_path.read_bytes()
    payload, member_name = _read_bytes(input_path)
    raw, encoding = _read_csv(payload)
    standardized, mapping = standardize(raw)
    validated = validate_input(standardized)
    report = audit(validated, mapping)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    validated.to_parquet(output_path, index=False)
    sidecar = output_path.with_suffix("")
    sidecar.with_suffix(".audit.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    provenance = {
        "source_name": source_name,
        "license_confirmed_by_operator": True,
        "source_file": input_path.name,
        "archive_member": member_name,
        "source_sha256": hashlib.sha256(original_bytes).hexdigest(),
        "encoding": encoding,
        "imported_at": datetime.now(timezone.utc).isoformat(),
    }
    sidecar.with_suffix(".provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"audit": report, "provenance": provenance}


def main() -> None:
    parser = argparse.ArgumentParser(description="競馬データを標準化・監査します")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("data/processed/races.parquet"))
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--license-confirmed", action="store_true")
    args = parser.parse_args()
    result = ingest(args.input, args.output, args.source_name, args.license_confirmed)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
