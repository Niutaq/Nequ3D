#Requires -Version 7
param(
  [string]$Fixtures = "",
  [string]$Bpp = "5",
  [string]$Steps = "50",
  [string]$BppList = "",
  [string]$StepsList = "",
  [string]$CoreAddr = $(if ($env:NEQU3D_CORE_ADDR) { $env:NEQU3D_CORE_ADDR } else { "127.0.0.1:50051" })
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ResultsDir = Join-Path $PSScriptRoot "results"
New-Item -ItemType Directory -Force -Path $ResultsDir | Out-Null

$bpps = if ($BppList) { $BppList -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @($Bpp) }
$stepsArr = if ($StepsList) { $StepsList -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @($Steps) }

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
      Where-Object { $_.FullName -notmatch "_unpacked" -and $_.Name -notin @("annotations.usda", "building_twin.usda") } |
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
Write-Host "Benchmark Core=$CoreAddr bpps=$($bpps -join ',') steps=$($stepsArr -join ',') assets=$($assets.Count)"

foreach ($asset in $assets) {
  foreach ($curBpp in $bpps) {
    foreach ($curSteps in $stepsArr) {
      $started = Get-Date
      $row = [ordered]@{
        id = $asset.id
        path = $asset.path
        bpp = [double]$curBpp
        steps = [int]$curSteps
        started_at = $started.ToString("o")
        ok = $false
        duration_sec = $null
        avg_psnr_db = $null
        avg_ssim = $null
        vram_saved_mb = $null
        vram_reduction_pct = $null
        ntc_ms = $null
        error = $null
        telemetry_summary = $null
      }

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
          $dest = "/tmp/workspace/bench-$stamp-$($curBpp)bpp-$($curSteps)st-$leaf"
          & $ctr cp $asset.path "${container}:$dest" | Out-Null
          $out = & $ctr exec $container python3 -u process_usd_file.py $dest $curBpp $curSteps 2>&1
          $telemetryLine = ($out | Select-String -Pattern "^Telemetry: " | Select-Object -Last 1).Line
          if ($telemetryLine) {
            $json = $telemetryLine.Substring("Telemetry: ".Length)
            $tel = $json | ConvertFrom-Json
            $row.ok = $true
            $row.avg_psnr_db = $tel.avg_psnr_db
            $row.avg_ssim = $tel.avg_ssim
            if ($tel.stage_timings_ms) {
              $row.ntc_ms = $tel.stage_timings_ms.ntc_ms
            }
            $savedTotal = 0.0
            $redVals = @()
            foreach ($nf in @($tel.ntc_compressed_files)) {
              if ($null -ne $nf.vram_saved_mb) { $savedTotal += [double]$nf.vram_saved_mb }
              if ($nf.vram_reduction) {
                $cleanRed = ($nf.vram_reduction -replace "%", "").Trim()
                $parsedRed = 0.0
                if ([double]::TryParse($cleanRed, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsedRed)) {
                  $redVals += $parsedRed
                }
              }
            }
            if ($savedTotal -gt 0) { $row.vram_saved_mb = [math]::Round($savedTotal, 2) }
            if ($redVals.Count -gt 0) {
              $row.vram_reduction_pct = [math]::Round((($redVals | Measure-Object -Average).Average), 2)
            }
            $row.telemetry_summary = [ordered]@{
              total_vertices = $tel.total_vertices
              total_faces = $tel.total_faces
              mesh_count = $tel.mesh_count
              texture_count = $tel.texture_count
              ntc_bypassed = $tel.ntc_bypassed
              has_ntc_quality = $tel.has_ntc_quality
              avg_psnr_db = $tel.avg_psnr_db
              avg_ssim = $tel.avg_ssim
              stage_timings_ms = $tel.stage_timings_ms
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
      Write-Host ("[{0} @ {1}bpp/{2}steps] ok={3} {4}s PSNR={5} SSIM={6} {7}" -f $asset.id, $curBpp, $curSteps, $row.ok, $row.duration_sec, $row.avg_psnr_db, $row.avg_ssim, $row.error)
    }
  }
}

$payload = [ordered]@{
  schema_version = 2
  created_at = (Get-Date).ToUniversalTime().ToString("o")
  environment = @{
    core_addr = $CoreAddr
    gpu = $gpu
    wails = "v3.1.0"
    host = $env:COMPUTERNAME
  }
  parameters = @{ bpps = $bpps; steps = $stepsArr }
  runs = $runs
}

$jsonPath = Join-Path $ResultsDir "run-$stamp.json"
$csvPath = Join-Path $ResultsDir "run-$stamp.csv"
($payload | ConvertTo-Json -Depth 10) | Set-Content -Path $jsonPath -Encoding utf8
$runs | Select-Object id, path, bpp, steps, ok, duration_sec, avg_psnr_db, avg_ssim, vram_saved_mb, vram_reduction_pct, ntc_ms, error | Export-Csv -Path $csvPath -NoTypeInformation
Write-Host "Wrote $jsonPath"
Write-Host "Wrote $csvPath"
