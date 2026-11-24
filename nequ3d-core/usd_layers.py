"""OpenUSD layer composition for Building Renovation Digital Twin state."""

from __future__ import annotations

import json
import os
from typing import Any

# OpenUSD text layers are authored as USDA strings (no runtime Stage required here).


def _escape_usda_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def write_annotations_layer(
    out_path: str,
    manifest: dict[str, Any],
    up_axis: str = "Y",
    meters_per_unit: float = 1.0,
) -> str:
    """
    Write an additive annotations.usda layer (measurements, zones, AI labels).
    Keeps scan geometry immutable in the base layer.
    """
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    lines = [
        "#usda 1.0",
        "(",
        f'    doc = "Nequ3D Building Renovation annotations"',
        f'    upAxis = "{up_axis or "Y"}"',
        f"    metersPerUnit = {float(meters_per_unit or 1.0)}",
        ")",
        "",
        'def Xform "Nequ3DTwin"',
        "{",
        '    def Xform "Zones"',
        "    {",
    ]

    for zone in manifest.get("zones", []):
        zid = str(zone.get("id", "zone")).replace(" ", "_")
        label = _escape_usda_string(str(zone.get("label", zid)))
        status = _escape_usda_string(str(zone.get("status", "unknown")))
        prim_paths = "|".join(zone.get("prim_paths") or [])
        lines.append(f'        def Xform "{zid}"')
        lines.append("        {")
        lines.append(f'            custom string nequ3d:zoneLabel = "{label}"')
        lines.append(f'            custom string nequ3d:status = "{status}"')
        lines.append(
            f'            custom string nequ3d:primPaths = "{_escape_usda_string(prim_paths)}"'
        )
        bbox = zone.get("bbox") or {}
        if bbox.get("min") and bbox.get("max"):
            mn = bbox["min"]
            mx = bbox["max"]
            lines.append(
                f"            custom float3[] nequ3d:bbox = [({mn[0]}, {mn[1]}, {mn[2]}), ({mx[0]}, {mx[1]}, {mx[2]})]"
            )
        lines.append("        }")
        lines.append("")

    lines.extend(
        [
            "    }",
            "",
            '    def Xform "Measurements"',
            "    {",
        ]
    )
    for i, m in enumerate(manifest.get("measurements") or []):
        mid = m.get("id", i + 1)
        dist = float(m.get("distance", 0.0))
        a = m.get("a") or {}
        b = m.get("b") or {}
        lines.append(f'        def Xform "m_{mid}"')
        lines.append("        {")
        lines.append(f"            custom double nequ3d:distance = {dist}")
        if a:
            lines.append(
                f"            custom float3 nequ3d:pointA = ({float(a.get('x', 0))}, {float(a.get('y', 0))}, {float(a.get('z', 0))})"
            )
        if b:
            lines.append(
                f"            custom float3 nequ3d:pointB = ({float(b.get('x', 0))}, {float(b.get('y', 0))}, {float(b.get('z', 0))})"
            )
        lines.append("        }")
        lines.append("")

    lines.extend(["    }", "", '    def Xform "Labels"', "    {"])
    for i, ann in enumerate(manifest.get("annotations") or []):
        aid = ann.get("id", i + 1)
        text = _escape_usda_string(str(ann.get("text", "")))
        zone = _escape_usda_string(str(ann.get("zone_id", "")))
        kind = _escape_usda_string(str(ann.get("kind", "note")))
        lines.append(f'        def Xform "a_{aid}"')
        lines.append("        {")
        lines.append(f'            custom string nequ3d:text = "{text}"')
        lines.append(f'            custom string nequ3d:zoneId = "{zone}"')
        lines.append(f'            custom string nequ3d:kind = "{kind}"')
        pos = ann.get("position") or {}
        if isinstance(pos, dict) and ("x" in pos or "y" in pos or "z" in pos):
            lines.append(
                f"            custom float3 nequ3d:position = ({float(pos.get('x', 0))}, {float(pos.get('y', 0))}, {float(pos.get('z', 0))})"
            )
        lines.append("        }")
        lines.append("")

    lines.extend(["    }", "}"])

    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return out_path


def write_composed_root(
    out_path: str,
    base_usd: str,
    annotations_usd: str,
    up_axis: str = "Y",
    meters_per_unit: float = 1.0,
) -> str:
    """
    Create a root .usda that subLayers the immutable base scan and annotations.
    Paths are written relative to out_path when possible.
    """
    out_dir = os.path.dirname(out_path) or "."
    os.makedirs(out_dir, exist_ok=True)

    def rel(p: str) -> str:
        try:
            return os.path.relpath(p, out_dir).replace("\\", "/")
        except ValueError:
            return p.replace("\\", "/")

    base_rel = rel(base_usd)
    ann_rel = rel(annotations_usd)
    content = f"""#usda 1.0
(
    doc = "Nequ3D composed Building Renovation Digital Twin"
    upAxis = "{up_axis or "Y"}"
    metersPerUnit = {float(meters_per_unit or 1.0)}
    subLayers = [
        @{ann_rel}@,
        @{base_rel}@
    ]
)
"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)
    return out_path


def persist_twin_layers(working_usd: str, manifest: dict[str, Any], out_dir: str | None = None) -> dict[str, str]:
    """Write twin_manifest.json, annotations.usda, and composed root next to the working USD."""
    base_dir = out_dir or os.path.dirname(working_usd) or "."
    twin_dir = os.path.join(base_dir, "twin")
    os.makedirs(twin_dir, exist_ok=True)

    up = str(manifest.get("up_axis") or "Y")
    mpu = float(manifest.get("meters_per_unit") or 1.0)

    manifest_path = os.path.join(twin_dir, "twin_manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    annotations_path = os.path.join(twin_dir, "annotations.usda")
    write_annotations_layer(annotations_path, manifest, up_axis=up, meters_per_unit=mpu)

    # Prefer referencing the working USD; if already a layer stack, still OK as payload.
    composed_path = os.path.join(twin_dir, "building_twin.usda")
    write_composed_root(
        composed_path,
        working_usd,
        annotations_path,
        up_axis=up,
        meters_per_unit=mpu,
    )

    return {
        "twin_dir": twin_dir,
        "twin_manifest_path": manifest_path,
        "annotations_usda": annotations_path,
        "composed_usda": composed_path,
    }
