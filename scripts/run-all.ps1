# One-command launcher for local development.
# Starts MinIO port-forward and the gRPC core as DETACHED background
# processes, then runs the Wails app in the foreground. Stopping the app
# also stops the background services.
#
# Usage (from the repo root):
#   pwsh -File ./scripts/run-all.ps1
# or simply:
#   task run-all

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root "nequ3d-app"
$CoreDir = Join-Path $Root "nequ3d-core"

$Logs = Join-Path $Root "data" "logs"
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$minioLog = Join-Path $Logs "minio-forward.log"
$coreLog  = Join-Path $Logs "core.log"

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Start-Background {
    param(
        [string]$File,
        [string]$ArgumentList,
        [string]$WorkDir,
        [string]$LogPath
    )
    $stdErr = "$LogPath.err"
    $proc = Start-Process -FilePath $File `
        -ArgumentList $ArgumentList `
        -WorkingDirectory $WorkDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LogPath `
        -RedirectStandardError $stdErr `
        -PassThru
    Write-Host "    started PID $($proc.Id): $File $ArgumentList  (log: $LogPath)"
    return $proc
}

# --- MinIO forward ---
Write-Step "Forwarding MinIO to 127.0.0.1:9000 (background)"
$minioProc = Start-Background -File "kubectl" `
    -ArgumentList "port-forward","svc/minio","9000:9000","-n","minio" `
    -WorkDir $Root -LogPath $minioLog

# --- Core gRPC server ---
Write-Step "Starting gRPC core on 50051 (background)"
New-Item -ItemType Directory -Force -Path (Join-Path $Root "data" "objects") | Out-Null
Write-Host "Cleaning up any old core container..."
docker rm -f nequ3d-core-dev 2>$null

$dockerArgs = @(
    "run","--rm",
    "--name","nequ3d-core-dev",
    "--gpus","all",
    "-e","MINIO_ENDPOINT=http://host.docker.internal:9000",
    # Share the host "data/objects" dir as the container "/tmp/workspace" so
    # proxy GLBs written by the core are visible to the Windows frontend.
    "-v","`"$Root\data\objects:/tmp/workspace`"",
    "-p","50051:50051","-p","8001:8001",
    "nequ3d-core:v4"
)
$coreProc = Start-Background -File "docker" `
    -ArgumentList ($dockerArgs -join " ") `
    -WorkDir $CoreDir -LogPath $coreLog

# Give the services a moment to boot and check their logs for obvious issues.
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "[minio-forward.log]" -ForegroundColor Yellow
if (Test-Path $minioLog) { Get-Content $minioLog -Tail 5 -ErrorAction SilentlyContinue }
if (Test-Path "$minioLog.err") { Get-Content "$minioLog.err" -Tail 5 -ErrorAction SilentlyContinue }
Write-Host "[core.log]" -ForegroundColor Yellow
if (Test-Path $coreLog) { Get-Content $coreLog -Tail 20 -ErrorAction SilentlyContinue }
if (Test-Path "$coreLog.err") { Get-Content "$coreLog.err" -Tail 20 -ErrorAction SilentlyContinue }

# --- Wails app (foreground) ---
Write-Step "Starting Wails app (dev-app)..."
try {
    Push-Location $AppDir
    & wails3 generate bindings
    & wails3 dev
} finally {
    Pop-Location
}

# --- Cleanup background services ---
Write-Step "Stopping background services..."
foreach ($proc in @($minioProc, $coreProc)) {
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Write-Host "    stopped PID $($proc.Id)"
    }
}

Write-Host ""
Write-Host "Done. Background logs:" -ForegroundColor Green
Write-Host "  $minioLog / $minioLog.err"
Write-Host "  $coreLog / $coreLog.err"
