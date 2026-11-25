/**
 * Dedicated Web Worker for deterministic anisotropic triangle-fitted 2DGS surfel conversion.
 * Keeps 950k-surfel math & quaternion packing completely off the UI main thread (INP < 10 ms).
 */

export type WorkerTextureSampler = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  flipY: boolean;
};

export type WorkerMeshPayload = {
  positions: Float32Array;
  indices: Uint32Array | null;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  colorItemSize: number;
  localMatrix: Float32Array; // 16-element column-major Matrix4
  sampler: WorkerTextureSampler | null;
  fallbackColor: [number, number, number];
  triCount: number;
};

export type SplatWorkerRequest = {
  meshes: WorkerMeshPayload[];
  maxSplats: number;
};

export type SplatWorkerResponse = {
  buffer: ArrayBuffer;
  count: number;
  radius: number;
  center: [number, number, number];
} | null;

function encodeByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 128 + 128)));
}

function transformPoint(
  m: Float32Array,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
  off: number,
): void {
  const w = 1 / (m[3] * x + m[7] * y + m[11] * z + m[15] || 1);
  out[off] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
  out[off + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
  out[off + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
}

/** Converts a 3x3 orthonormal basis (columns t1, t2, n) to unit quaternion [w, x, y, z]. */
function basisToQuat(
  m00: number,
  m10: number,
  m20: number,
  m01: number,
  m11: number,
  m21: number,
  m02: number,
  m12: number,
  m22: number,
  out: Float64Array,
): void {
  const trace = m00 + m11 + m22;
  let qw: number, qx: number, qy: number, qz: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    qw = 0.25 / s;
    qx = (m21 - m12) * s;
    qy = (m02 - m20) * s;
    qz = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  const len = Math.hypot(qw, qx, qy, qz) || 1;
  out[0] = qw / len;
  out[1] = qx / len;
  out[2] = qy / len;
  out[3] = qz / len;
}

export function buildSplatFromMeshes(req: SplatWorkerRequest): SplatWorkerResponse {
  const { meshes, maxSplats } = req;
  if (!meshes.length) return null;

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let totalTris = 0;
  const pt = new Float64Array(9);

  for (let m = 0; m < meshes.length; m++) {
    const entry = meshes[m];
    const pos = entry.positions;
    const mat = entry.localMatrix;
    const vCount = Math.floor(pos.length / 3);
    for (let i = 0; i < vCount; i++) {
      const o = i * 3;
      transformPoint(mat, pos[o], pos[o + 1], pos[o + 2], pt, 0);
      const x = pt[0],
        y = pt[1],
        z = pt[2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    totalTris += entry.triCount;
  }

  if (totalTris <= 0 || !Number.isFinite(minX)) return null;

  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;
  const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.1);

  const budget = Math.max(50000, Math.min(maxSplats, 980000));
  const stride = totalTris > budget ? totalTris / budget : 1;
  const coverageBoost = stride > 1 ? Math.sqrt(stride) * 1.25 : 1.15;
  const allowSubdiv = stride === 1 && totalTris < budget * 0.45;
  const targetEdge = maxDim / 220;
  const minS = maxDim * 0.0007;
  const maxS = maxDim * 0.035;

  const buffer = new ArrayBuffer(budget * 32);
  const f32 = new Float32Array(buffer);
  const u8 = new Uint8Array(buffer);
  const quat = new Float64Array(4);
  const rgb = new Uint8Array(3);

  let writeIdx = 0;
  let nextGlobalTri = 0;
  let globalTriOffset = 0;

  const sampleColor = (
    sampler: WorkerTextureSampler | null,
    uvs: Float32Array | null,
    colors: Float32Array | null,
    colorStride: number,
    fallback: [number, number, number],
    i0: number,
    i1: number,
    i2: number,
    r0: number,
    r1: number,
    r2: number,
  ): void => {
    if (sampler && uvs) {
      const u =
        (((uvs[i0 * 2] * r0 + uvs[i1 * 2] * r1 + uvs[i2 * 2] * r2) % 1) + 1) % 1;
      const v =
        (((uvs[i0 * 2 + 1] * r0 + uvs[i1 * 2 + 1] * r1 + uvs[i2 * 2 + 1] * r2) %
          1) +
          1) %
        1;
      const vy = sampler.flipY ? 1 - v : v;
      const tx = Math.min(sampler.width - 1, Math.floor(u * sampler.width));
      const ty = Math.min(sampler.height - 1, Math.floor(vy * sampler.height));
      const pOff = (ty * sampler.width + tx) * 4;
      rgb[0] = sampler.data[pOff];
      rgb[1] = sampler.data[pOff + 1];
      rgb[2] = sampler.data[pOff + 2];
      return;
    }
    if (colors && colorStride >= 3) {
      const cr =
        colors[i0 * colorStride] * r0 +
        colors[i1 * colorStride] * r1 +
        colors[i2 * colorStride] * r2;
      const cg =
        colors[i0 * colorStride + 1] * r0 +
        colors[i1 * colorStride + 1] * r1 +
        colors[i2 * colorStride + 1] * r2;
      const cb =
        colors[i0 * colorStride + 2] * r0 +
        colors[i1 * colorStride + 2] * r1 +
        colors[i2 * colorStride + 2] * r2;
      rgb[0] = Math.round(Math.min(1, Math.max(0, cr)) * 255);
      rgb[1] = Math.round(Math.min(1, Math.max(0, cg)) * 255);
      rgb[2] = Math.round(Math.min(1, Math.max(0, cb)) * 255);
      return;
    }
    rgb[0] = fallback[0];
    rgb[1] = fallback[1];
    rgb[2] = fallback[2];
  };

  const emit = (
    px: number,
    py: number,
    pz: number,
    sx: number,
    sy: number,
    sz: number,
    q0: number,
    q1: number,
    q2: number,
    q3: number,
  ): void => {
    if (writeIdx >= budget) return;
    const fOff = writeIdx * 8;
    f32[fOff + 0] = px - centerX;
    f32[fOff + 1] = -(py - centerY);
    f32[fOff + 2] = -(pz - centerZ);
    f32[fOff + 3] = sx;
    f32[fOff + 4] = sy;
    f32[fOff + 5] = sz;

    const bOff = writeIdx * 32;
    u8[bOff + 24] = rgb[0];
    u8[bOff + 25] = rgb[1];
    u8[bOff + 26] = rgb[2];
    u8[bOff + 27] = 255;
    u8[bOff + 28] = q0;
    u8[bOff + 29] = q1;
    u8[bOff + 30] = q2;
    u8[bOff + 31] = q3;
    writeIdx += 1;
  };

  for (let mIdx = 0; mIdx < meshes.length && writeIdx < budget; mIdx++) {
    const entry = meshes[mIdx];
    const {
      positions,
      indices,
      uvs,
      colors,
      colorItemSize,
      localMatrix,
      sampler,
      fallbackColor,
      triCount,
    } = entry;

    while (writeIdx < budget) {
      const localTri = Math.floor(nextGlobalTri) - globalTriOffset;
      if (localTri >= triCount) break;
      nextGlobalTri += stride;
      if (localTri < 0) continue;

      const i0 = indices ? indices[localTri * 3] : localTri * 3;
      const i1 = indices ? indices[localTri * 3 + 1] : localTri * 3 + 1;
      const i2 = indices ? indices[localTri * 3 + 2] : localTri * 3 + 2;

      transformPoint(
        localMatrix,
        positions[i0 * 3],
        positions[i0 * 3 + 1],
        positions[i0 * 3 + 2],
        pt,
        0,
      );
      transformPoint(
        localMatrix,
        positions[i1 * 3],
        positions[i1 * 3 + 1],
        positions[i1 * 3 + 2],
        pt,
        3,
      );
      transformPoint(
        localMatrix,
        positions[i2 * 3],
        positions[i2 * 3 + 1],
        positions[i2 * 3 + 2],
        pt,
        6,
      );

      const v0x = pt[0],
        v0y = pt[1],
        v0z = pt[2];
      const v1x = pt[3],
        v1y = pt[4],
        v1z = pt[5];
      const v2x = pt[6],
        v2y = pt[7],
        v2z = pt[8];

      const e01x = v1x - v0x,
        e01y = v1y - v0y,
        e01z = v1z - v0z;
      const e12x = v2x - v1x,
        e12y = v2y - v1y,
        e12z = v2z - v1z;
      const e20x = v0x - v2x,
        e20y = v0y - v2y,
        e20z = v0z - v2z;

      // norm = -(e01 x e20)
      let nx = -(e01y * e20z - e01z * e20y);
      let ny = -(e01z * e20x - e01x * e20z);
      let nz = -(e01x * e20y - e01y * e20x);
      const twiceArea = Math.hypot(nx, ny, nz);
      if (twiceArea < 1e-10) continue;
      nx /= twiceArea;
      ny /= twiceArea;
      nz /= twiceArea;

      const l0 = e01x * e01x + e01y * e01y + e01z * e01z;
      const l1 = e12x * e12x + e12y * e12y + e12z * e12z;
      const l2 = e20x * e20x + e20y * e20y + e20z * e20z;
      let t1x: number, t1y: number, t1z: number, t1Len: number;
      if (l0 >= l1 && l0 >= l2) {
        t1Len = Math.sqrt(l0) || 1;
        t1x = e01x / t1Len;
        t1y = e01y / t1Len;
        t1z = e01z / t1Len;
      } else if (l1 >= l2) {
        t1Len = Math.sqrt(l1) || 1;
        t1x = e12x / t1Len;
        t1y = e12y / t1Len;
        t1z = e12z / t1Len;
      } else {
        t1Len = Math.sqrt(l2) || 1;
        t1x = e20x / t1Len;
        t1y = e20y / t1Len;
        t1z = e20z / t1Len;
      }

      let t2x = ny * t1z - nz * t1y;
      let t2y = nz * t1x - nx * t1z;
      let t2z = nx * t1y - ny * t1x;
      const t2Len = Math.hypot(t2x, t2y, t2z) || 1;
      t2x /= t2Len;
      t2y /= t2Len;
      t2z /= t2Len;

      // Basis in OpenCV Y-down coordinates: flip Y and Z
      basisToQuat(
        t1x,
        -t1y,
        -t1z,
        t2x,
        -t2y,
        -t2z,
        nx,
        -ny,
        -nz,
        quat,
      );
      const q0 = encodeByte(quat[0]);
      const q1 = encodeByte(quat[1]);
      const q2 = encodeByte(quat[2]);
      const q3 = encodeByte(quat[3]);

      const cx = (v0x + v1x + v2x) / 3;
      const cy = (v0y + v1y + v2y) / 3;
      const cz = (v0z + v1z + v2z) / 3;

      const u0 = (v0x - cx) * t1x + (v0y - cy) * t1y + (v0z - cz) * t1z;
      const u1 = (v1x - cx) * t1x + (v1y - cy) * t1y + (v1z - cz) * t1z;
      const u2 = (v2x - cx) * t1x + (v2y - cy) * t1y + (v2z - cz) * t1z;
      const w0 = (v0x - cx) * t2x + (v0y - cy) * t2y + (v0z - cz) * t2z;
      const w1 = (v1x - cx) * t2x + (v1y - cy) * t2y + (v1z - cz) * t2z;
      const w2 = (v2x - cx) * t2x + (v2y - cy) * t2y + (v2z - cz) * t2z;

      const hx = (Math.max(u0, u1, u2) - Math.min(u0, u1, u2)) * 0.5;
      const hy = (Math.max(w0, w1, w2) - Math.min(w0, w1, w2)) * 0.5;
      const maxEdge = Math.sqrt(Math.max(l0, l1, l2));

      let k = 1;
      if (allowSubdiv && maxEdge > targetEdge * 1.8) {
        k = Math.min(6, Math.max(2, Math.ceil(maxEdge / targetEdge)));
        if (writeIdx + k * k > budget) k = 1;
      }

      if (k === 1) {
        const sx = Math.min(maxS, Math.max(minS, hx * 0.96 * coverageBoost));
        const sy = Math.min(maxS, Math.max(minS, hy * 0.96 * coverageBoost));
        const sz = Math.max(minS * 0.25, Math.min(sx, sy) * 0.14);
        sampleColor(
          sampler,
          uvs,
          colors,
          colorItemSize,
          fallbackColor,
          i0,
          i1,
          i2,
          1 / 3,
          1 / 3,
          1 / 3,
        );
        emit(cx, cy, cz, sx, sy, sz, q0, q1, q2, q3);
      } else {
        const invK = 1 / k;
        const sx = Math.min(maxS, Math.max(minS, hx * invK * 0.85));
        const sy = Math.min(maxS, Math.max(minS, hy * invK * 0.85));
        const sz = Math.max(minS * 0.25, Math.min(sx, sy) * 0.14);
        for (let a = 0; a < k; a++) {
          for (let b = 0; b < k - a; b++) {
            const r1 = (a + 1 / 3) * invK;
            const r2 = (b + 1 / 3) * invK;
            const r0 = 1 - r1 - r2;
            sampleColor(
              sampler,
              uvs,
              colors,
              colorItemSize,
              fallbackColor,
              i0,
              i1,
              i2,
              r0,
              r1,
              r2,
            );
            emit(
              v0x * r0 + v1x * r1 + v2x * r2,
              v0y * r0 + v1y * r1 + v2y * r2,
              v0z * r0 + v1z * r1 + v2z * r2,
              sx,
              sy,
              sz,
              q0,
              q1,
              q2,
              q3,
            );
            if (a + b + 1 < k) {
              const dr1 = (a + 2 / 3) * invK;
              const dr2 = (b + 2 / 3) * invK;
              const dr0 = 1 - dr1 - dr2;
              sampleColor(
                sampler,
                uvs,
                colors,
                colorItemSize,
                fallbackColor,
                i0,
                i1,
                i2,
                dr0,
                dr1,
                dr2,
              );
              emit(
                v0x * dr0 + v1x * dr1 + v2x * dr2,
                v0y * dr0 + v1y * dr1 + v2y * dr2,
                v0z * dr0 + v1z * dr1 + v2z * dr2,
                sx,
                sy,
                sz,
                q0,
                q1,
                q2,
                q3,
              );
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
    center: [centerX, centerY, centerZ],
  };
}

declare const WorkerGlobalScope: any;

if (
  typeof WorkerGlobalScope !== "undefined" &&
  typeof self !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  self.onmessage = (ev: MessageEvent<SplatWorkerRequest>) => {
    try {
      const res = buildSplatFromMeshes(ev.data);
      if (res) {
        (self as unknown as Worker).postMessage(res, [res.buffer]);
      } else {
        (self as unknown as Worker).postMessage(null);
      }
    } catch {
      (self as unknown as Worker).postMessage(null);
    }
  };
}
