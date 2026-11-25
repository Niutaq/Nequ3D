# Thin docker/podman shim for Taskfile and ad-hoc Core commands.
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('build', 'run-core', 'cli')]
  [string]$Action = 'cli',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

$ErrorActionPreference = 'Stop'

function Resolve-ContainerCLI {
    if ($env:NEQU3D_CONTAINER_CLI) {
        $forced = $env:NEQU3D_CONTAINER_CLI.Trim().ToLowerInvariant()
        if ($forced -notin @('docker', 'podman')) {
            throw "NEQU3D_CONTAINER_CLI must be 'docker' or 'podman'."
        }
        return $forced
    }
    if (Get-Command docker -ErrorAction SilentlyContinue) { return 'docker' }
    if (Get-Command podman -ErrorAction SilentlyContinue) { return 'podman' }
    throw "Missing container runtime (docker or podman)."
}

$cli = Resolve-ContainerCLI
$Root = Split-Path -Parent $PSScriptRoot
$hostFromContainer = if ($cli -eq 'podman') { 'host.containers.internal' } else { 'host.docker.internal' }

switch ($Action) {
    'build' {
        & $cli @Rest
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    'run-core' {
        $objects = Join-Path $Root 'data/objects'
        New-Item -ItemType Directory -Force -Path $objects | Out-Null
        $args = @(
            'run', '--rm', '--gpus', 'all',
            '-e', 'MINIO_ACCESS_KEY',
            '-e', 'MINIO_SECRET_KEY',
            '-e', "MINIO_ENDPOINT=http://${hostFromContainer}:9000",
            '-e', "LOCATE_SERVICE_URL=http://${hostFromContainer}:8000",
            '-e', "OTEL_EXPORTER_OTLP_ENDPOINT=http://${hostFromContainer}:4318",
            '--mount', "type=bind,source=$objects,target=/tmp/workspace",
            '-p', '127.0.0.1:50051:50051',
            '-p', '127.0.0.1:8001:8001'
        )
        if ($cli -eq 'podman') {
            $args += @('--add-host', 'host.docker.internal:host-gateway')
        }
        $args += 'nequ3d-core:v4'
        & $cli @args
        exit $LASTEXITCODE
    }
    default {
        & $cli @Rest
        exit $LASTEXITCODE
    }
}
