#Requires -Version 7
<#
.SYNOPSIS
  Packages and optionally pushes an exported Nequ3D OpenUSD Digital Twin + in-toto DSSE
  provenance bundle to an OCI registry using CNCF ORAS (`oras push` + `oras attach`).
.EXAMPLE
  pwsh -NoProfile -File ./scripts/push-oras-twin.ps1 -TwinDir ./data/objects/exports/omniverse/Flat -DryRun
  pwsh -NoProfile -File ./scripts/push-oras-twin.ps1 -TwinDir ./data/objects/exports/omniverse/Flat -Reference ghcr.io/niutaq/nequ3d-twins:flat-v1
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TwinDir,

    [string]$Reference = "localhost:5000/nequ3d/building-twin:latest",

    [switch]$DryRun,
    [switch]$PlainHttp
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $TwinDir -PathType Container)) {
    throw "Twin export directory does not exist: $TwinDir"
}

$resolvedDir = (Resolve-Path $TwinDir).Path
$manifestPath = Join-Path $resolvedDir "oras_artifact_manifest.json"
$intotoPath = Join-Path $resolvedDir "provenance.intoto.jsonl"

if (-not (Test-Path $intotoPath)) {
    throw "Missing in-toto provenance bundle ($intotoPath). Run Nequ3D analysis or VerifyTwinProvenance first."
}

function Get-MediaType([string]$Name) {
    $ext = [System.IO.Path]::GetExtension($Name).ToLowerInvariant()
    switch ($ext) {
        ".usda"  { return "model/vnd.usd+usda" }
        ".usd"   { return "model/vnd.usd" }
        ".usdc"  { return "model/vnd.usd" }
        ".usdz"  { return "model/vnd.usdz+zip" }
        ".glb"   { return "model/gltf-binary" }
        ".ntc"   { return "application/vnd.nvidia.rtxntc" }
        ".splat" { return "application/vnd.nequ3d.gsplat" }
        ".json"  { return "application/json" }
        default  { return "application/octet-stream" }
    }
}

$layerArgs = @()
Get-ChildItem -Path $resolvedDir -File | Where-Object {
    $_.Name -notin @("provenance.intoto.jsonl", "oras_artifact_manifest.json") -and -not $_.Name.EndsWith(".sha256.json")
} | Sort-Object Name | ForEach-Object {
    $mt = Get-MediaType $_.Name
    $layerArgs += "$($_.Name):$mt"
}

Write-Host "=== Nequ3D ORAS / OCI Twin Pack ===" -ForegroundColor Cyan
Write-Host "  Directory    : $resolvedDir"
Write-Host "  Target OCI   : $Reference"
Write-Host "  ArtifactType : application/vnd.nequ3d.twin.v1+json"
Write-Host "  Attestation  : provenance.intoto.jsonl (application/vnd.in-toto+json)"
Write-Host "  Layers ($($layerArgs.Count)) :"
foreach ($l in $layerArgs) {
    Write-Host "    - $l"
}

if (Test-Path $manifestPath) {
    $doc = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
    Write-Host "  OCI Manifest : schemaVersion=$($doc.schemaVersion), recordedLayers=$($doc.layers.Count)" -ForegroundColor Green
}

if ($DryRun) {
    Write-Host "[DryRun] Validation passed. Omit -DryRun (with 'oras' CLI installed) to push to $Reference." -ForegroundColor Yellow
    return
}

$orasCmd = Get-Command oras -ErrorAction SilentlyContinue
if (-not $orasCmd) {
    throw "CNCF 'oras' CLI is not installed on PATH. Install with 'winget install OrasProject.Oras' or run with -DryRun."
}

Push-Location $resolvedDir
try {
    $pushCmdArgs = @(
        "push", $Reference,
        "--artifact-type", "application/vnd.nequ3d.twin.v1+json"
    )
    if ($PlainHttp) { $pushCmdArgs += "--plain-http" }
    $pushCmdArgs += $layerArgs

    Write-Host "Pushing OpenUSD Twin artifact via ORAS..." -ForegroundColor Cyan
    & oras @pushCmdArgs
    if ($LASTEXITCODE -ne 0) { throw "oras push failed with exit code $LASTEXITCODE" }

    $attachArgs = @(
        "attach", $Reference,
        "--artifact-type", "application/vnd.in-toto+json",
        "provenance.intoto.jsonl:application/vnd.in-toto+json"
    )
    if ($PlainHttp) { $attachArgs += "--plain-http" }

    Write-Host "Attaching SLSA v1 / in-toto DSSE provenancereferrer via ORAS..." -ForegroundColor Cyan
    & oras @attachArgs
    if ($LASTEXITCODE -ne 0) { throw "oras attach failed with exit code $LASTEXITCODE" }

    Write-Host "Successfully pushed twin + attached in-toto provenance to $Reference" -ForegroundColor Green
} finally {
    Pop-Location
}
