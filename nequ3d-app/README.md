# Nequ3D desktop application

Go/Wails desktop application with a TypeScript/Vite frontend. The supported local workflow is Windows with NVIDIA GPU access; Core runs in Docker and MinIO in local Kubernetes.

Start the complete environment from the repository root:

```powershell
task run-all
```

Without Task:

```powershell
pwsh -NoProfile -File ./scripts/run-all.ps1
```

See the [main README](../README.md) for prerequisites, ports, optional Ollama models and troubleshooting.

For desktop-only development when Core and MinIO are already running, execute `wails3 dev` from this directory. `wails3 build` writes the desktop executable to `bin/`; the executable still needs the external services. Pin Wails Go, CLI, and `@wailsio/runtime` to **v3.1.0** (see the main README).

Frontend dependencies are installed with `npm ci`. To check the frontend directly:

```powershell
cd frontend
npm ci
npx --no-install tsc --noEmit
npm run build
```
