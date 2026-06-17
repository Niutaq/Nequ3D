// frontend/src/i18n.ts

export type Language = "en" | "pl";

export const content = {
  en: {
    appSubtitle: "OpenUSD Edge-to-Core Pipeline",
    btnSelect: "Select Mesh",
    btnSelectSplat: "Select 3DGS",
    btnAnalyze: "Run Core Analysis",
    btnAnalyzeLoad: "Processing...",
    btnAnalyzeSuccess: "Processed Successfully",
    btnAnalyzeFailed: "Analysis Failed",
    telemetryTitle: "Telemetry & NTC Metrics",
    viewerEmptyTitle: "No model loaded",
    viewerEmptyDesc: "Select a mesh asset from the Edge node.",
    aiTitle: "Analysis",
    aiEmpty: "Waiting for telemetry to generate architectural insights...",
    aiLoading: "AI is analyzing telemetry...",
    sysTime: "System Time",
    procTime: "Process Time",
    noFile: "No mesh selected...",
    noSplat: "No 3DGS environment selected...",
    errorFailed: "Pipeline Execution Failed",
    tabMesh: "Mesh",
    tabSplat: "3DGS (Scan)",
    tabHybrid: "Hybrid (Mesh + Splat)",
    tabQuality: "Quality (NTC)",
    compareTitle: "Neural Reconstruction Analysis",
    compareDesc: "Slide to compare Original vs NTC reconstructed texture.",
    origLabel: "Original (32bpp)",
    ntcLabel: "NTC Reconstructed",
    neuralBitrate: "Neural Bitrate",
    bppUnit: "BPP",
    cpuLabel: "CPU",
    ramLabel: "RAM",
    meshPathLabel: "Mesh Asset",
    splatPathLabel: "3DGS Environment",
    modelLabel: "LLM Engine",
    modelFast: "Gemma 2B - Fast",
    modelLlama: "Llama 3 8B - Deeper",
    modelMistral: "Mistral 7B - Balanced",
    themeToggle: "Toggle theme",
    langEnglish: "English",
    langPolish: "Polish",
    hybridNote:
      "NTC compresses only UV-mapped mesh textures. 3DGS remains an uncompressed environmental background.",
    hybridWaiting:
      "Hybrid view needs a processed mesh and a .splat or .ply environment.",
    qualityBypassed:
      "NTC quality view hidden because texture compression was bypassed.",
    geometryOnly:
      "Geometry-only analysis active. NTC was bypassed for this asset.",
    loadSplatFailed: "Could not load the selected 3DGS environment.",
    gpuEngine: "GPU_ENGINE",
    vramLoad: "VRAM_LOAD",
    sysClock: "SYSTEM_CLOCK",
    pipelineTimer: "PIPELINE_TIMER",
    dataIngestion: "DATA_INGESTION",
    loadAssetBtn: "LOAD ASSET (USD / GLB / SPLAT)",
    targetBitrate: "TARGET_BITRATE",
    analyticsEngine: "ANALYTICS_ENGINE",
  },
  pl: {
    appSubtitle: "Potok OpenUSD Edge-to-Core",
    btnSelect: "Wybierz siatkę",
    btnSelectSplat: "Wybierz 3DGS",
    btnAnalyze: "Uruchom analizę Core",
    btnAnalyzeLoad: "Przetwarzanie...",
    btnAnalyzeSuccess: "Zakończono sukcesem",
    btnAnalyzeFailed: "Analiza nieudana",
    telemetryTitle: "Telemetria i metryki NTC",
    viewerEmptyTitle: "Brak wczytanego modelu",
    viewerEmptyDesc: "Wybierz zasób siatki z węzła Edge.",
    aiTitle: "Analiza",
    aiEmpty: "Oczekuje na telemetrię, aby wygenerować analizę...",
    aiLoading: "AI analizuje telemetrię...",
    sysTime: "Czas systemowy",
    procTime: "Czas procesu",
    noFile: "Nie wybrano siatki...",
    noSplat: "Nie wybrano środowiska 3DGS...",
    errorFailed: "Błąd wykonania potoku",
    tabMesh: "Siatka",
    tabSplat: "3DGS (skan)",
    tabHybrid: "Hybryda (siatka + splat)",
    tabQuality: "Jakość (NTC)",
    compareTitle: "Analiza rekonstrukcji neuronowej",
    compareDesc: "Przesuń suwak, aby porównać oryginał z teksturą NTC.",
    origLabel: "Oryginał (32bpp)",
    ntcLabel: "Rekonstrukcja NTC",
    neuralBitrate: "Bitrate neuronowy",
    bppUnit: "BPP",
    cpuLabel: "CPU",
    ramLabel: "RAM",
    meshPathLabel: "Zasób siatki",
    splatPathLabel: "Środowisko 3DGS",
    modelLabel: "Silnik LLM",
    modelFast: "Gemma 2B - szybki",
    modelLlama: "Llama 3 8B - głębszy",
    modelMistral: "Mistral 7B - zbalansowany",
    themeToggle: "Przełącz motyw",
    langEnglish: "Angielski",
    langPolish: "Polski",
    hybridNote:
      "NTC kompresuje tylko tekstury UV siatki. 3DGS pozostaje nieskompresowanym tłem środowiskowym.",
    hybridWaiting:
      "Widok hybrydowy wymaga przetworzonej siatki oraz środowiska .splat lub .ply.",
    qualityBypassed:
      "Widok jakości NTC ukryty, ponieważ kompresja tekstur została pominięta.",
    geometryOnly:
      "Aktywna analiza samej geometrii. NTC zostało pominięte dla tego zasobu.",
    loadSplatFailed: "Nie można wczytać wybranego środowiska 3DGS.",
    gpuEngine: "SILNIK_GPU",
    vramLoad: "OBCIĄŻENIE_VRAM",
    sysClock: "ZEGAR_SYSTEMOWY",
    pipelineTimer: "CZAS_POTOKU",
    dataIngestion: "POBIERANIE_DANYCH",
    loadAssetBtn: "WCZYTAJ ZASÓB (USD / GLB / SPLAT)",
    targetBitrate: "DOCELOWY_BITRATE",
    analyticsEngine: "SILNIK_ANALITYCZNY",
  },
} as const;

export type I18nKey = keyof (typeof content)["en"];

export class IntLayer {
  static currentLang: Language = "en";

  static get t() {
    return content[this.currentLang];
  }

  static setLanguage(lang: Language) {
    this.currentLang = lang;
    localStorage.setItem("nequ3d.lang", lang);
    this.updateDOM();
  }

  static init() {
    const saved = localStorage.getItem("nequ3d.lang");
    if (saved === "en" || saved === "pl") {
      this.currentLang = saved;
    }
    this.updateDOM();
  }

  static updateDOM(root: ParentNode = document) {
    root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n") as I18nKey | null;
      if (key && this.t[key] && !el.hasAttribute("data-locked")) {
        el.innerHTML = this.t[key];
      }
    });

    root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title") as I18nKey | null;
      if (key && this.t[key]) {
        el.setAttribute("title", this.t[key]);
      }
    });

    root.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((el) => {
      const key = el.getAttribute("data-i18n-aria") as I18nKey | null;
      if (key && this.t[key]) {
        el.setAttribute("aria-label", this.t[key]);
      }
    });
  }
}
