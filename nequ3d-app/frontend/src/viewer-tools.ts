import {
  $needsRender,
  $renderer,
  $scene,
} from "@google/model-viewer/lib/model-viewer-base.js";
import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Plane,
  PlaneGeometry,
  Vector3,
  type Material,
  type Object3D,
} from "three";

export type ToolMode = "orbit" | "measure" | "section" | "pin";
export type SectionAxis = "x" | "y" | "z";

export type MeasurePoint = {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
};

export type Measurement = {
  id: number;
  a: MeasurePoint;
  b: MeasurePoint;
  distance: number;
};

export type PinNote = {
  id: number;
  text: string;
  kind: string;
  position: MeasurePoint;
};

type ModelViewerEl = HTMLElement & {
  src?: string;
  cameraControls?: boolean;
  getDimensions?: () => { x: number; y: number; z: number };
  getBoundingBoxCenter?: () => { x: number; y: number; z: number };
  positionAndNormalFromPoint?: (
    x: number,
    y: number,
  ) => {
    position: { x: number; y: number; z: number };
    normal: { x: number; y: number; z: number };
  } | null;
};

const SECTION_HELPER_NAME = "__nequ3d_section_helper";

let toolMode: ToolMode = "orbit";
let sectionAxis: SectionAxis = "y";
let sectionT = 0.5;
let sectionEnabled = false;
let activeSectionPlane: Plane | null = null;
let pendingPoint: MeasurePoint | null = null;
let measurements: Measurement[] = [];
let measureSeq = 1;
let hotspotSeq = 0;
let unitScale = 1;

export function setUnitScale(scale: number): void {
  unitScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function getUnitScale(): number {
  return unitScale;
}
let boundViewer: ModelViewerEl | null = null;
let clickHandler: ((e: MouseEvent) => void) | null = null;
let pointerDownHandler: ((e: PointerEvent) => void) | null = null;
let downX = 0;
let downY = 0;
let hasPointerDown = false;
let onMeasurementsChange: ((items: Measurement[]) => void) | null = null;
let onPendingChange: ((pending: boolean) => void) | null = null;
let onMeasureComplete: (() => void) | null = null;
let pinNotes: PinNote[] = [];
let pinSeq = 1;
let onPinsChange: ((items: PinNote[]) => void) | null = null;
let onPinSurfaceClick: ((point: MeasurePoint) => void) | null = null;

export function getPinNotes(): PinNote[] {
  return pinNotes.slice();
}

export function setPinsListener(fn: ((items: PinNote[]) => void) | null): void {
  onPinsChange = fn;
}

export function setPinSurfaceClickListener(
  fn: ((point: MeasurePoint) => void) | null,
): void {
  onPinSurfaceClick = fn;
}

export function addPinNote(point: MeasurePoint, text: string, kind = "note"): PinNote {
  const note: PinNote = {
    id: pinSeq++,
    text: text.trim() || "Note",
    kind,
    position: point,
  };
  pinNotes = [...pinNotes, note];
  if (boundViewer) renderPinHotspot(boundViewer, note);
  onPinsChange?.(pinNotes);
  return note;
}

export function removePinNote(id: number): void {
  pinNotes = pinNotes.filter((p) => p.id !== id);
  if (boundViewer) {
    boundViewer
      .querySelectorAll(`.pin-hotspot[data-pin-id="${id}"]`)
      .forEach((n) => n.remove());
  }
  onPinsChange?.(pinNotes);
}

export function clearPinNotes(): void {
  pinNotes = [];
  if (boundViewer) {
    boundViewer.querySelectorAll(".pin-hotspot").forEach((n) => n.remove());
  }
  onPinsChange?.(pinNotes);
}

export function loadPinNotes(notes: PinNote[]): void {
  if (boundViewer) {
    boundViewer.querySelectorAll(".pin-hotspot").forEach((n) => n.remove());
  }
  pinNotes = [];
  let maxId = 0;
  for (const raw of notes) {
    if (!raw || !raw.position) continue;
    const id = Number(raw.id) || maxId + 1;
    if (id > maxId) maxId = id;
    const note: PinNote = {
      id,
      text: String(raw.text || "Note"),
      kind: String(raw.kind || "note"),
      position: raw.position,
    };
    pinNotes.push(note);
    if (boundViewer) renderPinHotspot(boundViewer, note);
  }
  pinSeq = Math.max(pinSeq, maxId + 1);
  onPinsChange?.(pinNotes);
}

export function reattachPinHotspots(): void {
  if (!boundViewer) return;
  boundViewer.querySelectorAll(".pin-hotspot").forEach((n) => n.remove());
  for (const note of pinNotes) {
    renderPinHotspot(boundViewer, note);
  }
}

function renderPinHotspot(viewer: ModelViewerEl, note: PinNote): void {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "pin-hotspot";
  el.dataset.pinId = String(note.id);
  el.slot = `hotspot-p${note.id}`;
  el.dataset.position = `${note.position.x}m ${note.position.y}m ${note.position.z}m`;
  el.dataset.normal = `${note.position.nx}m ${note.position.ny}m ${note.position.nz}m`;
  el.title = note.text;
  el.innerHTML = `<span class="pin-badge">P${note.id}</span><span class="pin-label"></span>`;
  const lbl = el.querySelector<HTMLSpanElement>(".pin-label");
  if (lbl) lbl.textContent = note.text;
  viewer.appendChild(el);
}

export function getToolMode(): ToolMode {
  return toolMode;
}

export function getMeasurements(): Measurement[] {
  return measurements.slice();
}

export function setMeasurementsListener(
  fn: ((items: Measurement[]) => void) | null,
): void {
  onMeasurementsChange = fn;
}

export function setPendingListener(fn: ((pending: boolean) => void) | null): void {
  onPendingChange = fn;
}

export function setMeasureCompleteListener(fn: (() => void) | null): void {
  onMeasureComplete = fn;
}

export function bindViewerTools(viewer: ModelViewerEl | null): void {
  if (boundViewer && clickHandler) {
    boundViewer.removeEventListener("click", clickHandler as EventListener);
  }
  if (boundViewer && pointerDownHandler) {
    boundViewer.removeEventListener(
      "pointerdown",
      pointerDownHandler as EventListener,
    );
  }
  boundViewer = viewer;
  pointerDownHandler = (e: PointerEvent) => {
    if (e.button !== 0) {
      hasPointerDown = false;
      return;
    }
    hasPointerDown = true;
    downX = e.clientX;
    downY = e.clientY;
  };
  clickHandler = (e: MouseEvent) => {
    if ((toolMode !== "measure" && toolMode !== "pin") || !boundViewer) return;
    if (
      hasPointerDown &&
      Math.hypot(e.clientX - downX, e.clientY - downY) > 5
    ) {
      hasPointerDown = false;
      return;
    }
    hasPointerDown = false;
    if (toolMode === "pin") {
      handlePinClick(boundViewer, e);
      return;
    }
    handleMeasureClick(boundViewer, e);
  };
  if (boundViewer && pointerDownHandler && clickHandler) {
    boundViewer.addEventListener(
      "pointerdown",
      pointerDownHandler as EventListener,
    );
    boundViewer.addEventListener("click", clickHandler as EventListener);
  }
  applyCameraControls();
  if (sectionEnabled) applySectionPlane();
}

export function setToolMode(mode: ToolMode): void {
  toolMode = mode;
  if (mode !== "measure") {
    pendingPoint = null;
    onPendingChange?.(false);
  }
  if (mode === "section") {
    sectionEnabled = true;
    applySectionPlane();
  }
  applyCameraControls();
}

export function setSectionAxis(axis: SectionAxis): void {
  sectionAxis = axis;
  if (sectionEnabled) applySectionPlane();
}

export function setSectionT(t: number): void {
  sectionT = clamp01(t);
  if (sectionEnabled) applySectionPlane();
}

export function setSectionEnabled(on: boolean): void {
  sectionEnabled = on;
  if (!on) clearSectionPlane();
  else applySectionPlane();
}

export function isSectionEnabled(): boolean {
  return sectionEnabled;
}

export function getSectionAxis(): SectionAxis {
  return sectionAxis;
}

export function getSectionT(): number {
  return sectionT;
}

export function clearMeasurements(): void {
  measurements = [];
  pendingPoint = null;
  onPendingChange?.(false);
  removeHotspots();
  onMeasurementsChange?.(measurements);
}

export function removeMeasurement(id: number): void {
  measurements = measurements.filter((m) => m.id !== id);
  if (measurements.length === 0) {
    removeHotspots();
  }
  onMeasurementsChange?.(measurements);
}

export function focusMeasurement(id: number): void {
  if (!boundViewer) return;
  const item = measurements.find((m) => m.id === id);
  if (!item) return;
  removeHotspots();
  addHotspot(boundViewer, item.a, "A");
  addHotspot(boundViewer, item.b, "B");
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "—";
  if (Math.abs(meters) >= 1) return `${meters.toFixed(3)} m`;
  return `${(meters * 1000).toFixed(1)} mm`;
}

export function readModelExtents(viewer: ModelViewerEl | null): {
  size: { x: number; y: number; z: number };
  center: { x: number; y: number; z: number };
} | null {
  if (!viewer?.getDimensions || !viewer.getBoundingBoxCenter) return null;
  try {
    const size = viewer.getDimensions();
    const center = viewer.getBoundingBoxCenter();
    if (!size || !center) return null;
    return {
      size: {
        x: size.x * unitScale,
        y: size.y * unitScale,
        z: size.z * unitScale,
      },
      center,
    };
  } catch {
    return null;
  }
}

function applyCameraControls(): void {
  if (!boundViewer) return;
  boundViewer.cameraControls = true;
}

function handlePinClick(viewer: ModelViewerEl, e: MouseEvent): void {
  if (!viewer.positionAndNormalFromPoint) return;
  const hit = viewer.positionAndNormalFromPoint(e.clientX, e.clientY);
  if (!hit) return;
  if (
    sectionEnabled &&
    activeSectionPlane &&
    activeSectionPlane.distanceToPoint(
      new Vector3(hit.position.x, hit.position.y, hit.position.z),
    ) < -1e-4
  ) {
    return;
  }
  onPinSurfaceClick?.({
    x: hit.position.x,
    y: hit.position.y,
    z: hit.position.z,
    nx: hit.normal.x,
    ny: hit.normal.y,
    nz: hit.normal.z,
  });
}

function handleMeasureClick(viewer: ModelViewerEl, e: MouseEvent): void {
  if (!viewer.positionAndNormalFromPoint) return;
  const hit = viewer.positionAndNormalFromPoint(e.clientX, e.clientY);
  if (!hit) return;

  if (
    sectionEnabled &&
    activeSectionPlane &&
    activeSectionPlane.distanceToPoint(
      new Vector3(hit.position.x, hit.position.y, hit.position.z),
    ) < -1e-4
  ) {
    return;
  }

  const point: MeasurePoint = {
    x: hit.position.x,
    y: hit.position.y,
    z: hit.position.z,
    nx: hit.normal.x,
    ny: hit.normal.y,
    nz: hit.normal.z,
  };

  if (!pendingPoint) {
    removeHotspots();
    addHotspot(viewer, point, "A");
    pendingPoint = point;
    onPendingChange?.(true);
    return;
  }

  addHotspot(viewer, point, "B");
  const a = pendingPoint;
  const b = point;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) * unitScale;
  measurements = [
    ...measurements,
    { id: measureSeq++, a, b, distance },
  ];
  pendingPoint = null;
  onPendingChange?.(false);
  onMeasurementsChange?.(measurements);
  onMeasureComplete?.();
}

function addHotspot(viewer: ModelViewerEl, p: MeasurePoint, label: string): void {
  hotspotSeq += 1;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "measure-hotspot";
  el.slot = `hotspot-m${hotspotSeq}`;
  el.dataset.position = `${p.x}m ${p.y}m ${p.z}m`;
  el.dataset.normal = `${p.nx}m ${p.ny}m ${p.nz}m`;
  el.textContent = label;
  el.setAttribute("aria-label", `Measure point ${label}`);
  viewer.appendChild(el);
}

function removeHotspots(): void {
  if (!boundViewer) return;
  boundViewer
    .querySelectorAll(".measure-hotspot")
    .forEach((node) => node.remove());
  hotspotSeq = 0;
}

function getMvScene(viewer: ModelViewerEl): Object3D | null {
  try {
    return (viewer as any)[$scene] ?? null;
  } catch {
    return null;
  }
}

function getThreeRenderer(viewer: ModelViewerEl): {
  localClippingEnabled: boolean;
} | null {
  try {
    const rendererHost = (viewer as any)[$renderer];
    return rendererHost?.threeRenderer ?? null;
  } catch {
    return null;
  }
}

function requestRender(viewer: ModelViewerEl): void {
  try {
    (viewer as any)[$needsRender]?.();
  } catch {
    // ignore
  }
}

export function applySectionPlane(): void {
  const viewer = boundViewer;
  if (!viewer || !sectionEnabled) return;

  const extents = readModelExtents(viewer);
  const scene = getMvScene(viewer);
  const threeRenderer = getThreeRenderer(viewer);
  if (!extents || !scene || !threeRenderer) return;

  const { size, center } = extents;
  const axisSize = size[sectionAxis] || 1;
  const half = axisSize / 2;
  const pos = center[sectionAxis] - half + sectionT * axisSize;

  const normal = new Vector3(
    sectionAxis === "x" ? 1 : 0,
    sectionAxis === "y" ? 1 : 0,
    sectionAxis === "z" ? 1 : 0,
  );
  const point = new Vector3(
    sectionAxis === "x" ? pos : center.x,
    sectionAxis === "y" ? pos : center.y,
    sectionAxis === "z" ? pos : center.z,
  );
  const plane = new Plane().setFromNormalAndCoplanarPoint(normal, point);
  activeSectionPlane = plane;

  threeRenderer.localClippingEnabled = true;

  scene.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh || mesh.name === SECTION_HELPER_NAME) return;
    const mats = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    mats.forEach((mat) => {
      if (!mat) return;
      const m = mat as Material & { clippingPlanes?: Plane[] };
      m.clippingPlanes = [plane];
      m.clipShadows = true;
      m.needsUpdate = true;
    });
  });

  updateSectionHelper(scene, point, normal, size);
  requestRender(viewer);
}

function clearSectionPlane(): void {
  activeSectionPlane = null;
  const viewer = boundViewer;
  if (!viewer) return;
  const scene = getMvScene(viewer);
  const threeRenderer = getThreeRenderer(viewer);
  if (scene) {
    scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.name === SECTION_HELPER_NAME) {
        mesh.visible = false;
        return;
      }
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      mats.forEach((mat) => {
        if (!mat) return;
        const m = mat as Material & { clippingPlanes?: Plane[] };
        m.clippingPlanes = [];
        m.needsUpdate = true;
      });
    });
  }
  if (threeRenderer) threeRenderer.localClippingEnabled = false;
  requestRender(viewer);
}

function updateSectionHelper(
  scene: Object3D,
  point: Vector3,
  normal: Vector3,
  size: { x: number; y: number; z: number },
): void {
  let helper = scene.getObjectByName(SECTION_HELPER_NAME) as Mesh | undefined;
  const span = Math.max(size.x, size.y, size.z) * 1.2;

  if (!helper) {
    const geo = new PlaneGeometry(1, 1);
    const mat = new MeshBasicMaterial({
      color: 0x00d2e6,
      transparent: true,
      opacity: 0.18,
      side: DoubleSide,
      depthWrite: false,
    });
    helper = new Mesh(geo, mat);
    helper.name = SECTION_HELPER_NAME;
    helper.renderOrder = 999;
    helper.raycast = () => {};
    scene.add(helper);
  }

  helper.visible = true;
  helper.position.copy(point);
  helper.scale.set(span, span, 1);
  helper.lookAt(point.clone().add(normal));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
