"""Offline regression tests; no S3, Docker, GPU or live RPC calls."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch

with patch.dict(os.environ, {"MINIO_ACCESS_KEY": "test", "MINIO_SECRET_KEY": "test"}):
    import rpc_server as rpc


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        env = patch.dict(os.environ, {"NEQU3D_WORKSPACE": self.workspace.name})
        env.start()
        self.addCleanup(env.stop)
        self.service = rpc.NtcPipelineService()

    def request(self, name="same.usdz"):
        return rpc.pipeline_pb2.ProcessModelRequest(
            file_name=name, s3_object_key="input", target_bitrate=4, training_steps=150
        )

    @staticmethod
    def process(cmd, **kwargs):
        proxy = Path(cmd[3]).with_suffix(".glb")
        proxy.write_bytes(b"proxy")
        return SimpleNamespace(
            stdout=io.StringIO("Telemetry: " + json.dumps({"proxy_glb_path": str(proxy)}) + "\n"),
            returncode=0, wait=lambda: None,
        )

    def test_download_failure_balances_metric_and_returns_error(self):
        before = rpc.ACTIVE_GRPC_REQUESTS._value.get()
        with patch.object(rpc.s3_client, "download_file", side_effect=RuntimeError("S3 unavailable")):
            updates = list(self.service.ProcessModel(self.request(), None))
        self.assertEqual(updates[-1].update_type, "error")
        self.assertIn("S3 unavailable", updates[-1].message)
        self.assertEqual(rpc.ACTIVE_GRPC_REQUESTS._value.get(), before)

    def test_rejects_path_names_without_s3_access(self):
        for name in ("../escape.usdz", "/absolute.usdz", "C:\\escape.usdz", "..", ""):
            with self.subTest(name=name), patch.object(rpc.s3_client, "download_file") as download:
                updates = list(self.service.ProcessModel(self.request(name), None))
                self.assertEqual(updates[-1].update_type, "error")
                download.assert_not_called()

    def test_same_name_jobs_have_distinct_paths_and_object_keys(self):
        with patch.object(rpc.s3_client, "download_file") as download, \
             patch.object(rpc.s3_client, "upload_file"), \
             patch.object(rpc.subprocess, "Popen", side_effect=self.process):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda _: list(self.service.ProcessModel(self.request(), None)), range(2)))
        paths = [Path(call.args[2]) for call in download.call_args_list]
        self.assertEqual(len(set(paths)), 2)
        self.assertTrue(all(p.parent.parent == Path(self.workspace.name) for p in paths))
        keys = [updates[-1].proxy_glb_s3_key for updates in results]
        self.assertTrue(all(keys))
        self.assertEqual(len(set(keys)), 2)

    def test_failed_upload_does_not_return_nonexistent_object_key(self):
        with patch.object(rpc.s3_client, "download_file"), \
             patch.object(rpc.s3_client, "upload_file", side_effect=RuntimeError("upload failed")), \
             patch.object(rpc.subprocess, "Popen", side_effect=self.process):
            updates = list(self.service.ProcessModel(self.request(), None))
        self.assertEqual(updates[-1].update_type, "result")
        self.assertEqual(updates[-1].proxy_glb_s3_key, "")

    def test_closed_stream_balances_metric(self):
        before = rpc.ACTIVE_GRPC_REQUESTS._value.get()
        stream = self.service.ProcessModel(self.request(), None)
        next(stream)
        stream.close()
        self.assertEqual(rpc.ACTIVE_GRPC_REQUESTS._value.get(), before)


if __name__ == "__main__":
    unittest.main()
