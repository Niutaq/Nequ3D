# Experiments

Reproducible NTC / twin pipeline runs against Reality Scan assets.

## Layout

```text
experiments/
  README.md
  run-ntc-benchmark.ps1
  results/                 # gitignored numeric runs (CSV/JSON)
  fixtures.example.json    # example asset list
```

## Run

1. Start Core + MinIO (`task run-all` or Core already healthy on `:50051`).
2. Place USDZ/USD assets under `data/objects/` (or set paths in a fixtures file).
3. From repo root (PowerShell 7):

```powershell
pwsh -NoProfile -File ./experiments/run-ntc-benchmark.ps1
```

Optional:

```powershell
pwsh -NoProfile -File ./experiments/run-ntc-benchmark.ps1 -Fixtures ./experiments/fixtures.example.json -Bpp 5 -Steps 50
```

Results land in `experiments/results/run-<timestamp>.json` and `.csv`.

## Notes

- Prefer a fixed BPP/steps pair when comparing runs after Wails/Core upgrades.
- Record GPU name and driver in the JSON `environment` block (script auto-fills `nvidia-smi` when available).
- Do not invent README tables — link the newest `results/run-*.json` after a real run.
