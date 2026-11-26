// frontend/src/main.ts
// Global base styles are loaded via /style.css in index.html
import {
  EvaluateAdviceFaithfulness,
  GenerateRenovationAdvice,
  GetTwinEvents,
  ProcessModel,
  SelectFile,
  DownloadFromSketchfab,
  LocateObjects,
  SaveTwinAnnotations,
  RunRenovationAgent,
  VerifyTwinProvenance,
} from "../bindings/changeme/app";
import "@google/model-viewer";
import { $renderer } from "@google/model-viewer/lib/model-viewer-base.js";
import { Events } from "@wailsio/runtime";
import { IntLayer, type Language } from "./i18n";
import { Chart, registerables } from "chart.js";
import {
  addPinNote,
  applySectionPlane,
  bindViewerTools,
  clearMeasurements,
  clearPinNotes,
  focusMeasurement,
  formatDistance,
  getMeasurements,
  getPinNotes,
  getSectionAxis,
  getSectionT,
  getToolMode,
  isSectionEnabled,
  loadPinNotes,
  readModelExtents,
  reattachPinHotspots,
  removeMeasurement,
  removePinNote,
  setMeasureCompleteListener,
  setMeasurementsListener,
  setPendingListener,
  setPinSurfaceClickListener,
  setPinsListener,
  setSectionAxis,
  setSectionEnabled,
  setSectionT,
  setToolMode,
  setUnitScale,
  type MeasurePoint,
  type Measurement,
  type PinNote,
  type SectionAxis,
  type ToolMode,
} from "./viewer-tools";
import {
  convertViewerMeshToSplatBuffer,
  mountSplatViewer,
  resetSplatCamera,
  setSplatTopView,
  unmountSplatViewer,
  type ConvertedSplat,
  type SplatSource,
} from "./splat-viewer";
Chart.register(...registerables);

type ViewerMode = "mesh" | "quality" | "splat" | "hybrid";
type BuildingZone = {
  id?: string;
  label?: string;
  status?: string;
  prim_count?: number;
  bbox?: { min?: number[]; max?: number[] };
};
type ModelChoice = "gemma:2b" | "llama3" | "mistral" | "llava";
type TextScale = "sm" | "md" | "lg";

type SysStats = {
  time: string;
  gpu: number;
  vram: number;
  available?: boolean;
  message?: string;
};

type NtcAsset = {
  original?: string;
  original_path?: string;
  reconstructed_path?: string;
  status?: string;
  error?: string;
  metrics?: string;
};

type PipelineTelemetry = {
  status?: string;
  message?: string;
  details?: string;
  file_path?: string;
  proxy_glb_path?: string;
  ntc_bypassed?: boolean;
  ntc_bypass_reason?: string;
  has_ntc_quality?: boolean;
  ntc_compressed_files?: NtcAsset[];
  [key: string]: unknown;
};

// Fallback used only until the backend publishes the dynamically-assigned
// local-file server URL via the "localServerUrl" event.
let LOCAL_FILE_ENDPOINT = "http://localhost:9387/api/local-file?path=";
const MIN_LEFT_PANEL = 320;
const MIN_RIGHT_PANEL = 340;
const MIN_CENTER_PANEL = 420;
const TEXT_SCALE_OPTIONS: Record<TextScale, string> = {
  sm: "16px",
  md: "18px",
  lg: "20px",
};

const style = document.createElement("style");
style.textContent = `
  :root {
    --base-font-size: 18px;
    --bg-base: #0b0f17;
    --bg-panel: #111827;
    --bg-surface: #1e293b;
    --bg-surface-hover: #263349;
    --bg-darker: #090d14;
    --border-color: rgba(148, 163, 184, 0.22);
    --border-strong: rgba(148, 163, 184, 0.36);
    --accent-teal: #00d2e6;
    --accent-solid: #008ca8;
    --accent-solid-hover: #00728a;
    --accent-contrast: #ffffff;
    --accent-teal-dim: rgba(0, 210, 230, 0.16);
    --accent-warm: #f59e0b;
    --text-main: #f8fafc;
    --text-muted: #94a3b8;
    --font-sans: 'Sora', system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', ui-monospace, monospace;
    --left-panel-width: 370px;
    --right-panel-width: 380px;
    --radius: 10px;
    --glass: rgba(15, 23, 42, 0.85);
  }

  body[data-theme="light"] {
    --bg-base: #dfe6ee;
    --bg-panel: #f1f5f9;
    --bg-surface: #ffffff;
    --bg-surface-hover: #e2e8f0;
    --bg-darker: #ffffff;
    --border-color: #cbd5e1;
    --border-strong: #94a3b8;
    --accent-teal: #007c96;
    --accent-solid: #008ca8;
    --accent-solid-hover: #00728a;
    --accent-contrast: #ffffff;
    --accent-teal-dim: rgba(0, 140, 168, 0.14);
    --text-main: #0f172a;
    --text-muted: #475569;
    --glass: rgba(255, 255, 255, 0.92);
  }

  * { box-sizing: border-box; }

  html {
    font-size: var(--base-font-size, 18px);
    transition: font-size 0.18s ease;
  }

  body {
    margin: 0;
    background: var(--bg-base);
    color: var(--text-main);
    font-family: var(--font-sans);
    overflow: hidden;
    height: 100vh;
    user-select: none;
  }

  .workspace {
    display: grid;
    grid-template-columns: var(--left-panel-width) 1fr var(--right-panel-width);
    grid-template-rows: 68px 1fr;
    grid-template-areas:
      "topbar topbar topbar"
      "leftpanel viewport rightpanel";
    height: 100vh;
    width: 100vw;
    background: var(--bg-base);
    transition: grid-template-columns 0.28s cubic-bezier(0.22, 1, 0.36, 1), filter 0.85s cubic-bezier(0.16, 1, 0.3, 1), transform 0.85s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .workspace.left-collapsed {
    grid-template-columns: 0px 1fr var(--right-panel-width);
  }
  .workspace.right-collapsed {
    grid-template-columns: var(--left-panel-width) 1fr 0px;
  }
  .workspace.left-collapsed.right-collapsed {
    grid-template-columns: 0px 1fr 0px;
  }
  .workspace.left-collapsed .leftpanel,
  .workspace.right-collapsed .rightpanel {
    opacity: 0;
    filter: blur(4px);
    padding-left: 0;
    padding-right: 0;
    border-width: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .workspace.left-collapsed [data-gutter="left"],
  .workspace.right-collapsed [data-gutter="right"] {
    display: none;
  }

  .panel-collapse-btn {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 34;
    width: 22px;
    height: 58px;
    display: grid;
    place-items: center;
    background: var(--glass);
    backdrop-filter: blur(10px);
    border: 1px solid var(--border-color);
    color: var(--text-muted);
    cursor: pointer;
    padding: 0;
    transition: background 0.16s, border-color 0.16s, color 0.16s, width 0.16s;
  }
  .panel-collapse-btn:hover {
    background: var(--bg-surface-hover);
    border-color: var(--accent-teal);
    color: var(--accent-teal);
    width: 26px;
  }
  .panel-collapse-btn.left {
    left: 0;
    border-left: none;
    border-radius: 0 10px 10px 0;
  }
  .panel-collapse-btn.right {
    right: 0;
    border-right: none;
    border-radius: 10px 0 0 10px;
  }
  .panel-collapse-btn svg {
    transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .workspace.left-collapsed .panel-collapse-btn.left svg,
  .workspace.right-collapsed .panel-collapse-btn.right svg {
    transform: rotate(180deg);
  }

  .topbar {
    grid-area: topbar;
    background: var(--bg-darker);
    border-bottom: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 22px 0 24px;
    z-index: 100;
    gap: 24px;
  }

  .brand-block {
    display: flex;
    align-items: center;
    min-width: 120px;
  }
  .brand-mark {
    font-family: var(--font-sans);
    font-weight: 700;
    font-size: 1.4rem;
    letter-spacing: -0.04em;
    line-height: 1;
  }
  .brand-mark span { color: var(--accent-teal); }

  .leftpanel {
    grid-area: leftpanel;
    background: var(--bg-panel);
    border-right: 1px solid var(--border-color);
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
    min-width: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
    transition: opacity 0.22s ease, filter 0.22s ease;
  }

  .viewport {
    grid-area: viewport;
    background:
      radial-gradient(circle at 50% 40%, #141a20 0%, #050607 70%);
    position: relative;
    overflow: hidden;
  }

  .rightpanel {
    grid-area: rightpanel;
    background: var(--bg-panel);
    border-left: 1px solid var(--border-color);
    padding: 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
    min-width: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
    transition: opacity 0.22s ease, filter 0.22s ease;
  }

  .telemetry-group {
    display: flex;
    gap: 28px;
    align-items: center;
    justify-content: flex-start;
    margin-left: 16px;
    margin-right: auto;
  }
  .telemetry-item { display: flex; flex-direction: column; gap: 4px; min-width: 92px; }
  .telemetry-label { font-family: var(--font-mono); font-size: 0.74rem; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .telemetry-value { font-family: var(--font-mono); font-size: 1.05rem; font-weight: 700; color: var(--accent-teal); font-variant-numeric: tabular-nums; white-space: nowrap; }

  .sys-bar-bg { width: 88px; height: 4px; background: var(--border-color); margin-top: 2px; border-radius: 99px; overflow: hidden; }
  .sys-bar-fill { width: 100%; height: 100%; background: var(--accent-solid); transform-origin: left center; transform: scaleX(0); transition: transform 0.3s ease; will-change: transform; }

  .technical-button {
    background: var(--bg-surface);
    border: 1px solid var(--border-strong);
    color: var(--text-main);
    padding: 13px 18px;
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 0.84rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    transition: border-color 0.2s, background 0.2s, color 0.2s, transform 0.15s;
    border-radius: var(--radius);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
  }
  .technical-button:active:not(:disabled) { transform: translateY(1px); }
  .technical-button:hover:not(:disabled) { border-color: var(--accent-teal); background: var(--bg-surface-hover); color: var(--accent-teal); }
  .technical-button:disabled { opacity: 0.55; cursor: not-allowed; background: var(--bg-surface); border-color: var(--border-color); color: var(--text-muted); box-shadow: none; }
  .technical-button.primary { background: var(--accent-solid); border-color: var(--accent-solid); color: var(--accent-contrast); font-weight: 700; }
  .technical-button.primary:hover:not(:disabled) { background: var(--accent-solid-hover); border-color: var(--accent-solid-hover); color: var(--accent-contrast); }

  .panel-section {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    padding: 16px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
  }
  .section-label { font-family: var(--font-mono); font-size: 0.78rem; font-weight: 700; color: var(--text-main); text-transform: uppercase; letter-spacing: 0.05em; border-left: 3px solid var(--accent-teal); padding-left: 10px; }

  .technical-select { background: var(--bg-panel); border: 1px solid var(--border-strong); color: var(--text-main); padding: 11px 14px; font-family: var(--font-mono); font-size: 0.86rem; width: 100%; outline: none; border-radius: 8px; }
  .technical-select:focus { border-color: var(--accent-teal); }

  input[type="range"]:not(.comp-slider) { -webkit-appearance: none; width: 100%; background: transparent; }
  input[type="range"]:not(.comp-slider)::-webkit-slider-runnable-track { width: 100%; height: 4px; background: var(--border-strong); border-radius: 99px; }
  input[type="range"]:not(.comp-slider)::-webkit-slider-thumb { -webkit-appearance: none; height: 16px; width: 16px; background: var(--accent-solid); margin-top: -6px; cursor: pointer; border-radius: 50%; box-shadow: 0 0 0 3px var(--accent-teal-dim); }

  .viewer-chrome {
    position: absolute; top: 14px; left: 14px; right: 14px;
    display: flex; align-items: center; gap: 10px; z-index: 20; pointer-events: none;
  }
  .viewer-chrome > * { pointer-events: auto; }
  .viewer-tabs {
    display: flex; align-items: center; gap: 3px;
    background: var(--glass); backdrop-filter: blur(14px);
    border: 1px solid var(--border-color); border-radius: 999px; padding: 5px;
  }
  .view-tab {
    background: transparent; border: none; color: var(--text-muted);
    padding: 9px 16px; font-family: var(--font-sans); font-size: 0.8rem;
    font-weight: 600; letter-spacing: 0.02em; cursor: pointer;
    transition: color 0.2s, background 0.2s; border-radius: 999px;
  }
  .view-tab.active { color: var(--accent-contrast); background: var(--accent-solid); font-weight: 700; }
  .view-tab:hover:not(.active) { color: var(--text-main); background: var(--bg-surface-hover); }

  .viewer-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
  .comparison-wrapper { display: block; overflow: hidden; position: absolute; inset: 0; background: #000; }
  .comparison-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
  .comp-img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .img-after { position: absolute; inset: 0; z-index: 2; }
  .comp-slider { display: none; }
  .comp-divider { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--accent-teal); pointer-events: auto; cursor: ew-resize; z-index: 10; box-shadow: 0 0 18px rgba(20,184,166,0.45); display: flex; align-items: center; justify-content: center; }
  .comp-divider::after { content: ""; background: var(--bg-panel); border: 2px solid var(--accent-teal); border-radius: 50%; width: 22px; height: 22px; }

  .viewer-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-family: var(--font-sans); letter-spacing: 0.04em; gap: 16px; font-size: 0.95rem; text-align: center; padding: 0 24px; }

  .viewport-toolbar {
    position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%);
    display: flex; align-items: center; gap: 3px; flex-wrap: nowrap;
    background: var(--glass); backdrop-filter: blur(16px);
    border: 1px solid var(--border-color); border-radius: 999px; padding: 5px 6px;
    z-index: 30; box-shadow: 0 12px 40px rgba(0,0,0,0.35);
    max-width: calc(100% - 32px);
  }
  .tool-btn {
    border: none; background: transparent; color: var(--text-muted);
    font-family: var(--font-sans); font-size: 0.8rem; font-weight: 600;
    letter-spacing: 0.02em; padding: 9px 14px; border-radius: 999px; cursor: pointer;
    white-space: nowrap; flex-shrink: 0;
    transition: background 0.2s, color 0.2s;
  }
  .tool-btn:hover:not(.active) { color: var(--text-main); background: var(--bg-surface-hover); }
  .tool-btn.active { color: var(--accent-contrast); background: var(--accent-solid); font-weight: 700; }
  .tool-sep { width: 1px; height: 22px; background: var(--border-color); margin: 0 4px; }

  .dims-badge {
    margin-left: auto;
    background: var(--glass); backdrop-filter: blur(14px);
    border: 1px solid var(--border-color); border-radius: 999px;
    padding: 8px 14px; font-family: var(--font-mono); font-size: 0.8rem;
    color: var(--accent-teal); font-weight: 600; letter-spacing: 0.02em; white-space: nowrap;
  }

  .fps-pill {
    background: var(--glass); backdrop-filter: blur(14px);
    border: 1px solid var(--border-color); border-radius: 999px;
    padding: 8px 14px; font-family: var(--font-mono); font-size: 0.8rem;
    color: var(--accent-teal); font-weight: 700;
    min-width: 78px; text-align: center; font-variant-numeric: tabular-nums;
  }

  .section-rail {
    position: absolute; right: 34px; top: 50%; transform: translateY(-50%);
    width: 44px; height: min(42vh, 280px);
    display: none; flex-direction: column; align-items: center; gap: 10px;
    background: var(--glass); backdrop-filter: blur(14px);
    border: 1px solid var(--border-color); border-radius: 999px; padding: 14px 0;
    z-index: 25;
  }
  .section-rail.visible { display: flex; }
  .section-rail input[type="range"] {
    writing-mode: vertical-lr; direction: rtl;
    width: 18px; height: 100%; flex: 1;
  }
  .section-axis-row { display: flex; gap: 8px; }
  .axis-chip {
    flex: 1; border: 1px solid var(--border-strong); background: var(--bg-panel);
    color: var(--text-main); border-radius: 8px; padding: 9px 0;
    font-family: var(--font-mono); font-size: 0.84rem; font-weight: 600; cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .axis-chip:hover:not(.active) { background: var(--bg-surface-hover); border-color: var(--accent-teal); }
  .axis-chip.active { border-color: var(--accent-solid); background: var(--accent-solid); color: var(--accent-contrast); }

  .measure-hotspot {
    display: grid; place-items: center; width: 22px; height: 22px;
    border-radius: 50%; border: 2px solid var(--accent-teal);
    background: rgba(7, 9, 11, 0.85); color: var(--accent-teal);
    font-family: var(--font-mono); font-size: 0.7rem; font-weight: 700;
    transform: translate(-50%, -50%); cursor: default; pointer-events: none;
    box-shadow: 0 0 0 4px var(--accent-teal-dim);
  }

  .pin-hotspot {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 9px 3px 4px; border-radius: 999px;
    border: 1px solid rgba(245, 158, 11, 0.72);
    background: rgba(11, 15, 23, 0.88); color: #f8fafc;
    font-family: var(--font-sans); font-size: 0.72rem; font-weight: 600;
    transform: translate(-12px, -50%); cursor: default; pointer-events: none;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.42), 0 0 0 3px rgba(245, 158, 11, 0.16);
    max-width: 210px;
  }
  .pin-hotspot .pin-badge {
    background: var(--accent-warm); color: #0b0f17;
    border-radius: 999px; padding: 1px 6px; font-family: var(--font-mono);
    font-size: 0.66rem; font-weight: 800; flex-shrink: 0;
  }
  .pin-hotspot .pin-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .pin-popover {
    position: absolute;
    left: 50%;
    bottom: 78px;
    transform: translateX(-50%);
    z-index: 36;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 12px;
    background: var(--glass);
    backdrop-filter: blur(14px);
    border: 1px solid var(--accent-teal);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.36);
    min-width: 310px;
    animation: blurReveal 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .pin-popover[hidden] { display: none; }
  .pin-popover input {
    flex: 1;
    min-width: 170px;
    background: var(--bg-surface);
    color: var(--text-main);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    padding: 7px 10px;
    font-family: var(--font-sans);
    font-size: 0.8rem;
    outline: none;
  }
  .pin-popover input:focus { border-color: var(--accent-teal); }
  #pin-list {
    max-height: 120px;
    overflow-y: auto;
    padding-right: 4px;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .quality-metrics-row {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px solid var(--border-color);
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    font-family: var(--font-mono);
  }
  .quality-pill {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 8px 10px;
    text-align: center;
  }
  .quality-pill .q-lbl {
    display: block;
    font-size: 0.65rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 3px;
  }
  .quality-pill .q-val {
    font-size: 0.98rem;
    font-weight: 800;
    color: var(--accent-teal);
  }

  .simready-card {
    margin-top: 12px;
    background: var(--bg-panel);
    border: 1px solid var(--border-color);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .simready-card summary {
    list-style: none;
    cursor: pointer;
    padding: 11px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 0.74rem;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-main);
  }
  .simready-card summary::-webkit-details-marker { display: none; }
  .simready-badge {
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 700;
  }
  .simready-badge.ok {
    background: var(--accent-teal-dim);
    color: var(--accent-teal);
    border: 1px solid rgba(0, 210, 230, 0.35);
  }
  .simready-badge.warn {
    background: rgba(245, 158, 11, 0.14);
    color: var(--accent-warm);
    border: 1px solid rgba(245, 158, 11, 0.35);
  }
  .simready-checks {
    padding: 8px 12px 12px;
    border-top: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .simready-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--font-sans);
    font-size: 0.76rem;
    color: var(--text-muted);
    line-height: 1.35;
  }
  .simready-row .sr-icon {
    font-family: var(--font-mono);
    font-weight: 800;
    width: 14px;
    flex-shrink: 0;
  }
  .simready-row.ok .sr-icon { color: var(--accent-teal); }
  .simready-row.warn .sr-icon { color: var(--accent-warm); }
  .simready-row.info .sr-icon { color: var(--text-muted); }
  .simready-row.error .sr-icon { color: #ef4444; }

  .otel-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 8px;
  }
  .otel-trace-id {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    color: var(--accent-teal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .otel-stage-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 6px;
  }
  .otel-stage-head {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 0.68rem;
    color: var(--text-muted);
  }
  .otel-stage-head strong { color: var(--text-main); }
  .otel-bar-track {
    width: 100%;
    height: 5px;
    border-radius: 999px;
    background: var(--border-color);
    overflow: hidden;
  }
  .otel-bar-fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--accent-solid), var(--accent-teal));
  }

  .ce-list {
    max-height: 148px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-right: 3px;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .ce-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border-radius: 7px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    font-size: 0.72rem;
  }
  .ce-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 0.67rem;
  }
  .ce-type {
    color: var(--accent-teal);
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ce-seq {
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .ce-sub {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 0.7rem;
  }

  .measure-list { display: flex; flex-direction: column; gap: 6px; }
  #measure-list {
    max-height: 152px;
    overflow-y: auto;
    padding-right: 4px;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .measure-summary-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--text-muted);
    padding: 0 2px 2px;
  }
  .measure-row {
    display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px;
    padding: 9px 12px; border-radius: 8px; background: var(--bg-panel);
    border: 1px solid var(--border-color); font-family: var(--font-mono); font-size: 0.82rem;
    overflow-wrap: anywhere; word-break: break-word;
    transition: border-color 0.18s ease, background 0.18s ease;
  }
  .measure-row.clickable { cursor: pointer; }
  .measure-row.clickable:hover { border-color: var(--accent-teal); background: var(--bg-surface-hover); }
  .measure-row strong { color: var(--accent-teal); font-size: 0.9rem; flex-shrink: 0; }
  .measure-row-actions { display: flex; align-items: center; gap: 8px; }
  .measure-del-btn {
    width: 22px; height: 22px; border-radius: 6px; border: 1px solid transparent;
    background: transparent; color: var(--text-muted); font-size: 0.95rem; line-height: 1;
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }
  .measure-del-btn:hover { background: rgba(239, 68, 68, 0.14); border-color: rgba(239, 68, 68, 0.4); color: #f87171; }
  .measure-hint { font-size: 0.84rem; color: var(--text-muted); line-height: 1.45; margin: 0; overflow-wrap: anywhere; word-break: break-word; }
  .measure-hint.pending { color: var(--accent-warm); font-weight: 600; }

  #agent-log {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 4px;
  }
  .agent-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 999px;
    background: var(--bg-panel);
    border: 1px solid var(--border-color);
    font-family: var(--font-sans);
    font-size: 0.74rem;
    color: var(--text-muted);
    animation: blurReveal 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .agent-pill strong { color: var(--text-main); font-weight: 600; font-size: 0.75rem; }
  .agent-dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
    background: var(--accent-teal);
  }
  .agent-pill.running .agent-dot { background: var(--accent-warm); box-shadow: 0 0 8px var(--accent-warm); }
  .agent-pill.error .agent-dot { background: #ef4444; }
  .agent-pill.skipped .agent-dot { background: var(--text-muted); opacity: 0.5; }

  .ingest-details {
    border: 1px solid var(--border-color); border-radius: var(--radius);
    background: var(--bg-panel);
    padding: 0;
  }
  .ingest-details summary {
    list-style: none; cursor: pointer; padding: 11px 14px;
    font-family: var(--font-sans); font-size: 0.8rem; font-weight: 600;
    letter-spacing: 0.02em; color: var(--text-main);
  }
  .ingest-details summary::-webkit-details-marker { display: none; }
  .ingest-details[open] summary { color: var(--accent-teal); border-bottom: 1px solid var(--border-color); }
  .ingest-body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }

  #output {
    min-height: 120px;
    background: transparent;
    margin: 0;
  }

  .metric-card { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: var(--radius); padding: 14px; display: flex; flex-direction: column; gap: 4px; }
  .metric-title { font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .metric-value { font-size: 1.35rem; font-weight: 700; color: var(--text-main); letter-spacing: -0.02em; }
  .metric-value.highlight { color: var(--accent-teal); }
  .telemetry-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .chart-container { background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: var(--radius); padding: 14px; margin-top: 12px; display: flex; flex-direction: column; position: relative; }
  .chart-canvas-wrapper { position: relative; height: 160px; width: 100%; display: flex; justify-content: center; }

  #ai-output {
    padding-right: 4px;
    font-family: var(--font-sans);
    font-size: 0.88rem;
    line-height: 1.72;
    color: var(--text-main);
  }
  .ai-insight-card {
    background: linear-gradient(180deg, var(--bg-panel), var(--bg-surface));
    border: 1px solid var(--border-color);
    border-left: 3px solid var(--accent-teal);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 12px;
    font-family: var(--font-sans);
    font-size: 0.88rem;
    line-height: 1.68;
    color: var(--text-main);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
    overflow-wrap: anywhere;
    word-break: break-word;
    animation: blurReveal 0.34s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .ai-insight-card ul {
    margin: 0;
    padding-left: 16px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .ai-insight-card li {
    color: var(--text-main);
    padding-left: 2px;
  }
  .ai-insight-card li::marker { color: var(--accent-teal); }
  .ai-insight-card strong { color: var(--accent-teal); font-weight: 600; }

  @keyframes blurReveal {
    from { opacity: 0; filter: blur(6px); transform: translateY(3px); }
    to { opacity: 1; filter: blur(0); transform: translateY(0); }
  }
  .viewer-blur-enter {
    animation: blurReveal 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  }

  .workspace.intro-blur {
    filter: blur(14px) brightness(0.62);
    transform: scale(1.018);
  }

  .intro-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    background: radial-gradient(circle at 50% 48%, rgba(8, 22, 34, 0.84) 0%, rgba(5, 8, 14, 0.96) 56%, rgba(2, 4, 8, 0.99) 100%);
    backdrop-filter: blur(18px);
    cursor: pointer;
    transition: opacity 0.75s cubic-bezier(0.16, 1, 0.3, 1), transform 0.85s cubic-bezier(0.16, 1, 0.3, 1), filter 0.75s ease;
  }
  .intro-overlay.reveal {
    opacity: 0;
    transform: scale(1.16);
    filter: blur(12px);
    pointer-events: none;
  }
  .intro-ring {
    width: 84px;
    height: 84px;
    border-radius: 24px;
    display: grid;
    place-items: center;
    background: radial-gradient(circle at 35% 30%, rgba(0, 210, 230, 0.24), rgba(0, 140, 168, 0.06));
    border: 1px solid rgba(0, 210, 230, 0.42);
    box-shadow: 0 0 42px rgba(0, 210, 230, 0.28), inset 0 0 22px rgba(0, 210, 230, 0.14);
    animation: introPulse 0.65s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .intro-wordmark {
    font-family: var(--font-sans);
    font-size: 2.3rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    color: #f8fafc;
    text-shadow: 0 0 32px rgba(0, 210, 230, 0.35);
    animation: blurReveal 0.55s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  .intro-wordmark span { color: #00d2e6; }
  .intro-subtitle {
    font-family: var(--font-mono);
    font-size: 0.74rem;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: rgba(148, 163, 184, 0.9);
    animation: blurReveal 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes introPulse {
    from { opacity: 0; transform: scale(0.84); filter: blur(8px); }
    to { opacity: 1; transform: scale(1); filter: blur(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .intro-overlay { display: none !important; }
    .workspace.intro-blur { filter: none !important; transform: none !important; }
  }

  .spinner { width: 16px; height: 16px; border: 2px solid rgba(160, 174, 192, 0.18); border-top-color: var(--accent-teal); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .panel-gutter:hover { background: var(--accent-teal-dim); }
  .panel-gutter.dragging { background: var(--accent-teal); }

  .topbar-actions { display: flex; gap: 10px; align-items: center; }
  .segmented { display: flex; border: 1px solid var(--border-strong); background: var(--bg-surface); border-radius: 999px; overflow: hidden; }
  .segmented .view-tab { min-width: 44px; height: 38px; padding: 0 13px; font-size: 0.82rem; display: flex; align-items: center; justify-content: center; background: transparent; border-right: 1px solid var(--border-color); border-radius: 0; }
  .segmented .view-tab.active { background: var(--accent-solid); color: var(--accent-contrast); box-shadow: none; }
  .segmented .view-tab:hover:not(.active) { background: var(--bg-surface-hover); color: var(--text-main); }
  .segmented .view-tab:last-child { border-right: none; }
  .text-scale-control .view-tab { min-width: 46px; height: 38px; font-size: 0.9rem; font-weight: 700; text-shadow: none; }

  model-viewer { --poster-color: transparent; background-color: transparent; }

  .nav-hud {
    position: absolute;
    right: 18px;
    top: 112px;
    z-index: 32;
    background: rgba(15, 23, 42, 0.88);
    backdrop-filter: blur(14px);
    border: 1px solid rgba(148, 163, 184, 0.28);
    border-radius: 12px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 226px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
    user-select: none;
    color: #f8fafc;
    animation: blurReveal 0.22s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .nav-hud .nav-key {
    background: rgba(30, 41, 59, 0.92);
    border-color: rgba(148, 163, 184, 0.34);
    color: #f8fafc;
  }
  .nav-hud .nav-reset-btn {
    background: rgba(30, 41, 59, 0.92);
    border-color: rgba(148, 163, 184, 0.3);
    color: #e2e8f0;
  }
  .nav-hud .nav-legend,
  .nav-hud .nav-mouse-hint {
    color: #94a3b8;
    border-color: rgba(148, 163, 184, 0.2);
  }
  .pins-drawer {
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-panel);
    overflow: hidden;
  }
  .pins-drawer summary {
    list-style: none;
    cursor: pointer;
    padding: 8px 11px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--accent-warm);
  }
  .pins-drawer summary::-webkit-details-marker { display: none; }
  .pins-drawer-body {
    max-height: 124px;
    overflow-y: auto;
    padding: 6px 8px 8px;
    border-top: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    gap: 6px;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }
  .nav-hud[hidden] { display: none; }
  .nav-hud-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .nav-hud-title {
    font-family: var(--font-mono);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent-teal);
  }
  .nav-reset-btn {
    border: 1px solid var(--border-color);
    background: var(--bg-surface);
    color: var(--text-main);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 0.68rem;
    font-family: var(--font-mono);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .nav-reset-btn:hover {
    border-color: var(--accent-teal);
    color: var(--accent-teal);
  }
  .nav-key-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 5px;
  }
  .nav-key {
    height: 32px;
    border-radius: 7px;
    border: 1px solid var(--border-strong);
    background: var(--bg-surface);
    color: var(--text-main);
    font-family: var(--font-mono);
    font-size: 0.78rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: 0 2px 0 rgba(0, 0, 0, 0.25);
    transition: background 0.1s, border-color 0.1s, transform 0.08s, color 0.1s;
  }
  .nav-key:hover {
    border-color: var(--accent-teal);
    color: var(--accent-teal);
  }
  .nav-key.active {
    background: var(--accent-solid);
    border-color: var(--accent-teal);
    color: var(--accent-contrast);
    transform: translateY(1px);
    box-shadow: 0 0 12px var(--accent-teal-dim);
  }
  .nav-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    font-family: var(--font-mono);
    font-size: 0.64rem;
    color: var(--text-muted);
    line-height: 1.35;
  }
  .nav-mouse-hint {
    font-family: var(--font-mono);
    font-size: 0.62rem;
    color: var(--text-muted);
    border-top: 1px solid var(--border-color);
    padding-top: 6px;
    opacity: 0.9;
  }
`;
document.head.appendChild(style);

const Icons = {
  box: `<svg width="42" height="42" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M18 20h24l8 8v16H18V20Z" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/>
    <path d="M42 20v8h8" stroke="var(--accent-teal)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M26 32h16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity="0.5"/>
    <circle cx="48" cy="44" r="3.5" fill="var(--accent-teal)"/>
  </svg>`,
  moon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.2 14.8A8.3 8.3 0 0 1 9.2 3.8 8.5 8.5 0 1 0 20.2 14.8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  sun: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  folder: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2h7A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  play: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" fill="currentColor"/></svg>`,
};

let currentAbsolutePath = "";
let currentModelDir = "";
let currentSplatPath = "";
let autoSplatCache: { meshSrc: string; splat: ConvertedSplat } | null = null;
let currentBpp = "5";
let currentSteps = "150";
let activeMode: ViewerMode = "mesh";
let activeTextScale: TextScale = "md";
let timerInterval: number | null = null;
let fpsFrames = 0;
let lastFpsTime = performance.now();
let qualityAvailable = false;
let pendingQualitySpec: {
  originalUrl: string;
  reconstructedUrl: string;
  glbUrl: string;
} | null = null;
let hydratedQualityKey = "";
let tabSwitchSeq = 0;
let lastDetections: unknown = null;

// Global state to allow re-translating telemetry and LLM without re-running analysis
let currentRawTelemetry: string | null = null;
let currentTelemetryData: any = null;
let currentFaithfulness: any = null;
let twinCloudEvents: any[] = [];

const comparisonState = {
  split: 50,
  hybridSplit: 50,
};

let rotX = 0;
let rotY = 0;
let rotZ = 0;

function initUI(): void {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <div class="workspace">
      <header class="topbar">
        <div class="brand-block">
          <div class="brand-mark">nequ<span>3D</span></div>
        </div>

        <div class="telemetry-group">
          <div class="telemetry-item">
            <span class="telemetry-label" data-i18n="gpuEngine"></span>
            <span id="gpu-text" class="telemetry-value">0.0%</span>
            <div class="sys-bar-bg"><div id="gpu-bar" class="sys-bar-fill"></div></div>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label" data-i18n="vramLoad"></span>
            <span id="vram-text" class="telemetry-value">0.0%</span>
            <div class="sys-bar-bg"><div id="vram-bar" class="sys-bar-fill"></div></div>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label" data-i18n="sysClock"></span>
            <span id="sys-time" class="telemetry-value">--:--:--</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label" data-i18n="pipelineTimer"></span>
            <span id="process-timer" class="telemetry-value">0.0s</span>
          </div>
        </div>

        <div class="topbar-actions">
          <div class="segmented language-control">
            <button id="btn-lang-en" class="view-tab">EN</button>
            <button id="btn-lang-pl" class="view-tab">PL</button>
          </div>
          <div class="segmented text-scale-control">
            <button id="btn-size-sm" class="view-tab" data-i18n-title="sizeSmall" data-i18n-aria="sizeSmall">A-</button>
            <button id="btn-size-md" class="view-tab" data-i18n-title="sizeMedium" data-i18n-aria="sizeMedium">A</button>
            <button id="btn-size-lg" class="view-tab" data-i18n-title="sizeLarge" data-i18n-aria="sizeLarge">A+</button>
          </div>
          <button id="theme-toggle" class="technical-button" style="padding: 0; width: 38px; height: 38px; display: grid; place-items: center; border-radius: 999px;" data-i18n-title="themeToggle">${Icons.moon}</button>
        </div>
      </header>

      <aside class="leftpanel panel-left">
        <div class="panel-section">
          <span class="section-label" data-i18n="dataIngestion"></span>
          <button id="select-btn" class="technical-button primary">
            ${Icons.folder}
            <span data-i18n="loadAssetBtn"></span>
          </button>
          <div id="file-path" class="telemetry-label" style="text-transform: none; word-break: break-all;" data-i18n="noFile"></div>

          <details class="ingest-details">
            <summary data-i18n="ingestCollapse"></summary>
            <div class="ingest-body">
              <input type="text" id="sketchfab-url" name="sketchfab-url" autocomplete="off" data-i18n-placeholder="sketchfabUrl" placeholder="Model URL or UID" class="technical-select">
              <input type="password" id="sketchfab-token" name="sketchfab-token" autocomplete="off" data-i18n-placeholder="sketchfabToken" placeholder="API Token" class="technical-select">
              <button id="sketchfab-btn" class="technical-button primary">
                <span data-i18n="loadSketchfabBtn">Pobierz i Analizuj</span>
              </button>
              <div id="sketchfab-status" class="telemetry-label" style="text-transform: none; text-align: center; word-wrap: break-word;"></div>
            </div>
          </details>
        </div>

        <div class="panel-section">
          <span class="section-label" data-i18n="neuralBitrate"></span>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="telemetry-label" data-i18n="targetBitrate"></span>
            <span id="bpp-val" class="telemetry-value" style="font-size: 0.9rem;"></span>
          </div>
          <input type="range" id="bpp-slider" name="bpp-slider" min="1" max="8" step="1" value="5">

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
            <span class="telemetry-label" data-i18n="trainingSteps"></span>
            <span id="steps-val" class="telemetry-value" style="font-size: 0.9rem;"></span>
          </div>
          <input type="range" id="steps-slider" name="steps-slider" min="50" max="1000" step="50" value="150">
        </div>

        <div class="panel-section">
          <span class="section-label" data-i18n="modelLabel"></span>
          <select id="llm-model" name="llm-model" class="technical-select">
            <option value="gemma2" data-i18n="modelFast"></option>
            <option value="llama3" data-i18n="modelLlama"></option>
            <option value="llava">LLaVA (Vision AI)</option>
            <option value="mistral" data-i18n="modelMistral"></option>
          </select>
        </div>

        <button id="analyze-btn" class="technical-button primary" disabled>
          ${Icons.play}
          <span data-i18n="btnAnalyze"></span>
        </button>

        <div class="panel-section" style="flex: 1 0 auto;">
          <span class="section-label" data-i18n="telemetryTitle"></span>
          <div id="output" class="telemetry-table-container"></div>
        </div>
      </aside>

      <div class="panel-gutter" data-gutter="left" role="separator" style="grid-column: 1; grid-row: 2; justify-self: end; z-index: 1000; width: 5px; cursor: col-resize;"></div>

      <main class="viewport panel-center">
        <div class="viewer-chrome">
          <div class="viewer-tabs">
            <button id="tab-mesh" class="view-tab active" data-i18n="tabMesh"></button>
            <button id="tab-quality" class="view-tab" data-i18n="tabQuality" hidden></button>
            <button id="tab-splat" class="view-tab" data-i18n="tabSplatShort"></button>
            <button id="tab-hybrid" class="view-tab" data-i18n="tabHybrid"></button>
            <button id="btn-rot-x" class="view-tab" title="Rotate X">X</button>
            <button id="btn-rot-y" class="view-tab" title="Rotate Y">Y</button>
            <button id="btn-rot-z" class="view-tab" title="Rotate Z">Z</button>
            <button id="btn-top-view" class="view-tab" data-i18n="topViewBtn"></button>
          </div>
          <div id="dims-badge" class="dims-badge" hidden>—</div>
          <div id="fps-counter" class="fps-pill">0 FPS</div>
        </div>

        <div id="viewer-placeholder" class="viewer-placeholder">
          <div data-i18n="viewerEmptyTitle"></div>
        </div>

        <model-viewer id="viewer-usd" class="viewer-layer" style="display: none;" camera-controls exposure="1.05" shadow-intensity="0.45" interaction-prompt="none"></model-viewer>
        <div id="viewer-splat" class="viewer-layer" style="display: none; width: 100%; height: 100%; background: var(--bg-base);"></div>
        <div id="viewer-hybrid" class="viewer-layer" style="display: none; width: 100%; height: 100%; position: relative;">
          <model-viewer id="viewer-hybrid-mesh" class="viewer-layer" style="position:absolute; inset:0; width:100%; height:100%;" camera-controls exposure="1.05" shadow-intensity="0.45" interaction-prompt="none"></model-viewer>
          <div id="viewer-hybrid-splat" style="position:absolute; inset:0; pointer-events:none; background: var(--bg-base);"></div>
          <div id="hybrid-divider" class="comp-divider"></div>
          <div class="telemetry-label" style="position: absolute; top: 70px; left: 18px; z-index: 20; background: var(--glass); backdrop-filter: blur(8px); border-radius: 999px; padding: 6px 12px; pointer-events: none; border: 1px solid var(--border-color);">MESH</div>
          <div class="telemetry-label" style="position: absolute; top: 70px; right: 18px; z-index: 20; background: var(--glass); backdrop-filter: blur(8px); border-radius: 999px; padding: 6px 12px; pointer-events: none; border: 1px solid var(--border-color);">3DGS</div>
        </div>

        <div id="viewer-quality" class="comparison-wrapper" style="display: none;">
          <div id="comparison-layer" class="comparison-layer">
            <model-viewer id="viewer-orig" class="comp-img" camera-controls exposure="1.05" shadow-intensity="0.45" style="width: 100%; height: 100%;" interaction-prompt="none"></model-viewer>
            <model-viewer id="viewer-ntc" class="comp-img img-after" disable-zoom disable-pan disable-tap exposure="1.05" shadow-intensity="0.45" style="width: 100%; height: 100%; pointer-events: none;"></model-viewer>
            <div id="comp-divider" class="comp-divider"></div>
            <div class="telemetry-label" style="position: absolute; top: 70px; left: 18px; z-index: 20; background: var(--glass); backdrop-filter: blur(8px); border-radius: 999px; padding: 6px 12px; pointer-events: none; border: 1px solid var(--border-color);" data-i18n="origLabel"></div>
            <div class="telemetry-label" style="position: absolute; top: 70px; right: 18px; z-index: 20; background: var(--glass); backdrop-filter: blur(8px); border-radius: 999px; padding: 6px 12px; pointer-events: none; border: 1px solid var(--border-color);" data-i18n="ntcLabel"></div>
          </div>
        </div>

        <div class="viewport-toolbar" id="viewport-toolbar">
          <button type="button" class="tool-btn active" data-tool="orbit" data-i18n="toolOrbit"></button>
          <button type="button" class="tool-btn" data-tool="measure" data-i18n="toolMeasure"></button>
          <button type="button" class="tool-btn" data-tool="pin" data-i18n="toolPin"></button>
          <button type="button" class="tool-btn" data-tool="section" data-i18n="toolSection"></button>
          <div class="tool-sep"></div>
          <button type="button" class="tool-btn" id="btn-clear-measure" data-i18n="measureClear"></button>
          <div class="tool-sep"></div>
          <button type="button" class="tool-btn" id="btn-nav-hud" data-i18n="navToggle"></button>
        </div>

        <div id="pin-popover" class="pin-popover" hidden>
          <input type="text" id="pin-input" name="pin-input" autocomplete="off" data-i18n-placeholder="pinPlaceholder" placeholder="Note…" />
          <button type="button" id="btn-pin-confirm" class="nav-reset-btn" data-i18n="pinAdd"></button>
          <button type="button" id="btn-pin-cancel" class="nav-reset-btn" data-i18n="pinCancel"></button>
        </div>

        <div id="nav-hud" class="nav-hud" hidden>
          <div class="nav-hud-header">
            <span class="nav-hud-title" data-i18n="navTitle"></span>
            <button type="button" id="btn-nav-reset" class="nav-reset-btn" data-i18n="navReset"></button>
          </div>
          <div class="nav-key-grid">
            <button type="button" class="nav-key" data-nav-key="KeyQ" title="Turn left">Q</button>
            <button type="button" class="nav-key" data-nav-key="KeyW" title="Forward">W</button>
            <button type="button" class="nav-key" data-nav-key="KeyE" title="Turn right">E</button>
            <button type="button" class="nav-key" data-nav-key="KeyR" title="Tilt up">R</button>
            <button type="button" class="nav-key" data-nav-key="KeyA" title="Left">A</button>
            <button type="button" class="nav-key" data-nav-key="KeyS" title="Back">S</button>
            <button type="button" class="nav-key" data-nav-key="KeyD" title="Right">D</button>
            <button type="button" class="nav-key" data-nav-key="KeyF" title="Tilt down">F</button>
          </div>
          <div class="nav-legend">
            <span data-i18n="navMove"></span>
            <span data-i18n="navTurn"></span>
            <span data-i18n="navPitch"></span>
          </div>
          <div class="nav-mouse-hint" data-i18n="navMouseHint"></div>
        </div>

        <div id="section-rail" class="section-rail" aria-hidden="true">
          <input type="range" id="section-slider" name="section-slider" min="0" max="100" value="50" orient="vertical" />
        </div>

        <button type="button" id="toggle-left-panel" class="panel-collapse-btn left" aria-label="Collapse panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" id="toggle-right-panel" class="panel-collapse-btn right" aria-label="Collapse panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </main>

      <div class="panel-gutter" data-gutter="right" role="separator" style="grid-column: 3; grid-row: 2; justify-self: start; z-index: 1000; width: 5px; cursor: col-resize;"></div>

      <aside class="rightpanel panel-right">
        <div class="panel-section">
          <span class="section-label" data-i18n="toolsTitle"></span>
          <p id="measure-hint" class="measure-hint" data-i18n="measureHint"></p>
          <div class="section-axis-row" id="section-axis-row">
            <button type="button" class="axis-chip active" id="btn-section-off" data-i18n="sectionOff"></button>
            <button type="button" class="axis-chip" data-axis="x">X</button>
            <button type="button" class="axis-chip" data-axis="y">Y</button>
            <button type="button" class="axis-chip" data-axis="z">Z</button>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="telemetry-label" data-i18n="sectionDepth"></span>
            <span id="section-val" class="telemetry-value" style="font-size: 0.9rem;">50%</span>
          </div>
          <input type="range" id="section-slider-panel" name="section-slider-panel" min="0" max="100" value="50">
          <div id="measure-list" class="measure-list"></div>
          <div id="pin-list" class="measure-list"></div>
        </div>

        <div class="panel-section">
          <span class="section-label" data-i18n="zonesTitle"></span>
          <div id="zones-list" class="measure-list">
            <div class="measure-hint" data-i18n="zonesEmpty"></div>
          </div>
          <button id="btn-save-twin" class="technical-button" style="width:100%; margin-top:4px;" type="button">
            <span data-i18n="saveTwinBtn"></span>
          </button>
          <div id="twin-save-status" class="measure-hint"></div>
          <details id="ce-drawer" class="simready-card" style="margin-top:6px;">
            <summary>
              <span data-i18n="ceTitle"></span>
              <span id="ce-count-badge" class="simready-badge ok">0</span>
            </summary>
            <div class="simready-checks">
              <div id="ce-timeline-list" class="ce-list"></div>
            </div>
          </details>
        </div>

        <div class="panel-section">
          <span class="section-label" data-i18n="locateTitle"></span>
          <input type="text" id="locate-prompt" name="locate-prompt" autocomplete="off" class="technical-select" data-i18n-placeholder="locatePrompt" placeholder="crack, moisture, window">
          <button id="btn-locate" class="technical-button" style="width:100%; margin-top:4px;" type="button">
            <span data-i18n="locateBtn"></span>
          </button>
          <div id="locate-list" class="measure-list"></div>
        </div>

        <div class="panel-section" style="flex: 1 0 auto; display: flex; flex-direction: column;">
          <span class="section-label" data-i18n="aiTitle"></span>
          <button id="btn-agent" class="technical-button" style="width:100%; margin-bottom:4px;" type="button">
            <span data-i18n="agentBtn"></span>
          </button>
          <div id="agent-log" class="measure-list"></div>
          <div id="ai-output"></div>
          <div id="ai-faithfulness"></div>
        </div>
      </aside>
    </div>
  `;

  document.body.dataset.theme = "dark";

  IntLayer.init();
  initTheme();
  initTextScale();
  updateLanguageButtons();
  updateCollapseButtonTitles();
  updateBppLabel();
  attachEventListeners();
  initViewerToolsUI();
  initNavHud();
  initCollapsiblePanels();
  initResizablePanels();
  initComparisonResize();
  guardModelViewerArBug();
  startLocalClock();
  startFpsCounter();
  void refreshTwinEventsTimeline();
  playStartupIntro();
}

function guardModelViewerArBug(): void {
  // Work around upstream @google/model-viewer v4 ARRenderer.onUpdateScene bug:
  // mutating viewer.orientation outside WebXR creates XRMenuPanel (leaking 3 svg+xml blobs)
  // and crashes on null presentedScene.add(...).
  for (const id of [
    "viewer-usd",
    "viewer-orig",
    "viewer-ntc",
    "viewer-hybrid-mesh",
  ]) {
    try {
      const v = document.getElementById(id) as any;
      const ar = v?.[$renderer]?.arRenderer;
      if (ar && !ar.__nequ3dGuarded && typeof ar.onUpdateScene === "function") {
        const orig = ar.onUpdateScene;
        ar.onUpdateScene = () => {
          if (!ar.isPresenting || !ar.presentedScene) return;
          orig();
        };
        ar.__nequ3dGuarded = true;
      }
    } catch {
      /* ignore */
    }
  }
}

function startLocalClock(): void {
  const timeEl = getEl<HTMLSpanElement>("sys-time");
  const updateClock = () => {
    if (document.hidden) return;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const str = `${hh}:${mm}:${ss}`;
    if (timeEl.textContent !== str) timeEl.textContent = str;
  };
  updateClock();
  window.setInterval(updateClock, 1000);
}

function playStartupIntro(): void {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const workspace = document.querySelector<HTMLElement>(".workspace");
  if (!workspace) return;

  workspace.classList.add("intro-blur");

  const overlay = document.createElement("div");
  overlay.id = "nequ3d-intro";
  overlay.className = "intro-overlay";
  overlay.innerHTML = `
    <div class="intro-ring">${Icons.box}</div>
    <div class="intro-wordmark">nequ<span>3D</span></div>
    <div class="intro-subtitle">Spatial Twin &amp; Neural Texture Studio</div>
  `;
  document.body.appendChild(overlay);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    overlay.classList.add("reveal");
    workspace.classList.remove("intro-blur");
    window.setTimeout(() => overlay.remove(), 860);
  };

  overlay.addEventListener("click", dismiss, { once: true });
  window.setTimeout(dismiss, 620);
}

function animateBlurValue(el: HTMLElement | null, nextText: string): void {
  if (!el) return;
  if (el.textContent === nextText) return;
  el.textContent = nextText;
  if (typeof el.animate !== "function") return;
  try {
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(
      [
        { opacity: 0.35, filter: "blur(3.5px)", transform: "translateY(2px)" },
        { opacity: 1, filter: "blur(0px)", transform: "translateY(0)" },
      ],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  } catch {
    /* ignore */
  }
}

function triggerViewerBlurEnter(el: HTMLElement): void {
  el.classList.remove("viewer-blur-enter");
  void el.offsetWidth;
  el.classList.add("viewer-blur-enter");
}

function startFpsCounter() {
  const fpsEl = getEl("fps-counter");
  let lastLabel = "";
  function loop() {
    if (!document.hidden) {
      fpsFrames++;
      const now = performance.now();
      if (now - lastFpsTime >= 1000) {
        const nextLabel = `${Math.round((fpsFrames * 1000) / (now - lastFpsTime))} FPS`;
        if (fpsEl && nextLabel !== lastLabel) {
          fpsEl.textContent = nextLabel;
          lastLabel = nextLabel;
        }
        fpsFrames = 0;
        lastFpsTime = now;
      }
    } else {
      fpsFrames = 0;
      lastFpsTime = performance.now();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

function syncSectionUI(): void {
  const on = isSectionEnabled();
  const axis = getSectionAxis();
  getEl<HTMLButtonElement>("btn-section-off").classList.toggle("active", !on);
  getEl("section-axis-row")
    .querySelectorAll<HTMLButtonElement>("[data-axis]")
    .forEach((chip) => {
      chip.classList.toggle("active", on && chip.dataset.axis === axis);
    });
  const rail = getEl<HTMLDivElement>("section-rail");
  const showRail = getToolMode() === "section" && on;
  rail.classList.toggle("visible", showRail);
  rail.setAttribute("aria-hidden", showRail ? "false" : "true");
}

function initViewerToolsUI(): void {
  const toolbar = getEl<HTMLDivElement>("viewport-toolbar");
  toolbar.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.tool as ToolMode;
      if (!mode) return;
      if (mode === "section" && getToolMode() === "section" && isSectionEnabled()) {
        setSectionEnabled(false);
        activateToolMode("orbit");
        syncSectionUI();
        return;
      }
      activateToolMode(mode);
    });
  });

  getEl<HTMLButtonElement>("btn-clear-measure").addEventListener("click", () => {
    // Only clear temporary A->B measurements; 3D notes stay persistent until explicitly deleted
    clearMeasurements();
    renderMeasureList([]);
    setMeasureHint(false);
  });

  const syncSectionSliders = (raw: string) => {
    const t = Number(raw) / 100;
    setSectionT(t);
    getEl<HTMLInputElement>("section-slider").value = raw;
    getEl<HTMLInputElement>("section-slider-panel").value = raw;
    animateBlurValue(getEl("section-val"), `${raw}%`);
    if (!isSectionEnabled()) {
      setSectionEnabled(true);
      activateToolMode("section");
    }
    syncSectionUI();
  };

  getEl<HTMLInputElement>("section-slider").addEventListener("input", (e) => {
    syncSectionSliders((e.target as HTMLInputElement).value);
  });
  getEl<HTMLInputElement>("section-slider-panel").addEventListener(
    "input",
    (e) => {
      syncSectionSliders((e.target as HTMLInputElement).value);
    },
  );

  getEl<HTMLButtonElement>("btn-section-off").addEventListener("click", () => {
    setSectionEnabled(false);
    if (getToolMode() === "section") {
      activateToolMode("orbit");
    }
    syncSectionUI();
  });

  getEl("section-axis-row")
    .querySelectorAll<HTMLButtonElement>("[data-axis]")
    .forEach((chip) => {
      chip.addEventListener("click", () => {
        const axis = chip.dataset.axis as SectionAxis;
        if (!axis) return;
        if (isSectionEnabled() && getSectionAxis() === axis) {
          setSectionEnabled(false);
          if (getToolMode() === "section") {
            activateToolMode("orbit");
          }
          syncSectionUI();
          return;
        }
        setSectionAxis(axis);
        setSectionEnabled(true);
        applySectionPlane();
        syncSectionUI();
      });
    });

  setMeasurementsListener((items) => renderMeasureList(items));
  setPinsListener((items) => {
    persistPinsForCurrentAsset(items);
    renderPinList(items);
  });
  setPinSurfaceClickListener((point) => openPinPopover(point));
  setPendingListener((pending) => setMeasureHint(pending));
  setMeasureCompleteListener(() => {
    activateToolMode("orbit");
  });

  const pinPopover = getEl<HTMLDivElement>("pin-popover");
  const pinInput = getEl<HTMLInputElement>("pin-input");
  const commitPin = () => {
    if (!pendingPinPoint) {
      pinPopover.hidden = true;
      return;
    }
    const text = pinInput.value.trim();
    if (text) {
      addPinNote(pendingPinPoint, text, "note");
    }
    pendingPinPoint = null;
    pinInput.value = "";
    pinPopover.hidden = true;
    activateToolMode("orbit");
  };
  const cancelPin = () => {
    pendingPinPoint = null;
    pinInput.value = "";
    pinPopover.hidden = true;
  };
  getEl<HTMLButtonElement>("btn-pin-confirm").addEventListener("click", commitPin);
  getEl<HTMLButtonElement>("btn-pin-cancel").addEventListener("click", cancelPin);
  pinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPin();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelPin();
    }
  });

  const viewer = getEl("viewer-usd") as any;
  bindViewerTools(viewer);
  viewer.addEventListener("load", () => {
    reattachPinHotspots();
    updateDimsBadge(viewer);
    if (isSectionEnabled()) applySectionPlane();
  });

  activateToolMode("orbit");
  syncSectionUI();
  renderMeasureList(getMeasurements());
}

let navHudVisible = false;
let navHudUserToggled = false;
const heldNavKeys = new Set<string>();
let navDriveRaf = 0;

function setNavHudVisible(visible: boolean): void {
  navHudVisible = visible;
  const hud = getEl<HTMLDivElement>("nav-hud");
  const btn = getEl<HTMLButtonElement>("btn-nav-hud");
  hud.hidden = !visible;
  btn.classList.toggle("active", visible);
}

function getActiveModelViewer(): any | null {
  if (activeMode === "mesh") return getEl("viewer-usd");
  if (activeMode === "quality") return getEl("viewer-orig");
  if (activeMode === "hybrid") return getEl("viewer-hybrid-mesh");
  return null;
}

function stepModelViewerNav(): void {
  if (heldNavKeys.size === 0) {
    navDriveRaf = 0;
    return;
  }
  navDriveRaf = requestAnimationFrame(stepModelViewerNav);
  if (activeMode === "splat") return;

  const viewer = getActiveModelViewer();
  if (!viewer || !viewer.src || !viewer.getCameraOrbit || !viewer.getCameraTarget) {
    return;
  }
  try {
    const orbit = viewer.getCameraOrbit();
    const target = viewer.getCameraTarget();
    let theta = Number(orbit.theta) || 0;
    let phi = Number(orbit.phi) || Math.PI / 2;
    let radius = Number(orbit.radius) || 5;
    let tx = Number(target.x) || 0;
    let ty = Number(target.y) || 0;
    let tz = Number(target.z) || 0;

    const rotStep = 0.028;
    const moveStep = Math.max(0.03, radius * 0.014);

    if (heldNavKeys.has("KeyQ")) theta -= rotStep;
    if (heldNavKeys.has("KeyE")) theta += rotStep;
    if (heldNavKeys.has("KeyR")) phi = clamp(phi - rotStep, 0.08, Math.PI - 0.08);
    if (heldNavKeys.has("KeyF")) phi = clamp(phi + rotStep, 0.08, Math.PI - 0.08);

    // Camera horizontal forward & right vectors in Three.js Y-up
    const fwdX = -Math.sin(theta);
    const fwdZ = -Math.cos(theta);
    const rightX = Math.cos(theta);
    const rightZ = -Math.sin(theta);

    if (heldNavKeys.has("KeyW")) {
      tx += fwdX * moveStep;
      tz += fwdZ * moveStep;
    }
    if (heldNavKeys.has("KeyS")) {
      tx -= fwdX * moveStep;
      tz -= fwdZ * moveStep;
    }
    if (heldNavKeys.has("KeyD")) {
      tx += rightX * moveStep;
      tz += rightZ * moveStep;
    }
    if (heldNavKeys.has("KeyA")) {
      tx -= rightX * moveStep;
      tz -= rightZ * moveStep;
    }

    viewer.cameraOrbit = `${theta}rad ${phi}rad ${radius}m`;
    viewer.cameraTarget = `${tx}m ${ty}m ${tz}m`;
  } catch {
    /* ignore before model ready */
  }
}

function normalizeNavKeyCode(code: string): string | null {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return "KeyW";
    case "KeyS":
    case "ArrowDown":
      return "KeyS";
    case "KeyA":
    case "ArrowLeft":
      return "KeyA";
    case "KeyD":
    case "ArrowRight":
      return "KeyD";
    case "KeyQ":
    case "KeyE":
    case "KeyR":
    case "KeyF":
      return code;
    default:
      return null;
  }
}

function initNavHud(): void {
  const hud = getEl<HTMLDivElement>("nav-hud");
  const toggleBtn = getEl<HTMLButtonElement>("btn-nav-hud");
  const resetBtn = getEl<HTMLButtonElement>("btn-nav-reset");

  toggleBtn.addEventListener("click", () => {
    navHudUserToggled = true;
    setNavHudVisible(!navHudVisible);
  });

  resetBtn.addEventListener("click", () => {
    topViewActive = false;
    getEl<HTMLButtonElement>("btn-top-view").classList.remove("active");
    if (activeMode === "splat") {
      resetSplatCamera();
      return;
    }
    const viewer = getActiveModelViewer();
    if (viewer) {
      viewer.cameraOrbit = "auto auto auto";
      viewer.cameraTarget = "auto auto auto";
      viewer.fieldOfView = "auto";
    }
  });

  const setKeyVisual = (code: string, active: boolean) => {
    const el = hud.querySelector<HTMLButtonElement>(`[data-nav-key="${code}"]`);
    if (el) el.classList.toggle("active", active);
  };

  const pressKey = (code: string, fromPointer: boolean) => {
    if (!heldNavKeys.has(code)) {
      heldNavKeys.add(code);
      setKeyVisual(code, true);
      if (fromPointer && activeMode === "splat") {
        window.dispatchEvent(new KeyboardEvent("keydown", { code }));
      }
      if (!navDriveRaf) {
        navDriveRaf = requestAnimationFrame(stepModelViewerNav);
      }
    }
  };

  const releaseKey = (code: string, fromPointer: boolean) => {
    if (heldNavKeys.delete(code)) {
      setKeyVisual(code, false);
      if (fromPointer && activeMode === "splat") {
        window.dispatchEvent(new KeyboardEvent("keyup", { code }));
      }
    }
  };

  hud.querySelectorAll<HTMLButtonElement>("[data-nav-key]").forEach((btn) => {
    const code = btn.dataset.navKey;
    if (!code) return;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      pressKey(code, true);
    });
    const end = (e: PointerEvent) => {
      releaseKey(code, true);
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointercancel", end);
    btn.addEventListener("lostpointercapture", () => releaseKey(code, true));
  });

  window.addEventListener("keydown", (e) => {
    const tag = (document.activeElement?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const code = normalizeNavKeyCode(e.code);
    if (!code) return;
    pressKey(code, false);
  });

  window.addEventListener("keyup", (e) => {
    const code = normalizeNavKeyCode(e.code);
    if (!code) return;
    releaseKey(code, false);
  });

  window.addEventListener("blur", () => {
    Array.from(heldNavKeys).forEach((code) => releaseKey(code, true));
  });
}

let pendingPinPoint: MeasurePoint | null = null;
let topViewActive = false;

function openPinPopover(point: MeasurePoint): void {
  pendingPinPoint = point;
  const popover = getEl<HTMLDivElement>("pin-popover");
  const input = getEl<HTMLInputElement>("pin-input");
  popover.hidden = false;
  input.value = "";
  window.setTimeout(() => input.focus(), 10);
}

function getPinStorageKey(assetPath = currentAbsolutePath): string | null {
  const clean = assetPath.trim().toLowerCase().replace(/\\/g, "/");
  return clean ? `nequ3d.pins.${clean}` : null;
}

function persistPinsForCurrentAsset(items: PinNote[]): void {
  const key = getPinStorageKey();
  if (!key) return;
  try {
    if (items.length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(items));
    }
  } catch {
    /* ignore storage quota errors */
  }
}

function restorePinsForCurrentAsset(): void {
  const key = getPinStorageKey();
  if (!key) {
    clearPinNotes();
    return;
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      clearPinNotes();
      return;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      loadPinNotes(parsed as PinNote[]);
      return;
    }
  } catch {
    /* ignore malformed cache */
  }
  clearPinNotes();
}

function renderPinList(items: PinNote[]): void {
  const list = getEl<HTMLDivElement>("pin-list");
  if (!items.length) {
    list.innerHTML = "";
    return;
  }
  const title =
    IntLayer.currentLang === "pl"
      ? `Notatki 3D (${items.length})`
      : `3D Notes (${items.length})`;
  const delTitle = IntLayer.currentLang === "pl" ? "Usuń notatkę" : "Delete note";
  const wasOpen = Boolean(list.querySelector<HTMLDetailsElement>(".pins-drawer")?.open);

  const rows = items
    .map(
      (p) => `
      <div class="measure-row">
        <span style="color:var(--accent-warm);font-weight:700;">P${p.id}</span>
        <span style="flex:1;font-family:var(--font-sans);font-size:0.78rem;color:var(--text-main);">${escapeHtml(p.text)}</span>
        <button type="button" class="measure-del-btn" data-pin-del="${p.id}" title="${delTitle}" aria-label="${delTitle}">&times;</button>
      </div>`,
    )
    .join("");

  list.innerHTML = `
    <details class="pins-drawer"${wasOpen || items.length <= 3 ? " open" : ""}>
      <summary><span>${title}</span><span style="opacity:0.7;">▾</span></summary>
      <div class="pins-drawer-body">${rows}</div>
    </details>
  `;

  list.querySelectorAll<HTMLButtonElement>("[data-pin-del]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.dataset.pinDel);
      if (Number.isFinite(id)) removePinNote(id);
    });
  });
  const body = list.querySelector<HTMLElement>(".pins-drawer-body");
  if (body) body.scrollTop = body.scrollHeight;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toggleTopView(): void {
  const btn = getEl<HTMLButtonElement>("btn-top-view");
  if (activeMode === "splat") {
    topViewActive = !topViewActive;
    btn.classList.toggle("active", topViewActive);
    setSplatTopView(topViewActive);
    return;
  }
  const viewer = getActiveModelViewer();
  if (!viewer) {
    topViewActive = false;
    btn.classList.remove("active");
    return;
  }
  topViewActive = !topViewActive;
  btn.classList.toggle("active", topViewActive);
  if (topViewActive) {
    viewer.cameraOrbit = "0deg 0.5deg auto";
    viewer.fieldOfView = "14deg";
  } else {
    viewer.cameraOrbit = "auto auto auto";
    viewer.fieldOfView = "auto";
  }
}

function activateToolMode(mode: ToolMode): void {
  setToolMode(mode);
  if (mode === "section") setSectionEnabled(true);
  if (mode !== "pin") {
    pendingPinPoint = null;
    getEl<HTMLDivElement>("pin-popover").hidden = true;
  }

  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === mode);
  });

  if (mode === "pin") {
    const hint = getEl<HTMLParagraphElement>("measure-hint");
    hint.classList.remove("pending");
    hint.textContent = IntLayer.t.pinHint;
  } else if (mode === "measure") {
    setMeasureHint(false);
  }

  if (mode === "section") {
    const pct = Math.round(getSectionT() * 100);
    getEl<HTMLInputElement>("section-slider").value = String(pct);
    getEl<HTMLInputElement>("section-slider-panel").value = String(pct);
    getEl("section-val").textContent = `${pct}%`;
    applySectionPlane();
  }
  syncSectionUI();
}

function setMeasureHint(pending: boolean): void {
  const hint = getEl<HTMLParagraphElement>("measure-hint");
  hint.classList.toggle("pending", pending);
  hint.setAttribute(
    "data-i18n",
    pending ? "measurePending" : "measureHint",
  );
  hint.textContent = pending
    ? IntLayer.t.measurePending
    : IntLayer.t.measureHint;
}

function renderMeasureList(items: Measurement[]): void {
  const list = getEl<HTMLDivElement>("measure-list");
  if (!items.length) {
    list.innerHTML = `<div class="measure-hint" data-i18n="measureEmpty">${IntLayer.t.measureEmpty}</div>`;
    return;
  }
  const labelCount =
    IntLayer.currentLang === "pl"
      ? `Pomiary (${items.length})`
      : `Measurements (${items.length})`;
  const delTitle =
    IntLayer.currentLang === "pl" ? "Usuń pomiar" : "Delete measurement";

  list.innerHTML =
    `<div class="measure-summary-bar"><span>${labelCount}</span></div>` +
    items
      .map(
        (m, i) => `
        <div class="measure-row clickable" data-measure-focus="${m.id}">
          <span>#${i + 1}</span>
          <div class="measure-row-actions">
            <strong>${formatDistance(m.distance)}</strong>
            <button type="button" class="measure-del-btn" data-measure-del="${m.id}" title="${delTitle}" aria-label="${delTitle}">&times;</button>
          </div>
        </div>`,
      )
      .join("");

  list.querySelectorAll<HTMLElement>("[data-measure-focus]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.measureFocus);
      if (Number.isFinite(id)) focusMeasurement(id);
    });
  });

  list
    .querySelectorAll<HTMLButtonElement>("[data-measure-del]")
    .forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.measureDel);
        if (Number.isFinite(id)) removeMeasurement(id);
      });
    });

  list.scrollTop = list.scrollHeight;
}

function updateDimsBadge(viewer: any): void {
  const badge = getEl<HTMLDivElement>("dims-badge");
  const extents = readModelExtents(viewer);
  if (!extents) {
    badge.hidden = true;
    return;
  }
  const { size } = extents;
  badge.hidden = false;
  animateBlurValue(
    badge,
    `${IntLayer.t.dimsLabel}: ${formatDistance(size.x)} × ${formatDistance(size.y)} × ${formatDistance(size.z)}`,
  );
}

function updateViewerOrientations(): void {
  guardModelViewerArBug();
  const orientation = `${rotX}deg ${rotY}deg ${rotZ}deg`;
  const viewers = ["viewer-usd", "viewer-orig", "viewer-ntc", "viewer-hybrid-mesh"];
  viewers.forEach((id) => {
    const v = getEl<any>(id);
    if (v && v.orientation !== orientation) v.orientation = orientation;
  });
  autoSplatCache = null;
}

function attachEventListeners(): void {
  const selectBtn = getEl<HTMLButtonElement>("select-btn");
  const analyzeBtn = getEl<HTMLButtonElement>("analyze-btn");

  const bindSplitDivider = (
    dividerId: string,
    containerId: string,
    onSplit: (split: number) => void,
  ): void => {
    const divider = getEl<HTMLDivElement>(dividerId);
    const container = getEl<HTMLDivElement>(containerId);
    let dragging = false;

    divider.addEventListener("pointerdown", (e) => {
      dragging = true;
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    divider.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const rect = container.getBoundingClientRect();
      if (!rect.width) return;
      const split = clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100);
      onSplit(split);
    });

    divider.addEventListener("pointerup", (e) => {
      dragging = false;
      divider.releasePointerCapture(e.pointerId);
    });
  };

  bindSplitDivider("comp-divider", "comparison-layer", (split) => {
    comparisonState.split = split;
    syncComparisonLayout();
  });

  bindSplitDivider("hybrid-divider", "viewer-hybrid", (split) => {
    comparisonState.hybridSplit = split;
    syncHybridLayout();
  });

  getEl<HTMLButtonElement>("tab-mesh").addEventListener("click", () =>
    switchTab("mesh"),
  );
  getEl<HTMLButtonElement>("tab-quality").addEventListener("click", () =>
    switchTab("quality"),
  );
  getEl<HTMLButtonElement>("tab-splat").addEventListener("click", () =>
    switchTab("splat"),
  );
  getEl<HTMLButtonElement>("tab-hybrid").addEventListener("click", () =>
    switchTab("hybrid"),
  );
  getEl<HTMLButtonElement>("btn-save-twin").addEventListener("click", () => {
    void saveTwinAnnotations();
  });
  getEl<HTMLButtonElement>("btn-locate").addEventListener("click", () => {
    void runLocateFromViewer();
  });
  getEl<HTMLButtonElement>("btn-agent").addEventListener("click", () => {
    void runRenovationAgent();
  });
  Events.On("agentStep", (event: any) => {
    appendAgentStep(unwrapWailsPayload(event));
  });
  Events.On("twinCloudEvent", (event: any) => {
    const raw = unwrapWailsPayload(event);
    const parsed = typeof raw === "string" ? safeJsonParse<any>(raw) : raw;
    if (parsed && parsed.id) {
      twinCloudEvents = [
        parsed,
        ...twinCloudEvents.filter((x) => x.id !== parsed.id),
      ].slice(0, 40);
      renderCloudEventsTimeline();
    }
  });
  Events.On("llmFaithfulness", (event: any) => {
    const raw = unwrapWailsPayload(event);
    const parsed = typeof raw === "string" ? safeJsonParse<any>(raw) : raw;
    if (parsed && typeof parsed.score_pct === "number") {
      currentFaithfulness = parsed;
      renderFaithfulnessCard(parsed);
    }
  });

  getEl<HTMLButtonElement>("btn-rot-x").addEventListener("click", () => {
    rotX = (rotX + 90) % 360;
    updateViewerOrientations();
  });
  getEl<HTMLButtonElement>("btn-rot-y").addEventListener("click", () => {
    rotY = (rotY + 90) % 360;
    updateViewerOrientations();
  });
  getEl<HTMLButtonElement>("btn-rot-z").addEventListener("click", () => {
    rotZ = (rotZ + 90) % 360;
    updateViewerOrientations();
  });
  getEl<HTMLButtonElement>("btn-top-view").addEventListener("click", () => {
    toggleTopView();
  });


  getEl<HTMLInputElement>("bpp-slider").addEventListener("input", (event) => {
    currentBpp = (event.target as HTMLInputElement).value;
    updateBppLabel();
  });

  getEl<HTMLInputElement>("steps-slider").addEventListener("input", (event) => {
    currentSteps = (event.target as HTMLInputElement).value;
    updateBppLabel();
  });

  getEl<HTMLButtonElement>("btn-lang-en").addEventListener("click", () =>
    setLanguage("en"),
  );
  getEl<HTMLButtonElement>("btn-lang-pl").addEventListener("click", () =>
    setLanguage("pl"),
  );
  getEl<HTMLButtonElement>("btn-size-sm").addEventListener("click", () =>
    setTextScale("sm"),
  );
  getEl<HTMLButtonElement>("btn-size-md").addEventListener("click", () =>
    setTextScale("md"),
  );
  getEl<HTMLButtonElement>("btn-size-lg").addEventListener("click", () =>
    setTextScale("lg"),
  );
  getEl<HTMLButtonElement>("theme-toggle").addEventListener(
    "click",
    toggleTheme,
  );

  const viewerOrig = getEl<any>("viewer-orig");
  viewerOrig.addEventListener("camera-change", () => {
    if (activeMode !== "quality") return;
    syncQualityCamera(false);
  });

  try {
    Events.On("localServerUrl", (event: unknown) => {
      const data = (event as any)?.data;
      const url = Array.isArray(data) ? data[0] : data;
      if (typeof url === "string" && url.length > 0 && LOCAL_FILE_ENDPOINT !== url) {
        LOCAL_FILE_ENDPOINT = url;
        // The local-file server may have started after the user already
        // picked a mesh (dynamic port race). Re-render the preview so the
        // model actually shows.
        if (currentAbsolutePath && isMeshRenderable(currentAbsolutePath)) {
          previewMeshAsset(currentAbsolutePath);
        }
      }
    });
    Events.On("sysStats", (event: unknown) => {
      const stats = normalizeStatsEvent(event);
      if (stats) updateSystemStats(stats);
    });
    void Events.Emit("requestLocalServerUrl");
  } catch {
    console.warn("[Nequ3D] Wails event bridge unavailable.");
  }

  selectBtn.addEventListener("click", async () => {
    const path = await SelectFile();
    if (!path) return;
    await routeSelectedAsset(path);
  });

  const sketchfabBtn = getEl<HTMLButtonElement>("sketchfab-btn");
  const sketchfabStatus = getEl<HTMLDivElement>("sketchfab-status");
  sketchfabBtn.addEventListener("click", async () => {
    const urlInput = getEl<HTMLInputElement>("sketchfab-url").value;
    const tokenInput = getEl<HTMLInputElement>("sketchfab-token").value;
    if (!urlInput || !tokenInput) {
        sketchfabStatus.style.color = "red";
        sketchfabStatus.textContent = IntLayer.t.sketchfabMissing;
        return;
    }
    
    sketchfabBtn.disabled = true;
    const oldHtml = sketchfabBtn.innerHTML;
    sketchfabBtn.innerHTML = `<div class="spinner"></div><span style="font-size: 0.6rem;">${IntLayer.t.sketchfabDownloading}</span>`;
    sketchfabStatus.style.color = "var(--text-muted)";
    sketchfabStatus.textContent = IntLayer.t.sketchfabConnecting;
    
    try {
        const path = await DownloadFromSketchfab(urlInput, tokenInput);
        if (path) {
            sketchfabStatus.style.color = "var(--accent-teal)";
            sketchfabStatus.textContent = IntLayer.t.sketchfabSuccess;
            await routeSelectedAsset(path);
        }
    } catch (e) {
        sketchfabStatus.style.color = "red";
        sketchfabStatus.textContent = friendlySketchfabError(e);
    } finally {
        sketchfabBtn.disabled = false;
        sketchfabBtn.innerHTML = oldHtml;
    }
  });

  analyzeBtn.addEventListener("click", runAnalysis);
}

function updateCollapseButtonTitles(): void {
  const workspace = document.querySelector<HTMLDivElement>(".workspace");
  if (!workspace) return;
  const leftBtn = getEl<HTMLButtonElement>("toggle-left-panel");
  const rightBtn = getEl<HTMLButtonElement>("toggle-right-panel");
  const leftCollapsed = workspace.classList.contains("left-collapsed");
  const rightCollapsed = workspace.classList.contains("right-collapsed");
  leftBtn.title = `${leftCollapsed ? IntLayer.t.panelExpand : IntLayer.t.panelCollapse} (Ctrl+[)`;
  leftBtn.setAttribute("aria-label", leftBtn.title);
  rightBtn.title = `${rightCollapsed ? IntLayer.t.panelExpand : IntLayer.t.panelCollapse} (Ctrl+])`;
  rightBtn.setAttribute("aria-label", rightBtn.title);
}

function initCollapsiblePanels(): void {
  const workspace = document.querySelector<HTMLDivElement>(".workspace");
  if (!workspace) return;

  const toggleSide = (side: "left" | "right") => {
    workspace.classList.toggle(`${side}-collapsed`);
    updateCollapseButtonTitles();
    window.setTimeout(() => requestViewerResize(), 300);
  };

  getEl<HTMLButtonElement>("toggle-left-panel").addEventListener("click", () =>
    toggleSide("left"),
  );
  getEl<HTMLButtonElement>("toggle-right-panel").addEventListener("click", () =>
    toggleSide("right"),
  );

  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === "BracketLeft") {
      e.preventDefault();
      toggleSide("left");
    } else if (e.code === "BracketRight") {
      e.preventDefault();
      toggleSide("right");
    }
  });

  updateCollapseButtonTitles();
}

function initResizablePanels(): void {
  const workspace = document.querySelector<HTMLDivElement>(".workspace");
  if (!workspace) return;
  const leftPanel = document.querySelector<HTMLElement>(".panel-left")!;
  const rightPanel = document.querySelector<HTMLElement>(".panel-right")!;

  workspace.querySelectorAll<HTMLElement>(".panel-gutter").forEach((gutter) => {
    gutter.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const side = gutter.dataset.gutter;
      const startX = event.clientX;
      const startLeft = leftPanel.getBoundingClientRect().width;
      const startRight = rightPanel.getBoundingClientRect().width;
      const workspaceWidth = workspace.getBoundingClientRect().width;

      gutter.classList.add("dragging");
      gutter.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent): void => {
        const dx = moveEvent.clientX - startX;
        if (side === "left") {
          const maxLeft = Math.max(
            MIN_LEFT_PANEL,
            workspaceWidth - startRight - MIN_CENTER_PANEL - 28,
          );
          const nextLeft = clamp(startLeft + dx, MIN_LEFT_PANEL, maxLeft);
          document.documentElement.style.setProperty(
            "--left-panel-width",
            `${nextLeft}px`,
          );
        }

        if (side === "right") {
          const maxRight = Math.max(
            MIN_RIGHT_PANEL,
            workspaceWidth - startLeft - MIN_CENTER_PANEL - 28,
          );
          const nextRight = clamp(startRight - dx, MIN_RIGHT_PANEL, maxRight);
          document.documentElement.style.setProperty(
            "--right-panel-width",
            `${nextRight}px`,
          );
        }
      };

      const onUp = (upEvent: PointerEvent): void => {
        gutter.classList.remove("dragging");
        gutter.releasePointerCapture(upEvent.pointerId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        requestViewerResize();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  });
}

function initComparisonResize(): void {
  syncComparisonLayout();
}

// Maps the backend's machine-readable Sketchfab error code to a localized,
// user-friendly message. Always returns a complete, self-contained message
// with the "Error:" prefix applied exactly once (no double-prefix like
// "Błąd: Błąd"). Unknown/legacy errors fall back to the raw text.
function friendlySketchfabError(err: unknown): string {
  const prefix = IntLayer.t.sketchfabError + ": ";
  const text = String(err);
  const m = text.match(/(SKETCHFAB_[A-Z_]+)(?::|$)/);
  if (m) {
    const key = m[1] as keyof typeof IntLayer.t;
    const localized = (IntLayer.t as Record<string, string>)[key];
    if (localized && localized !== IntLayer.t.sketchfabError) {
      return prefix + localized;
    }
  }
  const cleaned = text.replace("Sketchfab API error (", "").replace("):", "");
  return prefix + cleaned;
}

async function runAnalysis(): Promise<void> {
  if (!currentAbsolutePath) return;

  const analyzeBtn = getEl<HTMLButtonElement>("analyze-btn");
  const outputPre = getEl<HTMLElement>("output");
  const processTimer = getEl<HTMLDivElement>("process-timer");

  switchTab("mesh");
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML =
    '<div class="spinner"></div><span data-i18n="btnAnalyzeLoad"></span>';
  IntLayer.translateAll(analyzeBtn);
  setQualityAvailability(false);

  const startTime = Date.now();
  timerInterval = window.setInterval(() => {
    processTimer.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  }, 100);

  try {
    const result = await ProcessModel(
      currentAbsolutePath,
      currentBpp,
      currentSteps,
    );
    const parsedJson = parseTelemetry(result);
    currentRawTelemetry = result;
    currentTelemetryData = parsedJson;
    await hydrateViewers(parsedJson);
    renderZonesList((parsedJson.zones as BuildingZone[]) || []);
    if (typeof parsedJson.environment_splat_path === "string" && parsedJson.environment_splat_path) {
      currentSplatPath = String(parsedJson.environment_splat_path);
      autoSplatCache = null;
    }
    outputPre.innerHTML = renderTelemetryHTML(parsedJson);
    initTelemetryCharts(parsedJson);
    analyzeBtn.innerHTML = '<span data-i18n="btnAnalyzeSuccess"></span>';
    IntLayer.translateAll(analyzeBtn);
    await runAdvice(result, parsedJson);
  } catch (error) {
    outputPre.innerHTML = `<div style="color: red;">${IntLayer.t.errorFailed}: ${String(error)}</div>`;
    analyzeBtn.innerHTML = '<span data-i18n="btnAnalyzeFailed"></span>';
    IntLayer.translateAll(analyzeBtn);
  } finally {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    analyzeBtn.disabled = false;
  }
}

async function hydrateViewers(telemetry: PipelineTelemetry): Promise<void> {
  const viewerUSD = getEl("viewer-usd") as any;
  const viewerPlaceholder = getEl<HTMLDivElement>("viewer-placeholder");

  // Respect USD stage metersPerUnit when running against an older Core image that exported raw units
  const twinMeta = telemetry.twin_manifest as
    | { meters_per_unit?: number }
    | undefined;
  const rawMpu = Number(twinMeta?.meters_per_unit ?? 1);
  const alreadyScaled = Boolean(telemetry.proxy_scaled_to_meters);
  setUnitScale(!alreadyScaled && Number.isFinite(rawMpu) && rawMpu > 0 ? rawMpu : 1);
  clearMeasurements();
  restorePinsForCurrentAsset();
  topViewActive = false;
  getEl<HTMLButtonElement>("btn-top-view").classList.remove("active");

  // Reset camera framing when loading a fresh processed model
  viewerUSD.cameraOrbit = "auto auto auto";
  viewerUSD.cameraTarget = "auto auto auto";
  viewerUSD.fieldOfView = "auto";

  const meshPath = resolveMeshPath(telemetry);
  if (meshPath) {
    const meshUrl = localFileUrl(meshPath);
    viewerUSD.src = meshUrl;
    viewerUSD.style.display = "block";
    viewerPlaceholder.style.display = "none";

    // Fix trimesh black base color export and apply texture
    viewerUSD.addEventListener(
      "load",
      async () => {
        if (viewerUSD.src !== meshUrl) return; // Prevent race conditions
        const material = viewerUSD.model?.materials[0];
        if (material) {
          material.pbrMetallicRoughness.setBaseColorFactor([1, 1, 1, 1]);

          // Load original texture for the MESH tab
          const originalPath =
            telemetry.ntc_compressed_files?.[0]?.original_path;
          if (originalPath) {
            try {
              const hostPath = toHostPath(originalPath);
              const texUrl = localFileUrl(hostPath);
              const texture = await viewerUSD.createTexture(texUrl);
              if (viewerUSD.src === meshUrl) {
                material.pbrMetallicRoughness.baseColorTexture.setTexture(
                  texture,
                );
                autoSplatCache = null;
              }
            } catch (e) {
              console.warn("[Nequ3D] Failed to apply texture to MESH tab", e);
            }
          }
        }
        if (isSectionEnabled()) applySectionPlane();
      },
      { once: true },
    );
  } else {
    viewerUSD.src = "";
    viewerUSD.style.display = "none";
    viewerPlaceholder.style.display = "flex";
  }

  await hydrateQualityViewer(telemetry);
  switchTab(activeMode);
}

async function hydrateQualityViewer(
  telemetry: PipelineTelemetry,
): Promise<void> {
  const qualityAsset = findQualityAsset(telemetry);

  if (!qualityAsset?.original_path || !qualityAsset?.reconstructed_path) {
    pendingQualitySpec = null;
    hydratedQualityKey = "";
    setQualityAvailability(false);
    return;
  }

  const originalPath = toHostPath(qualityAsset.original_path);
  const reconstructedPath = toHostPath(qualityAsset.reconstructed_path);
  const glbPath = resolveMeshPath(telemetry);

  if (!originalPath || !reconstructedPath || !glbPath) {
    pendingQualitySpec = null;
    hydratedQualityKey = "";
    setQualityAvailability(false);
    return;
  }

  // Defer mounting the 2 extra <model-viewer> instances until the user opens the Quality tab.
  pendingQualitySpec = {
    originalUrl: localFileUrl(originalPath),
    reconstructedUrl: localFileUrl(reconstructedPath),
    glbUrl: localFileUrl(glbPath),
  };
  hydratedQualityKey = "";
  comparisonState.split = 50;
  setQualityAvailability(true);
}

function syncQualityCamera(jump = false): void {
  const viewerOrig = getEl<any>("viewer-orig");
  const viewerNtc = getEl<any>("viewer-ntc");
  if (!viewerOrig?.src || !viewerNtc?.src) return;
  try {
    const orbit = viewerOrig.getCameraOrbit?.();
    const target = viewerOrig.getCameraTarget?.();
    const fov = viewerOrig.getFieldOfView?.();
    if (orbit) {
      viewerNtc.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`;
    }
    if (target) {
      viewerNtc.cameraTarget = `${target.x}m ${target.y}m ${target.z}m`;
    }
    if (typeof fov === "number" && Number.isFinite(fov)) {
      viewerNtc.fieldOfView = `${fov}deg`;
    }
    if (jump) {
      viewerNtc.jumpCameraToGoal?.();
    }
  } catch {
    /* ignore until both models finish framing */
  }
}

async function setQualityTextures(
  originalUrl: string,
  reconstructedUrl: string,
  glbUrl: string,
): Promise<void> {
  const viewerOrig = getEl<any>("viewer-orig");
  const viewerNtc = getEl<any>("viewer-ntc");

  setQualityAvailability(true);
  comparisonState.split = 50;

  // Reset BOTH cameras before loading a new model so previous model's orbit radius never lingers
  for (const v of [viewerOrig, viewerNtc]) {
    v.cameraOrbit = "auto auto auto";
    v.cameraTarget = "auto auto auto";
    v.fieldOfView = "auto";
  }

  viewerOrig.src = glbUrl;
  viewerNtc.src = glbUrl;

  const applyTexture = async (viewer: any, textureUrl: string) => {
    try {
      if (viewer.src !== glbUrl) return;
      const material = viewer.model?.materials[0];
      if (material) {
        material.pbrMetallicRoughness.setBaseColorFactor([1, 1, 1, 1]);
        const texture = await viewer.createTexture(textureUrl);
        if (viewer.src === glbUrl) {
          material.pbrMetallicRoughness.baseColorTexture.setTexture(texture);
        }
      }
    } catch (e) {
      console.warn("[Nequ3D] Failed to apply texture to model-viewer", e);
    }
  };

  viewerOrig.addEventListener(
    "load",
    async () => {
      await applyTexture(viewerOrig, originalUrl);
      viewerOrig.jumpCameraToGoal?.();
      syncQualityCamera(true);
    },
    { once: true },
  );
  viewerNtc.addEventListener(
    "load",
    async () => {
      await applyTexture(viewerNtc, reconstructedUrl);
      syncQualityCamera(true);
    },
    { once: true },
  );

  syncComparisonLayout();
}

function syncComparisonLayout(): void {
  const layer = getEl<HTMLDivElement>("comparison-layer");
  const viewerNtc = getEl<HTMLElement>("viewer-ntc");
  const divider = getEl<HTMLDivElement>("comp-divider");
  const split = clamp(comparisonState.split, 0, 100);

  layer.style.setProperty("--split", `${split}%`);
  divider.style.left = `${split}%`;
  viewerNtc.style.clipPath = `polygon(${split}% 0, 100% 0, 100% 100%, ${split}% 100%)`;
}

function syncHybridLayout(): void {
  const splatLayer = getEl<HTMLDivElement>("viewer-hybrid-splat");
  const divider = getEl<HTMLDivElement>("hybrid-divider");
  const split = clamp(comparisonState.hybridSplit, 0, 100);

  divider.style.left = `${split}%`;
  splatLayer.style.clipPath = `polygon(${split}% 0, 100% 0, 100% 100%, ${split}% 100%)`;
}

async function resolveSplatSource(
  viewerUSD: HTMLElement & { src?: string },
): Promise<SplatSource | null> {
  if (currentSplatPath) {
    return {
      kind: "url",
      url: localFileUrl(currentSplatPath),
      ext: getExt(currentSplatPath),
    };
  }
  const meshSrc = viewerUSD.src || "";
  if (!meshSrc) return null;

  if (
    autoSplatCache &&
    autoSplatCache.meshSrc === meshSrc &&
    autoSplatCache.splat.buffer.byteLength > 0
  ) {
    return {
      kind: "buffer",
      buffer: autoSplatCache.splat.buffer,
      radius: autoSplatCache.splat.radius,
      center: autoSplatCache.splat.center,
    };
  }

  const converted = await convertViewerMeshToSplatBuffer(viewerUSD, 950000);
  if (!converted) return null;
  autoSplatCache = { meshSrc, splat: converted };
  return {
    kind: "buffer",
    buffer: converted.buffer,
    radius: converted.radius,
    center: converted.center,
  };
}

function showSplatFallback(placeholder: HTMLDivElement, text: string): void {
  placeholder.style.display = "flex";
  placeholder.innerHTML = `<div>${text}</div>`;
}

async function hydrateHybridMeshMaterial(
  meshViewer: any,
  meshSrc: string,
): Promise<void> {
  const apply = async () => {
    if (meshViewer.src !== meshSrc) return;
    const material = meshViewer.model?.materials?.[0];
    if (!material) return;
    material.pbrMetallicRoughness.setBaseColorFactor([1, 1, 1, 1]);
    const originalPath =
      currentTelemetryData?.ntc_compressed_files?.[0]?.original_path;
    if (originalPath) {
      try {
        const texUrl = localFileUrl(toHostPath(originalPath));
        const texture = await meshViewer.createTexture(texUrl);
        if (meshViewer.src === meshSrc) {
          material.pbrMetallicRoughness.baseColorTexture.setTexture(texture);
        }
      } catch (e) {
        console.warn("[Nequ3D] Failed to apply texture to HYBRID mesh", e);
      }
    }
  };
  if (meshViewer.src !== meshSrc) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = window.setTimeout(finish, 4000);
      meshViewer.addEventListener(
        "load",
        () => {
          window.clearTimeout(timer);
          void apply().finally(finish);
        },
        { once: true },
      );
      meshViewer.src = meshSrc;
    });
  } else if (!meshViewer.loaded) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, 4000);
      meshViewer.addEventListener(
        "load",
        () => {
          window.clearTimeout(timer);
          void apply().finally(resolve);
        },
        { once: true },
      );
    });
  } else if (meshViewer.model) {
    await apply();
  }
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

async function switchTab(mode: ViewerMode): Promise<void> {
  const seq = ++tabSwitchSeq;
  activeMode = mode;

  const viewerUSD = getEl<HTMLElement>("viewer-usd") as HTMLElement & {
    src?: string;
  };
  const qualityLayer = getEl<HTMLDivElement>("viewer-quality");
  const splatHost = getEl<HTMLDivElement>("viewer-splat");
  const hybridHost = getEl<HTMLDivElement>("viewer-hybrid");
  const placeholder = getEl<HTMLDivElement>("viewer-placeholder");

  [
    getEl<HTMLButtonElement>("tab-mesh"),
    getEl<HTMLButtonElement>("tab-quality"),
    getEl<HTMLButtonElement>("tab-splat"),
    getEl<HTMLButtonElement>("tab-hybrid"),
  ].forEach((tab) => tab.classList.remove("active"));

  [viewerUSD, qualityLayer, splatHost, hybridHost, placeholder].forEach(
    (layer) => {
      layer.style.display = "none";
    },
  );

  if (mode !== "splat" && mode !== "hybrid") {
    await unmountSplatViewer();
    if (seq !== tabSwitchSeq) return;
  }

  if (mode === "mesh") {
    getEl<HTMLButtonElement>("tab-mesh").classList.add("active");
    const hasMesh = Boolean(viewerUSD.src);
    viewerUSD.style.display = hasMesh ? "block" : "none";
    if (hasMesh) triggerViewerBlurEnter(viewerUSD);
    placeholder.style.display = hasMesh ? "none" : "flex";
    if (!hasMesh) {
      placeholder.innerHTML = `<div data-i18n="viewerEmptyTitle">${IntLayer.t.viewerEmptyTitle}</div>`;
    }
  }

  if (mode === "quality") {
    getEl<HTMLButtonElement>("tab-quality").classList.add("active");
    if (qualityAvailable) {
      qualityLayer.style.display = "block";
      triggerViewerBlurEnter(qualityLayer);
      syncComparisonLayout();
      if (pendingQualitySpec) {
        const key = `${pendingQualitySpec.glbUrl}|${pendingQualitySpec.originalUrl}|${pendingQualitySpec.reconstructedUrl}`;
        if (hydratedQualityKey !== key) {
          hydratedQualityKey = key;
          await nextPaint();
          if (seq !== tabSwitchSeq) return;
          await setQualityTextures(
            pendingQualitySpec.originalUrl,
            pendingQualitySpec.reconstructedUrl,
            pendingQualitySpec.glbUrl,
          );
        }
      }
      requestAnimationFrame(() => syncQualityCamera(true));
    } else {
      placeholder.style.display = "flex";
    }
  }

  if (mode === "splat") {
    getEl<HTMLButtonElement>("tab-splat").classList.add("active");
    if (!navHudUserToggled) setNavHudVisible(true);
    splatHost.innerHTML = `<div class="measure-hint" style="padding:16px; display:flex; align-items:center; justify-content:center; height:100%;">Loading 3DGS…</div>`;
    splatHost.style.display = "block";
    triggerViewerBlurEnter(splatHost);
    // Yield to browser paint before reading textures / launching worker (keeps INP < 10 ms)
    await nextPaint();
    if (seq !== tabSwitchSeq) return;
    const source = await resolveSplatSource(viewerUSD);
    if (seq !== tabSwitchSeq) return;
    if (!source) {
      splatHost.style.display = "none";
      showSplatFallback(placeholder, IntLayer.t.hybridWaiting);
      return;
    }
    try {
      await mountSplatViewer(splatHost, source);
    } catch (e) {
      console.error("[Nequ3D] 3DGS mount failed", e);
      splatHost.style.display = "none";
      showSplatFallback(
        placeholder,
        IntLayer.currentLang === "pl"
          ? `Nie udało się wyrenderować 3DGS: ${String(e)}`
          : `Failed to render 3DGS: ${String(e)}`,
      );
    }
  }

  if (mode === "hybrid") {
    getEl<HTMLButtonElement>("tab-hybrid").classList.add("active");
    const meshViewer = getEl("viewer-hybrid-mesh") as any;
    const meshSrc = viewerUSD.src;
    if (!meshSrc) {
      showSplatFallback(placeholder, IntLayer.t.hybridWaiting);
      return;
    }
    hybridHost.style.display = "block";
    triggerViewerBlurEnter(hybridHost);
    syncHybridLayout();
    await nextPaint();
    if (seq !== tabSwitchSeq) return;
    const source = await resolveSplatSource(viewerUSD);
    if (seq !== tabSwitchSeq) return;
    if (!source) {
      hybridHost.style.display = "none";
      showSplatFallback(placeholder, IntLayer.t.hybridWaiting);
      return;
    }
    guardModelViewerArBug();
    const targetOrientation = `${rotX}deg ${rotY}deg ${rotZ}deg`;
    if (meshViewer.orientation !== targetOrientation) {
      meshViewer.orientation = targetOrientation;
    }
    await hydrateHybridMeshMaterial(meshViewer, meshSrc);
    if (seq !== tabSwitchSeq) return;
    try {
      const orbit = (viewerUSD as any).getCameraOrbit?.();
      const target = (viewerUSD as any).getCameraTarget?.();
      const fov = (viewerUSD as any).getFieldOfView?.();
      if (orbit) {
        meshViewer.cameraOrbit = `${orbit.theta}rad ${orbit.phi}rad ${orbit.radius}m`;
      }
      if (target) {
        meshViewer.cameraTarget = `${target.x}m ${target.y}m ${target.z}m`;
      }
      if (typeof fov === "number" && Number.isFinite(fov)) {
        meshViewer.fieldOfView = `${fov}deg`;
      }
      meshViewer.jumpCameraToGoal?.();
    } catch {
      /* ignore if orbit not yet ready */
    }
    try {
      await mountSplatViewer(
        getEl<HTMLDivElement>("viewer-hybrid-splat"),
        source,
        {
          syncViewer: meshViewer,
          syncCenter: source.kind === "buffer" ? source.center : undefined,
        },
      );
    } catch (e) {
      console.error("[Nequ3D] Hybrid 3DGS mount failed", e);
    }
  }
}

function setQualityAvailability(available: boolean): void {
  qualityAvailable = available;
  const tabQuality = getEl<HTMLButtonElement>("tab-quality");
  tabQuality.hidden = !available;
  if (!available && activeMode === "quality") {
    switchTab("mesh");
  }
}

async function routeSelectedAsset(path: string): Promise<void> {
  if (!isSupportedAsset(path)) {
    currentAbsolutePath = "";
    currentModelDir = "";
    getEl<HTMLDivElement>("file-path").textContent =
      `Unsupported asset format: ${getExt(path) || "unknown"}`;
    getEl<HTMLButtonElement>("analyze-btn").disabled = true;
    return;
  }

  if (isSplatAsset(path)) {
    currentSplatPath = path;
    autoSplatCache = null;
    getEl<HTMLDivElement>("file-path").textContent = path;
    getEl<HTMLButtonElement>("analyze-btn").disabled = !currentAbsolutePath;
    await switchTab("splat");
    return;
  }

  setMeshPath(path);
  setQualityAvailability(false);

  if (isMeshRenderable(path)) {
    await previewMeshAsset(path);
  } else {
    clearMeshPreview();
  }

  await switchTab("mesh");
}

function setMeshPath(path: string): void {
  currentAbsolutePath = path;
  currentModelDir = getDirectory(path);
  currentSplatPath = "";
  autoSplatCache = null;
  setUnitScale(1);
  clearMeasurements();
  restorePinsForCurrentAsset();
  topViewActive = false;
  getEl<HTMLButtonElement>("btn-top-view").classList.remove("active");
  getEl<HTMLDivElement>("file-path").textContent = path;
  getEl<HTMLButtonElement>("analyze-btn").disabled = false;
}

async function previewMeshAsset(path: string): Promise<void> {
  const viewerUSD = getEl("viewer-usd") as HTMLElement & { src?: string };
  const viewerPlaceholder = getEl<HTMLDivElement>("viewer-placeholder");
  const meshUrl = localFileUrl(path);

  viewerUSD.src = meshUrl;
  viewerUSD.style.display = "block";
  viewerPlaceholder.style.display = "none";
}

function clearMeshPreview(): void {
  const viewerUSD = getEl("viewer-usd") as HTMLElement & { src?: string };
  const viewerPlaceholder = getEl<HTMLDivElement>("viewer-placeholder");

  viewerUSD.src = "";
  viewerUSD.style.display = "none";
  viewerPlaceholder.style.display = "flex";
}

async function runAdvice(
  rawTelemetry: string,
  parsedTelemetry: PipelineTelemetry,
): Promise<void> {
  const aiOutput = getEl<HTMLDivElement>("ai-output");
  aiOutput.innerHTML = `<div class="status-pill"><div class="spinner"></div><span>${IntLayer.t.aiLoading}</span></div>`;

  let imageBase64 = "";
  const selectedModel = getSelectedModel();

  let debugHtml = "";
  if (selectedModel === "llava") {
    // Wait slightly to ensure the model-viewer has fully rendered the new mesh
    await new Promise((resolve) => setTimeout(resolve, 800));
    try {
      const viewerId = activeMode === "quality" ? "viewer-ntc" : "viewer-usd";
      const viewer = getEl<any>(viewerId);

      if (viewer && typeof viewer.toBlob === "function") {
        const blob = await viewer.toBlob();
        if (blob) {
          imageBase64 = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
        } else {
          debugHtml = `<div style="color:red; font-size:10px;">[Debug] toBlob returned null</div>`;
        }
      } else if (viewer && viewer.shadowRoot) {
        const canvas = viewer.shadowRoot.querySelector("canvas");
        if (canvas) {
          imageBase64 = canvas.toDataURL("image/jpeg", 0.85);
        } else {
          debugHtml = `<div style="color:red; font-size:10px;">[Debug] No canvas found in shadowRoot</div>`;
        }
      }
    } catch (e) {
      debugHtml = `<div style="color:red; font-size:10px;">[Debug] Exception: ${e}</div>`;
    }

    if (imageBase64) {
      debugHtml = `<img src="${imageBase64}" style="width:100px; border:2px solid lime; display:block; margin-bottom:10px;" />`;
    } else if (!debugHtml) {
      debugHtml = `<div style="color:red; font-size:10px;">[Debug] Image capture failed silently.</div>`;
    }

    aiOutput.innerHTML =
      `<div class="status-pill"><div class="spinner"></div><span>${IntLayer.t.aiLoading}</span></div>` +
      debugHtml;
  }

  const payload = JSON.stringify({
    model: selectedModel,
    language: IntLayer.currentLang === "pl" ? "Polish" : "English",
    analysis_mode: qualityAvailable ? "mesh_ntc" : "geometry_only",
    ntc_bypassed: !qualityAvailable || Boolean(parsedTelemetry.ntc_bypassed),
    telemetry: parsedTelemetry,
    raw_telemetry: rawTelemetry,
    image_base64: imageBase64,
  });

  let streamedText = "";
  let isStreaming = false;

  const unbindToken = Events.On("llmToken", (event: any) => {
    const token = event.data[0] || "";
    if (!isStreaming) {
      aiOutput.innerHTML = "";
      isStreaming = true;
    }
    streamedText += token;

    // Clean conversational preamble dynamically (EN + PL)
    let displayText = streamedText;
    const objectMatch =
      displayText.match(/- (?:\*\*)?(?:Object|Obiekt):/i) ||
      displayText.match(/\* (?:\*\*)?(?:Object|Obiekt):/i);
    if (objectMatch && objectMatch.index && objectMatch.index > 0) {
      displayText = displayText.substring(objectMatch.index);
    }

    aiOutput.innerHTML =
      debugHtml +
      `<div class="ai-insight-card">${formatMarkdown(displayText)}</div>`;
    aiOutput.scrollTop = aiOutput.scrollHeight;
  });

  const unbindDone = Events.On("llmDone", () => {
    unbindToken();
    unbindDone();
  });

  try {
    const aiResponse = await GenerateRenovationAdvice(payload);
    if (!isStreaming) {
      aiOutput.innerHTML = debugHtml;
      typeWriter(
        `<div class="ai-insight-card">${formatMarkdown(aiResponse)}</div>`,
        aiOutput,
      );
    } else {
      let finalResponse = aiResponse;
      const objectMatch =
        finalResponse.match(/- Object:/i) ||
        finalResponse.match(/- \*\*Object:/i);
      if (objectMatch && objectMatch.index && objectMatch.index > 0) {
        finalResponse = finalResponse.substring(objectMatch.index);
      }
      aiOutput.innerHTML =
        debugHtml +
        `<div class="ai-insight-card">${formatMarkdown(finalResponse)}</div>`;
    }
  } catch (error) {
    aiOutput.textContent = String(error);
  } finally {
    unbindToken();
    unbindDone();
  }
}

function formatMarkdown(markdown: string): string {
  return markdown
    .replace(
      /\*\*(.*?)\*\*/g,
      '<strong style="color: var(--accent-teal);">$1</strong>',
    )
    .replace(
      /(?:^|\n)(?:-|\*) (.*?)(?=\n|$)/g,
      '<div style="margin-left: 12px; margin-bottom: 6px; display: flex; gap: 8px; align-items: start;"><span style="color: var(--accent-teal);">•</span> <span>$1</span></div>',
    )
    .replace(/\n/g, "<br>");
}

function typeWriter(html: string, target: HTMLElement): void {
  let charIndex = 0;
  target.innerHTML = "";

  const tick = (): void => {
    if (charIndex >= html.length) return;
    if (html.charAt(charIndex) === "<") {
      let tag = "";
      while (html.charAt(charIndex) !== ">" && charIndex < html.length) {
        tag += html.charAt(charIndex);
        charIndex++;
      }
      target.innerHTML += `${tag}>`;
      charIndex++;
      tick();
      return;
    }
    target.innerHTML += html.charAt(charIndex);
    charIndex++;
    window.setTimeout(tick, 5);
  };

  tick();
}

function normalizeStatsEvent(event: unknown): SysStats | null {
  const eventLike = event as { data?: unknown };
  const candidates = [eventLike?.data, event];

  for (const candidate of candidates) {
    const payload = Array.isArray(candidate) ? candidate[0] : candidate;
    const parsed =
      typeof payload === "string"
        ? safeJsonParse<Record<string, unknown>>(payload)
        : payload;
    if (!parsed || typeof parsed !== "object") continue;

    const record = parsed as Record<string, unknown>;
    const gpu = Number(record.gpu ?? record.GPU);
    const vram = Number(record.vram ?? record.VRAM);
    const time = String(record.time ?? record.Time ?? "");
    const availableRaw = record.available ?? record.Available;
    const available =
      typeof availableRaw === "boolean" ? availableRaw : undefined;
    const messageValue = record.message ?? record.Message;
    const message = typeof messageValue === "string" ? messageValue : undefined;

    if (Number.isFinite(gpu) && Number.isFinite(vram)) {
      return { time, gpu, vram, available, message };
    }
  }

  return null;
}

function updateSystemStats(stats: SysStats): void {
  const gpu = clamp(stats.gpu, 0, 100);
  const vram = clamp(stats.vram, 0, 100);
  const gpuText = getEl<HTMLSpanElement>("gpu-text");
  const vramText = getEl<HTMLSpanElement>("vram-text");
  const gpuBar = getEl<HTMLDivElement>("gpu-bar");
  const vramBar = getEl<HTMLDivElement>("vram-bar");

  if (stats.available === false) {
    if (gpuText.textContent !== "N/A") gpuText.textContent = "N/A";
    if (vramText.textContent !== "--") vramText.textContent = "--";
    gpuBar.style.transform = "scaleX(0)";
    vramBar.style.transform = "scaleX(0)";
    return;
  }

  const gpuStr = `${gpu.toFixed(1)}%`;
  const vramStr = `${vram.toFixed(1)}%`;
  if (gpuText.textContent !== gpuStr) gpuText.textContent = gpuStr;
  if (vramText.textContent !== vramStr) vramText.textContent = vramStr;
  gpuBar.style.transform = `scaleX(${(gpu / 100).toFixed(3)})`;
  vramBar.style.transform = `scaleX(${(vram / 100).toFixed(3)})`;
}

function parseTelemetry(raw: string): PipelineTelemetry {
  // Usuwamy absolutnie wszystko co jest ANSI i carriage returns
  const cleanRaw = raw
    .replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      "",
    )
    .replace(/\r/g, "");
  const parsed = JSON.parse(cleanRaw) as PipelineTelemetry;
  return parsed;
}

function resolveMeshPath(telemetry: PipelineTelemetry): string {
  const proxy = telemetry.proxy_glb_path
    ? toHostPath(telemetry.proxy_glb_path)
    : "";
  if (proxy) return proxy;
  if (isMeshRenderable(currentAbsolutePath)) return currentAbsolutePath;
  if (isUSDAsset(currentAbsolutePath)) {
    return currentAbsolutePath.replace(
      /\.(usd|usdc|usda|usdz)$/i,
      "_proxy.glb",
    );
  }
  return "";
}

function findQualityAsset(telemetry: PipelineTelemetry): NtcAsset | null {
  const assets = telemetry.ntc_compressed_files;
  if (!Array.isArray(assets)) return null;
  return (
    assets.find(
      (asset) =>
        asset.original_path &&
        !asset.error &&
        !String(asset.status || "")
          .toLowerCase()
          .includes("skipped"),
    ) || null
  );
}

function localFileUrl(path: string): string {
  return `${LOCAL_FILE_ENDPOINT}${encodeURIComponent(toHostPath(path))}`;
}

function toHostPath(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/^file:\/\//i, "");
  const workspacePrefix = "/tmp/workspace/";
  const windowsWorkspacePrefix = "\\tmp\\workspace\\";

  // Container workspace paths are resolved by the Go preview server.
  if (trimmed.startsWith(workspacePrefix)) return trimmed;
  if (trimmed.startsWith(windowsWorkspacePrefix)) {
    return trimmed.replace(/\\/g, "/");
  }
  if (isWindowsAbsolute(trimmed) || trimmed.startsWith("/")) return trimmed;
  if (currentModelDir)
    return `${currentModelDir}${trimmed.replace(/\//g, "\\")}`;
  return trimmed;
}

function getDirectory(path: string): string {
  const slash = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (slash < 0) return "";
  return `${path.slice(0, slash)}${path.includes("\\") ? "\\" : "/"}`;
}

function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function getExt(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot).toLowerCase() : "";
}

function isMeshRenderable(path: string): boolean {
  return [".glb", ".gltf"].includes(getExt(path));
}

function isSplatAsset(path: string): boolean {
  return [".splat", ".ply"].includes(getExt(path));
}

function isUSDAsset(path: string): boolean {
  return [".usd", ".usdc", ".usda", ".usdz"].includes(getExt(path));
}

function isSupportedAsset(path: string): boolean {
  return isUSDAsset(path) || isMeshRenderable(path) || isSplatAsset(path);
}

function translateZoneStatus(status: string): string {
  switch (status) {
    case "ok":
      return IntLayer.t.zoneStatusOk;
    case "replace":
      return IntLayer.t.zoneStatusReplace;
    default:
      return IntLayer.t.zoneStatusUnknown;
  }
}

function renderZonesList(zones: BuildingZone[]): void {
  const list = getEl<HTMLDivElement>("zones-list");
  if (!zones.length) {
    list.innerHTML = `<div class="measure-hint" data-i18n="zonesEmpty">${IntLayer.t.zonesEmpty}</div>`;
    return;
  }

  // Preserve unsaved status selections across language switches
  const liveStatuses = new Map<string, string>();
  list
    .querySelectorAll<HTMLSelectElement>("[data-zone-status]")
    .forEach((sel) => {
      const id = sel.getAttribute("data-zone-status");
      if (id) liveStatuses.set(id, sel.value);
    });

  list.innerHTML = zones
    .map((z) => {
      const id = z.id || "zone";
      const label = z.label || id;
      const status = liveStatuses.get(id) || z.status || "unknown";
      z.status = status;
      const primCount = z.prim_count ?? 0;
      const safeId = escapeHtml(id);
      const safeLabel = escapeHtml(label);
      return `<div class="measure-row" data-zone-id="${safeId}">
        <div><strong>${safeLabel}</strong><div class="measure-hint" data-zone-meta="${safeId}">${translateZoneStatus(status)} · ${primCount} ${IntLayer.t.zonePrims}</div></div>
        <select id="zone-status-${safeId}" name="zone-status-${safeId}" aria-label="${safeLabel}" data-zone-status="${safeId}" class="technical-select" style="width:auto;min-width:110px;">
          <option value="unknown"${status === "unknown" ? " selected" : ""}>${IntLayer.t.zoneStatusUnknown}</option>
          <option value="ok"${status === "ok" ? " selected" : ""}>${IntLayer.t.zoneStatusOk}</option>
          <option value="replace"${status === "replace" ? " selected" : ""}>${IntLayer.t.zoneStatusReplace}</option>
        </select>
      </div>`;
    })
    .join("");

  list
    .querySelectorAll<HTMLSelectElement>("[data-zone-status]")
    .forEach((sel) => {
      sel.addEventListener("change", () => {
        const id = sel.getAttribute("data-zone-status") || "";
        const nextStatus = sel.value;
        const zone = zones.find((z) => (z.id || "zone") === id);
        if (zone) zone.status = nextStatus;
        const meta = list.querySelector<HTMLElement>(
          `[data-zone-meta="${CSS.escape(id)}"]`,
        );
        if (meta) {
          const primCount = zone?.prim_count ?? 0;
          meta.textContent = `${translateZoneStatus(nextStatus)} · ${primCount} ${IntLayer.t.zonePrims}`;
        }
      });
    });
}

async function saveTwinAnnotations(): Promise<void> {
  const status = getEl<HTMLDivElement>("twin-save-status");
  const twinDir = String(currentTelemetryData?.twin_dir || "");
  if (!twinDir) {
    status.innerHTML = `<span data-i18n="saveTwinFail">${IntLayer.t.saveTwinFail}</span>`;
    return;
  }
  const zoneSelects = Array.from(
    document.querySelectorAll<HTMLSelectElement>("[data-zone-status]"),
  );
  const zones = zoneSelects.map((el) => ({
    id: el.getAttribute("data-zone-status"),
    status: el.value,
  }));
  try {
    const result = await SaveTwinAnnotations(
      JSON.stringify({
        twin_dir: twinDir,
        measurements: getMeasurements(),
        zones,
        detections: lastDetections,
        annotations: getPinNotes(),
      }),
    );
    const parsed = safeJsonParse<{
      twin_manifest_path?: string;
      status?: string;
      sha256?: string;
    }>(result);
    const path =
      parsed?.twin_manifest_path ||
      String(currentTelemetryData?.twin_manifest_path || twinDir);
    const hash = parsed?.sha256 ? ` · sha256 ${parsed.sha256.slice(0, 12)}…` : "";
    status.innerHTML = `<span data-i18n="saveTwinOk">${IntLayer.t.saveTwinOk}</span>: ${escapeHtml(path)}${escapeHtml(hash)}`;
  } catch (e) {
    status.innerHTML = `<span data-i18n="saveTwinFail">${IntLayer.t.saveTwinFail}</span>: ${escapeHtml(String(e))}`;
  }
}

async function captureViewerImage(): Promise<string> {
  const viewerId = activeMode === "quality" ? "viewer-ntc" : "viewer-usd";
  const viewer = getEl<any>(viewerId);
  if (viewer && typeof viewer.toBlob === "function") {
    const blob = await viewer.toBlob();
    if (blob) {
      return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(blob);
      });
    }
  }
  if (viewer?.shadowRoot) {
    const canvas = viewer.shadowRoot.querySelector("canvas") as
      | HTMLCanvasElement
      | null;
    if (canvas) return canvas.toDataURL("image/jpeg", 0.85);
  }
  return "";
}

async function runLocateFromViewer(): Promise<void> {
  const list = getEl<HTMLDivElement>("locate-list");
  list.innerHTML = `<div class="measure-hint">${IntLayer.t.locateRunning}</div>`;
  try {
    const image = await captureViewerImage();
    if (!image) throw new Error("viewer snapshot unavailable");
    const prompt =
      getEl<HTMLInputElement>("locate-prompt").value ||
      "damaged wall, crack, moisture stain, window, door";
    const raw = await LocateObjects(image, prompt);
    lastDetections = JSON.parse(raw);
    const detections =
      (lastDetections as { detections?: Array<Record<string, unknown>> })
        ?.detections || [];
    if (!detections.length) {
      list.innerHTML = `<div class="measure-hint" data-i18n="locateEmpty">${IntLayer.t.locateEmpty}</div>`;
      return;
    }
    list.innerHTML = detections
      .map(
        (d) =>
          `<div class="measure-row"><strong>${String(d.label || "obj")}</strong><span>${Number(d.confidence || 0).toFixed(2)}</span></div>`,
      )
      .join("");
  } catch (e) {
    const msg = String(e);
    const locateDown =
      msg.includes("Connection refused") ||
      msg.includes("LocateAnything on :8000");
    list.innerHTML = "";
    const err = document.createElement("div");
    err.className = "measure-hint";
    err.style.color = "var(--danger, #c44)";
    err.textContent = locateDown
      ? IntLayer.currentLang === "pl"
        ? "Usługa detekcji LocateAnything (:8000) nie jest uruchomiona. Uruchom skrypt z flagą -WithLocate."
        : "LocateAnything detection service (:8000) is not running. Start with -WithLocate."
      : msg;
    list.appendChild(err);
  }
}

function unwrapWailsPayload(event: unknown): unknown {
  const data = (event as { data?: unknown } | null)?.data;
  // Wails may deliver a single string arg as data itself OR as data[0].
  // Indexing a string (data[0]) yields the first character — that broke agent steps.
  if (Array.isArray(data)) return data.length <= 1 ? data[0] : data;
  if (data !== undefined) return data;
  return event;
}

function shortenStepPath(detail: string): string {
  const trimmed = detail.trim();
  if (!trimmed || (!trimmed.includes("\\") && !trimmed.includes("/"))) {
    return trimmed;
  }
  if (/\.[A-Za-z0-9]{1,8}$/.test(trimmed)) {
    const parts = trimmed.split(/[\\/]/);
    const base = parts[parts.length - 1];
    if (base) return base;
  }
  return trimmed;
}

function formatAgentToolLabel(tool: string): string {
  const isPl = IntLayer.currentLang === "pl";
  const map: Record<string, [string, string]> = {
    plan: ["Plan", "Plan"],
    read_manifest: ["Read manifest", "Odczyt manifestu"],
    process_model: ["Process model", "Przetwarzanie modelu"],
    locate_objects: ["Locate objects", "Detekcja obiektów"],
    advice: ["AI summary", "Rekomendacja AI"],
    verify_faithfulness: ["Faithfulness eval", "Weryfikacja wierności"],
    save_annotations: ["Save annotations", "Zapis adnotacji"],
    agent: ["Agent", "Agent"],
  };
  const pair = map[tool];
  return pair ? (isPl ? pair[1] : pair[0]) : tool;
}

function formatAgentStatus(status: string): string {
  const isPl = IntLayer.currentLang === "pl";
  switch (status.toLowerCase()) {
    case "running":
      return isPl ? "w toku" : "running";
    case "ok":
      return isPl ? "gotowe" : "done";
    case "error":
      return isPl ? "błąd" : "error";
    case "skipped":
      return isPl ? "pominięto" : "skipped";
    default:
      return status;
  }
}

function formatAgentDetail(detail: string): string {
  const isPl = IntLayer.currentLang === "pl";
  if (!isPl) return detail;
  const exact: Record<string, string> = {
    "twin_manifest": "manifest bliźniaka 3D",
    "manifest loaded": "manifest wczytany",
    "ollama": "model Ollama",
    "advice ready": "podsumowanie gotowe",
    "offline fallback (Ollama unavailable)": "tryb offline (brak Ollama)",
  };
  return exact[detail] || detail;
}

function appendAgentStep(raw: unknown): void {
  const log = getEl<HTMLDivElement>("agent-log");
  let step: { tool?: string; status?: string; detail?: string } = {};
  try {
    if (typeof raw === "string") {
      step = JSON.parse(raw);
    } else if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      step = {
        tool: String(record.tool ?? record.Tool ?? ""),
        status: String(record.status ?? record.Status ?? ""),
        detail: String(record.detail ?? record.Detail ?? ""),
      };
    } else {
      step = { detail: String(raw) };
    }
  } catch {
    step = { detail: String(raw) };
  }
  const tool = step.tool?.trim() || "step";
  const status = step.status?.trim() || "—";
  let detail = formatAgentDetail(shortenStepPath(step.detail || ""));
  if (detail.length > 180) detail = `${detail.slice(0, 177)}…`;

  if (log.querySelector("[data-i18n='agentEmpty']")) log.innerHTML = "";

  const statusNorm = status.toLowerCase();
  const pillState =
    statusNorm === "running" ||
    statusNorm === "error" ||
    statusNorm === "skipped"
      ? statusNorm
      : "ok";

  // Compact inline pill per tool (updated in place without taking half the sidebar)
  let pill = log.querySelector<HTMLDivElement>(
    `[data-agent-tool="${CSS.escape(tool)}"]`,
  );
  if (!pill) {
    pill = document.createElement("div");
    pill.className = `agent-pill ${pillState}`;
    pill.setAttribute("data-agent-tool", tool);
    const dot = document.createElement("span");
    dot.className = "agent-dot";
    const title = document.createElement("strong");
    const meta = document.createElement("span");
    pill.append(dot, title, meta);
    log.appendChild(pill);
  } else {
    pill.className = `agent-pill ${pillState}`;
  }

  const title = pill.querySelector("strong")!;
  const meta = pill.querySelector("span:last-child")!;
  title.textContent = formatAgentToolLabel(tool);
  meta.textContent = formatAgentStatus(status);
  pill.title = detail ? `${title.textContent}: ${detail}` : title.textContent;
}

async function runRenovationAgent(): Promise<void> {
  const btn = getEl<HTMLButtonElement>("btn-agent");
  getEl<HTMLDivElement>("agent-log").innerHTML = "";
  btn.disabled = true;
  btn.innerHTML = `<span>${IntLayer.t.agentRunning}</span>`;
  try {
    const selectedModel = getSelectedModel();
    const locatePrompt = getEl<HTMLInputElement>("locate-prompt").value.trim();
    const image =
      selectedModel === "llava" || locatePrompt.length > 0
        ? await captureViewerImage()
        : "";
    const result = await RunRenovationAgent(
      JSON.stringify({
        goal: "Prioritize building renovation zones from the Reality Scan twin.",
        model: selectedModel,
        language: IntLayer.currentLang === "pl" ? "Polish" : "English",
        asset_path: currentAbsolutePath,
        bpp: currentBpp,
        steps: currentSteps,
        telemetry: currentRawTelemetry || "",
        image_base64: image,
        locate_prompt: locatePrompt,
      }),
    );
    const parsed = JSON.parse(result);
    if (parsed.telemetry) {
      const rawTelemetry =
        typeof parsed.telemetry === "string"
          ? parsed.telemetry
          : JSON.stringify(parsed.telemetry);
      currentRawTelemetry = rawTelemetry;
      currentTelemetryData = parseTelemetry(rawTelemetry);
      renderZonesList((currentTelemetryData?.zones as BuildingZone[]) || []);
    }
    if (parsed.advice) {
      const cleanedAdvice = stripAiPreamble(String(parsed.advice));
      getEl<HTMLDivElement>("ai-output").innerHTML =
        `<div class="ai-insight-card">${formatMarkdown(cleanedAdvice)}</div>`;
      if (parsed.faithfulness) {
        currentFaithfulness = parsed.faithfulness;
        renderFaithfulnessCard(parsed.faithfulness);
      } else if (currentRawTelemetry) {
        try {
          const evalRaw = await EvaluateAdviceFaithfulness(
            cleanedAdvice,
            currentRawTelemetry,
            IntLayer.currentLang,
          );
          const rep = safeJsonParse<any>(evalRaw);
          if (rep) {
            currentFaithfulness = rep;
            renderFaithfulnessCard(rep);
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    appendAgentStep({ tool: "agent", status: "error", detail: String(e) });
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<span data-i18n="agentBtn">${IntLayer.t.agentBtn}</span>`;
  }
}

function getSelectedModel(): ModelChoice {
  const value = getEl<HTMLSelectElement>("llm-model").value as ModelChoice;
  if (value === "llama3" || value === "mistral" || value === "llava")
    return value;
  return "gemma:2b";
}

function setLanguage(lang: Language): void {
  if (IntLayer.currentLang === lang) return;
  IntLayer.setLanguage(lang);
  updateLanguageButtons();
  updateCollapseButtonTitles();
  updateBppLabel();
  setMeasureHint(false);
  renderMeasureList(getMeasurements());
  renderPinList(getPinNotes());
  renderZonesList((currentTelemetryData?.zones as BuildingZone[]) || []);
  renderCloudEventsTimeline();
  if (currentFaithfulness) renderFaithfulnessCard(currentFaithfulness);
  updateDimsBadge(getEl("viewer-usd") as any);

  // Re-render telemetry immediately in new language
  if (currentTelemetryData) {
    const outputPre = getEl<HTMLElement>("output");
    outputPre.innerHTML = renderTelemetryHTML(currentTelemetryData);
    initTelemetryCharts(currentTelemetryData);
  }

  // Re-run LLM advice immediately in new language
  if (currentRawTelemetry && currentTelemetryData) {
    runAdvice(currentRawTelemetry, currentTelemetryData);
  }
}

function updateLanguageButtons(): void {
  getEl<HTMLButtonElement>("btn-lang-en").classList.toggle(
    "active",
    IntLayer.currentLang === "en",
  );
  getEl<HTMLButtonElement>("btn-lang-pl").classList.toggle(
    "active",
    IntLayer.currentLang === "pl",
  );
}

function initTextScale(): void {
  const savedScale = localStorage.getItem("nequ3d.textScale");
  const scale =
    savedScale === "sm" || savedScale === "md" || savedScale === "lg"
      ? savedScale
      : "md";
  setTextScale(scale);
}

function setTextScale(scale: TextScale): void {
  activeTextScale = scale;
  document.documentElement.style.setProperty(
    "--base-font-size",
    TEXT_SCALE_OPTIONS[scale],
  );
  localStorage.setItem("nequ3d.textScale", scale);
  updateTextScaleButtons();
}

function updateTextScaleButtons(): void {
  (["sm", "md", "lg"] as const).forEach((scale) => {
    getEl<HTMLButtonElement>(`btn-size-${scale}`).classList.toggle(
      "active",
      activeTextScale === scale,
    );
  });
}

function initTheme(): void {
  const savedTheme = localStorage.getItem("nequ3d.theme");
  const theme = savedTheme === "light" ? "light" : "dark";
  applyTheme(theme);
}

function toggleTheme(event?: MouseEvent): void {
  const nextTheme = document.body.dataset.theme === "light" ? "dark" : "light";

  if (!document.startViewTransition || !event) {
    applyTheme(nextTheme);
    return;
  }

  const x = event.clientX;
  const y = event.clientY;
  const endRadius = Math.hypot(
    Math.max(x, innerWidth - x),
    Math.max(y, innerHeight - y),
  );

  const transition = document.startViewTransition(() => {
    applyTheme(nextTheme);
  });

  transition.ready.then(() => {
    const clipPath = [
      `circle(0px at ${x}px ${y}px)`,
      `circle(${endRadius}px at ${x}px ${y}px)`,
    ];
    document.documentElement.animate(
      {
        clipPath: nextTheme === "dark" ? clipPath.reverse() : clipPath,
      },
      {
        duration: 500,
        easing: "ease-in",
        pseudoElement:
          nextTheme === "dark"
            ? "::view-transition-old(root)"
            : "::view-transition-new(root)",
      },
    );
  });
}

function applyTheme(theme: string): void {
  document.body.dataset.theme = theme;
  localStorage.setItem("nequ3d.theme", theme);
  getEl<HTMLButtonElement>("theme-toggle").innerHTML =
    theme === "light" ? Icons.sun : Icons.moon;
}

function updateBppLabel(): void {
  animateBlurValue(
    getEl<HTMLSpanElement>("bpp-val"),
    `${currentBpp} ${IntLayer.t.bppUnit}`,
  );

  const stepsVal = getEl<HTMLSpanElement>("steps-val");
  if (stepsVal) {
    animateBlurValue(stepsVal, currentSteps);
  }
}

function stripAiPreamble(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/(?:^|\n)\s*[-*•]\s+/);
  if (match && match.index !== undefined && match.index > 0) {
    return trimmed.slice(match.index).trim();
  }
  return trimmed;
}

function requestViewerResize(): void {
  syncComparisonLayout();
  syncHybridLayout();
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

initUI();

function renderTelemetryHTML(data: any): string {
  if (!data || typeof data !== "object") return String(data);
  const lang = IntLayer.currentLang || "en";

  const t = (en: string, pl: string) => (lang === "pl" ? pl : en);

  let html = `<div class="telemetry-grid">`;

  if (data.total_vertices !== undefined) {
    html += `
      <div class="metric-card">
        <span class="metric-title">${t("Vertices", "Wierzchołki")}</span>
        <span class="metric-value highlight">${data.total_vertices.toLocaleString()}</span>
      </div>
    `;
  }
  if (data.total_faces !== undefined) {
    html += `
      <div class="metric-card">
        <span class="metric-title">${t("Faces", "Wielokąty")}</span>
        <span class="metric-value">${data.total_faces?.toLocaleString()}</span>
      </div>
    `;
  }

  if (data.mesh_count !== undefined) {
    html += `
      <div class="metric-card">
        <span class="metric-title">${t("Meshes", "Siatki")}</span>
        <span class="metric-value">${data.mesh_count}</span>
      </div>
    `;
  }

  if (data.texture_count !== undefined) {
    html += `
      <div class="metric-card">
        <span class="metric-title">${t("Textures", "Tekstury")}</span>
        <span class="metric-value">${data.texture_count}</span>
      </div>
    `;
  }

  if (data.material_count !== undefined) {
    html += `
      <div class="metric-card">
        <span class="metric-title">${t("Materials", "Materiały")}</span>
        <span class="metric-value">${data.material_count}</span>
      </div>
    `;
  }

  if (data.total_prim_count !== undefined) {
    html += `
      <div class="metric-card">
        <span class="metric-title">${t("Prims", "Obiekty (Prims)")}</span>
        <span class="metric-value">${data.total_prim_count}</span>
      </div>
    `;
  }

  if (data.status !== undefined) {
    const rawStatus = String(data.status).toLowerCase();
    const statusLabel =
      rawStatus === "success"
        ? t("SUCCESS", "SUKCES")
        : rawStatus === "error" || rawStatus === "failed"
          ? t("ERROR", "BŁĄD")
          : String(data.status).toUpperCase();
    html += `
      <div class="metric-card" style="grid-column: span 2;">
        <span class="metric-title">${t("Status", "Status")}</span>
        <span class="metric-value" style="color: ${rawStatus === "success" ? "var(--accent-teal)" : "#e53e3e"}">${statusLabel}</span>
      </div>
    `;
  }

  html += `</div>`;

  if (
    data.ntc_compressed_files &&
    Array.isArray(data.ntc_compressed_files) &&
    data.ntc_compressed_files.length > 0
  ) {
    let savedTotal = 0;
    let totalTime = 0;
    let avgReduction = 0;
    let validFiles = 0;

    data.ntc_compressed_files.forEach((file: any) => {
      savedTotal += Number(file.vram_saved_mb) || 0;
      totalTime += Number(file.compression_time_sec) || 0;
      let redStr = String(file.vram_reduction || "").replace("%", "");
      let redNum = parseFloat(redStr);
      if (!isNaN(redNum)) {
        avgReduction += redNum;
        validFiles++;
      }
    });

    if (validFiles > 0) avgReduction /= validFiles;

    const psnrNum =
      typeof data.avg_psnr_db === "number" ? data.avg_psnr_db : null;
    const ssimNum = typeof data.avg_ssim === "number" ? data.avg_ssim : null;
    const psnrColor =
      psnrNum === null
        ? "var(--text-muted)"
        : psnrNum >= 35
          ? "var(--accent-teal)"
          : psnrNum >= 28
            ? "var(--accent-warm)"
            : "#ef4444";
    const ssimColor =
      ssimNum === null
        ? "var(--text-muted)"
        : ssimNum >= 0.94
          ? "var(--accent-teal)"
          : ssimNum >= 0.88
            ? "var(--accent-warm)"
            : "#ef4444";

    html += `
      <div class="chart-container">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
           <span style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; font-weight: 700;">${t("VRAM Optimization", "Optymalizacja VRAM")}</span>
           <span style="font-family: var(--font-mono); font-size: 1rem; color: var(--accent-teal); font-weight: 800;">-${avgReduction.toFixed(1)}%</span>
        </div>
        <div class="chart-canvas-wrapper" style="height: 180px;">
          <canvas id="vramChart"></canvas>
        </div>
        <div style="margin-top: 20px; display: flex; justify-content: space-around; font-family: var(--font-mono);">
          <div style="text-align: center;">
            <span style="color: var(--text-muted); font-size: 0.7rem; display: block; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">${t("Saved", "Zaoszczędzono")}</span>
            <span style="font-weight: 800; font-size: 1.2rem; color: var(--accent-teal);">${savedTotal.toFixed(2)} MB</span>
          </div>
          <div style="text-align: center;">
            <span style="color: var(--text-muted); font-size: 0.7rem; display: block; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;">${t("Time", "Czas")}</span>
            <span style="font-weight: 800; font-size: 1.2rem; color: var(--text-main);">${totalTime.toFixed(2)}s</span>
          </div>
        </div>
        <div class="quality-metrics-row">
          <div class="quality-pill">
            <span class="q-lbl">PSNR</span>
            <span id="ntc-psnr-val" class="q-val" style="color:${psnrColor};">${psnrNum !== null ? `${psnrNum.toFixed(2)} dB` : "…"}</span>
          </div>
          <div class="quality-pill">
            <span class="q-lbl">SSIM</span>
            <span id="ntc-ssim-val" class="q-val" style="color:${ssimColor};">${ssimNum !== null ? ssimNum.toFixed(4) : "…"}</span>
          </div>
        </div>
      </div>
    `;
  }

  html += renderSimReadyCardHTML(data);
  html += renderProvenanceCardHTML(data);
  html += renderOtelTraceCardHTML(data);

  return html;
}

async function refreshTwinEventsTimeline(): Promise<void> {
  try {
    const raw = await GetTwinEvents(30);
    const parsed = safeJsonParse<any[]>(raw);
    if (Array.isArray(parsed)) {
      twinCloudEvents = parsed;
    }
  } catch {
    /* ignore before backend ready */
  }
  renderCloudEventsTimeline();
}

function renderCloudEventsTimeline(): void {
  const list = document.getElementById("ce-timeline-list");
  const badge = document.getElementById("ce-count-badge");
  if (!list || !badge) return;
  badge.textContent = String(twinCloudEvents.length);
  if (!twinCloudEvents.length) {
    list.innerHTML = `<div class="measure-hint" data-i18n="ceEmpty">${IntLayer.t.ceEmpty}</div>`;
    return;
  }
  list.innerHTML = twinCloudEvents
    .map((ev) => {
      const shortType = String(ev.type || "").replace(/^io\.nequ3d\.twin\./, "");
      const seq = ev.streamseq ? `#${ev.streamseq}` : "";
      let hhmmss = "";
      if (typeof ev.time === "string") {
        const d = new Date(ev.time);
        if (!Number.isNaN(d.getTime())) {
          hhmmss = d.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
        }
      }
      const subj = escapeHtml(String(ev.subject || "twin"));
      return `<div class="ce-item">
        <div class="ce-head">
          <span class="ce-type" title="${escapeHtml(String(ev.type || ""))}">${escapeHtml(shortType)}</span>
          <span class="ce-seq">${escapeHtml(seq)} · ${escapeHtml(hhmmss)}</span>
        </div>
        <div class="ce-sub">
          <span>${subj}</span>
          <span>CloudEvents 1.0</span>
        </div>
      </div>`;
    })
    .join("");
}

function renderFaithfulnessCard(rep: any): void {
  const host = document.getElementById("ai-faithfulness");
  if (!host || !rep) return;
  const pct = Number(rep.score_pct ?? 0);
  const verdict = String(rep.verdict || "faithful");
  const badgeCls = verdict === "faithful" ? "ok" : "warn";
  const badgeText =
    verdict === "faithful"
      ? `${pct}% · ${IntLayer.t.faithFaithful}`
      : verdict === "warning"
        ? `${pct}% · ${IntLayer.t.faithWarning}`
        : `${pct}% · ${IntLayer.t.faithHallucinated}`;

  const checks: Array<{ passed?: boolean; label?: string; detail?: string }> =
    Array.isArray(rep.checks) ? rep.checks : [];
  const rowsHtml = checks
    .map((c) => {
      const ok = Boolean(c.passed);
      const cls = ok ? "ok" : "warn";
      const icon = ok ? "✓" : "!";
      return `<div class="simready-row ${cls}">
        <span class="sr-icon">${icon}</span>
        <span><strong>${escapeHtml(String(c.label || ""))}:</strong> ${escapeHtml(String(c.detail || ""))}</span>
      </div>`;
    })
    .join("");

  host.innerHTML = `
    <details class="simready-card" style="margin-top:4px;">
      <summary>
        <span>${IntLayer.t.faithTitle}</span>
        <span class="simready-badge ${badgeCls}">${escapeHtml(badgeText)}</span>
      </summary>
      <div class="simready-checks">${rowsHtml}</div>
    </details>
  `;
}

function renderProvenanceCardHTML(data: any): string {
  const ver = data?.provenance_verification;
  const prov = data?.provenance;
  const targetDir = String(data?.omniverse_export_dir || data?.twin_dir || "");
  if (!ver && !prov && !targetDir) return "";

  const isPl = IntLayer.currentLang === "pl";
  const verified = ver ? Boolean(ver.verified) : Boolean(prov?.intoto_sha256);
  const subjCount = Number(ver?.subject_count ?? prov?.subject_count ?? 0);
  const digest = String(ver?.intoto_sha256 || prov?.intoto_sha256 || "");
  const shortDigest = digest ? `${digest.slice(0, 14)}…` : "DSSE";
  const artifactType = String(
    ver?.artifact_type ||
      prov?.artifact_type ||
      "application/vnd.nequ3d.twin.v1+json",
  );

  return `
    <details class="simready-card">
      <summary>
        <span>${IntLayer.t.intotoTitle}</span>
        <span id="intoto-status-badge" class="simready-badge ${verified ? "ok" : "warn"}">${
          verified ? IntLayer.t.intotoVerified : IntLayer.t.intotoTampered
        }</span>
      </summary>
      <div class="simready-checks">
        <div class="simready-row ${verified ? "ok" : "warn"}">
          <span class="sr-icon">${verified ? "✓" : "!"}</span>
          <span id="intoto-subj-text">${
            isPl
              ? `Podpis DSSE + ${subjCount} artefaktów SHA-256 (${shortDigest})`
              : `DSSE signature + ${subjCount} SHA-256 subjects (${shortDigest})`
          }</span>
        </div>
        <div class="simready-row info">
          <span class="sr-icon">•</span>
          <span>ORAS OCI: <code>${escapeHtml(artifactType)}</code></span>
        </div>
        ${
          targetDir
            ? `<div style="margin-top:4px;display:flex;justify-content:flex-end;">
                <button type="button" class="nav-reset-btn" data-intoto-verify="${escapeHtml(targetDir)}">${IntLayer.t.intotoVerifyBtn}</button>
              </div>`
            : ""
        }
      </div>
    </details>
  `;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)} ms`;
}

function renderOtelTraceCardHTML(data: any): string {
  const traceId = typeof data?.trace_id === "string" ? data.trace_id : "";
  const jaegerUrl = typeof data?.jaeger_url === "string" ? data.jaeger_url : "";
  const edge = (data?.edge_timings_ms || {}) as Record<string, number>;
  const core = (data?.stage_timings_ms || {}) as Record<string, number>;

  const hasAny =
    Boolean(traceId) ||
    Object.keys(edge).length > 0 ||
    Object.keys(core).length > 0;
  if (!hasAny) return "";

  const isPl = IntLayer.currentLang === "pl";
  const stages: Array<{ label: string; ms: number }> = [];
  if (typeof edge.sha256_ms === "number") {
    stages.push({ label: "Edge SHA-256", ms: edge.sha256_ms });
  }
  if (typeof edge.minio_upload_ms === "number") {
    stages.push({
      label: isPl ? "MinIO S3 (wysyłka)" : "MinIO S3 upload",
      ms: edge.minio_upload_ms,
    });
  }
  if (typeof core.unpack_ms === "number" && core.unpack_ms > 0.5) {
    stages.push({
      label: isPl ? "Rozpakowanie USDZ" : "USDZ unpack",
      ms: core.unpack_ms,
    });
  }
  if (typeof core.usd_traverse_ms === "number") {
    stages.push({
      label: isPl ? "Graf sceny OpenUSD" : "OpenUSD traverse",
      ms: core.usd_traverse_ms,
    });
  }
  if (typeof core.ntc_ms === "number") {
    stages.push({
      label: "NVIDIA RTX NTC",
      ms: core.ntc_ms,
    });
  }
  if (typeof core.proxy_glb_ms === "number") {
    stages.push({
      label: isPl ? "Eksport Proxy GLB" : "Proxy GLB export",
      ms: core.proxy_glb_ms,
    });
  }
  if (typeof core.splat_3dgs_ms === "number") {
    stages.push({
      label: "3DGS Surfel Proxy",
      ms: core.splat_3dgs_ms,
    });
  }
  if (typeof core.twin_simready_ms === "number") {
    stages.push({
      label: "Twin + SimReady",
      ms: core.twin_simready_ms,
    });
  }
  if (stages.length <= 2 && typeof edge.core_rpc_ms === "number") {
    stages.push({
      label: isPl ? "Potok Core gRPC" : "Core gRPC pipeline",
      ms: edge.core_rpc_ms,
    });
  }
  if (typeof edge.minio_download_ms === "number") {
    stages.push({
      label: isPl ? "MinIO S3 (odbiór GLB)" : "MinIO S3 proxy pull",
      ms: edge.minio_download_ms,
    });
  }

  const totalMs =
    typeof edge.total_ms === "number" && edge.total_ms > 0
      ? edge.total_ms
      : stages.reduce((acc, s) => acc + s.ms, 0) || 1;

  const stagesHtml = stages
    .map((s) => {
      const pct = Math.max(3, Math.min(100, (s.ms / totalMs) * 100));
      return `
        <div class="otel-stage-row">
          <div class="otel-stage-head">
            <span>${escapeHtml(s.label)}</span>
            <strong>${formatMs(s.ms)}</strong>
          </div>
          <div class="otel-bar-track"><div class="otel-bar-fill" style="width:${pct.toFixed(1)}%;"></div></div>
        </div>
      `;
    })
    .join("");

  const shortTrace = traceId ? `${traceId.slice(0, 12)}…` : "local";

  return `
    <details class="simready-card" open>
      <summary>
        <span>${IntLayer.t.otelTitle}</span>
        <span class="simready-badge ok">${shortTrace}</span>
      </summary>
      <div class="simready-checks">
        ${
          traceId
            ? `<div class="otel-actions">
                <span class="otel-trace-id" title="${escapeHtml(traceId)}">${escapeHtml(traceId)}</span>
                <div style="display:flex;gap:4px;flex-shrink:0;">
                  <button type="button" class="nav-reset-btn" data-otel-copy="${escapeHtml(traceId)}">${IntLayer.t.otelCopy}</button>
                  ${
                    jaegerUrl
                      ? `<a class="nav-reset-btn" style="text-decoration:none;" href="${escapeHtml(jaegerUrl)}" target="_blank" rel="noopener noreferrer">${IntLayer.t.otelOpenJaeger}</a>`
                      : ""
                  }
                </div>
              </div>`
            : ""
        }
        ${stagesHtml}
      </div>
    </details>
  `;
}

function renderSimReadyCardHTML(data: any): string {
  const manifest = data?.twin_manifest as
    | {
        up_axis?: string;
        meters_per_unit?: number;
        prim_count?: number;
        zone_count?: number;
        integrity?: { working_usd_sha256?: string };
      }
    | undefined;
  const checklist = data?.simready_checklist as
    | {
        ready_for_kit_import?: boolean;
        checks?: Array<{ id: string; ok: boolean; detail: string; severity: string }>;
      }
    | undefined;

  if (!manifest && !checklist) return "";

  const isPl = IntLayer.currentLang === "pl";
  const ready =
    checklist?.ready_for_kit_import !== undefined
      ? Boolean(checklist.ready_for_kit_import)
      : Boolean(data?.simready_ready);

  const checks: Array<{ id: string; ok: boolean; detail: string; severity: string }> =
    Array.isArray(checklist?.checks) && checklist.checks.length > 0
      ? checklist.checks
      : [
          {
            id: "up_axis",
            ok: ["Y", "Z"].includes(String(manifest?.up_axis || "").toUpperCase()),
            detail: isPl
              ? `Oś pionowa upAxis = ${manifest?.up_axis || "brak"}`
              : `Stage upAxis = ${manifest?.up_axis || "missing"}`,
            severity: "warn",
          },
          {
            id: "meters_per_unit",
            ok: Number(manifest?.meters_per_unit || 0) > 0,
            detail: isPl
              ? `Skala metersPerUnit = ${manifest?.meters_per_unit ?? "?"}`
              : `metersPerUnit = ${manifest?.meters_per_unit ?? "?"}`,
            severity: "warn",
          },
          {
            id: "mesh_prims",
            ok: Number(manifest?.prim_count || 0) > 0,
            detail: isPl
              ? `Obiekty siatki w manifeście: ${manifest?.prim_count ?? 0}`
              : `Mesh prims in manifest: ${manifest?.prim_count ?? 0}`,
            severity: "error",
          },
          {
            id: "zones",
            ok: Number(manifest?.zone_count || 0) > 0,
            detail: isPl
              ? `Wykryte strefy budynku: ${manifest?.zone_count ?? 0}`
              : `Building zones inferred: ${manifest?.zone_count ?? 0}`,
            severity: "info",
          },
          {
            id: "integrity_hash",
            ok: Boolean(manifest?.integrity?.working_usd_sha256),
            detail: isPl
              ? "Integralność SHA-256 sceny USD zapisana"
              : "Working USD SHA-256 recorded",
            severity: "warn",
          },
        ];

  const rowsHtml = checks
    .map((c) => {
      const cls = c.ok ? "ok" : c.severity || "info";
      const icon = c.ok ? "✓" : cls === "error" ? "✕" : cls === "warn" ? "!" : "•";
      return `<div class="simready-row ${cls}"><span class="sr-icon">${icon}</span><span>${escapeHtml(c.detail)}</span></div>`;
    })
    .join("");

  return `
    <details class="simready-card">
      <summary>
        <span>${IntLayer.t.simreadyTitle}</span>
        <span class="simready-badge ${ready ? "ok" : "warn"}">${ready ? IntLayer.t.simreadyReady : IntLayer.t.simreadyWarn}</span>
      </summary>
      <div class="simready-checks">${rowsHtml}</div>
    </details>
  `;
}

async function hydrateClientNtcQuality(data: any): Promise<void> {
  if (typeof data?.avg_psnr_db === "number" && typeof data?.avg_ssim === "number") {
    return;
  }
  const asset = findQualityAsset(data);
  if (!asset?.original_path || !asset?.reconstructed_path) return;

  const loadImg = (url: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });

  try {
    const [origImg, reconImg] = await Promise.all([
      loadImg(localFileUrl(toHostPath(asset.original_path))),
      loadImg(localFileUrl(toHostPath(asset.reconstructed_path))),
    ]);
    const size = Math.min(512, Math.max(64, origImg.naturalWidth || 512));
    const w = Math.floor(size / 8) * 8;
    const h = Math.floor(
      (w * (origImg.naturalHeight || size)) / (origImg.naturalWidth || size) / 8,
    ) * 8;
    if (w < 8 || h < 8) return;

    const readPixels = (img: HTMLImageElement) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };

    const pa = readPixels(origImg);
    const pb = readPixels(reconImg);
    if (!pa || !pb) return;

    let sse = 0;
    const nPx = w * h;
    const ya = new Float32Array(nPx);
    const yb = new Float32Array(nPx);
    for (let i = 0; i < nPx; i++) {
      const o = i * 4;
      const dr = pa[o] - pb[o];
      const dg = pa[o + 1] - pb[o + 1];
      const db = pa[o + 2] - pb[o + 2];
      sse += dr * dr + dg * dg + db * db;
      ya[i] = 0.299 * pa[o] + 0.587 * pa[o + 1] + 0.114 * pa[o + 2];
      yb[i] = 0.299 * pb[o] + 0.587 * pb[o + 1] + 0.114 * pb[o + 2];
    }
    const mse = sse / (nPx * 3);
    const psnr = mse <= 1e-9 ? 99.9 : 10 * Math.log10((255 * 255) / mse);

    const c1 = (0.01 * 255) ** 2;
    const c2 = (0.03 * 255) ** 2;
    let ssimSum = 0;
    let blocks = 0;
    for (let by = 0; by < h; by += 8) {
      for (let bx = 0; bx < w; bx += 8) {
        let ma = 0;
        let mb = 0;
        for (let y = 0; y < 8; y++) {
          const row = (by + y) * w + bx;
          for (let x = 0; x < 8; x++) {
            ma += ya[row + x];
            mb += yb[row + x];
          }
        }
        ma /= 64;
        mb /= 64;
        let va = 0;
        let vb = 0;
        let cov = 0;
        for (let y = 0; y < 8; y++) {
          const row = (by + y) * w + bx;
          for (let x = 0; x < 8; x++) {
            const da = ya[row + x] - ma;
            const db = yb[row + x] - mb;
            va += da * da;
            vb += db * db;
            cov += da * db;
          }
        }
        va /= 64;
        vb /= 64;
        cov /= 64;
        ssimSum +=
          ((2 * ma * mb + c1) * (2 * cov + c2)) /
          ((ma * ma + mb * mb + c1) * (va + vb + c2));
        blocks += 1;
      }
    }
    const ssim = blocks > 0 ? clamp(ssimSum / blocks, 0, 1) : 0;
    data.avg_psnr_db = Number(psnr.toFixed(2));
    data.avg_ssim = Number(ssim.toFixed(4));

    const psnrEl = document.getElementById("ntc-psnr-val");
    const ssimEl = document.getElementById("ntc-ssim-val");
    if (psnrEl) {
      psnrEl.style.color =
        psnr >= 35 ? "var(--accent-teal)" : psnr >= 28 ? "var(--accent-warm)" : "#ef4444";
      animateBlurValue(psnrEl, `${psnr.toFixed(2)} dB`);
    }
    if (ssimEl) {
      ssimEl.style.color =
        ssim >= 0.94 ? "var(--accent-teal)" : ssim >= 0.88 ? "var(--accent-warm)" : "#ef4444";
      animateBlurValue(ssimEl, ssim.toFixed(4));
    }
  } catch (e) {
    console.warn("[Nequ3D] Client PSNR/SSIM fallback skipped", e);
  }
}

function initTelemetryCharts(data: any): void {
  void hydrateClientNtcQuality(data);
  document
    .querySelectorAll<HTMLButtonElement>("[data-otel-copy]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-otel-copy") || "";
        if (!val) return;
        navigator.clipboard?.writeText(val).then(() => {
          const orig = btn.textContent || IntLayer.t.otelCopy;
          animateBlurValue(btn, IntLayer.t.otelCopied);
          window.setTimeout(() => animateBlurValue(btn, orig), 1400);
        });
      });
    });
  document
    .querySelectorAll<HTMLButtonElement>("[data-intoto-verify]")
    .forEach((btn) => {
      btn.addEventListener("click", async () => {
        const dir = btn.getAttribute("data-intoto-verify") || "";
        if (!dir) return;
        btn.disabled = true;
        try {
          const raw = await VerifyTwinProvenance(dir);
          const ver = safeJsonParse<any>(raw);
          if (ver) {
            if (currentTelemetryData) {
              currentTelemetryData.provenance_verification = ver;
            }
            const badge = document.getElementById("intoto-status-badge");
            const subjText = document.getElementById("intoto-subj-text");
            if (badge) {
              badge.className = `simready-badge ${ver.verified ? "ok" : "warn"}`;
              badge.textContent = ver.verified
                ? IntLayer.t.intotoVerified
                : IntLayer.t.intotoTampered;
            }
            if (subjText) {
              const short = String(ver.intoto_sha256 || "").slice(0, 14);
              subjText.textContent =
                IntLayer.currentLang === "pl"
                  ? `Zweryfikowano na żywo: ${ver.subject_count} plików (${short}…)`
                  : `Live verified: ${ver.subject_count} files (${short}…)`;
            }
          }
        } catch (e) {
          console.warn("[Nequ3D] Provenance check failed", e);
        } finally {
          btn.disabled = false;
        }
      });
    });
  if (
    !data ||
    !data.ntc_compressed_files ||
    !Array.isArray(data.ntc_compressed_files) ||
    data.ntc_compressed_files.length === 0
  ) {
    return;
  }

  const canvas = document.getElementById("vramChart") as HTMLCanvasElement;
  if (!canvas) return;

  let rawVram = 0;
  let ntcVram = 0;

  data.ntc_compressed_files.forEach((file: any) => {
    rawVram += Number(file.raw_vram_mb) || 0;
    ntcVram += Number(file.ntc_vram_mb) || 0;
  });

  const lang = IntLayer.currentLang || "en";
  const t = (en: string, pl: string) => (lang === "pl" ? pl : en);

  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }

  new Chart(canvas, {
    type: "doughnut",
    data: {
      labels: [
        t("Original (Removed)", "Oryginał (Usunięty)"),
        t("NTC Compressed", "Skompresowane NTC"),
      ],
      datasets: [
        {
          data: [Math.max(0, rawVram - ntcVram), ntcVram],
          backgroundColor: ["#2D3748", "#00A8C6"],
          borderWidth: 0,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#A0AEC0",
            font: {
              family: "'JetBrains Mono', monospace",
              size: 10,
            },
          },
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return (
                " " +
                context.label +
                ": " +
                Number(context.raw).toFixed(2) +
                " MB"
              );
            },
          },
        },
      },
      cutout: "70%",
    },
  });
}
