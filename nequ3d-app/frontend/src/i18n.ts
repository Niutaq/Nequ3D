// frontend/src/i18n.ts

export type Language = "en" | "pl";

export const content = {
  en: {
    appSubtitle: "Building Renovation Digital Twin",
    btnSelect: "Select Mesh",
    btnSelectSplat: "Select 3DGS",
    btnAnalyze: "Analyze",
    btnAnalyzeLoad: "Analyzing...",
    btnAnalyzeSuccess: "Success",
    btnAnalyzeFailed: "Analysis Failed",
    telemetryTitle: "Metrics",
    viewerEmptyTitle: "Load a 3D model",
    viewerEmptyDesc: "Select a mesh asset from the Edge node.",
    aiTitle: "Assistant",
    aiEmpty: "",
    aiLoading: "Telemetry analyzing...",
    sysTime: "System Time",
    procTime: "Process Time",
    noFile: "No file selected",
    noSplat: "No 3DGS environment selected...",
    errorFailed: "Pipeline Execution Failed",
    tabMesh: "Mesh",
    tabSplat: "3DGS (Scan)",
    tabHybrid: "Hybrid",
    tabQuality: "NTC",
    compareTitle: "Neural Reconstruction Analysis",
    compareDesc: "Slide to compare Original vs NTC reconstructed texture.",
    origLabel: "Original (32bpp)",
    ntcLabel: "NTC Reconstructed",
    neuralBitrate: "NTC Compression",
    bppUnit: "BPP",
    cpuLabel: "CPU",
    ramLabel: "RAM",
    meshPathLabel: "Mesh Asset",
    splatPathLabel: "3DGS Environment",
    modelLabel: "AI Model",
    modelFast: "Gemma 2B",
    modelLlama: "Llama 3 8B",
    modelMistral: "Mistral 7B",
    themeToggle: "Toggle theme",
    langEnglish: "English",
    langPolish: "Polish",
    sizeSmall: "Small text",
    sizeMedium: "Medium text",
    sizeLarge: "Large text",
    hybridNote: "",
    hybridWaiting: "Requires mesh and .splat / .ply file",
    qualityBypassed:
      "NTC quality view hidden because texture compression was bypassed.",
    geometryOnly:
      "Geometry-only analysis active. NTC was bypassed for this asset.",
    loadSplatFailed: "Could not load the selected 3DGS environment.",
    gpuEngine: "GPU",
    vramLoad: "VRAM",
    sysClock: "Time",
    pipelineTimer: "Run",
    dataIngestion: "Model",
    loadAssetBtn: "Load file",
    targetBitrate: "Bitrate",
    trainingSteps: "Steps",
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
    brandTagline: "",
    zonesTitle: "Zones",
    zonesEmpty: "No zones",
    zoneStatusUnknown: "unknown",
    zoneStatusOk: "OK",
    zoneStatusReplace: "replace",
    zonePrims: "prims",
    saveTwinBtn: "Save zones",
    saveTwinOk: "Saved",
    saveTwinFail: "Save failed",
    agentBtn: "Run agent",
    agentRunning: "Agent running…",
    agentEmpty: "",
    locateTitle: "Detection",
    locateBtn: "Detect",
    locatePrompt: "e.g. crack, window, moisture",
    locateEmpty: "No detections",
    locateRunning: "Locating…",
    tabSplatShort: "3DGS",
    toolsTitle: "Measure & Section",
    toolOrbit: "Orbit",
    toolMeasure: "Measure",
    toolSection: "Section",
    toolPin: "Pin",
    pinHint: "Click surface to place a 3D note",
    pinPlaceholder: "e.g. crack near window, moisture…",
    pinAdd: "Add",
    pinCancel: "Cancel",
    topViewBtn: "2D Top",
    simreadyTitle: "OpenUSD / SimReady",
    simreadyReady: "Kit Ready",
    simreadyWarn: "Review",
    measureHint: "Click two points on the mesh",
    measurePending: "Click second point",
    measureEmpty: "",
    measureClear: "Clear",
    measureDistance: "Distance",
    sectionAxis: "Axis",
    sectionDepth: "Cut depth",
    sectionOn: "Enable section",
    sectionOff: "Off",
    dimsLabel: "Extents",
    panelCollapse: "Collapse panel",
    panelExpand: "Expand panel",
    ingestCollapse: "Sketchfab import",
    navToggle: "Controls",
    navTitle: "3D Navigation",
    navMove: "WASD · Move",
    navTurn: "Q/E · Turn",
    navPitch: "R/F · Tilt",
    navMouseHint: "LMB Orbit · RMB Pan · Scroll Zoom",
    navReset: "Reset view",
  },
  pl: {
    appSubtitle: "Cyfrowy bliźniak remontu budynku",
    btnSelect: "Wybierz siatkę",
    btnSelectSplat: "Wybierz 3DGS",
    btnAnalyze: "Analizuj",
    btnAnalyzeLoad: "Analizowanie...",
    btnAnalyzeSuccess: "Zakończono",
    btnAnalyzeFailed: "Analiza nieudana",
    telemetryTitle: "Metryki",
    viewerEmptyTitle: "Wczytaj model 3D",
    viewerEmptyDesc: "Wybierz zasób siatki z węzła Edge.",
    aiTitle: "Asystent",
    aiEmpty: "",
    aiLoading: "Analiza telemetrii...",
    sysTime: "Czas systemowy",
    procTime: "Czas procesu",
    noFile: "Brak pliku",
    noSplat: "Nie wybrano środowiska 3DGS...",
    errorFailed: "Błąd wykonania potoku",
    tabMesh: "Siatka",
    tabSplat: "3DGS (skan)",
    tabHybrid: "Hybryda",
    tabQuality: "NTC",
    compareTitle: "Analiza rekonstrukcji neuronowej",
    compareDesc: "Przesuń suwak, aby porównać oryginał z teksturą NTC.",
    origLabel: "Oryginał (32bpp)",
    ntcLabel: "Rekonstrukcja NTC",
    neuralBitrate: "Kompresja NTC",
    bppUnit: "BPP",
    cpuLabel: "CPU",
    ramLabel: "RAM",
    meshPathLabel: "Zasób siatki",
    splatPathLabel: "Środowisko 3DGS",
    modelLabel: "Model AI",
    modelFast: "Gemma 2B",
    modelLlama: "Llama 3 8B",
    modelMistral: "Mistral 7B",
    themeToggle: "Przełącz motyw",
    langEnglish: "Angielski",
    langPolish: "Polski",
    sizeSmall: "Mały tekst",
    sizeMedium: "Średni tekst",
    sizeLarge: "Duży tekst",
    hybridNote: "",
    hybridWaiting: "Wymagana siatka oraz plik .splat / .ply",
    qualityBypassed:
      "Widok jakości NTC ukryty, ponieważ kompresja tekstur została pominięta.",
    geometryOnly:
      "Aktywna analiza samej geometrii. NTC zostało pominięte dla tego zasobu.",
    loadSplatFailed: "Nie można wczytać wybranego środowiska 3DGS.",
    gpuEngine: "GPU",
    vramLoad: "VRAM",
    sysClock: "Czas",
    pipelineTimer: "Proces",
    dataIngestion: "Model",
    loadAssetBtn: "Wczytaj plik",
    targetBitrate: "Bitrate",
    trainingSteps: "Kroki",
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
    brandTagline: "",
    zonesTitle: "Strefy",
    zonesEmpty: "Brak stref",
    zoneStatusUnknown: "nieznany",
    zoneStatusOk: "OK",
    zoneStatusReplace: "do wymiany",
    zonePrims: "obiekty",
    saveTwinBtn: "Zapisz strefy",
    saveTwinOk: "Zapisano",
    saveTwinFail: "Błąd zapisu",
    agentBtn: "Uruchom agenta",
    agentRunning: "Agent pracuje…",
    agentEmpty: "",
    locateTitle: "Detekcja",
    locateBtn: "Wykryj",
    locatePrompt: "np. pęknięcie, okno, wilgoć",
    locateEmpty: "Brak wyników",
    locateRunning: "Wykrywanie…",
    tabSplatShort: "3DGS",
    toolsTitle: "Pomiar i przekrój",
    toolOrbit: "Obrót",
    toolMeasure: "Pomiar",
    toolSection: "Przekrój",
    toolPin: "Notatka",
    pinHint: "Kliknij powierzchnię, aby przypiąć notatkę 3D",
    pinPlaceholder: "np. pęknięcie przy oknie, wilgoć…",
    pinAdd: "Dodaj",
    pinCancel: "Anuluj",
    topViewBtn: "Rzut 2D",
    simreadyTitle: "Walidacja OpenUSD / SimReady",
    simreadyReady: "Gotowy (Kit)",
    simreadyWarn: "Wymaga uwag",
    measureHint: "Kliknij 2 punkty na modelu",
    measurePending: "Kliknij drugi punkt",
    measureEmpty: "",
    measureClear: "Wyczyść",
    measureDistance: "Odległość",
    sectionAxis: "Oś",
    sectionDepth: "Głębokość",
    sectionOn: "Włącz przekrój",
    sectionOff: "Wył.",
    dimsLabel: "Wymiary",
    panelCollapse: "Zwiń panel",
    panelExpand: "Rozwiń panel",
    ingestCollapse: "Import ze Sketchfab",
    navToggle: "Sterowanie",
    navTitle: "Nawigacja 3D",
    navMove: "WASD · Ruch",
    navTurn: "Q/E · Obrót",
    navPitch: "R/F · Pochylenie",
    navMouseHint: "LPM Obrót · PPM Przesuwanie · Scroll Zoom",
    navReset: "Reset widoku",
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
