# OpenUSD Edge-to-Core Asset Pipeline & Analytics Showcase

[![Docker](https://img.shields.io/badge/Docker-Required-2496ED?logo=docker\&logoColor=white)](https://www.docker.com/)
[![Wails](https://img.shields.io/badge/Wails-v3-orange)](https://v3alpha.wails.io/)
[![OpenUSD](https://img.shields.io/badge/OpenUSD-NVIDIA-success)](https://openusd.org/)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?logo=go)](https://go.dev/)
[![Python](https://img.shields.io/badge/Python-3.12+-3776AB?logo=python\&logoColor=white)](https://www.python.org/)

An advanced, high-performance 3D asset ingestion and processing pipeline designed for mobile mapping and reality capture telemetry, leveraging Go, Python, and NVIDIA Omniverse technologies (OpenUSD + RTX Neural Texture Compression).

---

## Architecture Overview

* **Edge Acquisition**: Mobile LiDAR SLAM & High-Resolution Photogrammetry (Reality Capture).
* **Control Layer (Backend)**: Asynchronous, stream-based Go server utilizing `go-chi` and structured JSON logging with `log/slog`.
* **Processing Layer (Worker)**: Headless Python services leveraging NVIDIA OpenUSD libraries and RTX Neural Texture Compression (NTC) for optimized memory utilization.
* **Analysis & Visualization**: Desktop analytics environment built with Wails, featuring geometric measurements, telemetry dashboards, and local LLM-assisted reporting (Google Gemma).

---

## Project Structure

```text
.
├── backend/        # High-performance Go orchestration server & REST API
├── processing/     # OpenUSD processing scripts & RTX NTC pipeline
├── viewer/         # Visualization and analytics frontend
├── data/           # Raw and optimized spatial assets (gitignored)
└── docs/           # Engineering thesis and technical documentation
```

---

## What Is It?

<img width="1401" height="848" alt="nequ3d_demo" src="https://github.com/user-attachments/assets/12934a36-fe67-4e29-976c-b6e27a28f5e7">

The platform transforms raw reality-capture datasets into optimized OpenUSD scenes suitable for visualization, analytics, and long-term archival.

The processing workflow enables:

* Automated ingestion of LiDAR and photogrammetry assets
* OpenUSD scene generation and manipulation
* Neural texture compression using NVIDIA RTX NTC
* Telemetry collection and performance monitoring
* Desktop-based geometry inspection and measurement
* AI-assisted report generation using local LLM inference

---

# Prerequisites

Before running the system, install the required tooling.

## Docker

Docker is used to build and execute the isolated OpenUSD processing environment.

### Installation

https://www.docker.com/products/docker-desktop/

Verify your installation:

```bash
docker --version
```

Expected output:

```text
Docker version XX.X.X
```

---

## Wails v3

Wails powers the native desktop analytics application.

### Installation

https://v3alpha.wails.io/getting-started/installation/

Verify installation:

```bash
wails3 version
```

Expected output:

```text
Wails CLI v3.x.x
```

---

# Building the Processing Environment

Navigate to the processing module:

```bash
cd processing
```

Build the OpenUSD processing container:

```bash
docker build -t nequ3d-core:latest .
```

This image contains:

* NVIDIA OpenUSD runtime
* RTX Neural Texture Compression toolchain
* Python processing scripts
* Asset optimization pipeline
* Headless worker services

Verify the image was created successfully:

```bash
docker images
```

Expected result:

```text
REPOSITORY      TAG       IMAGE ID
nequ3d-core     latest    xxxxxxxxxxxx
```

---

# Running the Analytics Application

Navigate to the application frontend:

```bash
cd nequ3d-app/frontend
```

Generate Wails bindings:

```bash
wails3 generate bindings
```

Launch the development environment:

```bash
wails3 dev
```

The development environment automatically:

* Generates Go ↔ Frontend bindings
* Launches the desktop application
* Enables hot reload
* Connects backend services
* Streams telemetry data

For convenience, both commands can be executed together:

```bash
wails3 generate bindings && wails3 dev
```

---

# Quick Start

Build the processing environment:

```bash
cd processing
docker build -t nequ3d-core:latest .
```

Start the analytics application:

```bash
cd ../nequ3d-app/frontend
wails3 generate bindings && wails3 dev
```

---

# Technology Stack

| Layer            | Technology     |
| ---------------- | -------------- |
| Backend          | Go             |
| API              | Chi Router     |
| Processing       | Python         |
| Scene Format     | OpenUSD        |
| Compression      | NVIDIA RTX NTC |
| Desktop UI       | Wails          |
| AI Reporting     | Google Gemma   |
| Containerization | Docker         |

---

# Future Roadmap

* Distributed processing workers
* Kubernetes deployment support
* Cloud object storage integration
* Live telemetry streaming
* Web-based analytics dashboard
* Collaborative OpenUSD scene review
* AI-assisted anomaly detection

---

# License

This project is intended for research, engineering, and educational purposes.
