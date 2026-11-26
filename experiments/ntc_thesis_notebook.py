# /// script
# requires-python = ">=3.10"
# dependencies = ["marimo"]
# ///

import marimo

__generated_with = "0.26.0"
app = marimo.App(width="medium", app_title="Nequ3D — RTX NTC Thesis Benchmark")


@app.cell
def _():
    import glob
    import json
    import os
    from pathlib import Path
    import marimo as mo

    return Path, glob, json, mo


@app.cell
def _(Path, glob, json, mo):
    results_dir = Path(__file__).resolve().parent / "results"
    json_files = sorted(glob.glob(str(results_dir / "run-*.json")), reverse=True)

    runs_rows = []
    gpu_label = "Unknown GPU"
    using_demo_preview = False

    for jf in json_files:
        try:
            doc = json.loads(Path(jf).read_text(encoding="utf-8"))
            gpu_info = (doc.get("environment") or {}).get("gpu") or {}
            if gpu_info.get("name"):
                gpu_label = f"{gpu_info.get('name')} ({gpu_info.get('memory_total_mb', '?')} MB)"
            for r in doc.get("runs") or []:
                summary = r.get("telemetry_summary") or {}
                runs_rows.append(
                    {
                        "run_file": Path(jf).name,
                        "asset": str(r.get("id") or "asset"),
                        "bpp": float(r.get("bpp") or 0),
                        "steps": int(r.get("steps") or 0),
                        "ok": bool(r.get("ok")),
                        "duration_sec": float(r.get("duration_sec") or 0.0),
                        "avg_psnr_db": r.get("avg_psnr_db", summary.get("avg_psnr_db")),
                        "avg_ssim": r.get("avg_ssim", summary.get("avg_ssim")),
                        "vram_saved_mb": r.get("vram_saved_mb"),
                        "vram_reduction_pct": r.get("vram_reduction_pct"),
                        "ntc_ms": r.get(
                            "ntc_ms",
                            (summary.get("stage_timings_ms") or {}).get("ntc_ms"),
                        ),
                    }
                )
        except Exception:
            pass

    if not runs_rows:
        using_demo_preview = True
        gpu_label = "SYNTHETIC PREVIEW (Run `task benchmark-sweep` on your GPU before citing!)"
        for bpp_val, psnr_val, ssim_val, red_val, saved_val, sec_val in [
            (2.0, 31.85, 0.9180, 93.8, 60.03, 19.4),
            (4.0, 35.92, 0.9585, 87.5, 56.00, 22.1),
            (5.0, 37.14, 0.9672, 84.4, 54.02, 23.8),
            (6.0, 38.28, 0.9741, 81.3, 52.03, 25.2),
        ]:
            runs_rows.append(
                {
                    "run_file": "preview-only",
                    "asset": "Demo_RealityScan",
                    "bpp": bpp_val,
                    "steps": 450,
                    "ok": True,
                    "duration_sec": sec_val,
                    "avg_psnr_db": psnr_val,
                    "avg_ssim": ssim_val,
                    "vram_saved_mb": saved_val,
                    "vram_reduction_pct": red_val,
                    "ntc_ms": sec_val * 820.0,
                }
            )

    assets = sorted({r["asset"] for r in runs_rows})
    asset_dropdown = mo.ui.dropdown(
        options=["All"] + assets,
        value="All",
        label="Filter Reality Scan Asset",
    )
    caption_input = mo.ui.text(
        value="Porównanie jakości rekonstrukcji tekstur NVIDIA RTX NTC (PSNR, SSIM) i redukcji pamięci VRAM",
        label="LaTeX Table Caption (PL / EN)",
        full_width=True,
    )
    return (
        asset_dropdown,
        caption_input,
        gpu_label,
        json_files,
        runs_rows,
        using_demo_preview,
    )


@app.cell
def _(
    asset_dropdown,
    caption_input,
    gpu_label,
    json_files,
    mo,
    using_demo_preview,
):
    banner = (
        mo.callout(
            mo.md(
                "**Brak plików `experiments/results/run-*.json`** — wyświetlany jest wyłącznie poglądowy układ tabeli. "
                "Uruchom `task benchmark-sweep`, aby wygenerować rzeczywiste pomiary z karty RTX przed wklejeniem do pracy magisterskiej."
            ),
            kind="warn",
        )
        if using_demo_preview
        else mo.callout(
            mo.md(
                f"Wczytano **{len(json_files)}** plików pomiarowych z `experiments/results/` · GPU: **{gpu_label}**"
            ),
            kind="success",
        )
    )
    mo.vstack(
        [
            mo.md("# Nequ3D — Notatnik Badawczy NVIDIA RTX NTC (`marimo`)"),
            banner,
            mo.hstack([asset_dropdown, caption_input], widths=[1, 2]),
        ]
    )


@app.cell
def _(asset_dropdown, caption_input, mo, runs_rows):
    filtered = [
        r
        for r in runs_rows
        if asset_dropdown.value == "All" or r["asset"] == asset_dropdown.value
    ]
    filtered.sort(key=lambda x: (x["asset"], x["bpp"], x["steps"]))

    def fmt_num(v, digits=2, suffix=""):
        if isinstance(v, (int, float)):
            return f"{v:.{digits}f}{suffix}"
        return "---"

    latex_lines = [
        r"\begin{table}[htbp]",
        r"\centering",
        f"\\caption{{{caption_input.value}}}",
        r"\label{tab:nequ3d-ntc-sweep}",
        r"\begin{tabular}{lcccccc}",
        r"\toprule",
        r"Model USDZ & Docelowe BPP & Kroki & Redukcja VRAM (\%) & Oszczędność (MB) & PSNR (dB) & SSIM \\",
        r"\midrule",
    ]
    for row in filtered:
        safe_asset = str(row["asset"]).replace("_", r"\_")
        latex_lines.append(
            f"{safe_asset} & {row['bpp']:.1f} & {row['steps']} & "
            f"{fmt_num(row['vram_reduction_pct'], 1)} & {fmt_num(row['vram_saved_mb'], 2)} & "
            f"{fmt_num(row['avg_psnr_db'], 2)} & {fmt_num(row['avg_ssim'], 4)} \\\\"
        )
    latex_lines.extend(
        [
            r"\bottomrule",
            r"\end{tabular}",
            r"\end{table}",
        ]
    )
    latex_code = "\n".join(latex_lines)

    # Pure SVG Rate-Distortion Curve (zero matplotlib/altair install required!)
    pts = [
        (float(r["bpp"]), float(r["avg_psnr_db"]))
        for r in filtered
        if isinstance(r.get("avg_psnr_db"), (int, float))
    ]
    svg_html = ""
    if len(pts) >= 2:
        pts.sort(key=lambda p: p[0])
        min_x, max_x = min(p[0] for p in pts), max(p[0] for p in pts)
        min_y, max_y = min(p[1] for p in pts) - 1.0, max(p[1] for p in pts) + 1.0
        span_x = max(0.5, max_x - min_x)
        span_y = max(1.0, max_y - min_y)

        def sx(x):
            return 60 + ((x - min_x) / span_x) * 480

        def sy(y):
            return 190 - ((y - min_y) / span_y) * 150

        poly = " ".join(f"{sx(x):.1f},{sy(y):.1f}" for x, y in pts)
        circles = "".join(
            f'<circle cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="5" fill="#00d2e6" />'
            f'<text x="{sx(x):.1f}" y="{sy(y) - 10:.1f}" text-anchor="middle" fill="#cbd5e1" font-size="11" font-family="monospace">{y:.2f} dB</text>'
            f'<text x="{sx(x):.1f}" y="212" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="monospace">{x:.0f} BPP</text>'
            for x, y in pts
        )
        svg_html = f"""
        <svg viewBox="0 0 600 230" style="width:100%;max-width:680px;background:#0f172a;border-radius:10px;border:1px solid #334155;padding:8px;">
          <line x1="50" y1="190" x2="560" y2="190" stroke="#475569" stroke-width="1" />
          <line x1="50" y1="30" x2="50" y2="190" stroke="#475569" stroke-width="1" />
          <polyline fill="none" stroke="#008ca8" stroke-width="2.5" points="{poly}" />
          {circles}
        </svg>
        """

    mo.vstack(
        [
            mo.md("### Tabela pomiarów"),
            mo.ui.table(filtered),
            mo.md("### Krzywa Rate–Distortion (BPP vs PSNR dB)"),
            mo.Html(svg_html) if svg_html else mo.md("_Za mało punktów PSNR do wykresu._"),
            mo.md("### Gotowa tabela LaTeX (`booktabs`) do pracy magisterskiej"),
            mo.md(f"```latex\n{latex_code}\n```"),
        ]
    )


if __name__ == "__main__":
    app.run()
