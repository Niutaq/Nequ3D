<h1 align="center">Nequ3D — Building Renovation Digital Twin</h1>

<div align="center">
  <img width="220" height="220" alt="Nequ3D logo" src="https://github.com/user-attachments/assets/cad8e101-5116-45e5-8f56-742ff72a3a07" />
  <p>
    <strong>Reality Scan (USDZ) → OpenUSD &amp; NVIDIA RTX NTC → Hybrid Mesh / 3DGS Inspection → Local AI Renovation Agent → Omniverse Kit</strong>
  </p>
</div>

<img alt="Nequ3D dashboard" src="docs/nequ3d_dashboard.png" />

## Architecture & Tech Stack

| Layer | Technology | Role |
| --- | --- | --- |
| **Frontend & 3D** | ![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white) ![Vite](https://img.shields.io/badge/Vite-v8.3-646CFF?logo=vite&logoColor=white) ![Three.js](https://img.shields.io/badge/Three.js-WebGL2-000000?logo=threedotjs&logoColor=white) ![gsplat](https://img.shields.io/badge/gsplat-3DGS-008CA8) | WebView2 workstation, Mesh / NTC / 3DGS / Hybrid split view, metric measure, XYZ section, 2D Top View & persistent 3D pins |
| **Desktop Edge** | ![Wails](https://img.shields.io/badge/Wails-v3.1.0-DF0000) ![Go](https://img.shields.io/badge/Go-1.26+-00ADD8?logo=go&logoColor=white) | Native Windows shell, capability-token preview server, GPU telemetry & tool-using AI orchestrator |
| **3D & Neural Core** | ![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white) ![OpenUSD](https://img.shields.io/badge/OpenUSD-SimReady-00B4D8) ![NVIDIA RTX NTC](https://img.shields.io/badge/NVIDIA_RTX_NTC-v0.10.1-76B900?logo=nvidia&logoColor=white) ![CUDA](https://img.shields.io/badge/CUDA-12.6-76B900?logo=nvidia&logoColor=white) | OpenUSD stage traversal, neural texture compression (`ntc-cli`), PSNR/SSIM metrics & `annotations.usda` layers |
| **RPC & Events** | ![gRPC](https://img.shields.io/badge/gRPC-Protobuf-244C5A) ![CloudEvents](https://img.shields.io/badge/CloudEvents-v1.0-1D4ED8?logo=cloudevents&logoColor=white) ![NATS JetStream](https://img.shields.io/badge/NATS_JetStream-durable-27AAE1?logo=natsdotio&logoColor=white) | Streaming Edge ↔ Core pipeline RPC & persistent digital-twin event timeline |
| **Provenance & OCI** | ![in-toto](https://img.shields.io/badge/in--toto-SLSA_v1-0F766E) ![ORAS](https://img.shields.io/badge/ORAS-OCI_Artifacts-4F46E5) ![MinIO](https://img.shields.io/badge/MinIO-S3_API-C72E49?logo=minio&logoColor=white) | DSSE-signed `SLSA v1` attestations, OCI twin manifests & S3 buckets (`raw-scans` / `processed-models`) |
| **Offline AI & Evals** | ![Ollama](https://img.shields.io/badge/Ollama-local-111827?logo=ollama&logoColor=white) ![Faithfulness Eval](https://img.shields.io/badge/Faithfulness-Telemetry_Judge-059669) ![LocateAnything](https://img.shields.io/badge/LocateAnything-optional-6366F1) | Local LLM planner/advisor (`gemma:2b` / `llama3` / `llava`), numerical faithfulness judge & optional vision detection |
| **Containers & K8s** | ![Docker](https://img.shields.io/badge/Docker-GPU-2496ED?logo=docker&logoColor=white) ![Podman](https://img.shields.io/badge/Podman-5+-892CA0?logo=podman&logoColor=white) ![Kubernetes](https://img.shields.io/badge/Kubernetes-local-326CE5?logo=kubernetes&logoColor=white) ![Helm](https://img.shields.io/badge/Helm-v3-0F1689?logo=helm&logoColor=white) ![KEDA](https://img.shields.io/badge/KEDA-GPU_Autoscaler-326CE5) | `nequ3d-core:v4` CUDA container, Helm packaging & scale-to-zero `ScaledObject` |
| **GitOps & NetSecOps** | ![Argo CD](https://img.shields.io/badge/Argo_CD-GitOps-EF7B4D?logo=argo&logoColor=white) ![Sealed Secrets](https://img.shields.io/badge/Sealed_Secrets-CNCF-1F2937) ![Kyverno](https://img.shields.io/badge/Kyverno-Policy_as_Code-F36B21) ![Tetragon](https://img.shields.io/badge/Tetragon-eBPF_Shield-F8C517?logo=cilium&logoColor=black) ![Trivy](https://img.shields.io/badge/Trivy-SBOM_%26_Audit-1904DA?logo=trivy&logoColor=white) | GitOps sync, encrypted secrets, admission policies, eBPF runtime shield & CycloneDX SBOM ([threat model](docs/security-threat-model.md)) |
| **Observability** | ![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-OTLP-425CC7?logo=opentelemetry&logoColor=white) ![Jaeger](https://img.shields.io/badge/Jaeger-tracing-60D0E4?logo=jaeger&logoColor=black) ![Prometheus](https://img.shields.io/badge/Prometheus-metrics-E6522C?logo=prometheus&logoColor=white) ![Grafana](https://img.shields.io/badge/Grafana-dashboards-F46800?logo=grafana&logoColor=white) | End-to-end W3C trace propagation (Edge → gRPC → Core), Prometheus gauges & Grafana dashboards |
| **Research & CI** | ![marimo](https://img.shields.io/badge/marimo-notebook-10B981) ![Task](https://img.shields.io/badge/Task-runner-29BEB0?logo=task&logoColor=white) ![GitHub Actions](https://img.shields.io/badge/GitHub_Actions-CI-2088FF?logo=githubactions&logoColor=white) | Reactive RTX NTC rate-distortion & LaTeX `booktabs` notebook (`task notebook`) + automated CI |

## Quick Start (Windows + NVIDIA GPU)

**Prerequisites:** PowerShell 7, Go 1.26+, Node.js 22+, Edge WebView2, Docker Desktop (or Podman 5+) with NVIDIA GPU passthrough, `kubectl` with a local Kubernetes cluster (`docker-desktop` / `k3s` / `k3d`), and optional [Task](https://taskfile.dev/) + [Ollama](https://ollama.com/) (`ollama pull gemma:2b`).

```powershell
# 1) Install Wails v3 CLI (one-time)
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0

# 2) Launch everything (MinIO, GPU Core, Jaeger/Grafana/Prometheus/Argo UIs, NATS JetStream & Wails app)
task run-all
# First run or after Python/Dockerfile edits:
task run-all-build
```

<details>
<summary><strong>First-time Kubernetes MinIO bootstrap, Podman &amp; Windows Smart App Control notes</strong></summary>

```powershell
# Bootstrap MinIO namespace, credentials secret, and deployment on a fresh local K8s cluster:
kubectl create namespace minio --dry-run=client -o yaml | kubectl apply -f -
kubectl -n minio create secret generic minio-credentials `
  --from-literal=rootUser=minioadmin `
  --from-literal=rootPassword=minioadmin `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f gitops/apps/minio-standalone.yaml
```

- **Without `task`:** `pwsh -NoProfile -File ./scripts/run-all.ps1 -WithStack` (add `-BuildCore`, `-NoStack`, or `-WithLocate` as needed).
- **Podman:** set `$env:NEQU3D_CONTAINER_CLI = 'podman'` if Docker is also installed; Core reaches host forwards via `host.containers.internal`.
- **Windows Smart App Control:** if unsigned local Go binaries (`wails3.exe`) are blocked, the launcher automatically falls back to `go run`; disable Smart App Control if `go.exe` itself is blocked.

</details>

## Workflow

1. **Load file** (`.usdz` / `.usd` / `.glb` / `.ply` / `.splat`) → click **Analyze** to run OpenUSD parsing, RTX NTC compression, 3DGS surfel generation, SimReady validation, and `in-toto` attestation.
2. Inspect in **Mesh**, **NTC** (32bpp vs NTC split), **3DGS**, or **Hybrid** (Mesh / 3DGS split), take metric **Measurements**, cut **XYZ Sections**, toggle **2D Top** view, and pin persistent **3D Notes**.
3. Set zone renovation statuses and click **Save zones** (`twin_manifest.json` + `annotations.usda` + refreshed DSSE signature & CloudEvent).
4. Click **Run agent** (local Ollama + automatic numerical faithfulness evaluation) or open `exports/omniverse/<asset>/building_twin.usda` directly in **NVIDIA Omniverse Kit**.

## Key Commands & Ports

| Command | Action |
| --- | --- |
| `task run-all` / `task run-all-lite` | Full stack with CNCF UIs / Lite session (`-NoStack`) |
| `task run-all-build` | Rebuild `nequ3d-core:v4` + start full session |
| `task run-all-locate` | Full session + optional LocateAnything (`:8000`, ≥12 GB VRAM) |
| `task benchmark-sweep` | Multi-BPP / multi-step RTX NTC benchmark (`experiments/results/`) |
| `task notebook` | Reactive `marimo` Rate–Distortion & LaTeX table notebook |
| `task security-audit` | Verify Kyverno policies, Tetragon eBPF, KEDA & build CycloneDX SBOM |
| `task oras-dryrun TWIN_DIR=...` | Validate OCI / ORAS twin layers & `in-toto` provenance bundle |

| Service | Local Endpoint |
| --- | --- |
| Nequ3D Vite / Dev UI | `127.0.0.1:9245` |
| Core gRPC / Metrics | `127.0.0.1:50051` / `127.0.0.1:8001/metrics` |
| MinIO S3 API / Console | `127.0.0.1:9000` / `127.0.0.1:9001` |
| Jaeger UI / OTLP HTTP | `127.0.0.1:16686` / `127.0.0.1:4318` |
| Grafana / Prometheus / Argo CD | `127.0.0.1:3000` / `127.0.0.1:9090` / `127.0.0.1:8080` |
| Ollama / LocateAnything | `127.0.0.1:11434` / `127.0.0.1:8000` |

## Repository Layout

```text
nequ3d-app/       Wails v3.1 Go Edge, NATS JetStream, OTel, in-toto/AI verifiers & TypeScript UI
nequ3d-core/      CUDA/Python gRPC server, OpenUSD, NVIDIA RTX NTC, 2DGS & Omniverse packager
proto/            Protobuf pipeline contract
gitops/, helm/    Argo CD apps, Helm chart, KEDA scaler, Kyverno & Tetragon eBPF policies
experiments/      RTX NTC benchmark harness & reactive marimo thesis notebook
scripts/          One-command Windows launcher, ORAS packager, marimo bootstrap & NetSecOps audit
docs/             Dashboard preview & NetSecOps / eBPF threat model
ml-services/      Optional LocateAnything vision microservice
```

## License

Apache License 2.0 — see [LICENSE](LICENSE). Third-party components retain their respective licenses.
