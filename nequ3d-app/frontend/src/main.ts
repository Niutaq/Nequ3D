// frontend/src/main.ts
import "../public/style.css";
import {
  GenerateRenovationAdvice,
  ProcessModel,
  SelectFile,
} from "../bindings/changeme/app";
import "@google/model-viewer";
import { Events } from "@wailsio/runtime";
import { IntLayer, type Language } from "./i18n";

type ViewerMode = "mesh" | "quality";
type ModelChoice = "gemma:2b" | "llama3" | "mistral";

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

const LOCAL_FILE_ENDPOINT = "http://localhost:8081/api/local-file?path=";
const MIN_LEFT_PANEL = 280;
const MIN_RIGHT_PANEL = 300;
const MIN_CENTER_PANEL = 420;

const style = document.createElement("style");
style.textContent = `
  :root {
    --bg-base: #0B1116;
    --bg-panel: #111820;
    --bg-darker: #070B0E;
    --border-color: #1C2733;
    --accent-orange: #FF6D00;
    --accent-orange-dim: rgba(255, 109, 0, 0.15);
    --accent-emerald: #10B981;
    --text-main: #E2E8F0;
    --text-muted: #64748B;
    --font-mono: 'JetBrains Mono', monospace;
    --left-panel-width: 400px;
    --right-panel-width: 420px;
  }

  body[data-theme="light"] {
    --bg-base: #F1F5F9;
    --bg-panel: #FFFFFF;
    --bg-darker: #E2E8F0;
    --border-color: #CBD5E1;
    --text-main: #0F172A;
    --text-muted: #64748B;
  }

  * { box-sizing: border-box; }

  html { font-size: 20px; }

  body {
    margin: 0;
    background: var(--bg-base);
    color: var(--text-main);
    font-family: 'Inter', sans-serif;
    overflow: hidden;
    height: 100vh;
    user-select: none;
  }

  .workspace {
    display: grid;
    grid-template-columns: var(--left-panel-width) 1fr var(--right-panel-width);
    grid-template-rows: 80px 1fr;
    grid-template-areas:
      "topbar topbar topbar"
      "leftpanel viewport rightpanel";
    height: 100vh;
    width: 100vw;
  }

  .topbar {
    grid-area: topbar;
    background: var(--bg-darker);
    border-bottom: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 32px;
    z-index: 100;
  }

  .leftpanel {
    grid-area: leftpanel;
    background: var(--bg-panel);
    border-right: 1px solid var(--border-color);
    padding: 32px;
    display: flex;
    flex-direction: column;
    gap: 32px;
    overflow-y: auto;
  }

  .viewport {
    grid-area: viewport;
    background: var(--bg-base);
    position: relative;
    overflow: hidden;
  }

  .rightpanel {
    grid-area: rightpanel;
    background: var(--bg-panel);
    border-left: 1px solid var(--border-color);
    padding: 32px;
    display: flex;
    flex-direction: column;
    gap: 32px;
    overflow-y: auto;
  }

  .telemetry-group { display: flex; gap: 40px; }
  .telemetry-item { display: flex; flex-direction: column; gap: 6px; }
  .telemetry-label { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.1em; }
  .telemetry-value { font-family: var(--font-mono); font-size: 18px; font-weight: 600; color: var(--accent-emerald); }

  .sys-bar-bg { width: 80px; height: 3px; background: var(--border-color); margin-top: 6px; }
  .sys-bar-fill { height: 100%; background: var(--accent-emerald); transition: width 0.3s; }

  .technical-button {
    background: var(--bg-darker);
    border: 1px solid var(--border-color);
    color: var(--text-main);
    padding: 16px;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    transition: all 0.15s ease;
    border-radius: 0;
  }
  .technical-button:hover:not(:disabled) { border-color: var(--accent-orange); background: var(--accent-orange-dim); color: var(--accent-orange); }
  .technical-button:disabled { opacity: 0.4; cursor: not-allowed; }
  .technical-button.primary { border-color: var(--accent-orange); color: var(--accent-orange); background: var(--accent-orange-dim); }

  .panel-section { display: flex; flex-direction: column; gap: 16px; }
  .section-label { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; border-left: 2px solid var(--accent-orange); padding-left: 10px; }

  .technical-select { background: var(--bg-darker); border: 1px solid var(--border-color); color: var(--text-main); padding: 12px; font-family: var(--font-mono); font-size: 14px; width: 100%; outline: none; }

  input[type="range"]:not(.comp-slider) { -webkit-appearance: none; width: 100%; background: transparent; }
  input[type="range"]:not(.comp-slider)::-webkit-slider-runnable-track { width: 100%; height: 2px; background: var(--border-color); }
  input[type="range"]:not(.comp-slider)::-webkit-slider-thumb { -webkit-appearance: none; height: 16px; width: 8px; background: var(--accent-orange); margin-top: -7px; cursor: pointer; }

  .viewer-tabs { position: absolute; top: 0; left: 0; display: flex; z-index: 1000; background: var(--bg-darker); border-bottom: 1px solid var(--border-color); border-right: 1px solid var(--border-color); }
  .view-tab { background: transparent; border: none; border-right: 1px solid var(--border-color); color: var(--text-muted); padding: 14px 28px; font-family: var(--font-mono); font-size: 12px; text-transform: uppercase; cursor: pointer; transition: all 0.2s; }
  .view-tab.active { color: var(--accent-orange); background: var(--bg-panel); box-shadow: inset 0 -2px 0 var(--accent-orange); }

  .viewer-layer { position: absolute; inset: 0; width: 100%; height: 100%; }
  .comparison-wrapper { display: flex; align-items: center; justify-content: center; overflow: hidden; position: absolute; inset: 0; background: #000; }
  .comparison-layer { position: relative; display: inline-flex; max-width: 100%; max-height: 100%; }
  .comp-img { object-fit: contain; max-width: 100%; max-height: 100%; display: block; }
  .img-after { position: absolute; inset: 0; z-index: 2; }
  .comp-slider { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: ew-resize; z-index: 10; margin: 0; }
  .comp-divider { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--accent-orange); pointer-events: none; z-index: 5; box-shadow: 0 0 10px var(--accent-orange); }

  .viewer-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: var(--text-muted); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.2em; gap: 20px; }

  pre#output { background: var(--bg-darker); border: 1px solid var(--border-color); padding: 14px; font-size: 12px; color: var(--accent-emerald); overflow: auto; max-height: 250px; margin: 0; font-family: var(--font-mono); }

  .spinner { width: 16px; height: 16px; border: 2px solid rgba(255, 255, 255, 0.1); border-top-color: var(--accent-orange); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .panel-gutter:hover { background: var(--accent-orange-dim); }
  .panel-gutter.dragging { background: var(--accent-orange); }
`;
document.head.appendChild(style);

const Icons = {
  box: `<svg width="42" height="42" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <!-- Neural Node / Wireframe Cube -->
    <path d="M32 12 L52 24 L52 46 L32 58 L12 46 L12 24 Z" stroke="#10B981" stroke-width="2" stroke-linejoin="round" fill="rgba(16, 185, 129, 0.05)"/>
    <path d="M32 12 L32 35 M12 24 L32 35 M52 24 L32 35" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="32" cy="35" r="4" fill="#FF6D00" filter="drop-shadow(0 0 4px #FF6D00)"/>
    <circle cx="32" cy="12" r="2" fill="#10B981"/>
    <circle cx="52" cy="24" r="2" fill="#10B981"/>
    <circle cx="52" cy="46" r="2" fill="#10B981"/>
    <circle cx="32" cy="58" r="2" fill="#10B981"/>
    <circle cx="12" cy="46" r="2" fill="#10B981"/>
    <circle cx="12" cy="24" r="2" fill="#10B981"/>
  </svg>`,
  moon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.2 14.8A8.3 8.3 0 0 1 9.2 3.8 8.5 8.5 0 1 0 20.2 14.8Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  sun: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  folder: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2h7A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  play: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" fill="currentColor"/></svg>`,
};

let currentAbsolutePath = "";
let currentModelDir = "";
let currentBpp = "5";
let activeMode: ViewerMode = "mesh";
let timerInterval: number | null = null;
let qualityAvailable = false;

const comparisonState = {
  split: 50,
};
function initUI(): void {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
    <div class="workspace">
      <header class="topbar">
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
            <span id="process-timer" class="telemetry-value" style="color: var(--accent-orange);">0.0s</span>
          </div>
        </div>

        <div class="topbar-actions" style="display: flex; gap: 20px; align-items: center;">
          <div class="segmented" style="display: flex; border: 1px solid var(--border-color); background: var(--bg-darker);">
            <button id="btn-lang-en" class="view-tab" style="padding: 10px 20px; border-right: 1px solid var(--border-color);">EN</button>
            <button id="btn-lang-pl" class="view-tab" style="padding: 10px 20px; border: none;">PL</button>
          </div>
          <button id="theme-toggle" class="technical-button" style="padding: 0; width: 44px; height: 44px; display: grid; place-items: center;" data-i18n-title="themeToggle">${Icons.moon}</button>
        </div>
      </header>

      <aside class="leftpanel panel-left">
        <div class="panel-section">
          <span class="section-label" data-i18n="dataIngestion"></span>
          <button id="select-btn" class="technical-button primary">
            ${Icons.folder}
            <span data-i18n="loadAssetBtn"></span>
          </button>
          <div id="file-path" class="telemetry-label" style="text-transform: none; word-break: break-all; margin-top: 6px;" data-i18n="noFile"></div>
        </div>

        <div class="panel-section">
          <span class="section-label" data-i18n="neuralBitrate"></span>
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="telemetry-label" data-i18n="targetBitrate"></span>
            <span id="bpp-val" class="telemetry-value" style="font-size: 16px; color: var(--accent-orange);"></span>
          </div>
          <input type="range" id="bpp-slider" min="1" max="8" step="1" value="5">
        </div>

        <div class="panel-section">
          <span class="section-label" data-i18n="modelLabel"></span>
          <select id="llm-model" class="technical-select">
            <option value="gemma:2b" data-i18n="modelFast"></option>
            <option value="llama3" data-i18n="modelLlama"></option>
            <option value="mistral" data-i18n="modelMistral"></option>
          </select>
        </div>

        <button id="analyze-btn" class="technical-button" style="margin-top: auto; border-color: var(--accent-emerald); color: var(--accent-emerald);" disabled>
          ${Icons.play}
          <span data-i18n="btnAnalyze"></span>
        </button>

        <div class="panel-section">
          <span class="section-label" data-i18n="telemetryTitle"></span>
          <pre id="output" class="mono">_</pre>
        </div>
        </aside>

        <div class="panel-gutter" data-gutter="left" role="separator" style="grid-column: 1; grid-row: 2; justify-self: end; z-index: 1000; width: 6px; cursor: col-resize;"></div>

        <main class="viewport panel-center">
        <div class="viewer-tabs">
          <button id="tab-mesh" class="view-tab active" data-i18n="tabMesh"></button>
          <button id="tab-quality" class="view-tab" data-i18n="tabQuality" hidden></button>
        </div>

        <div id="viewer-placeholder" class="viewer-placeholder">
          <div style="font-size: 50px; opacity: 0.2;">${Icons.box}</div>
          <div data-i18n="viewerEmptyTitle"></div>
        </div>

        <model-viewer id="viewer-usd" class="viewer-layer" style="display: none;" camera-controls auto-rotate exposure="1.05" shadow-intensity="0.6"></model-viewer>

        <div id="viewer-quality" class="comparison-wrapper" style="display: none;">
          <div id="comparison-layer" class="comparison-layer">
              <img id="img-orig" class="comp-img" alt="">
              <canvas id="canvas-ntc" class="comp-img img-after"></canvas>
              <div id="comp-divider" class="comp-divider"></div>
              <input type="range" min="0" max="100" value="50" class="comp-slider" id="compare-slider">

              <div class="telemetry-label" style="position: absolute; top: 15px; left: 15px; z-index: 20; background: rgba(0,0,0,0.5); padding: 4px 8px;" data-i18n="origLabel"></div>
              <div class="telemetry-label" style="position: absolute; top: 15px; right: 15px; z-index: 20; background: rgba(0,0,0,0.5); padding: 4px 8px;" data-i18n="ntcLabel"></div>
          </div>
        </div>
        </main>

        <div class="panel-gutter" data-gutter="right" role="separator" style="grid-column: 3; grid-row: 2; justify-self: start; z-index: 1000; width: 6px; cursor: col-resize;"></div>

        <aside class="rightpanel panel-right">
        <div class="panel-section" style="height: 100%;">
          <span class="section-label" data-i18n="aiTitle"></span>
          <div id="ai-output" style="flex: 1; overflow-y: auto; padding-right: 12px;">
            <span style="opacity: 0.5; font-style: italic;" data-i18n="aiEmpty"></span>
          </div>
        </div>
        </aside>
        </div>
        `;

  document.body.dataset.theme = "dark";

  IntLayer.init();
  initTheme();
  updateLanguageButtons();
  updateBppLabel();
  attachEventListeners();
  initResizablePanels();
  initComparisonResize();
}

function attachEventListeners(): void {
  const selectBtn = getEl<HTMLButtonElement>("select-btn");
  const analyzeBtn = getEl<HTMLButtonElement>("analyze-btn");
  const compareSlider = getEl<HTMLInputElement>("compare-slider");

  getEl<HTMLButtonElement>("tab-mesh").addEventListener("click", () =>
    switchTab("mesh"),
  );
  getEl<HTMLButtonElement>("tab-quality").addEventListener("click", () =>
    switchTab("quality"),
  );

  getEl<HTMLInputElement>("bpp-slider").addEventListener("input", (event) => {
    currentBpp = (event.target as HTMLInputElement).value;
    updateBppLabel();
  });

  getEl<HTMLButtonElement>("btn-lang-en").addEventListener("click", () =>
    setLanguage("en"),
  );
  getEl<HTMLButtonElement>("btn-lang-pl").addEventListener("click", () =>
    setLanguage("pl"),
  );
  getEl<HTMLButtonElement>("theme-toggle").addEventListener(
    "click",
    toggleTheme,
  );

  compareSlider.addEventListener("input", (event) => {
    comparisonState.split = Number((event.target as HTMLInputElement).value);
    syncComparisonLayout();
  });

  try {
    Events.On("sysStats", (event: unknown) => {
      const stats = normalizeStatsEvent(event);
      if (stats) updateSystemStats(stats);
    });
  } catch {
    console.warn("[Nequ3D] Wails event bridge unavailable.");
  }

  selectBtn.addEventListener("click", async () => {
    const path = await SelectFile();
    if (!path) return;
    await routeSelectedAsset(path);
  });

  analyzeBtn.addEventListener("click", runAnalysis);
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

async function runAnalysis(): Promise<void> {
  if (!currentAbsolutePath) return;

  const analyzeBtn = getEl<HTMLButtonElement>("analyze-btn");
  const outputPre = getEl<HTMLPreElement>("output");
  const processTimer = getEl<HTMLDivElement>("process-timer");

  switchTab("mesh");
  analyzeBtn.disabled = true;
  analyzeBtn.innerHTML = `<div class="spinner"></div><span>${IntLayer.t.btnAnalyzeLoad}</span>`;
  setQualityAvailability(false);

  const startTime = Date.now();
  timerInterval = window.setInterval(() => {
    processTimer.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  }, 100);

  try {
    const result = await ProcessModel(currentAbsolutePath, currentBpp);
    const parsedJson = parseTelemetry(result);
    await hydrateViewers(parsedJson);
    outputPre.textContent = JSON.stringify(parsedJson, null, 2);
    analyzeBtn.innerHTML = `<span>${IntLayer.t.btnAnalyzeSuccess}</span>`;
    await runAdvice(result, parsedJson);
  } catch (error) {
    outputPre.textContent = `${IntLayer.t.errorFailed}: ${String(error)}`;
    analyzeBtn.innerHTML = `<span>${IntLayer.t.btnAnalyzeFailed}</span>`;
  } finally {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    analyzeBtn.disabled = false;
  }
}

async function hydrateViewers(telemetry: PipelineTelemetry): Promise<void> {
  const viewerUSD = getEl("viewer-usd") as HTMLElement & { src?: string };
  const viewerPlaceholder = getEl<HTMLDivElement>("viewer-placeholder");

  const meshPath = resolveMeshPath(telemetry);
  if (meshPath) {
    const meshUrl = localFileUrl(meshPath);
    viewerUSD.src = meshUrl;
    viewerUSD.style.display = "block";
    viewerPlaceholder.style.display = "none";
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

  if (!qualityAsset?.original_path) {
    setQualityAvailability(false);
    return;
  }

  const originalPath = toHostPath(qualityAsset.original_path);
  if (!originalPath) {
    setQualityAvailability(false);
    return;
  }

  await setQualityTextures(localFileUrl(originalPath));
}

async function setQualityTextures(originalUrl: string): Promise<void> {
  const imgOrig = getEl<HTMLImageElement>("img-orig");
  const canvasNtc = getEl<HTMLCanvasElement>("canvas-ntc");

  setQualityAvailability(true);

  const cacheUrl = `${originalUrl}&cb=${Date.now()}`;
  const originalImage = await loadImage(cacheUrl).catch((error) => {
    console.warn("[Nequ3D] Quality original texture load skipped.", error);
    return null;
  });
  if (!originalImage) return;

  const naturalWidth = originalImage.naturalWidth || originalImage.width;
  const naturalHeight = originalImage.naturalHeight || originalImage.height;
  comparisonState.split = 50;
  getEl<HTMLInputElement>("compare-slider").value = "50";

  imgOrig.src = cacheUrl;
  canvasNtc.width = naturalWidth;
  canvasNtc.height = naturalHeight;

  const ctx = canvasNtc.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    drawNtcSimulation(ctx, originalImage, currentBpp);
  }
  syncComparisonLayout();
}

function drawNtcSimulation(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  bpp: string,
): void {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width <= 0 || height <= 0) return;

  const bppNum = Number.parseInt(bpp, 10);
  const bitrate = Number.isFinite(bppNum) ? bppNum : 5;
  const scale =
    bitrate <= 2 ? 0.15 : bitrate <= 4 ? 0.25 : bitrate <= 6 ? 0.45 : 0.65;
  const blurPx =
    bitrate <= 2 ? 1.8 : bitrate <= 4 ? 1.25 : bitrate <= 6 ? 0.8 : 0.35;
  const scaledWidth = Math.max(1, Math.round(width * scale));
  const scaledHeight = Math.max(1, Math.round(height * scale));
  const offscreen = document.createElement("canvas");

  offscreen.width = scaledWidth;
  offscreen.height = scaledHeight;

  const offCtx = offscreen.getContext("2d");
  if (!offCtx) return;

  offCtx.imageSmoothingEnabled = true;
  offCtx.imageSmoothingQuality = "low";
  offCtx.clearRect(0, 0, scaledWidth, scaledHeight);
  offCtx.drawImage(image, 0, 0, width, height, 0, 0, scaledWidth, scaledHeight);

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = false;
  ctx.filter = `blur(${blurPx}px)`;
  ctx.drawImage(
    offscreen,
    0,
    0,
    scaledWidth,
    scaledHeight,
    0,
    0,
    width,
    height,
  );
  ctx.restore();
}

function syncComparisonLayout(): void {
  const layer = getEl<HTMLDivElement>("comparison-layer");
  const canvasNtc = getEl<HTMLCanvasElement>("canvas-ntc");
  const divider = getEl<HTMLDivElement>("comp-divider");
  const split = clamp(comparisonState.split, 0, 100);

  layer.style.setProperty("--split", `${split}%`);
  divider.style.left = `${split}%`;
  canvasNtc.style.clipPath = `polygon(${split}% 0, 100% 0, 100% 100%, ${split}% 100%)`;
}

function switchTab(mode: ViewerMode): void {
  activeMode = mode;

  const viewerUSD = getEl<HTMLElement>("viewer-usd");
  const qualityLayer = getEl<HTMLDivElement>("viewer-quality");
  const placeholder = getEl<HTMLDivElement>("viewer-placeholder");

  [
    getEl<HTMLButtonElement>("tab-mesh"),
    getEl<HTMLButtonElement>("tab-quality"),
  ].forEach((tab) => tab.classList.remove("active"));

  [viewerUSD, qualityLayer, placeholder].forEach((layer) => {
    layer.style.display = "none";
  });

  if (mode === "mesh") {
    getEl<HTMLButtonElement>("tab-mesh").classList.add("active");
    const hasMesh = Boolean((viewerUSD as HTMLElement & { src?: string }).src);
    viewerUSD.style.display = hasMesh ? "block" : "none";
    placeholder.style.display = hasMesh ? "none" : "flex";
  }

  if (mode === "quality") {
    getEl<HTMLButtonElement>("tab-quality").classList.add("active");
    if (qualityAvailable) {
      qualityLayer.style.display = "grid";
      syncComparisonLayout();
    } else {
      placeholder.style.display = "flex";
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

  setMeshPath(path);
  setQualityAvailability(false);

  if (isMeshRenderable(path)) {
    await previewMeshAsset(path);
  } else {
    clearMeshPreview();
  }

  switchTab("mesh");
}

function setMeshPath(path: string): void {
  currentAbsolutePath = path;
  currentModelDir = getDirectory(path);
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

  const payload = JSON.stringify({
    model: getSelectedModel(),
    analysis_mode: qualityAvailable ? "mesh_ntc" : "geometry_only",
    ntc_bypassed: !qualityAvailable || Boolean(parsedTelemetry.ntc_bypassed),
    instruction_context: qualityAvailable
      ? "Discuss mesh geometry and NTC texture compression only for UV-mapped mesh textures. Treat 3DGS as a separate uncompressed background."
      : "Focus purely on mesh geometry and structure. Do not claim NTC VRAM savings because NTC was bypassed or no external textures were available.",
    telemetry: parsedTelemetry,
    raw_telemetry: rawTelemetry,
  });

  try {
    const aiResponse = await GenerateRenovationAdvice(payload);
    typeWriter(formatMarkdown(aiResponse), aiOutput);
  } catch (error) {
    aiOutput.textContent = String(error);
  }
}

function formatMarkdown(markdown: string): string {
  return markdown
    .replace(
      /\*\*(.*?)\*\*/g,
      '<strong style="color: var(--accent-emerald);">$1</strong>',
    )
    .replace(
      /(?:^|\n)\* (.*?)(?=\n|$)/g,
      '<div style="margin-left: 12px; margin-bottom: 6px;">- $1</div>',
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
  getEl<HTMLDivElement>("sys-time").textContent = stats.time || "--:--:--";

  if (stats.available === false) {
    getEl<HTMLSpanElement>("gpu-text").textContent = "NVIDIA unavailable";
    getEl<HTMLSpanElement>("vram-text").textContent = "--";
    getEl<HTMLDivElement>("gpu-bar").style.width = "0%";
    getEl<HTMLDivElement>("vram-bar").style.width = "0%";
    return;
  }

  getEl<HTMLSpanElement>("gpu-text").textContent = `${gpu.toFixed(1)}%`;
  getEl<HTMLDivElement>("gpu-bar").style.width = `${gpu}%`;
  getEl<HTMLSpanElement>("vram-text").textContent = `${vram.toFixed(1)}%`;
  getEl<HTMLDivElement>("vram-bar").style.width = `${vram}%`;
}

function parseTelemetry(raw: string): PipelineTelemetry {
  const parsed = JSON.parse(raw) as PipelineTelemetry;
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
  const workspacePrefix = "/workspace/";
  const windowsWorkspacePrefix = "\\workspace\\";

  if (trimmed.startsWith(workspacePrefix)) {
    return `${currentModelDir}${trimmed
      .slice(workspacePrefix.length)
      .replace(/\//g, "\\")}`;
  }

  if (trimmed.startsWith(windowsWorkspacePrefix)) {
    return `${currentModelDir}${trimmed
      .slice(windowsWorkspacePrefix.length)
      .replace(/\//g, "\\")}`;
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

function isUSDAsset(path: string): boolean {
  return [".usd", ".usdc", ".usda", ".usdz"].includes(getExt(path));
}

function isSupportedAsset(path: string): boolean {
  return isUSDAsset(path) || isMeshRenderable(path);
}

function getSelectedModel(): ModelChoice {
  const value = getEl<HTMLSelectElement>("llm-model").value as ModelChoice;
  if (value === "llama3" || value === "mistral") return value;
  return "gemma:2b";
}

function setLanguage(lang: Language): void {
  IntLayer.setLanguage(lang);
  updateLanguageButtons();
  updateBppLabel();
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

function initTheme(): void {
  const savedTheme = localStorage.getItem("nequ3d.theme");
  const theme = savedTheme === "light" ? "light" : "dark";
  applyTheme(theme);
}

function toggleTheme(): void {
  const nextTheme = document.body.dataset.theme === "light" ? "dark" : "light";
  applyTheme(nextTheme);
}

function applyTheme(theme: string): void {
  document.body.dataset.theme = theme;
  localStorage.setItem("nequ3d.theme", theme);
  getEl<HTMLButtonElement>("theme-toggle").innerHTML =
    theme === "light" ? Icons.sun : Icons.moon;
}

function updateBppLabel(): void {
  getEl<HTMLSpanElement>("bpp-val").textContent =
    `${currentBpp} ${IntLayer.t.bppUnit}`;
}

function requestViewerResize(): void {
  syncComparisonLayout();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Image load failed: ${src}`));
    image.src = src;
  });
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
