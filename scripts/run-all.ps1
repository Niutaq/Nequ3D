# Windows launcher. Run from any directory; task run-all calls this script.
[CmdletBinding()]
param([switch]$BuildCore, [switch]$CheckOnly, [switch]$ServicesOnly)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This launcher requires Windows and PowerShell 7.' }
$Root = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root 'nequ3d-app'
$Logs = Join-Path $Root 'data/logs'
$Objects = Join-Path $Root 'data/objects'
$CoreImage = 'nequ3d-core:v4'
$CoreName = 'nequ3d-core-dev'
$minioProc = $null
$coreStarted = $false
$locationPushed = $false
$launcherFailed = $false
$previousAccessKey = $env:MINIO_ACCESS_KEY
$previousSecretKey = $env:MINIO_SECRET_KEY

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

try {
    foreach ($tool in @('go', 'node', 'npm.cmd', 'wails3', 'docker', 'kubectl')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "Missing command: $tool. See README.md prerequisites."
        }
    }
    Invoke-Checked docker @('info', '--format', '{{.ServerVersion}}')
    $context = & kubectl config current-context
    if ($LASTEXITCODE -ne 0) { throw 'No Kubernetes context selected. Configure kubectl before starting.' }
    $apiCheck = & kubectl get --raw=/readyz --request-timeout=10s 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Kubernetes API is unavailable (context: $context). Start the selected cluster; for docker-desktop, check Docker Desktop Kubernetes and its control-plane container. Verify with: kubectl get --raw=/readyz. Details: $apiCheck"
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
        Write-Host 'Prerequisites available. No services started.'
        return
    }
    foreach ($port in @(9000, 50051, 8001, 9245)) {
        if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
            throw "Port $port is already in use. Stop the previous Nequ3D session before starting."
        }
    }
    $existingCore = & docker ps -aq --filter "name=^/$CoreName$"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect Core containers.' }
    if ($existingCore) { throw "Container $CoreName already exists. Stop the previous session first." }

    New-Item -ItemType Directory -Force -Path $Logs, $Objects | Out-Null
    & docker image inspect $CoreImage *> $null
    if ($BuildCore -or $LASTEXITCODE -ne 0) {
        Write-Host "Building $CoreImage (this can take several minutes)..."
        Invoke-Checked docker @('build', '-t', $CoreImage, (Join-Path $Root 'nequ3d-core'))
    }

    Write-Host 'Starting MinIO port-forward...'
    $minioProc = Start-Process kubectl -ArgumentList @('port-forward', 'svc/minio', '9000:9000', '-n', 'minio') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Logs 'minio-forward.log') -RedirectStandardError (Join-Path $Logs 'minio-forward.log.err') -PassThru
    Wait-Http 'http://127.0.0.1:9000/minio/health/live' 'MinIO'

    Write-Host 'Starting Core with GPU access...'
    Invoke-Checked docker @('run', '-d', '--rm', '--name', $CoreName, '--gpus', 'all', '-e', 'MINIO_ACCESS_KEY', '-e', 'MINIO_SECRET_KEY', '-e', 'MINIO_ENDPOINT=http://host.docker.internal:9000', '--mount', "type=bind,source=$Objects,target=/tmp/workspace", '-p', '127.0.0.1:50051:50051', '-p', '127.0.0.1:8001:8001', $CoreImage)
    $coreStarted = $true
    Wait-Http 'http://127.0.0.1:8001/metrics' 'Core'
    Invoke-Checked docker @('exec', $CoreName, 'python3', '-c', 'import socket; s=socket.create_connection(("127.0.0.1",50051),5); s.close()')
    Invoke-Checked docker @('exec', $CoreName, 'nvidia-smi', '--query-gpu=name', '--format=csv,noheader')
    Write-Host 'MinIO HTTP, Core metrics, gRPC TCP port and GPU checks passed (not a processing test).'
    if ($ServicesOnly) { return }

    Push-Location $AppDir
    $locationPushed = $true
    Invoke-Checked wails3 @('generate', 'bindings')
    Invoke-Checked wails3 @('dev')
} catch {
    $launcherFailed = $true
    throw
} finally {
    $env:MINIO_ACCESS_KEY = $previousAccessKey
    $env:MINIO_SECRET_KEY = $previousSecretKey
    if ($locationPushed) { Pop-Location }
    if ($coreStarted) {
        & docker logs $CoreName *> (Join-Path $Logs 'core.log')
        & docker stop --time 10 $CoreName | Out-Null
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
