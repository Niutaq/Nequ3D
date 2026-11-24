"""Building Renovation Digital Twin manifest helpers."""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any

from pxr import Usd, UsdGeom, UsdShade  # type: ignore


ZONE_HINTS = (
    ("kitchen", ("kitchen", "kuchnia", "cook")),
    ("bathroom", ("bath", "łazien", "toilet", "wc", "shower")),
    ("facade", ("facade", "façade", "elewac", "exterior", "wall_ext")),
    ("roof", ("roof", "dach", "ceiling_ext")),
    ("floor", ("floor", "podłog", "slab")),
    ("living", ("living", "salon", "lounge")),
    ("corridor", ("corridor", "hall", "korytarz")),
    ("structure", ("struct", "beam", "column", "pillar")),
)


def _file_sha256(path: str) -> str | None:
    if not path or not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _bbox_for_mesh(prim: Usd.Prim) -> dict[str, list[float]] | None:
    mesh = UsdGeom.Mesh(prim)
    points = mesh.GetPointsAttr().Get()
    if not points:
        return None
    xs = [float(p[0]) for p in points]
    ys = [float(p[1]) for p in points]
    zs = [float(p[2]) for p in points]
    return {
        "min": [min(xs), min(ys), min(zs)],
        "max": [max(xs), max(ys), max(zs)],
    }


def _guess_zone(name: str, path: str) -> str:
    blob = f"{name} {path}".lower()
    for zone_id, hints in ZONE_HINTS:
        if any(h in blob for h in hints):
            return zone_id
    # Fall back to first meaningful path token
    parts = [p for p in path.strip("/").split("/") if p and p.lower() not in ("root", "world", "scene")]
    if parts:
        token = re.sub(r"[^a-zA-Z0-9_]+", "_", parts[0]).strip("_").lower()
        if token:
            return f"zone_{token}"
    return "zone_unassigned"


def build_twin_manifest(
    usd_path: str,
    telemetry: dict[str, Any] | None = None,
    source_asset: str | None = None,
) -> dict[str, Any]:
    """Extract prim identity, bounds, materials, and building zones from a USD stage."""
    stage = Usd.Stage.Open(usd_path)
    if not stage:
        return {"error": f"Failed to open USD stage: {usd_path}"}

    up_axis = str(UsdGeom.GetStageUpAxis(stage) or "")
    meters = UsdGeom.GetStageMetersPerUnit(stage)

    prims: list[dict[str, Any]] = []
    zones: dict[str, dict[str, Any]] = {}

    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh):
            continue
        path = str(prim.GetPath())
        name = prim.GetName()
        zone_id = _guess_zone(name, path)
        bbox = _bbox_for_mesh(prim)
        materials: list[str] = []
        if prim.HasAPI(UsdShade.MaterialBindingAPI):
            mat, _ = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()
            if mat:
                materials.append(str(mat.GetPath()))

        mesh = UsdGeom.Mesh(prim)
        points = mesh.GetPointsAttr().Get() or []
        entry = {
            "path": path,
            "name": name,
            "type": "Mesh",
            "zone_id": zone_id,
            "bbox": bbox,
            "materials": materials,
            "vertex_count": len(points),
        }
        prims.append(entry)

        zone = zones.setdefault(
            zone_id,
            {
                "id": zone_id,
                "label": zone_id.replace("_", " ").title(),
                "prim_paths": [],
                "status": "unknown",
                "bbox": None,
            },
        )
        zone["prim_paths"].append(path)
        if bbox:
            if zone["bbox"] is None:
                zone["bbox"] = {
                    "min": list(bbox["min"]),
                    "max": list(bbox["max"]),
                }
            else:
                for i in range(3):
                    zone["bbox"]["min"][i] = min(zone["bbox"]["min"][i], bbox["min"][i])
                    zone["bbox"]["max"][i] = max(zone["bbox"]["max"][i], bbox["max"][i])

    source = source_asset or usd_path
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "kind": "building_renovation_twin",
        "source_asset": source,
        "working_usd": usd_path,
        "up_axis": up_axis,
        "meters_per_unit": float(meters) if meters else None,
        "integrity": {
            "source_sha256": _file_sha256(source) if source else None,
            "working_usd_sha256": _file_sha256(usd_path),
        },
        "prims": prims,
        "zones": list(zones.values()),
        "measurements": [],
        "annotations": [],
        "detections": [],
    }
    if telemetry:
        manifest["pipeline_status"] = telemetry.get("status")
        manifest["ntc_bypassed"] = telemetry.get("ntc_bypassed")
        for key in ("proxy_glb_path", "proxy_ntc_glb_path", "has_ntc_quality"):
            if key in telemetry:
                manifest[key] = telemetry[key]
    return manifest


def write_twin_manifest(manifest: dict[str, Any], out_dir: str) -> str:
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "twin_manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return path


def merge_annotations_into_manifest(
    manifest: dict[str, Any],
    *,
    measurements: list[dict[str, Any]] | None = None,
    annotations: list[dict[str, Any]] | None = None,
    zone_updates: list[dict[str, Any]] | None = None,
    detections: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    if measurements is not None:
        manifest["measurements"] = measurements
    if annotations is not None:
        manifest["annotations"] = annotations
    if detections is not None:
        manifest["detections"] = detections
    if zone_updates:
        by_id = {z["id"]: z for z in manifest.get("zones", [])}
        for upd in zone_updates:
            zid = upd.get("id")
            if not zid:
                continue
            if zid in by_id:
                by_id[zid].update(upd)
            else:
                by_id[zid] = upd
        manifest["zones"] = list(by_id.values())
    return manifest
