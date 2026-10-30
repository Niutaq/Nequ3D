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

export type ToolMode = "orbit" | "measure" | "section";
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
let pendingPoint: MeasurePoint | null = null;
let measurements: Measurement[] = [];
let measureSeq = 1;
let hotspotSeq = 0;
let boundViewer: ModelViewerEl | null = null;
let clickHandler: ((e: MouseEvent) => void) | null = null;
let onMeasurementsChange: ((items: Measurement[]) => void) | null = null;
let onPendingChange: ((pending: boolean) => void) | null = null;

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

export function bindViewerTools(viewer: ModelViewerEl | null): void {
  if (boundViewer && clickHandler) {
    boundViewer.removeEventListener("click", clickHandler as EventListener);
  }
  boundViewer = viewer;
  clickHandler = (e: MouseEvent) => {
    if (toolMode !== "measure" || !boundViewer) return;
    handleMeasureClick(boundViewer, e);
  };
  if (boundViewer && clickHandler) {
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
    return { size, center };
  } catch {
    return null;
  }
}

function applyCameraControls(): void {
  if (!boundViewer) return;
  boundViewer.cameraControls = toolMode !== "measure";
}

function handleMeasureClick(viewer: ModelViewerEl, e: MouseEvent): void {
  if (!viewer.positionAndNormalFromPoint) return;
  const hit = viewer.positionAndNormalFromPoint(e.clientX, e.clientY);
  if (!hit) return;

  const point: MeasurePoint = {
    x: hit.position.x,
    y: hit.position.y,
    z: hit.position.z,
    nx: hit.normal.x,
    ny: hit.normal.y,
    nz: hit.normal.z,
  };

  addHotspot(viewer, point, pendingPoint ? "B" : "A");

  if (!pendingPoint) {
    pendingPoint = point;
    onPendingChange?.(true);
    return;
  }

  const a = pendingPoint;
  const b = point;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  measurements = [
    ...measurements,
    { id: measureSeq++, a, b, distance },
  ];
  pendingPoint = null;
  onPendingChange?.(false);
  onMeasurementsChange?.(measurements);
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
      color: 0x14b8a6,
      transparent: true,
      opacity: 0.18,
      side: DoubleSide,
      depthWrite: false,
    });
    helper = new Mesh(geo, mat);
    helper.name = SECTION_HELPER_NAME;
    helper.renderOrder = 999;
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
