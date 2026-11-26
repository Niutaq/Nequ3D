"""Omniverse / Kit interop packager (filesystem export, no Nucleus required)."""

from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from typing import Any

from provenance_intoto import generate_twin_provenance


def build_simready_checklist(manifest: dict[str, Any]) -> dict[str, Any]:
    """Lightweight SimReady-inspired readiness checklist for building scans."""
    up = (manifest.get("up_axis") or "").upper()
    mpu = manifest.get("meters_per_unit")
    prims = manifest.get("prims") or []
    zones = manifest.get("zones") or []

    checks = []

    def add(name: str, ok: bool, detail: str, severity: str = "info") -> None:
        checks.append(
            {
                "id": name,
                "ok": ok,
                "detail": detail,
                "severity": severity if not ok else "ok",
            }
        )

    add(
        "up_axis",
        up in ("Y", "Z"),
        f"Stage upAxis={up or 'missing'} (Y or Z expected)",
        "warn",
    )
    add(
        "meters_per_unit",
        isinstance(mpu, (int, float)) and float(mpu) > 0,
        f"metersPerUnit={mpu}",
        "warn",
    )
    add(
        "mesh_prims",
        len(prims) > 0,
        f"{len(prims)} mesh prim(s) in twin_manifest",
        "error",
    )
    add(
        "zones",
        len(zones) > 0,
        f"{len(zones)} building zone(s) inferred or authored",
        "info",
    )
    missing_bbox = sum(1 for p in prims if not p.get("bbox"))
    add(
        "bbox_coverage",
        missing_bbox == 0,
        f"{missing_bbox} mesh prim(s) missing bbox",
        "warn",
    )
    add(
        "colliders",
        False,
        "No UsdPhysics collision schemas authored (expected for Reality Scan meshes)",
        "info",
    )
    add(
        "semantic_labels",
        any(z.get("status") not in (None, "unknown") for z in zones),
        "Zone renovation status mostly unknown until annotations are saved",
        "info",
    )
    add(
        "integrity_hash",
        bool((manifest.get("integrity") or {}).get("working_usd_sha256")),
        "SHA-256 of working USD recorded in twin_manifest",
        "warn",
    )

    ready = all(c["ok"] or c["severity"] == "info" for c in checks)
    return {
        "schema_version": 1,
        "profile": "nequ3d_building_renovation_simready_lite",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ready_for_kit_import": ready,
        "checks": checks,
        "notes": [
            "This is a Nequ3D checklist inspired by SimReady Foundation, not an official NVIDIA validator.",
            "Open building_twin.usda in Omniverse Kit / USD Composer from the local filesystem.",
            "Nucleus is optional; local paths are enough for research import.",
        ],
    }


def package_omniverse_export(
    twin_dir: str,
    export_root: str,
    asset_name: str,
    manifest: dict[str, Any],
    extra_files: list[str] | None = None,
    telemetry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Copy twin layers + checklist into exports/omniverse/<asset>/.
    """
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in asset_name).strip("_")
    if not safe:
        safe = "asset"
    dest = os.path.join(export_root, safe)
    os.makedirs(dest, exist_ok=True)

    copied = []
    for name in ("twin_manifest.json", "annotations.usda", "building_twin.usda"):
        src = os.path.join(twin_dir, name)
        if os.path.isfile(src):
            dst = os.path.join(dest, name)
            shutil.copy2(src, dst)
            copied.append(dst)

    for path in extra_files or []:
        if path and os.path.isfile(path):
            dst = os.path.join(dest, os.path.basename(path))
            shutil.copy2(path, dst)
            copied.append(dst)

    checklist = build_simready_checklist(manifest)
    checklist_path = os.path.join(dest, "simready_checklist.json")
    with open(checklist_path, "w", encoding="utf-8") as f:
        json.dump(checklist, f, indent=2)

    readme_path = os.path.join(dest, "README.txt")
    with open(readme_path, "w", encoding="utf-8") as f:
        f.write(
            "Nequ3D Omniverse interop pack\n"
            "=============================\n"
            "1. Install Omniverse Kit / USD Composer template.\n"
            "2. File → Open → building_twin.usda (local filesystem).\n"
            "3. Review annotations under /Nequ3DTwin and simready_checklist.json.\n"
            "4. Nucleus is not required for this research workflow.\n"
        )

    all_files = copied + [checklist_path, readme_path]
    provenance = generate_twin_provenance(
        dest,
        all_files,
        manifest,
        telemetry=telemetry,
    )

    return {
        "export_dir": dest,
        "files": all_files + [provenance["intoto_path"], provenance["oras_manifest_path"]],
        "checklist": checklist,
        "provenance": provenance,
    }
