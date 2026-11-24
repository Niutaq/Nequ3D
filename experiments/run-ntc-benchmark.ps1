#Requires -Version 7
param(
  [string]$Fixtures = "",
  [string]$Bpp = "5",
  [string]$Steps = "50",
  [string]$CoreAddr = $(if ($env:NEQU3D_CORE_ADDR) { $env:NEQU3D_CORE_ADDR } else { "127.0.0.1:50051" })
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ResultsDir = Join-Path $PSScriptRoot "results"
New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null

$assets = @()
if ($Fixtures -and (Test-Path $Fixtures)) {
  $doc = Get-Content -Raw -Path $Fixtures | ConvertFrom-Json
  foreach ($a in $doc.assets) {
    $p = $a.path
    if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path $Root $p }
    if (Test-Path $p) {
      $assets += [pscustomobject]@{ id = $a.id; path = (Resolve-Path $p).Path; notes = $a.notes }
    } else {
      Write-Warning "Missing fixture asset: $p"
    }
  }
} else {
  $objects = Join-Path $Root "data/objects"
  if (Test-Path $objects) {
    Get-ChildItem -Path $objects -Recurse -Include *.usdz,*.usd,*.usda,*.usdc |
      Select-Object -First 5 |
      ForEach-Object {
        $assets += [pscustomobject]@{ id = $_.BaseName; path = $_.FullName; notes = "auto-discovered" }
      }
  }
}

if (-not $assets.Count) {
  Write-Host "No assets found. Add Reality Scan USDZ files under data/objects or pass -Fixtures."
  exit 2
}

$gpu = @{ available = $false }
try {
  $line = & nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader,nounits 2>$null | Select-Object -First 1
  if ($line) {
    $parts = $line -split ","
    $gpu = @{
      available = $true
      name = $parts[0].Trim()
      driver = $parts[1].Trim()
      memory_total_mb = [double]$parts[2].Trim()
    }
  }
} catch {}

$runs = @()
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Write-Host "Benchmark Core=$CoreAddr bpp=$Bpp steps=$Steps assets=$($assets.Count)"

foreach ($asset in $assets) {
  $started = Get-Date
  $row = [ordered]@{
    id = $asset.id
    path = $asset.path
    bpp = $Bpp
    steps = $Steps
    started_at = $started.ToString("o")
    ok = $false
    duration_sec = $null
    error = $null
    telemetry_summary = $null
  }

  # Prefer invoking Core inside the running container (docker or podman).
  $ctr = $env:NEQU3D_CONTAINER_CLI
  if (-not $ctr) {
    if (Get-Command docker -ErrorAction SilentlyContinue) { $ctr = 'docker' }
    elseif (Get-Command podman -ErrorAction SilentlyContinue) { $ctr = 'podman' }
  }
  $container = $null
  if ($ctr) {
    $container = & $ctr ps --filter "ancestor=nequ3d-core:v4" --format "{{.ID}}" 2>$null | Select-Object -First 1
    if (-not $container) {
      $container = & $ctr ps --filter "name=nequ3d" --format "{{.ID}}" 2>$null | Select-Object -First 1
    }
  }

  try {
    if ($container) {
      $leaf = [System.IO.Path]::GetFileName($asset.path)
      $dest = "/tmp/workspace/bench-$stamp-$leaf"
      & $ctr cp $asset.path "${container}:$dest" | Out-Null
      $out = & $ctr exec $container python -u process_usd_file.py $dest $Bpp $Steps 2>&1
      $telemetryLine = ($out | Select-String -Pattern "^Telemetry: " | Select-Object -Last 1).Line
      if ($telemetryLine) {
        $json = $telemetryLine.Substring("Telemetry: ".Length)
        $tel = $json | ConvertFrom-Json
        $row.ok = $true
        $row.telemetry_summary = [ordered]@{
          mesh_count = $tel.mesh_count
          texture_count = $tel.texture_count
          ntc_bypassed = $tel.ntc_bypassed
          has_ntc_quality = $tel.has_ntc_quality
          zone_count = @($tel.zones).Count
          twin_dir = $tel.twin_dir
          omniverse_export_dir = $tel.omniverse_export_dir
        }
      } else {
        $row.error = "No Telemetry line from Core"
        $row.telemetry_summary = @{ log_tail = ($out | Select-Object -Last 20) -join "`n" }
      }
    } else {
      $row.error = "No running nequ3d-core container (docker/podman); start task run-all first"
    }
  } catch {
    $row.error = $_.Exception.Message
  }

  $row.duration_sec = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
  $runs += [pscustomobject]$row
  Write-Host ("[{0}] ok={1} {2}s {3}" -f $asset.id, $row.ok, $row.duration_sec, $row.error)
}

$payload = [ordered]@{
  schema_version = 1
  created_at = (Get-Date).ToUniversalTime().ToString("o")
  environment = @{
    core_addr = $CoreAddr
    gpu = $gpu
    wails = "v3.1.0"
    host = $env:COMPUTERNAME
  }
  parameters = @{ bpp = $Bpp; steps = $Steps }
  runs = $runs
}

$jsonPath = Join-Path $ResultsDir "run-$stamp.json"
$csvPath = Join-Path $ResultsDir "run-$stamp.csv"
($payload | ConvertTo-Json -Depth 8) | Set-Content -Path $jsonPath -Encoding utf8
$runs | Select-Object id, path, bpp, steps, ok, duration_sec, error | Export-Csv -Path $csvPath -NoTypeInformation
Write-Host "Wrote $jsonPath"
Write-Host "Wrote $csvPath"
