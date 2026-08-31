import json
import os
import subprocess
import sys
import time
from concurrent import futures

import grpc

sys.path.append(os.path.join(os.path.dirname(__file__), "pipeline_rpc"))
import pipeline_pb2
import pipeline_pb2_grpc


class NtcPipelineService(pipeline_pb2_grpc.NtcPipelineServiceServicer):
    def ProcessModel(self, request, context):
        print(f"[gRPC] Starting processing model: {request.absolute_path}")

        yield pipeline_pb2.ProcessModelResponse(
            update_type="info",
            message=f"Starting model processing: {os.path.basename(request.absolute_path)}",
        )

        model_dir = os.path.dirname(request.absolute_path)
        file_name = os.path.basename(request.absolute_path)

        cmd = [
            "docker",
            "run",
            "--rm",
            "--gpus",
            "all",
            "-v",
            f"{model_dir}:/workspace",
            "nequ3d-core:latest",
            "python3",
            "-u",
            "/app/process_usd_file.py",
            f"/workspace/{file_name}",
            str(request.target_bitrate),
            str(request.training_steps),
        ]

        try:
            process = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
            )

            telemetry_json = None

            for line in process.stdout:
                line = line.strip()
                if not line:
                    continue

                print(f"[Docker Stream] {line}")
                sys.stdout.flush()

                if line.startswith("Telemetry: "):
                    telemetry_json = line[len("Telemetry: ") :].strip()
                else:
                    yield pipeline_pb2.ProcessModelResponse(update_type="info", message=line)

            process.wait()

            if process.returncode != 0:
                yield pipeline_pb2.ProcessModelResponse(
                    update_type="error",
                    message=f"Docker process exited with code {process.returncode}",
                )
                return

            if telemetry_json:
                yield pipeline_pb2.ProcessModelResponse(
                    update_type="result",
                    message="Finished successfully.",
                    telemetry_json=telemetry_json,
                )
            else:
                yield pipeline_pb2.ProcessModelResponse(
                    update_type="error",
                    message="No telemetry JSON in output.",
                )

        except Exception as e:
            print(f"[gRPC] Server error: {e}")
            yield pipeline_pb2.ProcessModelResponse(update_type="error", message=str(e))


def serve():
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    pipeline_pb2_grpc.add_NtcPipelineServiceServicer_to_server(
        NtcPipelineService(), server
    )
    server.add_insecure_port("[::]:50051")
    print("[gRPC] NTC Pipeline gRPC server is listening on port 50051...")
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
