import asyncio
import io
import logging
import os
import re
import threading
from typing import List, Optional

import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

MODEL_ID = os.environ.get("LOCATE_MODEL_ID", "nvidia/LocateAnything-3B")

app = FastAPI(title="LocateAnything Microservice")

worker = None
model_load_error: Optional[str] = None
model_loading = False


class LocateAnythingWorker:
    """Minimal worker based on the NVIDIA LocateAnything-3B model card."""

    def __init__(self, model_path: str, device: str, dtype: torch.dtype):
        from transformers import AutoModel, AutoProcessor, AutoTokenizer

        self.device = device
        self.dtype = dtype
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.processor = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
        self.model = (
            AutoModel.from_pretrained(
                model_path,
                torch_dtype=dtype,
                trust_remote_code=True,
                attn_implementation="sdpa",
            )
            .to(device)
            .eval()
        )

    @torch.no_grad()
    def predict(self, image: Image.Image, question: str) -> str:
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": image},
                    {"type": "text", "text": question},
                ],
            }
        ]
        text = self.processor.py_apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        images, videos = self.processor.process_vision_info(messages)
        inputs = self.processor(
            text=[text], images=images, videos=videos, return_tensors="pt"
        ).to(self.device)

        pixel_values = inputs["pixel_values"].to(self.dtype)
        response = self.model.generate(
            pixel_values=pixel_values,
            input_ids=inputs["input_ids"],
            attention_mask=inputs["attention_mask"],
            image_grid_hws=inputs.get("image_grid_hws", None),
            tokenizer=self.tokenizer,
            max_new_tokens=1024,
            use_cache=True,
            generation_mode=os.environ.get("LOCATE_GENERATION_MODE", "fast"),
            temperature=0.2,
            do_sample=False,
            verbose=False,
        )
        if isinstance(response, tuple):
            return str(response[0])
        return str(response)


def _load_model() -> None:
    global worker, model_load_error, model_loading
    model_loading = True
    model_load_error = None
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and torch.cuda.is_bf16_supported():
            dtype = torch.bfloat16
        elif device == "cuda":
            dtype = torch.float16
        else:
            dtype = torch.float32
        logger.info(
            "Loading %s on %s (%s)...", MODEL_ID, device, dtype
        )
        worker = LocateAnythingWorker(MODEL_ID, device=device, dtype=dtype)
        logger.info("Model loaded successfully.")
    except Exception as e:
        worker = None
        model_load_error = str(e)
        logger.exception("Failed to load model: %s", e)
    finally:
        model_loading = False


@app.on_event("startup")
def startup_event():
    # Load in a background thread so /health can report progress during HF download.
    threading.Thread(target=_load_model, name="locate-model-loader", daemon=True).start()


@app.get("/health")
def health():
    if worker is not None:
        return {"status": "ok", "ready": True, "model": MODEL_ID}
    if model_load_error:
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "ready": False,
                "detail": model_load_error,
                "model": MODEL_ID,
            },
        )
    detail = "model still loading" if model_loading else "model not started"
    return JSONResponse(
        status_code=503,
        content={"status": "starting", "ready": False, "detail": detail, "model": MODEL_ID},
    )


class BoundingBox(BaseModel):
    xmin: float
    ymin: float
    xmax: float
    ymax: float
    label: str
    confidence: float


class LocateResponse(BaseModel):
    detections: List[BoundingBox]
    message: str


def parse_model_output(output_text: str, prompt: str) -> List[BoundingBox]:
    boxes: List[BoundingBox] = []
    pattern = r"\[\[?(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\]?"
    matches = re.findall(pattern, output_text)
    for match in matches:
        y1, x1, y2, x2 = map(float, match)
        # LocateAnything often emits 0-1000 normalized coords as [[y1,x1,y2,x2]].
        boxes.append(
            BoundingBox(
                ymin=y1 / 1000.0,
                xmin=x1 / 1000.0,
                ymax=y2 / 1000.0,
                xmax=x2 / 1000.0,
                label=prompt,
                confidence=0.95,
            )
        )
    return boxes


@app.post("/api/v1/locate", response_model=LocateResponse)
async def locate_objects(prompt: str = Form(...), image: UploadFile = File(...)):
    if worker is None:
        if model_load_error:
            return LocateResponse(detections=[], message=f"Model failed to load: {model_load_error}")
        return LocateResponse(detections=[], message="Model is still loading.")

    try:
        image_bytes = await image.read()
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        logger.info("Running inference for prompt: %s", prompt)
        raw_output = await asyncio.to_thread(worker.predict, pil_image, prompt)
        logger.info("Raw output: %s", raw_output[:500])
        detections = parse_model_output(raw_output, prompt)
        return LocateResponse(detections=detections, message="Analysis complete.")
    except Exception as e:
        logger.exception("Error during inference")
        return LocateResponse(detections=[], message=f"Error: {e}")
