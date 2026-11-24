<h1 align="center">Nequ3D — Building Renovation Digital Twin</h1>

<div align="center">
  <img width="250" height="250" alt="Nequ3D logo" src="https://github.com/user-attachments/assets/cad8e101-5116-45e5-8f56-742ff72a3a07" />
</div>

Nequ3D turns **Reality Scan** captures into an **OpenUSD Building Renovation Digital Twin**: edge inspection on Windows, GPU Core processing in Docker, neural texture compression (NVIDIA RTX NTC), zone-aware annotations, a local tool-using AI agent, and an optional **Omniverse Kit** export pack — without replacing the desktop app with Kit.

**Research question:** how can a local tool-using agent, on Reality Scan + OpenUSD twin layers, propose a zone-ordered renovation priority that an engineer can inspect and export to Kit?  
**Start here:** jump to [Start everything](#start-everything) and [Reality Scan workflow](#reality-scan-workflow).

**One command:** `task run-all` starts MinIO forward, Core (GPU), Wails, and CNCF UIs (Argo `:8080`, Grafana `:3000`, Prometheus `:9090`, MinIO console `:9001`). Lite: `task run-all-lite`. Locate: `task run-all-locate`.

**Supported local workflow: Windows + NVIDIA GPU.** The Wails desktop app runs on Windows; the Python Core runs in a Linux Docker container. MinIO runs in the local Kubernetes cluster and is exposed by the launcher.

<img alt="Nequ3D dashboard" src="docs/nequ3d_dashboard.png" />

## What you get

| Capability | Role |
| --- | --- |
| OpenUSD ingest + NTC | Compress UV textures; compute VRAM savings, PSNR & SSIM; emit GLB proxies for WebView |
| Twin manifest + zones | Prim identity, building sections, renovation status |
| USD layers | Immutable scan + `annotations.usda` composition (zones, measurements, 3D notes) |
| Measure / section / 2D Top | Metric measurements, interactive XYZ section plane, 2D Top View & persistent 3D pins |
| Hybrid Mesh + 3DGS | Pixel-locked Mesh / 3DGS split view + automatic Mesh → 2DGS conversion & `.ply`/`.splat` loader |
| LocateAnything | Snapshot → object detections (optional microservice) |
| Renovation agent | Ollama plans tools: `ProcessModel`, manifest, locate, advice |
| Omniverse interop | Filesystem export + OpenUSD / SimReady-lite validation card for Kit |
| NetSecOps | SHA-256 sidecars, MinIO metadata, loopback preview tokens |

## Architecture & Tech Stack

| Component | Technology | Description |
| --- | --- | --- |
| **Frontend & 3D** | ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white) ![Vite](https://img.shields.io/badge/Vite-v8.3-646CFF?logo=vite&logoColor=white) ![Three.js](https://img.shields.io/badge/Three.js-WebGL2-000000?logo=threedotjs&logoColor=white) ![gsplat](https://img.shields.io/badge/gsplat-3DGS-008CA8) | WebView2 UI, `<model-viewer>`, hybrid Mesh/3DGS, measurements, 2D Top View & 3D pins |
| **Desktop Edge** | ![Wails](https://img.shields.io/badge/Wails-v3.1.0-DF0000) ![Go](https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go&logoColor=white) | Native Windows shell, HTTP preview cache, GPU telemetry & tool-using agent |
| **3D & Neural Core** | ![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white) ![OpenUSD](https://img.shields.io/badge/OpenUSD-SimReady-00B4D8) ![NVIDIA RTX NTC](https://img.shields.io/badge/NVIDIA_RTX_NTC-v0.10.1-76B900?logo=nvidia&logoColor=white) ![CUDA](https://img.shields.io/badge/CUDA-12.6-76B900?logo=nvidia&logoColor=white) | OpenUSD parsing, neural texture compression (`ntc-cli`), PSNR/SSIM & USD layers |
| **RPC & Events** | ![gRPC](https://img.shields.io/badge/gRPC-Protobuf-244C5A) ![NATS](https://img.shields.io/badge/NATS-embedded-27AAE1?logo=natsdotio&logoColor=white) | Streaming Edge ↔ Core pipeline RPC and internal event bus |
| **Object Storage** | ![MinIO](https://img.shields.io/badge/MinIO-S3_API-C72E49?logo=minio&logoColor=white) | `raw-scans` & `processed-models` buckets with SHA-256 integrity sidecars |
| **Offline AI** | ![Ollama](https://img.shields.io/badge/Ollama-local-111827?logo=ollama&logoColor=white) ![LocateAnything](https://img.shields.io/badge/LocateAnything-optional-6366F1) | Local LLM advice/planner (`gemma:2b` / `llama3` / `llava`) — **no cloud API key** |
| **Containers & K8s** | ![Docker](https://img.shields.io/badge/Docker-GPU-2496ED?logo=docker&logoColor=white) ![Podman](https://img.shields.io/badge/Podman-5+-892CA0?logo=podman&logoColor=white) ![Kubernetes](https://img.shields.io/badge/Kubernetes-local-326CE5?logo=kubernetes&logoColor=white) ![Helm](https://img.shields.io/badge/Helm-v3-0F1689?logo=helm&logoColor=white) | `nequ3d-core:v4` GPU container + local cluster packaging |
| **GitOps & Secrets** | ![Argo CD](https://img.shields.io/badge/Argo_CD-GitOps-EF7B4D?logo=argo&logoColor=white) ![Sealed Secrets](https://img.shields.io/badge/Sealed_Secrets-CNCF-1F2937) | Declarative cluster sync and encrypted Kubernetes secrets |
| **Observability** | ![Prometheus](https://img.shields.io/badge/Prometheus-metrics-E6522C?logo=prometheus&logoColor=white) ![Grafana](https://img.shields.io/badge/Grafana-dashboards-F46800?logo=grafana&logoColor=white) | Core gRPC, NTC VRAM/PSNR/SSIM gauges (`:8001`) & dashboards |
| **Automation & CI** | ![Task](https://img.shields.io/badge/Task-runner-29BEB0?logo=task&logoColor=white) ![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-CI-2088FF?logo=githubactions&logoColor=white) | One-command launch (`task run-all`) + Frontend / Go / Python / Helm CI |

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
```

If Windows **Smart App Control / Application Control** blocks unsigned or unverified developer binaries (`An Application Control policy has blocked this file` — e.g. `%USERPROFILE%\go\bin\wails3.exe`, `task.exe`, `go.exe`, or the locally compiled `nequ3d-app\bin\nequ3d-app.exe`), the launcher falls back to `go run ...@v3.1.0` when `go.exe` is permitted, or fails fast if `go.exe` itself is blocked. To allow local Go/Wails/Task builds, turn off Smart App Control: *Windows Security → App & browser control → Smart App Control → Off* (and run `Unblock-File` on downloaded `.exe` tools if needed).

## Prerequisites

Install and make available on `PATH`:

- Windows with [PowerShell 7](https://learn.microsoft.com/powershell/scripting/installing-powershell-on-windows).
- [Go 1.26+](https://go.dev/dl/), [Node.js 22.12+](https://nodejs.org/en/download), Microsoft Edge WebView2.
- [Wails v3.1.0 CLI](https://v3.wails.io/) (`wails3` above).
- A container runtime with GPU support + NVIDIA Windows drivers:
  - [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Linux containers / WSL 2), **or**
  - [Podman](https://podman.io/) 5+ on Windows (`podman machine init` + `podman machine start`). The launcher auto-detects `docker` or `podman` (override with `NEQU3D_CONTAINER_CLI=podman`).
- `kubectl` and a local Kubernetes context with MinIO (`gitops/apps/minio-standalone.yaml`, secret `minio-credentials`).
  The manifest uses `bitnamilegacy/minio` because anonymous pulls of `minio/minio` are no longer available (MinIO AIStor).
- Optional: [Task](https://taskfile.dev/installation/), [Ollama](https://ollama.com/) for AI reports/agent.

### Kubernetes (Docker Desktop / k3s) & MinIO bootstrap

The launcher requires an active local Kubernetes cluster (`docker-desktop`, `k3s`, `kind`, `k3d`, or `minikube`) with the `minio` namespace, credentials secret, and deployment running. If you are setting up from scratch, or after a Docker Desktop / k3s cluster update or reset, enable Kubernetes (e.g., *Docker Desktop → Settings → Kubernetes → Enable Kubernetes*) and bootstrap MinIO:

```powershell
# 1) Verify Kubernetes API is ready
kubectl get --raw=/readyz

# 2) Check if MinIO is already deployed
kubectl get svc -n minio

# 3) If empty, create the namespace, credentials secret, and MinIO deployment
kubectl create namespace minio --dry-run=client -o yaml | kubectl apply -f -
kubectl -n minio create secret generic minio-credentials `
  --from-literal=rootUser=minioadmin `
  --from-literal=rootPassword=minioadmin `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f gitops/apps/minio-standalone.yaml
```

### Podman notes

Podman replaces Docker for building/running **Core**, but MinIO still needs a **Kubernetes** cluster and `kubectl` (Docker Desktop used to bundle both).

```powershell
# 1) Podman VM (one-time + start)
podman machine init
podman machine start

# 2) kubectl (not shipped with Podman)
winget install Kubernetes.kubectl

# 3) Local cluster for MinIO (pick one), then bootstrap namespace/secret/deployment
#    e.g. k3s / kind / k3d / minikube / enable Kubernetes in Podman Desktop
kubectl create namespace minio --dry-run=client -o yaml | kubectl apply -f -
kubectl -n minio create secret generic minio-credentials `
  --from-literal=rootUser=minioadmin `
  --from-literal=rootPassword=minioadmin `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f gitops/apps/minio-standalone.yaml

$env:NEQU3D_CONTAINER_CLI = 'podman'   # optional if docker is also installed
task run-all
```

Core reaches MinIO via `host.containers.internal:9000`. GPU passthrough into the Podman machine must work for NTC (`nvidia-smi` inside the container). If the machine has no GPU, the launcher’s GPU check will fail — fix CDI/passthrough or use Docker Desktop with GPU.

MinIO credentials come from the Kubernetes secret — they are not embedded in source. Prefer bucket SSE/KMS when available.

## Start everything

From the repository root in PowerShell 7:

```powershell
task run-all
```

Without Task:

```powershell
pwsh -NoProfile -File ./scripts/run-all.ps1
```

The launcher checks tools/ports, builds `nequ3d-core:v4` if needed, starts Ollama if installed, port-forwards MinIO, starts Core with GPU + `data/objects` mount (and `LOCATE_SERVICE_URL` pointing at the host), generates Wails bindings, and runs `wails3 dev`.

```powershell
pwsh -NoProfile -File ./scripts/run-all.ps1 -BuildCore   # after Core Python/Dockerfile changes
pwsh -NoProfile -File ./scripts/run-all.ps1 -CheckOnly   # prerequisites only
pwsh -NoProfile -File ./scripts/run-all.ps1 -WithLocate  # also start LocateAnything on :8000 (GPU)
# or: task run-all-locate
```

**Locate in view** needs LocateAnything on host port `8000`. Without `-WithLocate`, start it separately (`task build-locate` then `task run-locate`). Core reaches it via `host.docker.internal:8000` (Podman: `host.containers.internal`). First locate image/model pull is large and shares VRAM with Core (LocateAnything-3B prefers ≥12 GB VRAM; use `transformers==4.57.1`, not v5). Rebuild after locate Dockerfile changes: `-WithLocate -BuildLocate`.

## Reality Scan workflow

```text
Reality Scan → USDZ → Nequ3D Edge (Wails 3.1)
                   → integrity sidecar + MinIO raw-scans
                   → Core: OpenUSD + NTC + twin layers
                   → viewer (mesh / quality / 3DGS / hybrid)
                   → exports/omniverse/<asset> → optional Kit open
```

1. Export a building capture from Reality Scan as USDZ.
2. **Load asset** in Nequ3D → **Run Core Analysis**.
3. Inspect zones, measure, section; **Save twin annotations**.
4. Optionally **Run renovation agent** (local Ollama) or **Locate in view**.
5. Open `building_twin.usda` in Omniverse Kit (exported under `exports/omniverse/<asset>/`).

## Experiments

Benchmark harness: [`experiments/`](experiments/). Place USDZ files under `data/objects/`, start Core, then:

```powershell
pwsh -NoProfile -File ./experiments/run-ntc-benchmark.ps1
```

Results: `experiments/results/run-<timestamp>.json` (+ CSV). **README tables should cite those files** — do not invent numbers before a run on your GPU.

## Security (scan protection)

Reality Scan data can reveal real interiors. Controls include SHA-256 sidecars, MinIO object metadata, loopback preview tokens, and local-first Ollama.

## Optional AI

```powershell
# Install https://ollama.com/ then:
ollama serve          # launcher also tries this if ollama is on PATH
ollama pull gemma:2b
# optional: llama3, mistral, llava
```

Ollama on `localhost:11434`. Default model: `gemma:2b`. If Ollama is down, **Run renovation agent** still returns an offline checklist (zones / twin / locate) instead of hard-failing.

## Development commands

| Command | Purpose |
| --- | --- |
| `task run-all` / `task dev` | Full Windows session |
| `task run-all-locate` | Same + LocateAnything on :8000 |
| `task build-core` | Rebuild `nequ3d-core:v4` |
| `task build-locate` / `task run-locate` | LocateAnything image / container |
| `task dev-app` | Desktop only (Core/MinIO already up) |
| `task run-core` | Core only |
| `task proto` | Regenerate gRPC stubs |
| `wails3 build` in `nequ3d-app` | Desktop binary under `nequ3d-app/bin` |

## Ports

| Service | Port |
| --- | --- |
| MinIO API | 9000 |
| Core gRPC | 50051 |
| Core metrics | 8001 |
| LocateAnything | 8000 |
| Vite | 9245 |
| Ollama | 11434 |

## Repository structure

```text
nequ3d-app/       Go/Wails 3.1 desktop + TypeScript frontend
nequ3d-core/      Python gRPC, OpenUSD, NTC, twin + Omniverse export
proto/            Shared RPC
scripts/          Windows launcher
experiments/      NTC / twin benchmarks
docs/             Screenshots, performance, security, Omniverse
gitops/, helm/    Kubernetes / GitOps
ml-services/      LocateAnything (optional)
data/             Local objects/logs (gitignored)
```

## License

See [LICENSE](LICENSE) (Apache License 2.0). Third-party components have their own licenses.
