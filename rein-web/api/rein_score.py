from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tarfile
import tempfile
import threading
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
import jwt

sys.path.insert(0, str(Path(__file__).resolve().parent))


BROKER_URL = "https://dcewdzagnomcnvteokwj.supabase.co/functions/v1/vercel-rein-model"
_runtime: Any = None
_runtime_lock = threading.Lock()
ISSUER = "https://oidc.vercel.com/hunaken-akademia"
AUDIENCE = "https://vercel.com/hunaken-akademia"
_jwks = jwt.PyJWKClient(f"{ISSUER}/.well-known/jwks", lifespan=300, timeout=5)


def authorize(token: str) -> None:
    if not token or len(token) > 16384:
        raise jwt.InvalidTokenError("Missing token")
    key = _jwks.get_signing_key_from_jwt(token)
    claims = jwt.decode(token, key.key, algorithms=["RS256"], issuer=ISSUER,
                        audience=AUDIENCE, options={"require": ["exp", "iat", "iss", "aud"]})
    if (claims.get("owner_id") != "team_JoV13Y5pkEXrjvf8JCKP6tNY"
            or claims.get("project_id") != "prj_8X6LIxRxvKKNyVQWxFKF6AQJ6wrm"
            or claims.get("environment") not in ("production", "preview")):
        raise jwt.InvalidTokenError("Unauthorized project")


def _request_bundle(token: str) -> tuple[dict, bytes]:
    if not token:
        raise RuntimeError("VERCEL_OIDC_TOKEN is unavailable")
    request = urllib.request.Request(
        BROKER_URL, data=b"{}", method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            registry = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"REIN broker returned {error.code}: {detail}") from error
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


def get_runtime(token: str) -> Any:
    global _runtime
    if _runtime is not None:
        return _runtime
    with _runtime_lock:
        if _runtime is not None:
            return _runtime
        from rein_core import ReinRuntime

        registry, bundle = _request_bundle(token)
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
            token = self.headers.get("x-rein-oidc-token", "")
            authorize(token)
            size = int(self.headers.get("content-length", "0"))
            if size <= 0 or size > 131072:
                raise ValueError("Invalid request size")
            payload = json.loads(self.rfile.read(size))
            runners = payload.get("runners", [])
            if not 4 <= len(runners) <= 18:
                raise ValueError("Runner count must be between 4 and 18")
            result = get_runtime(token).score(payload["race"], runners)
            body = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
        except (jwt.InvalidTokenError, jwt.PyJWKClientError):
            body = b'{"error":"Unauthorized"}'
            self.send_response(401)
        except (ValueError, KeyError, TypeError):
            body = b'{"error":"Invalid request"}'
            self.send_response(400)
        except Exception:
            body = b'{"error":"Inference temporarily unavailable"}'
            self.send_response(500)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
