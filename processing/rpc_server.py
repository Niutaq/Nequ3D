import json
import logging
import os
import subprocess
import sys
import time
from concurrent import futures

import grpc
from prometheus_client import start_http_server, Gauge
from pythonjsonlogger import jsonlogger

# Initialize structured JSON logging
logger = logging.getLogger("nequ3d_core")
logger.setLevel(logging.INFO)
logHandler = logging.StreamHandler(sys.stdout)
formatter = jsonlogger.JsonFormatter('%(asctime)s %(levelname)s %(name)s %(message)s')
logHandler.setFormatter(formatter)
logger.addHandler(logHandler)

# Initialize Prometheus Metrics
ACTIVE_GRPC_REQUESTS = Gauge('nequ3d_active_requests_total', 'Number of active gRPC requests being processed')
PROCESSED_MODELS = Gauge('nequ3d_processed_models_total', 'Total number of models processed')

sys.path.append(os.path.join(os.path.dirname(__file__), "pipeline_rpc"))
import pipeline_pb2
import pipeline_pb2_grpc


import re

ansi_escape = re.compile(r'(?:\x1B[@-_]|[\x80-\x9F])[0-?]*[ -/]*[@-~]|[\x00-\x1F\x7F]')

class NtcPipelineService(pipeline_pb2_grpc.NtcPipelineServiceServicer):
    def ProcessModel(self, request, context):
        ACTIVE_GRPC_REQUESTS.inc()
        logger.info("Starting processing model", extra={"absolute_path": request.absolute_path})

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
                # Strip ANSI escape codes
                clean_line = ansi_escape.sub('', line.strip())
                if not clean_line:
                    continue

                if not clean_line.startswith("Telemetry: "):
                    logger.info("Docker process output", extra={"docker_output": clean_line})

                if clean_line.startswith("Telemetry: "):
                    telemetry_json = clean_line[len("Telemetry: ") :].strip()
                else:
                    yield pipeline_pb2.ProcessModelResponse(update_type="info", message=clean_line)

            process.wait()

            if process.returncode != 0:
                logger.error("Docker process exited with error", extra={"returncode": process.returncode})
                yield pipeline_pb2.ProcessModelResponse(
                    update_type="error",
                    message=f"Docker process exited with code {process.returncode}",
                )
                return

            if telemetry_json:
                logger.info("Processing finished successfully")
                yield pipeline_pb2.ProcessModelResponse(
                    update_type="result",
                    message="Finished successfully.",
                    telemetry_json=telemetry_json,
                )
                PROCESSED_MODELS.inc()
            else:
                logger.warning("No telemetry JSON in output")
                yield pipeline_pb2.ProcessModelResponse(
                    update_type="error",
                    message="No telemetry JSON in output.",
                )

        except Exception as e:
            logger.error("Server error", extra={"error": str(e)})
            yield pipeline_pb2.ProcessModelResponse(update_type="error", message=str(e))
        finally:
            ACTIVE_GRPC_REQUESTS.dec()


def serve():
    # Start Prometheus metrics server
    start_http_server(8000)
    logger.info("Started Prometheus metrics server on port 8000")

    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    pipeline_pb2_grpc.add_NtcPipelineServiceServicer_to_server(
        NtcPipelineService(), server
    )
    server.add_insecure_port("[::]:50051")
    logger.info("NTC Pipeline gRPC server is listening on port 50051...")
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
