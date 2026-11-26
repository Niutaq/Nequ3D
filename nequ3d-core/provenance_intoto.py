"""in-toto Attestation v1 (SLSA Provenance v1.0) & OCI/ORAS artifact manifest builder."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any

INTOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1"
SLSA_PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
NEQU3D_BUILD_TYPE = "https://nequ3d.io/Attestations/OpenUSDNeuralTwin/v1"
NEQU3D_BUILDER_ID = "https://nequ3d.io/builders/nequ3d-core@v4"
DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json"
ORAS_ARTIFACT_TYPE = "application/vnd.nequ3d.twin.v1+json"


def _sha256_file(path: str) -> tuple[str, int] | None:
    if not path or not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    total = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
            total += len(chunk)
    return h.hexdigest(), total


def _media_type_for_file(filename: str) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".usda":
        return "model/vnd.usd+usda"
    if ext in (".usd", ".usdc"):
        return "model/vnd.usd"
    if ext == ".usdz":
        return "model/vnd.usdz+zip"
    if ext == ".glb":
        return "model/gltf-binary"
    if ext == ".ntc":
        return "application/vnd.nvidia.rtxntc"
    if ext == ".splat":
        return "application/vnd.nequ3d.gsplat"
    if filename.endswith(".intoto.jsonl"):
        return "application/vnd.in-toto+json"
    if ext == ".json":
        return "application/json"
    return "application/octet-stream"


def _dsse_pae(payload_type: str, payload: bytes) -> bytes:
    pt_bytes = payload_type.encode("utf-8")
    header = f"DSSEv1 {len(pt_bytes)} ".encode("ascii") + pt_bytes + f" {len(payload)} ".encode("ascii")
    return header + payload


def generate_twin_provenance(
    export_dir: str,
    subject_files: list[str],
    manifest: dict[str, Any],
    telemetry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Writes DSSE-wrapped in-toto v1 Statement (`provenance.intoto.jsonl`) & ORAS OCI manifest."""
    os.makedirs(export_dir, exist_ok=True)
    now_iso = datetime.now(timezone.utc).isoformat()
    tel = telemetry or {}

    subjects: list[dict[str, Any]] = []
    oci_layers: list[dict[str, Any]] = []
    seen_names: set[str] = set()

    for path in subject_files:
        if not path or not os.path.isfile(path):
            continue
        name = os.path.basename(path)
        if name in seen_names or name in ("provenance.intoto.jsonl", "oras_artifact_manifest.json"):
            continue
        digest_info = _sha256_file(path)
        if not digest_info:
            continue
        sha_hex, size_bytes = digest_info
        seen_names.add(name)
        subjects.append(
            {
                "name": name,
                "digest": {"sha256": sha_hex},
            }
        )
        oci_layers.append(
            {
                "mediaType": _media_type_for_file(name),
                "digest": f"sha256:{sha_hex}",
                "size": size_bytes,
                "annotations": {
                    "org.opencontainers.image.title": name,
                },
            }
        )

    integrity = manifest.get("integrity") or {}
    deps: list[dict[str, Any]] = []
    src_asset = str(manifest.get("source_asset") or tel.get("source_asset") or "")
    if integrity.get("source_sha256"):
        deps.append(
            {
                "uri": f"file:///{os.path.basename(src_asset) or 'source_scan.usdz'}",
                "digest": {"sha256": str(integrity["source_sha256"])},
                "name": os.path.basename(src_asset) or "source_scan.usdz",
            }
        )
    if integrity.get("working_usd_sha256"):
        deps.append(
            {
                "uri": f"file:///{os.path.basename(str(manifest.get('working_usd') or 'stage.usd'))}",
                "digest": {"sha256": str(integrity["working_usd_sha256"])},
                "name": "working_usd_stage",
            }
        )

    statement = {
        "_type": INTOTO_STATEMENT_TYPE,
        "subject": subjects,
        "predicateType": SLSA_PREDICATE_TYPE,
        "predicate": {
            "buildDefinition": {
                "buildType": NEQU3D_BUILD_TYPE,
                "externalParameters": {
                    "ntc_bypassed": bool(tel.get("ntc_bypassed", manifest.get("ntc_bypassed", True))),
                    "up_axis": manifest.get("up_axis") or "Y",
                    "meters_per_unit": manifest.get("meters_per_unit") or 1.0,
                    "zone_count": len(manifest.get("zones") or []),
                },
                "internalParameters": {
                    "avg_psnr_db": tel.get("avg_psnr_db"),
                    "avg_ssim": tel.get("avg_ssim"),
                    "texture_count": tel.get("texture_count", 0),
                },
                "resolvedDependencies": deps,
            },
            "runDetails": {
                "builder": {
                    "id": NEQU3D_BUILDER_ID,
                },
                "metadata": {
                    "invocationId": str(tel.get("trace_id") or ""),
                    "finishedOn": now_iso,
                },
            },
        },
    }

    payload_bytes = json.dumps(statement, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_b64 = base64.b64encode(payload_bytes).decode("ascii")

    signing_secret = os.environ.get("NEQU3D_ATTESTATION_KEY", "nequ3d-local-dev-dsse-key").encode("utf-8")
    key_id = "nequ3d-dsse-hmac-sha256-v1"
    pae = _dsse_pae(DSSE_PAYLOAD_TYPE, payload_bytes)
    sig_b64 = base64.b64encode(hmac.new(signing_secret, pae, hashlib.sha256).digest()).decode("ascii")

    envelope = {
        "payloadType": DSSE_PAYLOAD_TYPE,
        "payload": payload_b64,
        "signatures": [
            {
                "keyid": key_id,
                "sig": sig_b64,
            }
        ],
    }

    intoto_path = os.path.join(export_dir, "provenance.intoto.jsonl")
    with open(intoto_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(envelope) + "\n")

    intoto_digest, intoto_size = _sha256_file(intoto_path) or ("", 0)
    if intoto_digest:
        oci_layers.append(
            {
                "mediaType": DSSE_PAYLOAD_TYPE,
                "digest": f"sha256:{intoto_digest}",
                "size": intoto_size,
                "annotations": {
                    "org.opencontainers.image.title": "provenance.intoto.jsonl",
                    "io.in-toto.predicate-type": SLSA_PREDICATE_TYPE,
                },
            }
        )

    oras_manifest = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "artifactType": ORAS_ARTIFACT_TYPE,
        "config": {
            "mediaType": "application/vnd.oci.empty.v1+json",
            "digest": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
            "size": 2,
        },
        "layers": oci_layers,
        "annotations": {
            "org.opencontainers.image.created": now_iso,
            "org.opencontainers.image.source": "https://github.com/Niutaq/Nequ3D",
            "io.nequ3d.asset": os.path.basename(src_asset) or "building_twin",
            "io.nequ3d.trace_id": str(tel.get("trace_id") or ""),
        },
    }
    oras_path = os.path.join(export_dir, "oras_artifact_manifest.json")
    with open(oras_path, "w", encoding="utf-8") as f:
        json.dump(oras_manifest, f, indent=2)

    return {
        "intoto_path": intoto_path,
        "intoto_sha256": intoto_digest,
        "oras_manifest_path": oras_path,
        "subject_count": len(subjects),
        "predicate_type": SLSA_PREDICATE_TYPE,
        "artifact_type": ORAS_ARTIFACT_TYPE,
        "key_id": key_id,
    }
