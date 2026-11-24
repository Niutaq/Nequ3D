"""Integrity helpers for Reality Scan artifacts (NetSecOps)."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_integrity_sidecar(asset_path: str, meta: dict[str, Any] | None = None) -> str:
    """Write <asset>.sha256.json next to the file for tamper detection."""
    digest = sha256_file(asset_path)
    payload = {
        "algorithm": "sha256",
        "path": os.path.basename(asset_path),
        "sha256": digest,
        "bytes": os.path.getsize(asset_path),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if meta:
        payload["meta"] = meta
    out = asset_path + ".sha256.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return out


def verify_integrity_sidecar(asset_path: str) -> dict[str, Any]:
    sidecar = asset_path + ".sha256.json"
    if not os.path.isfile(sidecar):
        return {"ok": False, "reason": "missing_sidecar"}
    with open(sidecar, encoding="utf-8") as f:
        expected = json.load(f)
    actual = sha256_file(asset_path)
    ok = actual == expected.get("sha256")
    return {
        "ok": ok,
        "expected": expected.get("sha256"),
        "actual": actual,
        "sidecar": sidecar,
    }
