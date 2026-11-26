#Requires -Version 7
<#
.SYNOPSIS
  Launches the Nequ3D marimo thesis benchmark notebook, automatically bootstrapping
  an isolated `data/marimo-venv` environment on first run if `marimo` is not installed.
#>
[CmdletBinding()]
param(
    [ValidateSet("edit", "run")]
    [string]$Mode = "edit",
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$NotebookPath = Join-Path $Root "experiments/ntc_thesis_notebook.py"
$VenvDir = Join-Path $Root "data/marimo-venv"
$VenvPython = Join-Path $VenvDir "Scripts/python.exe"

function Test-MarimoModule([string]$PyExe) {
    if (-not $PyExe) { return $false }
    try {
        & $PyExe -c "import marimo" *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

$targetPython = $null

# 1. Reuse active python if marimo is already installed
$sysPy = Get-Command python -ErrorAction SilentlyContinue
if ($sysPy -and (Test-MarimoModule $sysPy.Source)) {
    $targetPython = $sysPy.Source
}

# 2. Reuse cached isolated venv under gitignored data/marimo-venv
if (-not $targetPython -and (Test-Path $VenvPython) -and (Test-MarimoModule $VenvPython)) {
    $targetPython = $VenvPython
}

# 3. Auto-bootstrap isolated data/marimo-venv on first run (never pollutes base conda/system Python)
if (-not $targetPython) {
    if (-not $sysPy) {
        throw "Python 3 is required on PATH to run the marimo notebook."
    }
    Write-Host "Bootstrapping isolated marimo environment in $VenvDir (one-time setup)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $VenvDir) | Out-Null
    if (-not (Test-Path $VenvPython)) {
        & $sysPy.Source -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) { throw "Failed to create venv at $VenvDir" }
    }
    & $VenvPython -m pip install --upgrade --quiet pip marimo
    if ($LASTEXITCODE -ne 0) { throw "Failed to install marimo into $VenvDir" }
    $targetPython = $VenvPython
}

if ($CheckOnly) {
    $ver = & $targetPython -m marimo --version
    if ($LASTEXITCODE -ne 0) { throw "marimo version check failed" }
    & $targetPython -c "import runpy, sys; sys.path.insert(0, r'$(Join-Path $Root 'experiments')'); import ntc_thesis_notebook; assert hasattr(ntc_thesis_notebook, 'app'); print('MARIMO_NOTEBOOK_READY:', '$($ver -join '')')"
    if ($LASTEXITCODE -ne 0) { throw "ntc_thesis_notebook.py import check failed" }
    return
}

Write-Host "Opening Nequ3D marimo notebook ($Mode)..." -ForegroundColor Cyan
& $targetPython -m marimo $Mode $NotebookPath
