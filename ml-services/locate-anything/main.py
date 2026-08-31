import io
import logging
import re
from typing import List

import torch
from fastapi import FastAPI, File, Form, UploadFile
from PIL import Image
from pydantic import BaseModel
from transformers import pipeline

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# -------------------------------------------------------------------------------

app = FastAPI(title="LocateAnything Microservice")

model_pipeline = None


@app.on_event("startup")
def startup_event():
    global model_pipeline
    logger.info("Loading NVIDIA/LocateAnything-3B...")
    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype = torch.float16 if device == "cuda" else torch.float32

        from transformers import AutoModel, AutoProcessor
        from transformers.modeling_utils import PreTrainedModel
        


        logger.info("Downloading model... (this may take a while)")
        model = AutoModel.from_pretrained(
            "nvidia/LocateAnything-3B", trust_remote_code=True, torch_dtype=dtype
        ).to(device)

        processor = AutoProcessor.from_pretrained(
            "nvidia/LocateAnything-3B", trust_remote_code=True
        )

        model_pipeline = pipeline(
            "image-text-to-text",
            model=model,
            image_processor=processor,
            tokenizer=processor,
        )
        logger.info("Model loaded successfully.")
    except Exception as e:
        logger.error(f"Failed to load model: {e}")


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
    boxes = []

    pattern = r"\[\[?(\d+),\s*(\d+),\s*(\d+),\s*(\d+)\]\]?"
    matches = re.findall(pattern, output_text)

    for match in matches:
        y1, x1, y2, x2 = map(float, match)
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


import asyncio

@app.post("/api/v1/locate", response_model=LocateResponse)
async def locate_objects(prompt: str = Form(...), image: UploadFile = File(...)):
    global model_pipeline
    if model_pipeline is None:
        return LocateResponse(detections=[], message="Model is not loaded.")

    try:
        image_bytes = await image.read()
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": pil_image},
                    {"type": "text", "text": prompt},
                ],
            },
        ]

        logger.info(f"Running inference for prompt: {prompt}")
        
        def run_inference():
            return model_pipeline(text=messages)
            
        result = await asyncio.to_thread(run_inference)

        raw_output = str(result)
        logger.info(f"Raw output: {raw_output}")

        detections = parse_model_output(raw_output, prompt)

        return LocateResponse(detections=detections, message="Analysis complete.")
    except Exception as e:
        logger.error(f"Error during inference: {str(e)}")
        return LocateResponse(detections=[], message=f"Error: {str(e)}")
