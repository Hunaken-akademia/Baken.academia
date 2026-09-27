#!/usr/bin/env bash
set -Eeuo pipefail
# Keep historical uploads unchanged. Reuse their checksum verification and signed
# upload helpers, then enrich only the daily manifest with validated capture info.
source scripts/upload_archive_to_supabase.sh
python - "$manifest_file" daily/complete.json <<'PY'
import json,sys
from pathlib import Path
manifest=Path(sys.argv[1]); value=json.loads(manifest.read_text()); capture=json.loads(Path(sys.argv[2]).read_text())
value.update(daily_capture_schema=capture['capture_schema'],capture_status=capture['status'],race_count=capture['result']['races'])
manifest.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
PY
upload_signed "$manifest_path" "$manifest_file" application/json
