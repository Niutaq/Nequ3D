// frontend/src/i18n.ts

export type Language = "en" | "pl";

export const content = {
  en: {
    appSubtitle: "OpenUSD Edge-to-Core Pipeline",
    btnSelect: "Select Mesh",
    btnSelectSplat: "Select 3DGS",
    btnAnalyze: "Run Core Analysis",
    btnAnalyzeLoad: "Analyzing...",
    btnAnalyzeSuccess: "Success",
    btnAnalyzeFailed: "Analysis Failed",
    telemetryTitle: "Telemetry & NTC Metrics",
    viewerEmptyTitle: "No model loaded",
    viewerEmptyDesc: "Select a mesh asset from the Edge node.",
    aiTitle: "Analysis",
    aiEmpty: "Waiting for telemetry to generate architectural insights...",
    aiLoading: "Telemetry analyzing...",
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
    sizeSmall: "Small text",
    sizeMedium: "Medium text",
    sizeLarge: "Large text",
    hybridNote:
      "NTC compresses only UV-mapped mesh textures. 3DGS remains an uncompressed environmental background.",
    hybridWaiting:
      "Hybrid view needs a processed mesh and a .splat or .ply environment.",
    qualityBypassed:
      "NTC quality view hidden because texture compression was bypassed.",
    geometryOnly:
      "Geometry-only analysis active. NTC was bypassed for this asset.",
    loadSplatFailed: "Could not load the selected 3DGS environment.",
    gpuEngine: "GPU LOAD",
    vramLoad: "VRAM LOAD",
    sysClock: "SYSTEM CLOCK",
    pipelineTimer: "PIPELINE TIMER",
    dataIngestion: "DATA INGESTION",
    loadAssetBtn: "LOAD ASSET",
    targetBitrate: "TARGET BITRATE",
    trainingSteps: "TRAINING STEPS",
    analyticsEngine: "ANALYTICS ENGINE",
    loadSketchfabBtn: "Load & Analyze",
    sketchfabUrl: "Model URL or UID",
    sketchfabToken: "API Token (required)",
    sketchfabDownloading: "Downloading USDZ...",
    sketchfabConnecting: "Connecting to API...",
    sketchfabSuccess: "Downloaded successfully!",
    sketchfabMissing: "Missing URL or token!",
    sketchfabError: "Error",
    sketchfabNetwork: "Could not reach the Sketchfab API. Check your internet connection and try again.",
    sketchfabRequest: "The Sketchfab request failed. Check that the model URL/UID is correct.",
    sketchfabInvalidToken: "Invalid API token. Please check your Sketchfab API token and try again.",
    sketchfabForbidden: "This model cannot be downloaded. It may be private/paid, your API token may lack download permission, or the model has no downloadable USDZ/GLB files. Check the token in your Sketchfab account settings and pick a downloadable model.",
    sketchfabNotFound: "Model not found. Check that the model URL or UID is correct.",
    sketchfabRateLimit: "Too many requests to the Sketchfab API. Please wait a moment and try again.",
    sketchfabServer: "Sketchfab is temporarily unavailable. Please try again later.",
    sketchfabParse: "Could not read the Sketchfab response. Please try again.",
    sketchfabNoUsdz: "This model has no USDZ format (required for NTC).",
    sketchfabNoGlb: "This model has no GLB format (required for preview).",
    sketchfabDownload: "Failed to download the model files from Sketchfab. Please try again.",
  },
  pl: {
    appSubtitle: "Potok OpenUSD Edge-to-Core",
    btnSelect: "Wybierz siatkę",
    btnSelectSplat: "Wybierz 3DGS",
    btnAnalyze: "Uruchom analizę Core",
    btnAnalyzeLoad: "Analizowanie...",
    btnAnalyzeSuccess: "Zakończono",
    btnAnalyzeFailed: "Analiza nieudana",
    telemetryTitle: "Telemetria i metryki NTC",
    viewerEmptyTitle: "Brak wczytanego modelu",
    viewerEmptyDesc: "Wybierz zasób siatki z węzła Edge.",
    aiTitle: "Analiza",
    aiEmpty: "Oczekuje na telemetrię, aby wygenerować analizę...",
    aiLoading: "Analiza telemetrii...",
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
    sizeSmall: "Mały tekst",
    sizeMedium: "Średni tekst",
    sizeLarge: "Duży tekst",
    hybridNote:
      "NTC kompresuje tylko tekstury UV siatki. 3DGS pozostaje nieskompresowanym tłem środowiskowym.",
    hybridWaiting:
      "Widok hybrydowy wymaga przetworzonej siatki oraz środowiska .splat lub .ply.",
    qualityBypassed:
      "Widok jakości NTC ukryty, ponieważ kompresja tekstur została pominięta.",
    geometryOnly:
      "Aktywna analiza samej geometrii. NTC zostało pominięte dla tego zasobu.",
    loadSplatFailed: "Nie można wczytać wybranego środowiska 3DGS.",
    gpuEngine: "OBCIĄŻENIE GPU",
    vramLoad: "OBCIĄŻENIE VRAM",
    sysClock: "ZEGAR SYSTEMOWY",
    pipelineTimer: "POMIAR",
    dataIngestion: "POBIERANIE DANYCH",
    loadAssetBtn: "WCZYTAJ",
    targetBitrate: "DOCELOWY BITRATE",
    trainingSteps: "KROKI TRENINGU",
    analyticsEngine: "SILNIK ANALITYCZNY",
    loadSketchfabBtn: "Pobierz i Analizuj",
    sketchfabUrl: "Model URL lub UID",
    sketchfabToken: "API Token (wymagany)",
    sketchfabDownloading: "Pobieranie USDZ...",
    sketchfabConnecting: "Łączenie z API Sketchfab...",
    sketchfabSuccess: "Pobrano pomyślnie!",
    sketchfabMissing: "Brak URL lub tokena!",
    sketchfabError: "Błąd",
    sketchfabNetwork: "Nie można połączyć się z API Sketchfab. Sprawdź połączenie internetowe i spróbuj ponownie.",
    sketchfabRequest: "Żądanie do Sketchfab nie powiodło się. Sprawdź poprawność URL/UID modelu.",
    sketchfabInvalidToken: "Nieprawidłowy token API. Sprawdź swój token API Sketchfab i spróbuj ponownie.",
    sketchfabForbidden: "Tego modelu nie można pobrać. Może być prywatny lub płatny, Twój token API może nie mieć uprawnień do pobierania, albo model nie posiada plików USDZ/GLB do pobrania. Sprawdź token w ustawieniach konta Sketchfab i wybierz model, który można pobrać.",
    sketchfabNotFound: "Model nie został znaleziony. Sprawdź, czy URL lub UID modelu jest poprawny.",
    sketchfabRateLimit: "Zbyt wiele żądań do API Sketchfab. Odczekaj chwilę i spróbuj ponownie.",
    sketchfabServer: "Sketchfab jest chwilowo niedostępny. Spróbuj ponownie później.",
    sketchfabParse: "Nie można odczytać odpowiedzi ze Sketchfab. Spróbuj ponownie.",
    sketchfabNoUsdz: "Ten model nie posiada formatu USDZ (wymaganego przez NTC).",
    sketchfabNoGlb: "Ten model nie posiada formatu GLB (wymaganego do podglądu).",
    sketchfabDownload: "Nie udało się pobrać plików modelu ze Sketchfab. Spróbuj ponownie.",
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

    root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder") as I18nKey | null;
      if (key && this.t[key]) {
        el.setAttribute("placeholder", this.t[key]);
      }
    });
  }

  static translateAll(root: ParentNode = document) {
    this.updateDOM(root);
  }
}
