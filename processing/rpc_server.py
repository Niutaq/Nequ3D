import json
import logging
import os
import subprocess
import sys
import time
from concurrent import futures

import grpc
import requests
from prometheus_client import Gauge, start_http_server
from pythonjsonlogger import jsonlogger

# Initialize structured JSON logging
logger = logging.getLogger("nequ3d_core")
logger.setLevel(logging.INFO)
logHandler = logging.StreamHandler(sys.stdout)
formatter = jsonlogger.JsonFormatter("%(asctime)s %(levelname)s %(name)s %(message)s")
logHandler.setFormatter(formatter)
logger.addHandler(logHandler)

# Initialize Prometheus Metrics
ACTIVE_GRPC_REQUESTS = Gauge(
    "nequ3d_active_requests_total", "Number of active gRPC requests being processed"
)
PROCESSED_MODELS = Gauge(
    "nequ3d_processed_models_total", "Total number of models processed"
)

sys.path.append(os.path.join(os.path.dirname(__file__), "pipeline_rpc"))
import re

from pipeline import pipeline_pb2, pipeline_pb2_grpc

ansi_escape = re.compile(r"(?:\x1B[@-_]|[\x80-\x9F])[0-?]*[ -/]*[@-~]|[\x00-\x1F\x7F]")


class NtcPipelineService(pipeline_pb2_grpc.NtcPipelineServiceServicer):
    def ProcessModel(self, request, context):
        ACTIVE_GRPC_REQUESTS.inc()
        logger.info(
            "Starting processing model", extra={"file_name": request.file_name}
        )

        yield pipeline_pb2.ProcessModelResponse(
            update_type="info",
            message=f"Starting model processing: {request.file_name}",
        )

        model_dir = "/tmp/workspace"
        os.makedirs(model_dir, exist_ok=True)
        file_path = os.path.join(model_dir, request.file_name)
        
        with open(file_path, "wb") as f:
            f.write(request.file_data)

        cmd = [
            "python3",
            "-u",
            "/app/process_usd_file.py",
            file_path,
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
                clean_line = ansi_escape.sub("", line.strip())
                if not clean_line:
                    continue

                if not clean_line.startswith("Telemetry: "):
                    logger.info(
                        "Docker process output", extra={"docker_output": clean_line}
                    )

                if clean_line.startswith("Telemetry: "):
                    telemetry_json = clean_line[len("Telemetry: ") :].strip()
                else:
                    yield pipeline_pb2.ProcessModelResponse(
                        update_type="info", message=clean_line
                    )

            process.wait()

            if process.returncode != 0:
                logger.error(
                    "Docker process exited with error",
                    extra={"returncode": process.returncode},
                )
                yield pipeline_pb2.ProcessModelResponse(
                    update_type="error",
                    message=f"Docker process exited with code {process.returncode}",
                )
                return

            if telemetry_json:
                logger.info("Processing finished successfully")
                proxy_glb_data = b""
                try:
                    telemetry_dict = json.loads(telemetry_json)
                    proxy_path = telemetry_dict.get("proxy_glb_path")
                    if proxy_path and os.path.exists(proxy_path):
                        with open(proxy_path, "rb") as f:
                            proxy_glb_data = f.read()
                except Exception as e:
                    logger.error(f"Failed to load proxy GLB: {e}")

                yield pipeline_pb2.ProcessModelResponse(
                    update_type="result",
                    message="Finished successfully.",
                    telemetry_json=telemetry_json,
                    proxy_glb_data=proxy_glb_data,
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

    def LocateObjects(self, request, context):
        ACTIVE_GRPC_REQUESTS.inc()
        logger.info(
            "Received LocateObjects request",
            extra={
                "prompt": request.prompt,
                "image_size_bytes": len(request.image_data),
            },
        )

        try:
            locate_service_url = os.environ.get(
                "LOCATE_SERVICE_URL", "http://localhost:8000"
            )
            api_endpoint = f"{locate_service_url}/api/v1/locate"

            files = {"image": ("image.jpg", request.image_data, "image/jpeg")}
            data = {"prompt": request.prompt}

            logger.info(f"Sending request to: {api_endpoint}")
            response = requests.post(api_endpoint, files=files, data=data, timeout=300)

            if response.status_code != 200:
                raise Exception(
                    f"LocateAnything microservice error: {response.status_code} - {response.text}"
                )

            result_json = response.json()

            detections = []
            for d in result_json.get("detections", []):
                box = pipeline_pb2.LocateResponse.BoundingBox(
                    xmin=d["xmin"],
                    ymin=d["ymin"],
                    xmax=d["xmax"],
                    ymax=d["ymax"],
                    label=d["label"],
                    confidence=d["confidence"],
                )
                detections.append(box)

            return pipeline_pb2.LocateResponse(
                detections=detections,
                message=result_json.get("message", "Obiekty poprawnie zlokalizowane."),
            )
        except Exception as e:
            logger.error("LocateObjects error", extra={"error": str(e)})
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return pipeline_pb2.LocateResponse(message=str(e))
        finally:
            ACTIVE_GRPC_REQUESTS.dec()


def serve():
    # Start Prometheus metrics server
    start_http_server(8001)
    logger.info("Started Prometheus metrics server on port 8001")

    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=10),
        options=[
            ('grpc.max_send_message_length', 100 * 1024 * 1024),
            ('grpc.max_receive_message_length', 100 * 1024 * 1024)
        ]
    )
    pipeline_pb2_grpc.add_NtcPipelineServiceServicer_to_server(
        NtcPipelineService(), server
    )
    server.add_insecure_port("[::]:50051")
    logger.info("NTC Pipeline gRPC server is listening on port 50051...")
    server.start()
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
