# OpenUSD Edge-to-Core Asset Pipeline & Analytics Showcase

An advanced, high-performance 3D asset ingestion and processing pipeline designed for mobile mapping and reality capture telemetry, leveraging Go, Python, and NVIDIA Omniverse (OpenUSD + NTC).

## Architecture Overview

- **Edge Acquisition**: Mobile LiDAR SLAM (Scaniverse) & High-Res Photogrammetry (Reality Capture).
- **Control Layer (Backend)**: Asynchronous, stream-based Go server utilizing `go-chi` and structured JSON logging (`log/slog`).
- **Processing Layer (Worker)**: Headless Python scripts leveraging NVIDIA OpenUSD libraries and RTX Neural Texture Compression (NTC) to minimize VRAM footprints.
- **Analysis & Visualization**: Multilayered analytical desktop interface (Wails/Go) with metric telemetry, geometric point-to-point measurements, and local LLM (Google Gemma) report generation.

## Project Structure

- `backend/` - High-performance Go orchestration server & REST API.
- `processing/` - Core USD manipulation scripts & NVIDIA RTX NTC pipeline.
- `viewer/` - Frontend visualization layers & analytical canvas components.
- `data/` - Od-isolated storage partitions for raw and optimized spatial assets (ignored by Git).
- `docs/` - Technical engineering thesis artifacts and system documentation.
