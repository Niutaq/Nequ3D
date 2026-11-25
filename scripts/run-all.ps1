# Windows launcher. Run from any directory; task run-all calls this script.
# Container runtime: Docker Desktop OR Podman (auto-detected).
# One-shot: MinIO PF + Core GPU + Wails + (default) Argo/Prometheus/Grafana PFs.
[CmdletBinding()]
param(
    [switch]$BuildCore,
    [switch]$CheckOnly,
    [switch]$ServicesOnly,
    [switch]$WithLocate,
    [switch]$BuildLocate,
    # CNCF side stack (Argo CD + kube-prometheus-stack UIs). On by default via task run-all.
    [switch]$WithStack,
    [switch]$NoStack
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This launcher requires Windows and PowerShell 7.' }
$Root = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root 'nequ3d-app'
$Logs = Join-Path $Root 'data/logs'
$Objects = Join-Path $Root 'data/objects'
$HfCache = Join-Path $Root 'data/hf_cache'
$GitOpsApps = Join-Path $Root 'gitops/apps'
$CoreImage = 'nequ3d-core:v4'
$CoreName = 'nequ3d-core-dev'
$LocateImage = 'nequ3d-locate:latest'
$LocateName = 'nequ3d-locate-dev'
$minioProc = $null
$forwardProcs = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$coreStarted = $false
$locateStarted = $false
$locationPushed = $false
$launcherFailed = $false
$previousAccessKey = $env:MINIO_ACCESS_KEY
$previousSecretKey = $env:MINIO_SECRET_KEY
$ContainerCLI = $null
$MinioHostFromContainer = 'host.docker.internal'
$WailsMode = $null # 'exe' | 'gorun'
$WailsGoPackage = 'github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0'
$EnableStack = -not $NoStack
if ($WithStack) { $EnableStack = $true }

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    $commandLabel = "$File $($Arguments -join ' ')"
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Exit code: $LASTEXITCODE." }
    } catch {
        throw "Command failed: $commandLabel`n$($_.Exception.Message)"
    }
}

function Test-WailsExe {
    $cmd = Get-Command wails3 -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Stop'
        & $cmd.Source version *> $null
        $ErrorActionPreference = $prev
        return ($LASTEXITCODE -eq 0)
    } catch {
        $ErrorActionPreference = 'Stop'
        # Common on Windows: WDAC / Smart App Control blocks unsigned go\bin\wails3.exe
        return $false
    }
}

function Test-GoExe {
    $cmd = Get-Command go -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    try {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = 'Stop'
        & $cmd.Source version *> $null
        $ErrorActionPreference = $prev
        return ($LASTEXITCODE -eq 0)
    } catch {
        $ErrorActionPreference = 'Stop'
        # Common on Windows: WDAC / Smart App Control blocks go.exe
        return $false
    }
}

function Resolve-WailsMode {
    if (Test-WailsExe) { return 'exe' }
    if (Test-GoExe) { return 'gorun' }
    $goCmd = Get-Command go -ErrorAction SilentlyContinue
    $goState = if ($goCmd) { "found at '$($goCmd.Source)' but blocked from executing (likely Windows Application Control / Smart App Control)" } else { 'missing from PATH' }
    throw @"
Cannot run Wails CLI or Go toolchain.
- wails3.exe is missing or blocked by Windows Application Control (unsigned binary in %USERPROFILE%\go\bin).
- go.exe is $goState.

Fix options:
  1) Windows Security → App & browser control → Smart App Control → Off (required when go.exe or compiled .exe binaries are blocked), then optionally:
       go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
  2) If a downloaded executable was marked from the internet, run:
       Unblock-File '<path-to-exe>'
"@
}

function Invoke-Wails {
    param([string[]]$Arguments)
    if ($WailsMode -eq 'exe') {
        Invoke-Checked wails3 $Arguments
        return
    }
    $label = "go run $WailsGoPackage $($Arguments -join ' ')"
    Write-Host "Wails via go run (wails3.exe blocked or missing): $label"
    try {
        & go run $WailsGoPackage @Arguments
        if ($LASTEXITCODE -ne 0) { throw "Exit code: $LASTEXITCODE." }
    } catch {
        throw "Command failed: $label`n$($_.Exception.Message)"
    }
}

function Wait-Http {
    param([string]$Url, [string]$Name, [int]$TimeoutSeconds = 60)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if ($Name -eq 'MinIO' -and $minioProc.HasExited) {
            throw "MinIO port-forward exited. See $Logs/minio-forward.log.err"
        }
        try {
            $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become ready at $Url. See $Logs."
}

function Test-HttpOk {
    param([string]$Url)
    try {
        $response = Invoke-WebRequest -Uri $Url -TimeoutSec 2 -SkipHttpErrorCheck
        return ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500)
    } catch {
        return $false
    }
}

function Test-PortListen {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Start-KubectlForward {
    param(
        [string[]]$ArgumentList,
        [string]$LogName
    )
    $out = Join-Path $Logs "$LogName.log"
    $err = Join-Path $Logs "$LogName.log.err"
    $proc = Start-Process kubectl -ArgumentList $ArgumentList -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    $forwardProcs.Add($proc) | Out-Null
    return $proc
}

function Ensure-CncfStack {
    if (-not $EnableStack) {
        Write-Host 'CNCF stack UIs: skipped (-NoStack)'
        return
    }
    Write-Host 'CNCF stack: ensuring Argo CD + monitoring (Prometheus/Grafana)...'

    & kubectl get deploy argocd-server -n argocd --request-timeout=10s *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Installing Argo CD (first run can take several minutes)...'
        & kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
        if ($LASTEXITCODE -ne 0) { throw 'Failed to create argocd namespace.' }
        & kubectl apply --server-side --force-conflicts -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install Argo CD manifests.' }
    }
    & kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=300s
    if ($LASTEXITCODE -ne 0) { throw 'Argo CD server did not become Available.' }

    $monitoringApp = Join-Path $GitOpsApps 'monitoring.yaml'
    if (Test-Path $monitoringApp) {
        & kubectl apply -f $monitoringApp
        if ($LASTEXITCODE -ne 0) { throw "Failed to apply $monitoringApp" }
    } else {
        Write-Host "Warning: missing $monitoringApp — skip kube-prometheus-stack Application" -ForegroundColor Yellow
    }

    $jaegerManifest = Join-Path $GitOpsApps 'jaeger-standalone.yaml'
    $jaegerReady = $false
    if (Test-Path $jaegerManifest) {
        & kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f - *> $null
        & kubectl apply -f $jaegerManifest
        if ($LASTEXITCODE -eq 0) {
            & kubectl wait --for=condition=Available deployment/jaeger -n monitoring --timeout=45s *> $null
            if ($LASTEXITCODE -eq 0) { $jaegerReady = $true }
        }
    }

    # Port-forwards (skip if already listening — e.g. previous session / manual PF).
    if (-not (Test-PortListen 8080)) {
        Start-KubectlForward @('port-forward', 'svc/argocd-server', '8080:443', '-n', 'argocd') 'argo-forward' | Out-Null
    }
    if (-not (Test-PortListen 9001)) {
        Start-KubectlForward @('port-forward', 'svc/minio', '9001:9001', '-n', 'minio') 'minio-console-forward' | Out-Null
    }

    # Grafana/Prometheus appear after Argo syncs the Helm chart (slow on first cluster).
    # Cap wait so the desktop app still starts; UIs can catch up later.
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $grafanaReady = $false
    $promReady = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        & kubectl get svc kube-prometheus-stack-grafana -n monitoring --request-timeout=5s *> $null
        if ($LASTEXITCODE -eq 0) { $grafanaReady = $true }
        & kubectl get svc kube-prometheus-stack-prometheus -n monitoring --request-timeout=5s *> $null
        if ($LASTEXITCODE -eq 0) { $promReady = $true }
        if ($grafanaReady -and $promReady) { break }
        Start-Sleep -Seconds 5
    }

    if ($grafanaReady -and -not (Test-PortListen 3000)) {
        Start-KubectlForward @('port-forward', 'svc/kube-prometheus-stack-grafana', '3000:80', '-n', 'monitoring') 'grafana-forward' | Out-Null
    }
    if ($promReady -and -not (Test-PortListen 9090)) {
        Start-KubectlForward @('port-forward', 'svc/kube-prometheus-stack-prometheus', '9090:9090', '-n', 'monitoring') 'prometheus-forward' | Out-Null
    }
    if ($jaegerReady) {
        if (-not (Test-PortListen 16686) -and -not (Test-PortListen 4318)) {
            Start-KubectlForward @('port-forward', '--address', '0.0.0.0', 'svc/jaeger', '16686:16686', '4318:4318', '-n', 'monitoring') 'jaeger-forward' | Out-Null
        } elseif (-not (Test-PortListen 4318)) {
            Start-KubectlForward @('port-forward', '--address', '0.0.0.0', 'svc/jaeger', '4318:4318', '-n', 'monitoring') 'jaeger-otlp-forward' | Out-Null
        } elseif (-not (Test-PortListen 16686)) {
            Start-KubectlForward @('port-forward', 'svc/jaeger', '16686:16686', '-n', 'monitoring') 'jaeger-ui-forward' | Out-Null
        }
    }

    $argoPass = ''
    try {
        $b64 = & kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' --request-timeout=10s 2>$null
        if ($b64) { $argoPass = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) }
    } catch { }

    Write-Host ''
    Write-Host '=== Session URLs (one-shot) ===' -ForegroundColor Cyan
    Write-Host "  App / Vite     http://127.0.0.1:9245/"
    Write-Host "  Core metrics   http://127.0.0.1:8001/metrics"
    Write-Host "  MinIO API      http://127.0.0.1:9000"
    Write-Host "  MinIO console  http://127.0.0.1:9001"
    Write-Host "  Argo CD        https://127.0.0.1:8080  (admin / $(if ($argoPass) { $argoPass } else { '(kubectl -n argocd get secret argocd-initial-admin-secret)' }))"
    if ($grafanaReady) {
        Write-Host '  Grafana        http://127.0.0.1:3000  (admin / prom-operator)'
    } else {
        Write-Host '  Grafana        (pending — kube-prometheus-stack still syncing; re-run or task monitoring-ui)' -ForegroundColor Yellow
    }
    if ($promReady) {
        Write-Host '  Prometheus     http://127.0.0.1:9090'
    } else {
        Write-Host '  Prometheus     (pending — same as Grafana)' -ForegroundColor Yellow
    }
    if ($jaegerReady) {
        Write-Host '  Jaeger (OTel)  http://127.0.0.1:16686  (OTLP HTTP :4318)'
    } else {
        Write-Host '  Jaeger (OTel)  (pending — run task jaeger-ui once image pulls)' -ForegroundColor Yellow
    }
    Write-Host '===============================' -ForegroundColor Cyan
    Write-Host ''
}

function Ensure-Ollama {
    if (Test-HttpOk 'http://127.0.0.1:11434/api/tags') {
        Write-Host 'Ollama: ready on :11434'
        return
    }
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
        Write-Host 'Ollama: not installed (optional). Install from https://ollama.com/ then: ollama pull gemma:2b' -ForegroundColor Yellow
        return
    }
    Write-Host 'Ollama: starting serve in background...'
    Start-Process -FilePath 'ollama' -ArgumentList @('serve') -WindowStyle Hidden | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if (Test-HttpOk 'http://127.0.0.1:11434/api/tags') {
            Write-Host 'Ollama: ready on :11434'
            return
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-Host 'Ollama: installed but not responding yet. Start manually with: ollama serve' -ForegroundColor Yellow
}

function Ensure-LocateService {
    if (-not $WithLocate) {
        if (Test-HttpOk 'http://127.0.0.1:8000/health') {
            Write-Host 'LocateAnything: already healthy on :8000'
        } else {
            Write-Host 'LocateAnything: not running (optional). Use -WithLocate or: task run-locate' -ForegroundColor Yellow
        }
        return
    }
    if (Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue) {
        if (Test-HttpOk 'http://127.0.0.1:8000/health') {
            Write-Host 'LocateAnything: already healthy on :8000'
            return
        }
        throw 'Port 8000 is in use but LocateAnything /health is not OK. Free the port or stop the other process.'
    }
    $existing = & $ContainerCLI ps -aq --filter "name=$LocateName"
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Locate containers via $ContainerCLI." }
    if ($existing) { throw "Container $LocateName already exists. Stop it first: $ContainerCLI rm -f $LocateName" }

    New-Item -ItemType Directory -Force -Path $HfCache | Out-Null
    & $ContainerCLI image inspect $LocateImage *> $null
    if ($BuildLocate -or $LASTEXITCODE -ne 0) {
        Write-Host "Building $LocateImage with $ContainerCLI (first run downloads CUDA + model deps)..."
        Invoke-ContainerChecked @('build', '-t', $LocateImage, (Join-Path $Root 'ml-services/locate-anything'))
    }

    Write-Host "Starting LocateAnything with GPU ($ContainerCLI) on :8000..."
    $locateArgs = @(
        'run', '-d', '--rm', '--name', $LocateName,
        '--gpus', 'all',
        '--mount', "type=bind,source=$HfCache,target=/root/.cache/huggingface",
        '-p', '127.0.0.1:8000:8000',
        $LocateImage
    )
    $locateOut = & $ContainerCLI @locateArgs 2>&1
    $locateExit = $LASTEXITCODE
    if ($locateExit -ne 0) {
        throw @"
Failed to start LocateAnything via $ContainerCLI (exit $locateExit).
Output: $($locateOut | Out-String)
"@
    }
    $script:locateStarted = $true
    Write-Host "LocateAnything container started: $(($locateOut | Select-Object -Last 1))"
    # Model download + load can take several minutes on first run.
    Wait-LocateHealth 900
}

function Wait-LocateHealth {
    param([int]$TimeoutSeconds = 900)
    $url = 'http://127.0.0.1:8000/health'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $lastDetail = ''
    do {
        if (-not (& $ContainerCLI ps -q --filter "name=$LocateName")) {
            & $ContainerCLI logs $LocateName *> (Join-Path $Logs 'locate.log')
            throw "LocateAnything container exited before becoming healthy. See $Logs/locate.log"
        }
        try {
            $response = Invoke-WebRequest -Uri $url -TimeoutSec 3 -SkipHttpErrorCheck
            $body = if ($null -ne $response.Content) { [string]$response.Content } else { '' }
            $lastDetail = $body
            if ([int]$response.StatusCode -eq 200) {
                Write-Host 'LocateAnything: healthy on :8000'
                return
            }
            if ([int]$response.StatusCode -eq 500) {
                & $ContainerCLI logs $LocateName *> (Join-Path $Logs 'locate.log')
                throw @"
LocateAnything failed to load the model (HTTP 500 from /health).
Detail: $body
Logs: $Logs/locate.log
Rebuild with pinned transformers==4.57.1:
  pwsh -NoProfile -File ./scripts/run-all.ps1 -WithLocate -BuildLocate
"@
            }
        } catch {
            if ($_.Exception.Message -match 'LocateAnything failed to load') { throw }
            # Connection refused while uvicorn / model loader starts.
        }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    & $ContainerCLI logs $LocateName *> (Join-Path $Logs 'locate.log')
    throw "LocateAnything did not become ready at $url within ${TimeoutSeconds}s. Last detail: $lastDetail See $Logs/locate.log"
}

function Resolve-ContainerCLI {
    if ($env:NEQU3D_CONTAINER_CLI) {
        $forced = $env:NEQU3D_CONTAINER_CLI.Trim().ToLowerInvariant()
        if ($forced -notin @('docker', 'podman')) {
            throw "NEQU3D_CONTAINER_CLI must be 'docker' or 'podman' (got: $forced)."
        }
        if (-not (Get-Command $forced -ErrorAction SilentlyContinue)) {
            throw "NEQU3D_CONTAINER_CLI=$forced but that command is not on PATH."
        }
        return $forced
    }
    if (Get-Command docker -ErrorAction SilentlyContinue) { return 'docker' }
    if (Get-Command podman -ErrorAction SilentlyContinue) { return 'podman' }
    throw "Missing container runtime: install Docker Desktop or Podman, then ensure 'docker' or 'podman' is on PATH. See README.md prerequisites."
}

function Ensure-PodmanMachine {
    # Podman on Windows needs a Linux VM. Init is interactive/heavy — only start an existing machine.
    $machinesJson = & podman machine list --format json 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot list Podman machines. Try: podman machine init && podman machine start"
    }
    $machines = @()
    if ($machinesJson) {
        try { $machines = $machinesJson | ConvertFrom-Json } catch { $machines = @() }
    }
    if (-not $machines -or @($machines).Count -eq 0) {
        throw @"
Podman is installed, but no Podman machine exists yet.
Create and start one (one-time), then re-run the launcher:

  podman machine init
  podman machine start

Optional GPU note: NVIDIA CUDA in Core still needs GPU passthrough into the Podman machine
(WSL2/CDI). If nvidia-smi fails inside the container, see README Podman notes.
"@
    }
    $running = @($machines | Where-Object { $_.Running -eq $true -or $_.LastUp -eq 'Currently running' })
    if ($running.Count -gt 0) { return }

    $name = $machines[0].Name
    if (-not $name) { $name = 'podman-machine-default' }
    Write-Host "Starting Podman machine '$name'..."
    & podman machine start $name
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to start Podman machine '$name'. Run: podman machine start"
    }
}

function Invoke-ContainerChecked {
    param([string[]]$Arguments)
    Invoke-Checked $ContainerCLI $Arguments
}

try {
    $ContainerCLI = Resolve-ContainerCLI
    $missing = @()
    foreach ($tool in @('go', 'node', 'npm.cmd', 'kubectl')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $missing += $tool }
    }
    if ($missing.Count -gt 0) {
        $hint = ''
        if ($missing -contains 'kubectl' -and $ContainerCLI -eq 'podman') {
            $hint = @"

kubectl is not bundled with Podman. Install it, then create/use a local cluster for MinIO, e.g.:
  winget install Kubernetes.kubectl
  # cluster examples: kind / k3d / minikube / Podman Desktop Kubernetes
Apply gitops/apps/minio-standalone.yaml (and the minio-credentials secret) into that cluster.
"@
        }
        throw "Missing command(s): $($missing -join ', '). See README.md prerequisites.$hint"
    }
    $WailsMode = Resolve-WailsMode
    Write-Host "Wails CLI mode: $WailsMode"

    if ($ContainerCLI -eq 'podman') {
        Ensure-PodmanMachine
        $MinioHostFromContainer = 'host.containers.internal'
        Write-Host "Container runtime: podman (MinIO host from Core: $MinioHostFromContainer)"
    } else {
        Write-Host 'Container runtime: docker'
    }

    Invoke-ContainerChecked @('info')
    $context = & kubectl config current-context
    if ($LASTEXITCODE -ne 0) { throw 'No Kubernetes context selected. Configure kubectl before starting.' }
    $apiReady = $false
    $apiCheck = ''
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        $apiCheck = & kubectl get --raw=/readyz --request-timeout=10s 2>&1
        if ($LASTEXITCODE -eq 0) {
            $apiReady = $true
            break
        }
        if ($attempt -lt 10) {
            Write-Host "Waiting for Kubernetes API readiness (context: $context, attempt $attempt/10)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        }
    }
    if (-not $apiReady) {
        throw "Kubernetes API is unavailable (context: $context). Start the selected cluster (kind/k3d/minikube/Docker Desktop/Podman kube). Verify with: kubectl get --raw=/readyz. Details: $apiCheck"
    }
    Invoke-Checked kubectl @('get', 'service/minio', '-n', 'minio', '--request-timeout=10s')
    Invoke-Checked kubectl @('wait', '--for=condition=Available', 'deployment/minio', '-n', 'minio', '--timeout=15s')
    # Read the existing secret without printing credentials or putting them in arguments.
    $secretJson = & kubectl get secret minio-credentials -n minio -o json --request-timeout=10s
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the MinIO credentials secret.' }
    $minioSecret = $secretJson | ConvertFrom-Json
    $env:MINIO_ACCESS_KEY = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($minioSecret.data.rootUser))
    $env:MINIO_SECRET_KEY = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($minioSecret.data.rootPassword))
    if (-not $env:MINIO_ACCESS_KEY -or -not $env:MINIO_SECRET_KEY) { throw 'MinIO secret must contain rootUser and rootPassword.' }

    if ($CheckOnly) {
        Write-Host "Prerequisites available (container CLI: $ContainerCLI). No services started."
        return
    }
    $didCleanup = $false
    $existingCore = & $ContainerCLI ps -aq --filter "name=$CoreName"
    if ($LASTEXITCODE -ne 0) { throw "Cannot inspect Core containers via $ContainerCLI." }
    if ($existingCore) {
        Write-Host "Cleaning up leftover container $CoreName from previous session..." -ForegroundColor Yellow
        & $ContainerCLI rm -f $CoreName *> $null
        if ($LASTEXITCODE -ne 0) { throw "Failed to remove leftover container $CoreName." }
        $didCleanup = $true
    }
    if (Get-Process -Name 'nequ3d-app' -ErrorAction SilentlyContinue) {
        Stop-Process -Name 'nequ3d-app' -Force -ErrorAction SilentlyContinue
        $didCleanup = $true
    }
    $orphanPortProcs = @{ 9000 = 'kubectl'; 9245 = 'node' }
    foreach ($entry in $orphanPortProcs.GetEnumerator()) {
        $owningPids = Get-NetTCPConnection -State Listen -LocalPort $entry.Key -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($owningPid in $owningPids) {
            $proc = Get-Process -Id $owningPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq $entry.Value) {
                Write-Host "Cleaning up leftover $($entry.Value) process (PID $owningPid) on port $($entry.Key)..." -ForegroundColor Yellow
                Stop-Process -Id $owningPid -Force -ErrorAction SilentlyContinue
                $didCleanup = $true
            }
        }
    }
    if ($didCleanup) {
        for ($i = 0; $i -lt 20; $i++) {
            if (-not ((Test-PortListen 50051) -or (Test-PortListen 8001) -or (Test-PortListen 9000) -or (Test-PortListen 9245))) {
                break
            }
            Start-Sleep -Milliseconds 100
        }
    }

    $busyPorts = @(9000, 50051, 8001, 9245)
    if ($EnableStack) { $busyPorts += @(8080, 3000, 9090, 9001, 16686, 4318) }
    foreach ($port in $busyPorts) {
        # Stack UI ports may already be forwarded from a previous helper — only hard-fail core ports.
        if ($port -in @(8080, 3000, 9090, 9001, 16686, 4318) -and (Test-PortListen $port)) { continue }
        if (Test-PortListen $port) {
            throw "Port $port is already in use. Stop the previous Nequ3D session before starting."
        }
    }

    New-Item -ItemType Directory -Force -Path $Logs, $Objects | Out-Null
    & $ContainerCLI image inspect $CoreImage *> $null
    if ($BuildCore -or $LASTEXITCODE -ne 0) {
        Write-Host "Building $CoreImage with $ContainerCLI (this can take several minutes)..."
        Invoke-ContainerChecked @('build', '-t', $CoreImage, (Join-Path $Root 'nequ3d-core'))
    }

    Ensure-Ollama
    Ensure-LocateService

    Write-Host 'Starting MinIO port-forward...'
    $minioProc = Start-KubectlForward @('port-forward', 'svc/minio', '9000:9000', '-n', 'minio') 'minio-forward'
    Wait-Http 'http://127.0.0.1:9000/minio/health/live' 'MinIO'
    Ensure-CncfStack

    Write-Host "Starting Core with GPU access ($ContainerCLI)..."
    $minioEndpoint = "http://${MinioHostFromContainer}:9000"
    # LocateAnything listens on the host; Core must reach it via the gateway hostname.
    $locateEndpoint = "http://${MinioHostFromContainer}:8000"
    $otelContainerEndpoint = "http://${MinioHostFromContainer}:4318"
    $env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318'
    $runArgs = @(
        'run', '-d', '--rm', '--name', $CoreName,
        '--gpus', 'all',
        '-e', 'MINIO_ACCESS_KEY',
        '-e', 'MINIO_SECRET_KEY',
        '-e', "MINIO_ENDPOINT=$minioEndpoint",
        '-e', "LOCATE_SERVICE_URL=$locateEndpoint",
        '-e', "OTEL_EXPORTER_OTLP_ENDPOINT=$otelContainerEndpoint",
        '--mount', "type=bind,source=$Objects,target=/tmp/workspace",
        '-p', '127.0.0.1:50051:50051',
        '-p', '127.0.0.1:8001:8001',
        $CoreImage
    )
    # Podman: also publish host.docker.internal alias used by some stacks / docs.
    if ($ContainerCLI -eq 'podman') {
        $runArgs = @(
            'run', '-d', '--rm', '--name', $CoreName,
            '--gpus', 'all',
            '--add-host', 'host.docker.internal:host-gateway',
            '-e', 'MINIO_ACCESS_KEY',
            '-e', 'MINIO_SECRET_KEY',
            '-e', "MINIO_ENDPOINT=$minioEndpoint",
            '-e', "LOCATE_SERVICE_URL=$locateEndpoint",
            '-e', "OTEL_EXPORTER_OTLP_ENDPOINT=$otelContainerEndpoint",
            '--mount', "type=bind,source=$Objects,target=/tmp/workspace",
            '-p', '127.0.0.1:50051:50051',
            '-p', '127.0.0.1:8001:8001',
            $CoreImage
        )
    }
    # Keep stdout (container ID) separate from native exit code. Mixing them in
    # one return value makes PowerShell treat the ID string as a failed exit.
    $runOut = & $ContainerCLI @runArgs 2>&1
    $runExit = $LASTEXITCODE
    if ($runExit -ne 0) {
        throw @"
Failed to start Core container via $ContainerCLI (exit $runExit).
Output: $($runOut | Out-String)
If GPU flags failed, check NVIDIA Container Toolkit / Docker Desktop GPU support.
MinIO endpoint from container: $minioEndpoint
"@
    }
    $coreStarted = $true
    Write-Host "Core container started: $(($runOut | Select-Object -Last 1))"
    Wait-Http 'http://127.0.0.1:8001/metrics' 'Core'
    Invoke-ContainerChecked @('exec', $CoreName, 'python3', '-c', 'import socket; s=socket.create_connection(("127.0.0.1",50051),5); s.close()')
    Invoke-ContainerChecked @('exec', $CoreName, 'nvidia-smi', '--query-gpu=name', '--format=csv,noheader')
    Write-Host 'MinIO HTTP, Core metrics, gRPC TCP port and GPU checks passed (not a processing test).'
    if ($ServicesOnly) { return }

    Push-Location $AppDir
    $locationPushed = $true
    Invoke-Wails @('generate', 'bindings')
    Invoke-Wails @('dev')
} catch {
    $launcherFailed = $true
    throw
} finally {
    $env:MINIO_ACCESS_KEY = $previousAccessKey
    $env:MINIO_SECRET_KEY = $previousSecretKey
    if ($locationPushed) { Pop-Location }
    if ($coreStarted -and $ContainerCLI) {
        & $ContainerCLI logs $CoreName *> (Join-Path $Logs 'core.log')
        & $ContainerCLI stop --timeout 10 $CoreName | Out-Null
    }
    if ($locateStarted -and $ContainerCLI) {
        & $ContainerCLI logs $LocateName *> (Join-Path $Logs 'locate.log')
        & $ContainerCLI stop --timeout 10 $LocateName | Out-Null
    }
    foreach ($proc in $forwardProcs) {
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ($minioProc -and -not $minioProc.HasExited) {
        Stop-Process -Id $minioProc.Id -Force -ErrorAction SilentlyContinue
    }
    if ($launcherFailed) {
        Write-Host 'Launcher failed. See the error above.' -ForegroundColor Red
    } elseif ($CheckOnly) {
        # No session or logs were created.
    } else {
        Write-Host "Launcher session ended. Logs: $Logs"
    }
}
