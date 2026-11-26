"""Offline unit tests for in-toto v1 SLSA provenance & ORAS artifact manifest."""

from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest

from provenance_intoto import (
    DSSE_PAYLOAD_TYPE,
    INTOTO_STATEMENT_TYPE,
    ORAS_ARTIFACT_TYPE,
    SLSA_PREDICATE_TYPE,
    generate_twin_provenance,
)


class ProvenanceTests(unittest.TestCase):
    def test_generates_valid_dsse_intoto_and_oras_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            usda = os.path.join(tmp, "building_twin.usda")
            manifest_path = os.path.join(tmp, "twin_manifest.json")
            with open(usda, "w", encoding="utf-8") as f:
                f.write("#usda 1.0\n")
            manifest_doc = {
                "source_asset": "/tmp/workspace/Flat.usdz",
                "working_usd": "/tmp/workspace/Flat.usd",
                "up_axis": "Y",
                "meters_per_unit": 1.0,
                "integrity": {
                    "source_sha256": "a" * 64,
                    "working_usd_sha256": "b" * 64,
                },
                "zones": [{"id": "kitchen"}],
            }
            with open(manifest_path, "w", encoding="utf-8") as f:
                json.dump(manifest_doc, f)

            info = generate_twin_provenance(
                tmp,
                [usda, manifest_path],
                manifest_doc,
                telemetry={"trace_id": "4f1a0d638c243d7e3ebbcb510209dfc8", "avg_psnr_db": 36.4, "avg_ssim": 0.96},
            )
            self.assertEqual(info["subject_count"], 2)
            self.assertTrue(os.path.isfile(info["intoto_path"]))
            self.assertTrue(os.path.isfile(info["oras_manifest_path"]))

            with open(info["intoto_path"], encoding="utf-8") as f:
                env = json.loads(f.readline())
            self.assertEqual(env["payloadType"], DSSE_PAYLOAD_TYPE)
            self.assertTrue(env["signatures"][0]["sig"])

            stmt = json.loads(base64.b64decode(env["payload"]).decode("utf-8"))
            self.assertEqual(stmt["_type"], INTOTO_STATEMENT_TYPE)
            self.assertEqual(stmt["predicateType"], SLSA_PREDICATE_TYPE)
            self.assertEqual(len(stmt["subject"]), 2)
            self.assertEqual(
                stmt["predicate"]["runDetails"]["metadata"]["invocationId"],
                "4f1a0d638c243d7e3ebbcb510209dfc8",
            )

            with open(info["oras_manifest_path"], encoding="utf-8") as f:
                oras_doc = json.load(f)
            self.assertEqual(oras_doc["artifactType"], ORAS_ARTIFACT_TYPE)
            # 2 twin files + provenance.intoto.jsonl = 3 OCI layers
            self.assertEqual(len(oras_doc["layers"]), 3)


if __name__ == "__main__":
    unittest.main()
