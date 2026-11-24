/** Lazy Gaussian splat viewer & deterministic anisotropic 2DGS surfel converter for 3DGS / Hybrid tabs. */
import { $scene } from "@google/model-viewer/lib/model-viewer-base.js";
import {
  Box3,
  Color,
  Matrix4,
  Quaternion as ThreeQuaternion,
  Vector2,
  Vector3 as ThreeVector3,
  type BufferGeometry,
  type Material,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
} from "three";

export type SplatSource =
  | { kind: "url"; url: string; ext?: string }
  | {
      kind: "buffer";
      buffer: ArrayBuffer;
      radius?: number;
      center?: [number, number, number];
    };

export type ConvertedSplat = {
  buffer: ArrayBuffer;
  count: number;
  radius: number;
  center: [number, number, number];
};

export type MountSplatOptions = {
  /** When provided (Hybrid tab), locks gsplat camera 1:1 to this <model-viewer>'s Three.js camera & model transform. */
  syncViewer?: HTMLElement | null;
  /** Center offset subtracted from model-local coordinates when generating the splat buffer. */
  syncCenter?: [number, number, number];
};

const SECTION_HELPER_NAME = "__nequ3d_section_helper";

let raf = 0;
let disposed = true;
let hostEl: HTMLElement | null = null;
let activeResizeObserver: ResizeObserver | null = null;
let activeControls: {
  update?: () => void;
  dispose?: () => void;
  setCameraTarget?: (v: any) => void;
} | null = null;
let activeRenderer: { dispose?: () => void } | null = null;
let activeResetFn: (() => void) | null = null;
let activeTopViewFn: ((enabled: boolean) => void) | null = null;
let activeKeyGuard: ((e: KeyboardEvent) => void) | null = null;

type TextureSampler = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  flipY: boolean;
};

function buildTextureSampler(material: Material | undefined): {
  sampler: TextureSampler | null;
  fallbackColor: [number, number, number];
} {
  const mat = material as
    | (Material & {
        color?: Color;
        map?: {
          flipY?: boolean;
          image?: CanvasImageSource & {
            width?: number;
            height?: number;
            naturalWidth?: number;
            naturalHeight?: number;
          };
        };
      })
    | undefined;

  const fallbackColor: [number, number, number] = [200, 210, 215];
  if (mat?.color) {
    fallbackColor[0] = Math.round(Math.min(1, Math.max(0, mat.color.r)) * 255);
    fallbackColor[1] = Math.round(Math.min(1, Math.max(0, mat.color.g)) * 255);
    fallbackColor[2] = Math.round(Math.min(1, Math.max(0, mat.color.b)) * 255);
  }

  const img = mat?.map?.image;
  if (!img) return { sampler: null, fallbackColor };

  const rawW = Number(img.width ?? img.naturalWidth ?? 0);
  const rawH = Number(img.height ?? img.naturalHeight ?? 0);
  if (!rawW || !rawH) return { sampler: null, fallbackColor };

  // In glTF / Three.js GLTFLoader, texture.flipY is false (v=0 is top of image).
  const flipY = mat?.map?.flipY === true;

  // High-res 2048px cap preserves sharp architectural & furniture details.
  const scale = Math.min(1, 2048 / Math.max(rawW, rawH));
  const width = Math.max(1, Math.round(rawW * scale));
  const height = Math.max(1, Math.round(rawH * scale));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { sampler: null, fallbackColor };
    ctx.drawImage(img, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { sampler: { data, width, height, flipY }, fallbackColor };
  } catch {
    return { sampler: null, fallbackColor };
  }
}

function getModelRoot(modelScene: any): Object3D | null {
  const gltfScene = modelScene?.currentGLTF?.scene as Object3D | undefined;
  if (gltfScene) return gltfScene;
  const gltfs = modelScene?.currentGLTFs as
    | Array<{ scene?: Object3D }>
    | undefined;
  if (Array.isArray(gltfs) && gltfs[0]?.scene) return gltfs[0].scene;
  return modelScene as Object3D | null;
}

function isInternalHelperMesh(mesh: Mesh, modelScene: any): boolean {
  if (mesh.name === SECTION_HELPER_NAME) return true;
  if (modelScene?.bakedShadows?.has?.(mesh)) return true;
  if (
    modelScene?.shadow &&
    (mesh === modelScene.shadow || mesh.parent === modelScene.shadow)
  ) {
    return true;
  }
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const matType = String((mat as any)?.type || "");
  if (matType === "ShadowMaterial") return true;
  const lowerName = (mesh.name || "").toLowerCase();
  if (lowerName.includes("shadow") || lowerName.includes("skybox")) return true;
  return false;
}

function encodeByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 128 + 128)));
}

/**
 * Deterministic anisotropic triangle-fitted 2D Gaussian surfel converter.
 * Instead of random Monte Carlo sampling (which causes Poisson clumping and black holes),
 * every triangle (or deterministic stride / barycentric subdivision on large faces) emits
 * a flat elliptical surfel aligned to its exact tangent/bitangent/normal frame and extents.
 */
export async function convertViewerMeshToSplatBuffer(
  viewer: HTMLElement | null,
  maxSplats = 950000,
): Promise<ConvertedSplat | null> {
  if (!viewer) return null;
  let modelScene: any = null;
  try {
    modelScene = (viewer as any)[$scene] ?? null;
  } catch {
    modelScene = null;
  }
  if (!modelScene) return null;

  modelScene.updateMatrixWorld(true);
  const root = getModelRoot(modelScene);
  if (!root) return null;
  root.updateMatrixWorld(true);

  const invRoot = root.matrixWorld.clone().invert();

  type MeshEntry = {
    geo: BufferGeometry;
    localMatrix: Matrix4;
    sampler: TextureSampler | null;
    fallbackColor: [number, number, number];
    triCount: number;
  };

  const entries: MeshEntry[] = [];
  const bbox = new Box3();
  const v0 = new ThreeVector3();
  const v1 = new ThreeVector3();
  const v2 = new ThreeVector3();

  let totalTris = 0;

  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (
      !mesh.isMesh ||
      !mesh.visible ||
      isInternalHelperMesh(mesh, modelScene)
    ) {
      return;
    }
    const geo = mesh.geometry as BufferGeometry | undefined;
    const posAttr = geo?.attributes?.position;
    if (!geo || !posAttr || posAttr.count < 3) return;

    const index = geo.index;
    const triCount = index
      ? Math.floor(index.count / 3)
      : Math.floor(posAttr.count / 3);
    if (triCount <= 0) return;

    const localMatrix = invRoot.clone().multiply(mesh.matrixWorld);
    // Compute bbox quickly over unique vertices
    for (let i = 0; i < posAttr.count; i++) {
      v0.fromBufferAttribute(posAttr, i).applyMatrix4(localMatrix);
      bbox.expandByPoint(v0);
    }

    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const { sampler, fallbackColor } = buildTextureSampler(mat);
    entries.push({ geo, localMatrix, sampler, fallbackColor, triCount });
    totalTris += triCount;
  });

  if (!entries.length || totalTris <= 0) return null;

  const center = bbox.getCenter(new ThreeVector3());
  const size = bbox.getSize(new ThreeVector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.1);

  const budget = Math.max(50000, Math.min(maxSplats, 980000));
  const stride = totalTris > budget ? totalTris / budget : 1;
  // Tight overlap seals every triangle seam cleanly without over-blurring edges
  const coverageBoost = stride > 1 ? Math.sqrt(stride) * 1.25 : 1.15;
  // On low-poly models, subdivide large triangles deterministically for crisp texture detail
  const allowSubdiv = stride === 1 && totalTris < budget * 0.45;
  const targetEdge = maxDim / 220;
  const minS = maxDim * 0.0007;
  const maxS = maxDim * 0.035;

  // Allocate buffer up to budget
  const buffer = new ArrayBuffer(budget * 32);
  const f32 = new Float32Array(buffer);
  const u8 = new Uint8Array(buffer);

  const e01 = new ThreeVector3();
  const e12 = new ThreeVector3();
  const e20 = new ThreeVector3();
  const t1 = new ThreeVector3();
  const t2 = new ThreeVector3();
  const norm = new ThreeVector3();
  const t1Cv = new ThreeVector3();
  const t2Cv = new ThreeVector3();
  const nCv = new ThreeVector3();
  const basisMat = new Matrix4();
  const surfQuat = new ThreeQuaternion();
  const rel = new ThreeVector3();
  const uv0 = new Vector2();
  const uv1 = new Vector2();
  const uv2 = new Vector2();

  let writeIdx = 0;

  const sampleColorAt = (
    sampler: TextureSampler | null,
    uvAttr: any,
    colorAttr: any,
    fallbackColor: [number, number, number],
    i0: number,
    i1: number,
    i2: number,
    r0: number,
    r1: number,
    r2: number,
  ): [number, number, number] => {
    if (sampler && uvAttr) {
      uv0.set(uvAttr.getX(i0), uvAttr.getY(i0));
      uv1.set(uvAttr.getX(i1), uvAttr.getY(i1));
      uv2.set(uvAttr.getX(i2), uvAttr.getY(i2));
      const u = (((uv0.x * r0 + uv1.x * r1 + uv2.x * r2) % 1) + 1) % 1;
      const v = (((uv0.y * r0 + uv1.y * r1 + uv2.y * r2) % 1) + 1) % 1;
      const vy = sampler.flipY ? 1 - v : v;
      const tx = Math.min(sampler.width - 1, Math.floor(u * sampler.width));
      const ty = Math.min(sampler.height - 1, Math.floor(vy * sampler.height));
      const pOff = (ty * sampler.width + tx) * 4;
      return [sampler.data[pOff], sampler.data[pOff + 1], sampler.data[pOff + 2]];
    }
    if (colorAttr) {
      return [
        Math.round(
          Math.min(
            1,
            Math.max(
              0,
              colorAttr.getX(i0) * r0 +
                colorAttr.getX(i1) * r1 +
                colorAttr.getX(i2) * r2,
            ),
          ) * 255,
        ),
        Math.round(
          Math.min(
            1,
            Math.max(
              0,
              colorAttr.getY(i0) * r0 +
                colorAttr.getY(i1) * r1 +
                colorAttr.getY(i2) * r2,
            ),
          ) * 255,
        ),
        Math.round(
          Math.min(
            1,
            Math.max(
              0,
              colorAttr.getZ(i0) * r0 +
                colorAttr.getZ(i1) * r1 +
                colorAttr.getZ(i2) * r2,
            ),
          ) * 255,
        ),
      ];
    }
    return fallbackColor;
  };

  const emitSplat = (
    px: number,
    py: number,
    pz: number,
    sx: number,
    sy: number,
    sz: number,
    cr: number,
    cg: number,
    cb: number,
    q: ThreeQuaternion,
  ) => {
    if (writeIdx >= budget) return;
    const fOff = writeIdx * 8;
    // Convert Three.js Y-up to gsplat OpenCV Y-down
    f32[fOff + 0] = px - center.x;
    f32[fOff + 1] = -(py - center.y);
    f32[fOff + 2] = -(pz - center.z);
    f32[fOff + 3] = sx;
    f32[fOff + 4] = sy;
    f32[fOff + 5] = sz;

    const bOff = writeIdx * 32;
    u8[bOff + 24] = cr;
    u8[bOff + 25] = cg;
    u8[bOff + 26] = cb;
    u8[bOff + 27] = 255;
    // gsplat SplatData quaternion byte layout is [w, x, y, z]
    u8[bOff + 28] = encodeByte(q.w);
    u8[bOff + 29] = encodeByte(q.x);
    u8[bOff + 30] = encodeByte(q.y);
    u8[bOff + 31] = encodeByte(q.z);
    writeIdx += 1;
  };

  let nextGlobalTri = 0;
  let globalTriOffset = 0;

  for (let mIdx = 0; mIdx < entries.length && writeIdx < budget; mIdx++) {
    const entry = entries[mIdx];
    const posAttr = entry.geo.attributes.position;
    const uvAttr = entry.geo.attributes.uv;
    const colorAttr = entry.geo.attributes.color;
    const index = entry.geo.index;
    const { localMatrix, sampler, fallbackColor, triCount } = entry;

    while (writeIdx < budget) {
      const localTri = Math.floor(nextGlobalTri) - globalTriOffset;
      if (localTri >= triCount) break;
      nextGlobalTri += stride;
      if (localTri < 0) continue;

      const i0 = index ? index.getX(localTri * 3) : localTri * 3;
      const i1 = index ? index.getX(localTri * 3 + 1) : localTri * 3 + 1;
      const i2 = index ? index.getX(localTri * 3 + 2) : localTri * 3 + 2;

      v0.fromBufferAttribute(posAttr, i0).applyMatrix4(localMatrix);
      v1.fromBufferAttribute(posAttr, i1).applyMatrix4(localMatrix);
      v2.fromBufferAttribute(posAttr, i2).applyMatrix4(localMatrix);

      e01.subVectors(v1, v0);
      e12.subVectors(v2, v1);
      e20.subVectors(v0, v2);
      norm.crossVectors(e01, e20).negate();
      const twiceArea = norm.length();
      if (twiceArea < 1e-10) continue;
      norm.divideScalar(twiceArea);

      // Longest edge defines primary tangent axis for optimal anisotropic ellipse fit
      const l0 = e01.lengthSq();
      const l1 = e12.lengthSq();
      const l2 = e20.lengthSq();
      if (l0 >= l1 && l0 >= l2) {
        t1.copy(e01).normalize();
      } else if (l1 >= l2) {
        t1.copy(e12).normalize();
      } else {
        t1.copy(e20).normalize();
      }
      t2.crossVectors(norm, t1).normalize();

      // Build right-handed orthonormal basis in OpenCV Y-down coordinates (det(C) = +1)
      t1Cv.set(t1.x, -t1.y, -t1.z);
      t2Cv.set(t2.x, -t2.y, -t2.z);
      nCv.set(norm.x, -norm.y, -norm.z);
      basisMat.makeBasis(t1Cv, t2Cv, nCv);
      surfQuat.setFromRotationMatrix(basisMat);

      const cx = (v0.x + v1.x + v2.x) / 3;
      const cy = (v0.y + v1.y + v2.y) / 3;
      const cz = (v0.z + v1.z + v2.z) / 3;

      // Exact bounding half-extents of the triangle in its tangent plane
      let minU = Infinity;
      let maxU = -Infinity;
      let minW = Infinity;
      let maxW = -Infinity;
      for (const v of [v0, v1, v2]) {
        rel.set(v.x - cx, v.y - cy, v.z - cz);
        const uProj = rel.dot(t1);
        const wProj = rel.dot(t2);
        if (uProj < minU) minU = uProj;
        if (uProj > maxU) maxU = uProj;
        if (wProj < minW) minW = wProj;
        if (wProj > maxW) maxW = wProj;
      }
      const hx = (maxU - minU) * 0.5;
      const hy = (maxW - minW) * 0.5;
      const maxEdge = Math.sqrt(Math.max(l0, l1, l2));

      // Deterministic barycentric subdivision for large low-poly faces
      let k = 1;
      if (allowSubdiv && maxEdge > targetEdge * 1.8) {
        k = Math.min(6, Math.max(2, Math.ceil(maxEdge / targetEdge)));
        if (writeIdx + k * k > budget) k = 1;
      }

      if (k === 1) {
        const sx = Math.min(maxS, Math.max(minS, hx * 0.96 * coverageBoost));
        const sy = Math.min(maxS, Math.max(minS, hy * 0.96 * coverageBoost));
        const sz = Math.max(minS * 0.25, Math.min(sx, sy) * 0.14);
        const [cr, cg, cb] = sampleColorAt(
          sampler,
          uvAttr,
          colorAttr,
          fallbackColor,
          i0,
          i1,
          i2,
          1 / 3,
          1 / 3,
          1 / 3,
        );
        emitSplat(cx, cy, cz, sx, sy, sz, cr, cg, cb, surfQuat);
      } else {
        const invK = 1 / k;
        const sx = Math.min(maxS, Math.max(minS, (hx * invK) * 0.85));
        const sy = Math.min(maxS, Math.max(minS, (hy * invK) * 0.85));
        const sz = Math.max(minS * 0.25, Math.min(sx, sy) * 0.14);
        for (let a = 0; a < k; a++) {
          for (let b = 0; b < k - a; b++) {
            // Upward sub-triangle centroid
            const r1 = (a + 1 / 3) * invK;
            const r2 = (b + 1 / 3) * invK;
            const r0 = 1 - r1 - r2;
            const px = v0.x * r0 + v1.x * r1 + v2.x * r2;
            const py = v0.y * r0 + v1.y * r1 + v2.y * r2;
            const pz = v0.z * r0 + v1.z * r1 + v2.z * r2;
            const [cr, cg, cb] = sampleColorAt(
              sampler,
              uvAttr,
              colorAttr,
              fallbackColor,
              i0,
              i1,
              i2,
              r0,
              r1,
              r2,
            );
            emitSplat(px, py, pz, sx, sy, sz, cr, cg, cb, surfQuat);

            // Downward sub-triangle centroid
            if (a + b + 1 < k) {
              const dr1 = (a + 2 / 3) * invK;
              const dr2 = (b + 2 / 3) * invK;
              const dr0 = 1 - dr1 - dr2;
              const dpx = v0.x * dr0 + v1.x * dr1 + v2.x * dr2;
              const dpy = v0.y * dr0 + v1.y * dr1 + v2.y * dr2;
              const dpz = v0.z * dr0 + v1.z * dr1 + v2.z * dr2;
              const [dcr, dcg, dcb] = sampleColorAt(
                sampler,
                uvAttr,
                colorAttr,
                fallbackColor,
                i0,
                i1,
                i2,
                dr0,
                dr1,
                dr2,
              );
              emitSplat(dpx, dpy, dpz, sx, sy, sz, dcr, dcg, dcb, surfQuat);
            }
          }
        }
      }
    }

    globalTriOffset += triCount;
  }

  if (writeIdx === 0) return null;
  const finalBuffer =
    writeIdx < budget ? buffer.slice(0, writeIdx * 32) : buffer;
  return {
    buffer: finalBuffer,
    count: writeIdx,
    radius: Math.max(2.2, maxDim * 1.15),
    center: [center.x, center.y, center.z],
  };
}

/** Resets the active standalone 3DGS camera back to its initial framing. */
export function resetSplatCamera(): void {
  activeResetFn?.();
}

/** Switches the active standalone 3DGS camera between overhead 2D Top View and 3D orbit. */
export function setSplatTopView(enabled: boolean): void {
  activeTopViewFn?.(enabled);
}

const PLY_TYPE_SIZE: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

function readPlyScalar(view: DataView, offset: number, type: string): number {
  switch (type) {
    case "float":
    case "float32":
      return view.getFloat32(offset, true);
    case "double":
    case "float64":
      return view.getFloat64(offset, true);
    case "uchar":
    case "uint8":
      return view.getUint8(offset);
    case "char":
    case "int8":
      return view.getInt8(offset);
    case "ushort":
    case "uint16":
      return view.getUint16(offset, true);
    case "short":
    case "int16":
      return view.getInt16(offset, true);
    case "uint":
    case "uint32":
      return view.getUint32(offset, true);
    case "int":
    case "int32":
      return view.getInt32(offset, true);
    default:
      return 0;
  }
}

/**
 * Universal PLY -> 32-byte .splat parser.
 * Supports both native 3DGS PLY (f_dc_0..2, scale_0..2, rot_0..3, opacity) AND
 * standard point-cloud/mesh PLY (x,y,z + optional RGB) in binary_little_endian or ASCII,
 * safely handling Windows CRLF headers and extra face/list elements.
 */
function parsePlyToSplatBuffer(raw: ArrayBuffer): ConvertedSplat {
  const bytes = new Uint8Array(raw);
  const headerSlice = bytes.subarray(0, Math.min(bytes.length, 65536));
  const headerText = new TextDecoder().decode(headerSlice);
  const endMatch = /end_header\r?\n/.exec(headerText);
  if (!endMatch || endMatch.index === undefined) {
    throw new Error("Invalid PLY header (missing end_header)");
  }
  const dataOffset = endMatch.index + endMatch[0].length;
  const lines = headerText
    .slice(0, endMatch.index)
    .split(/\r?\n/)
    .map((l) => l.trim());

  let isAscii = false;
  let vertexCount = 0;
  let inVertexElement = false;
  const props: Array<{ name: string; type: string; offset: number }> = [];
  let rowStride = 0;

  for (const line of lines) {
    if (line.startsWith("format ")) {
      if (line.includes("ascii")) isAscii = true;
      else if (line.includes("binary_big_endian")) {
        throw new Error("Unsupported PLY format: binary_big_endian");
      }
    } else if (line.startsWith("element ")) {
      const parts = line.split(/\s+/);
      inVertexElement = parts[1] === "vertex";
      if (inVertexElement) vertexCount = parseInt(parts[2] || "0", 10);
    } else if (inVertexElement && line.startsWith("property ")) {
      const parts = line.split(/\s+/);
      if (parts[1] === "list") continue;
      const type = parts[1];
      const name = parts[2];
      const sz = PLY_TYPE_SIZE[type];
      if (!sz) continue;
      props.push({ name, type, offset: rowStride });
      rowStride += sz;
    }
  }

  if (vertexCount <= 0 || props.length === 0) {
    throw new Error("PLY contains no vertex records");
  }

  const propByName = new Map<
    string,
    { name: string; type: string; offset: number; idx: number }
  >();
  props.forEach((p, idx) =>
    propByName.set(p.name, { name: p.name, type: p.type, offset: p.offset, idx }),
  );

  const has3dgs =
    propByName.has("scale_0") &&
    propByName.has("f_dc_0") &&
    propByName.has("rot_0");

  const maxPts = Math.min(vertexCount, 950000);
  const step = vertexCount > maxPts ? vertexCount / maxPts : 1;

  const xs = new Float32Array(maxPts);
  const ys = new Float32Array(maxPts);
  const zs = new Float32Array(maxPts);
  const buffer = new ArrayBuffer(maxPts * 32);
  const f32 = new Float32Array(buffer);
  const u8 = new Uint8Array(buffer);

  const SH_C0 = 0.28209479177387814;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  const view = isAscii ? null : new DataView(raw, dataOffset);
  const asciiLines = isAscii
    ? new TextDecoder()
        .decode(bytes.subarray(dataOffset))
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
    : null;

  const getVal = (
    vertexIdx: number,
    name: string,
    asciiTokens: string[] | null,
    fallback: number,
  ): number => {
    const p = propByName.get(name);
    if (!p) return fallback;
    if (asciiTokens) {
      const v = parseFloat(asciiTokens[p.idx] || "");
      return Number.isFinite(v) ? v : fallback;
    }
    if (!view) return fallback;
    const bytePos = vertexIdx * rowStride + p.offset;
    if (bytePos + (PLY_TYPE_SIZE[p.type] || 4) > view.byteLength) {
      return fallback;
    }
    return readPlyScalar(view, bytePos, p.type);
  };

  let count = 0;
  for (let outIdx = 0; outIdx < maxPts; outIdx++) {
    const vIdx = Math.min(vertexCount - 1, Math.floor(outIdx * step));
    const tokens = asciiLines
      ? (asciiLines[vIdx]?.trim().split(/\s+/) ?? null)
      : null;
    if (isAscii && !tokens) break;

    const x = getVal(vIdx, "x", tokens, 0);
    const y = getVal(vIdx, "y", tokens, 0);
    const z = getVal(vIdx, "z", tokens, 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    xs[count] = x;
    ys[count] = y;
    zs[count] = z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;

    const fOff = count * 8;
    const bOff = count * 32;

    if (has3dgs) {
      const sx = Math.exp(getVal(vIdx, "scale_0", tokens, -4));
      const sy = Math.exp(getVal(vIdx, "scale_1", tokens, -4));
      const sz = Math.exp(getVal(vIdx, "scale_2", tokens, -4));
      f32[fOff + 3] = Number.isFinite(sx) ? sx : 0.01;
      f32[fOff + 4] = Number.isFinite(sy) ? sy : 0.01;
      f32[fOff + 5] = Number.isFinite(sz) ? sz : 0.01;

      const r = 0.5 + SH_C0 * getVal(vIdx, "f_dc_0", tokens, 0);
      const g = 0.5 + SH_C0 * getVal(vIdx, "f_dc_1", tokens, 0);
      const b = 0.5 + SH_C0 * getVal(vIdx, "f_dc_2", tokens, 0);
      const op = getVal(vIdx, "opacity", tokens, 4);
      const a = 1 / (1 + Math.exp(-op));
      u8[bOff + 24] = Math.max(0, Math.min(255, Math.round(r * 255)));
      u8[bOff + 25] = Math.max(0, Math.min(255, Math.round(g * 255)));
      u8[bOff + 26] = Math.max(0, Math.min(255, Math.round(b * 255)));
      u8[bOff + 27] = Math.max(0, Math.min(255, Math.round(a * 255)));

      const r0 = getVal(vIdx, "rot_0", tokens, 1);
      const r1 = getVal(vIdx, "rot_1", tokens, 0);
      const r2 = getVal(vIdx, "rot_2", tokens, 0);
      const r3 = getVal(vIdx, "rot_3", tokens, 0);
      const qLen = Math.hypot(r0, r1, r2, r3) || 1;
      u8[bOff + 28] = encodeByte(r0 / qLen);
      u8[bOff + 29] = encodeByte(r1 / qLen);
      u8[bOff + 30] = encodeByte(r2 / qLen);
      u8[bOff + 31] = encodeByte(r3 / qLen);
    } else {
      // Standard point-cloud / mesh PLY vertex
      const rProp =
        propByName.get("red") ||
        propByName.get("diffuse_red") ||
        propByName.get("r");
      const gProp =
        propByName.get("green") ||
        propByName.get("diffuse_green") ||
        propByName.get("g");
      const bProp =
        propByName.get("blue") ||
        propByName.get("diffuse_blue") ||
        propByName.get("b");
      let r = rProp ? getVal(vIdx, rProp.name, tokens, 200) : 200;
      let g = gProp ? getVal(vIdx, gProp.name, tokens, 210) : 210;
      let b = bProp ? getVal(vIdx, bProp.name, tokens, 215) : 215;
      if (rProp && (rProp.type === "float" || rProp.type === "float32")) {
        r *= 255;
        g *= 255;
        b *= 255;
      }
      u8[bOff + 24] = Math.max(0, Math.min(255, Math.round(r)));
      u8[bOff + 25] = Math.max(0, Math.min(255, Math.round(g)));
      u8[bOff + 26] = Math.max(0, Math.min(255, Math.round(b)));
      u8[bOff + 27] = 250;
      u8[bOff + 28] = 255;
      u8[bOff + 29] = 128;
      u8[bOff + 30] = 128;
      u8[bOff + 31] = 128;
    }

    count += 1;
  }

  if (count === 0) {
    throw new Error("PLY contains no valid finite vertices");
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.1);
  const ptScale = Math.min(
    maxDim * 0.012,
    Math.max(maxDim * 0.0012, maxDim / Math.sqrt(count) * 1.15),
  );

  for (let i = 0; i < count; i++) {
    const fOff = i * 8;
    if (has3dgs) {
      f32[fOff + 0] = xs[i] - cx;
      f32[fOff + 1] = ys[i] - cy;
      f32[fOff + 2] = zs[i] - cz;
    } else {
      // Standard Y-up point cloud -> gsplat OpenCV Y-down
      f32[fOff + 0] = xs[i] - cx;
      f32[fOff + 1] = -(ys[i] - cy);
      f32[fOff + 2] = -(zs[i] - cz);
      f32[fOff + 3] = ptScale;
      f32[fOff + 4] = ptScale;
      f32[fOff + 5] = ptScale;
    }
  }

  const finalBuffer = count < maxPts ? buffer.slice(0, count * 32) : buffer;
  return {
    buffer: finalBuffer,
    count,
    radius: Math.max(1.5, maxDim * 1.15),
    center: [cx, cy, cz],
  };
}

function centerSplatBuffer(raw: ArrayBuffer): ConvertedSplat {
  const count = Math.floor(raw.byteLength / 32);
  if (count <= 0) throw new Error("Empty .splat file");
  const copy = raw.slice(0, count * 32);
  const f32 = new Float32Array(copy);
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = f32[i * 8 + 0];
    const y = f32[i * 8 + 1];
    const z = f32[i * 8 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const cx = Number.isFinite(minX) ? (minX + maxX) * 0.5 : 0;
  const cy = Number.isFinite(minY) ? (minY + maxY) * 0.5 : 0;
  const cz = Number.isFinite(minZ) ? (minZ + maxZ) * 0.5 : 0;
  const maxDim = Number.isFinite(minX)
    ? Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.1)
    : 5;
  for (let i = 0; i < count; i++) {
    f32[i * 8 + 0] -= cx;
    f32[i * 8 + 1] -= cy;
    f32[i * 8 + 2] -= cz;
  }
  return {
    buffer: copy,
    count,
    radius: Math.max(1.5, maxDim * 1.15),
    center: [cx, cy, cz],
  };
}

/** Pushes updated projection/focal/viewport uniforms directly to gsplat's WebGL2 shader. */
function pushProjectionUniforms(
  renderer: any,
  camera: any,
  canvas: HTMLCanvasElement,
): void {
  const gl = renderer?.gl as WebGL2RenderingContext | undefined;
  const prog = renderer?.renderProgram?.program as WebGLProgram | undefined;
  if (!gl || !prog || !camera?.data) return;

  camera.data.setSize(canvas.width, canvas.height);
  camera.update?.();

  gl.useProgram(prog);
  const projLoc = gl.getUniformLocation(prog, "projection");
  if (projLoc) {
    gl.uniformMatrix4fv(projLoc, false, camera.data.projectionMatrix.buffer);
  }
  const focalLoc = gl.getUniformLocation(prog, "focal");
  if (focalLoc) {
    gl.uniform2fv(focalLoc, new Float32Array([camera.data.fx, camera.data.fy]));
  }
  const vpLoc = gl.getUniformLocation(prog, "viewport");
  if (vpLoc) {
    gl.uniform2fv(vpLoc, new Float32Array([canvas.width, canvas.height]));
  }
}

export async function mountSplatViewer(
  host: HTMLElement,
  source: SplatSource,
  options?: MountSplatOptions,
): Promise<void> {
  await unmountSplatViewer();
  disposed = false;
  hostEl = host;
  host.innerHTML = `<div class="measure-hint" style="padding:16px; display:flex; align-items:center; justify-content:center; height:100%;">Loading 3DGS…</div>`;

  let mod: any;
  try {
    mod = await import("gsplat");
  } catch (e) {
    host.innerHTML = `<div class="measure-hint" style="padding:16px;">gsplat unavailable: ${String(e)}</div>`;
    return;
  }

  const Scene = mod.Scene ?? mod.default?.Scene;
  const Renderer = mod.WebGLRenderer ?? mod.default?.WebGLRenderer;
  const Camera = mod.Camera ?? mod.default?.Camera;
  const OrbitControls = mod.OrbitControls ?? mod.default?.OrbitControls;
  const Loader = mod.Loader ?? mod.default?.Loader;
  const Vector3 = mod.Vector3 ?? mod.default?.Vector3;
  const GsplatQuaternion = mod.Quaternion ?? mod.default?.Quaternion;

  if (!Scene || !Renderer || !Loader || !Camera) {
    host.innerHTML = `<div class="measure-hint" style="padding:16px;">gsplat renderer unavailable.</div>`;
    return;
  }

  let loadedBuffer: ArrayBuffer;
  let radius = 5;
  let resolvedCenter: [number, number, number] = [0, 0, 0];

  try {
    if (source.kind === "buffer") {
      loadedBuffer = source.buffer;
      radius = source.radius ?? 5;
      resolvedCenter = source.center ?? [0, 0, 0];
    } else {
      const resp = await fetch(source.url);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} while fetching splat file`);
      }
      const raw = await resp.arrayBuffer();
      const parsed =
        source.ext === ".ply"
          ? parsePlyToSplatBuffer(raw)
          : centerSplatBuffer(raw);
      loadedBuffer = parsed.buffer;
      radius = parsed.radius;
      resolvedCenter = parsed.center;
    }
  } catch (e) {
    host.innerHTML = `<div class="measure-hint" style="padding:16px; display:flex; align-items:center; justify-content:center; height:100%;">Failed to load splat: ${String(e)}</div>`;
    return;
  }

  if (disposed) return;

  const canvas = document.createElement("canvas");
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  host.innerHTML = "";
  host.appendChild(canvas);

  const scene = new Scene();
  const camera = new Camera();
  const renderer = new Renderer(canvas);
  activeRenderer = renderer;

  const syncViewer = options?.syncViewer ?? null;
  const syncCenter: [number, number, number] =
    options?.syncCenter ?? resolvedCenter;

  let lastFocal = -1;
  let lastW = 0;
  let lastH = 0;

  let topViewMode = false;
  const applyStandaloneFov = (h: number) => {
    if (syncViewer || !camera.data) return;
    const fovDeg = topViewMode ? 16 : 42;
    const f = h / (2 * Math.tan((fovDeg * Math.PI) / 360));
    camera.data.fx = f;
    camera.data.fy = f;
    camera.data.near = Math.max(0.01, radius * 0.002);
    camera.data.far = Math.max(500, radius * 24);
    lastFocal = f;
  };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round((host.clientWidth || 800) * dpr));
    const h = Math.max(1, Math.round((host.clientHeight || 600) * dpr));
    lastW = w;
    lastH = h;
    renderer.setSize(w, h);
    applyStandaloneFov(h);
    pushProjectionUniforms(renderer, camera, canvas);
  };
  resize();
  activeResizeObserver = new ResizeObserver(() => resize());
  activeResizeObserver.observe(host);

  // Prevent gsplat global WASD/QERF listeners from hijacking typing inside form fields
  if (!syncViewer) {
    activeKeyGuard = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", activeKeyGuard, true);
  }

  const createControls = (alpha = 0.45, beta = 0.35, dist = radius) => {
    if (syncViewer || !OrbitControls) return null;
    const ctrl = new OrbitControls(
      camera,
      canvas,
      alpha,
      beta,
      dist,
      true,
      Vector3 ? new Vector3(0, 0, 0) : undefined,
    );
    ctrl.minZoom = Math.max(0.05, radius * 0.06);
    ctrl.maxZoom = Math.max(30, radius * 8);
    return ctrl;
  };

  let controls = createControls();
  activeControls = controls;
  activeResetFn = () => {
    if (syncViewer) return;
    topViewMode = false;
    try {
      controls?.dispose?.();
    } catch {
      /* ignore */
    }
    controls = createControls(0.45, 0.35, radius);
    activeControls = controls;
    applyStandaloneFov(canvas.height || lastH || 600);
    pushProjectionUniforms(renderer, camera, canvas);
  };
  activeTopViewFn = (enabled: boolean) => {
    if (syncViewer) return;
    topViewMode = enabled;
    try {
      controls?.dispose?.();
    } catch {
      /* ignore */
    }
    if (enabled) {
      // Overhead view looking straight down from above (in gsplat Y-down, +beta elevates camera toward -Y = up)
      controls = createControls(0, Math.PI / 2 - 0.015, radius * 2.5);
    } else {
      controls = createControls(0.45, 0.35, radius);
    }
    activeControls = controls;
    applyStandaloneFov(canvas.height || lastH || 600);
    pushProjectionUniforms(renderer, camera, canvas);
  };

  try {
    Loader.LoadFromArrayBuffer(loadedBuffer, scene);
  } catch (e) {
    host.innerHTML = `<div class="measure-hint" style="padding:16px; display:flex; align-items:center; justify-content:center; height:100%;">Failed to load splat: ${String(e)}</div>`;
    return;
  }

  const invModelMat = new Matrix4();
  const relCamMat = new Matrix4();
  const relPos = new ThreeVector3();
  const relQuat = new ThreeQuaternion();
  const relScale = new ThreeVector3();
  let uniformsPrimed = false;

  const syncFromModelViewer = () => {
    if (!syncViewer || !Vector3 || !GsplatQuaternion) return;
    const mvScene = (syncViewer as any)[$scene];
    const threeCam = mvScene?.camera as PerspectiveCamera | undefined;
    const mvRoot = getModelRoot(mvScene);
    if (!threeCam || !mvRoot) return;

    mvScene.updateMatrixWorld(true);
    threeCam.updateMatrixWorld(true);
    mvRoot.updateMatrixWorld(true);

    // Compute camera pose in pure model-local space: inv(M_model) * M_cam
    invModelMat.copy(mvRoot.matrixWorld).invert();
    relCamMat.multiplyMatrices(invModelMat, threeCam.matrixWorld);
    relCamMat.decompose(relPos, relQuat, relScale);

    const fovRad = ((threeCam.fov || 30) * Math.PI) / 180;
    const focal = canvas.height / (2 * Math.tan(fovRad / 2));

    camera.position = new Vector3(
      relPos.x - syncCenter[0],
      -(relPos.y - syncCenter[1]),
      -(relPos.z - syncCenter[2]),
    );
    camera.rotation = new GsplatQuaternion(
      relQuat.x,
      -relQuat.y,
      -relQuat.z,
      relQuat.w,
    );

    if (camera.data && Number.isFinite(focal) && focal > 1) {
      const changed =
        !uniformsPrimed ||
        Math.abs(focal - lastFocal) > 0.25 ||
        canvas.width !== lastW ||
        canvas.height !== lastH;
      camera.data.fx = focal;
      camera.data.fy = focal;
      camera.data.near = Math.max(0.01, threeCam.near || radius * 0.002);
      camera.data.far = Math.max(500, (threeCam.far || 500) * 2, radius * 16);
      if (changed) {
        lastFocal = focal;
        lastW = canvas.width;
        lastH = canvas.height;
        pushProjectionUniforms(renderer, camera, canvas);
      } else {
        camera.update?.();
      }
    } else {
      camera.update?.();
    }
  };

  const loop = () => {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    try {
      if (syncViewer) {
        syncFromModelViewer();
      } else {
        controls?.update?.();
      }
      renderer.render(scene, camera);
      if (!uniformsPrimed && renderer?.renderProgram?.program) {
        uniformsPrimed = true;
        pushProjectionUniforms(renderer, camera, canvas);
      }
    } catch {
      /* ignore */
    }
  };
  loop();
}

export async function unmountSplatViewer(): Promise<void> {
  disposed = true;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  activeResetFn = null;
  activeTopViewFn = null;
  if (activeKeyGuard) {
    window.removeEventListener("keydown", activeKeyGuard, true);
    activeKeyGuard = null;
  }
  try {
    activeResizeObserver?.disconnect();
  } catch {
    /* ignore */
  }
  activeResizeObserver = null;
  try {
    activeControls?.dispose?.();
  } catch {
    /* ignore */
  }
  activeControls = null;
  try {
    activeRenderer?.dispose?.();
  } catch {
    /* ignore */
  }
  activeRenderer = null;
  if (hostEl) hostEl.innerHTML = "";
  hostEl = null;
}
