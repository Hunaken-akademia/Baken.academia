from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rein_core import ReinRuntime


BROKER_URL = "https://dcewdzagnomcnvteokwj.supabase.co/functions/v1/vercel-rein-model"
_runtime: ReinRuntime | None = None
_runtime_lock = threading.Lock()


def _request_bundle() -> tuple[dict, bytes]:
    token = os.environ.get("VERCEL_OIDC_TOKEN", "")
    if not token:
        raise RuntimeError("VERCEL_OIDC_TOKEN is unavailable")
    request = urllib.request.Request(
        BROKER_URL, data=b"{}", method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        registry = json.load(response)
    with urllib.request.urlopen(registry["bundle_url"], timeout=40) as response:
        bundle = response.read()
    expected = registry["model"]["artifact_sha256"]
    if hashlib.sha256(bundle).hexdigest() != expected:
        raise RuntimeError("REIN bundle checksum mismatch")
    return registry, bundle


def _safe_extract(archive: tarfile.TarFile, destination: Path) -> None:
    root = destination.resolve()
    for member in archive.getmembers():
        target = (destination / member.name).resolve()
        if root not in target.parents and target != root:
            raise RuntimeError("Unsafe archive member")
    archive.extractall(destination, filter="data")


def get_runtime() -> ReinRuntime:
    global _runtime
    if _runtime is not None:
        return _runtime
    with _runtime_lock:
        if _runtime is not None:
            return _runtime
        registry, bundle = _request_bundle()
        version = registry["model"]["version"]
        destination = Path(tempfile.gettempdir()) / "rein-runtime" / version
        if not (destination / "schema.json").is_file():
            shutil.rmtree(destination.parent, ignore_errors=True)
            destination.parent.mkdir(parents=True, exist_ok=True)
            archive_path = destination.parent / "bundle.tar.gz"
            archive_path.write_bytes(bundle)
            with tarfile.open(archive_path, "r:gz") as archive:
                _safe_extract(archive, destination.parent)
        _runtime = ReinRuntime.load(destination, version)
        return _runtime


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        try:
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > 131072:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size))
            runners = payload.get("runners", [])
            if not 4 <= len(runners) <= 18:
                raise ValueError("Runner count must be between 4 and 18")
            result = get_runtime().score(payload["race"], runners)
            body = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
        except Exception as error:
            body = json.dumps({"error": str(error)}, ensure_ascii=False).encode("utf-8")
            self.send_response(500)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
