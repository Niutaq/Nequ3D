# Libraries
import json
import os
import subprocess
import sys
import time
import uuid
import zipfile  # Built-in library for ZIP/USDZ handling

import numpy as np
import trimesh
from PIL import Image
from pxr import Usd, UsdGeom, UsdShade, Gf  # type: ignore

from integrity import write_integrity_sidecar
from omniverse_export import package_omniverse_export
from otel_setup import (
    current_trace_id_hex,
    extract_parent_context,
    flush_otel,
    init_core_tracer,
    start_span,
)
from twin_manifest import build_twin_manifest
from usd_layers import persist_twin_layers


def unpack_usdz(usdz_path):
    """
    Unpacks a .usdz file (ZIP archive) to a temporary folder.
    This allows NTC-CLI to have physical access to textures on disk.
    """
    if not usdz_path.lower().endswith(".usdz"):
        return usdz_path  # Skip if it's a raw .usd, .usdc, or .glb

    print(f"[Core Python] USDZ archive detected. Extracting: {usdz_path}")
    extract_dir = usdz_path + "_unpacked"

    # Create folder and extract
    if not os.path.exists(extract_dir):
        os.makedirs(extract_dir, exist_ok=True)
        try:
            with zipfile.ZipFile(usdz_path, "r") as zip_ref:
                zip_ref.extractall(extract_dir)
            print(f"[Core Python] Archive successfully extracted to: {extract_dir}")
        except zipfile.BadZipFile:
            print(f"[Core Python] ERROR: {usdz_path} is not a valid ZIP archive.")
            return usdz_path
    else:
        print(f"[Core Python] Using previously extracted folder: {extract_dir}")

    # Search for the main scene file (usually .usdc or .usda) inside the folder
    for root, dirs, files in os.walk(extract_dir):
        for file in files:
            if file.lower().endswith((".usdc", ".usda")):
                main_usd = os.path.join(root, file)
                print(f"[Core Python] Found main geometry file: {main_usd}")
                return main_usd

    # Fallback for unusual USDZ structure
    print("[Core Python] WARNING: No .usdc/.usda file found in archive.")
    return usdz_path


def get_texture_for_prim(prim):
    if not prim.HasAPI(UsdShade.MaterialBindingAPI):
        UsdShade.MaterialBindingAPI.Apply(prim)
    mat, _ = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()
    if not mat:
        return None
    for s_prim in prim.GetStage().Traverse():
        if s_prim.IsA(UsdShade.Shader) and s_prim.GetPath().HasPrefix(mat.GetPath()):
            shader = UsdShade.Shader(s_prim)
            if shader.GetIdAttr().Get() == "UsdUVTexture":
                file_attr = shader.GetInput("file")
                if file_attr:
                    tex = str(file_attr.Get())
                    if tex.startswith("@") and tex.endswith("@"):
                        tex = tex[1:-1]
                    return tex
    return None


def build_material(img_path):
    mat_name = f"mat_{uuid.uuid4().hex}"
    kwargs = {
        "name": mat_name,
        "metallicFactor": 0.0,
        "roughnessFactor": 0.8,
        "baseColorFactor": [255, 255, 255, 255],
    }
    if img_path and os.path.exists(img_path):
        try:
            kwargs["baseColorTexture"] = Image.open(img_path)
        except Exception:
            pass
    return trimesh.visual.material.PBRMaterial(**kwargs)


def generate_proxy_mesh(usd_path, suffix="_proxy.glb", use_reconstructed=False):
    """
    Generates a lightweight .glb (.gltf) structural proxy directly via Pixar API.
    Properly handles GeomSubsets and embeds textures.
    """
    proxy_path = usd_path.rsplit(".", 1)[0] + suffix
    print(
        f"[Core Python] Generating structural proxy GLB: {proxy_path} (Reconstructed: {use_reconstructed})"
    )

    try:
        stage = Usd.Stage.Open(usd_path)
        if not stage:
            print(f"[Core Python] Error: Could not open USD scene: {usd_path}")
            return None

        base_dir = os.path.dirname(usd_path)
        meters_per_unit = float(UsdGeom.GetStageMetersPerUnit(stage) or 1.0)
        scale_to_meters = (
            meters_per_unit
            if meters_per_unit > 0 and abs(meters_per_unit - 1.0) > 1e-6
            else 1.0
        )
        meshes = []

        for prim in stage.Traverse():
            if prim.IsA(UsdGeom.Mesh):
                mesh = UsdGeom.Mesh(prim)
                points = mesh.GetPointsAttr().Get()
                face_counts = mesh.GetFaceVertexCountsAttr().Get()
                face_indices = mesh.GetFaceVertexIndicesAttr().Get()

                if not points or not face_counts or not face_indices:
                    continue

                points = np.array(points)

                # Apply local-to-world transform
                time_code = Usd.TimeCode.Default()
                xform_cache = UsdGeom.XformCache(time_code)
                world_transform = xform_cache.GetLocalToWorldTransform(prim)

                # Convert GfMatrix4d to numpy array and multiply points (row-major)
                matrix = np.array(world_transform)
                ones = np.ones((points.shape[0], 1))
                points_4 = np.hstack([points, ones])
                points = points_4.dot(matrix)[:, :3]
                if scale_to_meters != 1.0:
                    points = points * scale_to_meters

                counts = np.array(face_counts)
                indices = np.array(face_indices)

                pv_api = UsdGeom.PrimvarsAPI(prim)
                st_primvar = None
                for uv_name in ["st", "st0", "uv", "uv0"]:
                    pv = pv_api.GetPrimvar(uv_name)
                    if pv and pv.HasValue():
                        st_primvar = pv
                        break

                uv_data = None
                uv_indices = None
                is_face_varying = False
                if st_primvar and st_primvar.HasValue():
                    uv_data = np.array(st_primvar.Get())
                    if st_primvar.GetInterpolation() == UsdGeom.Tokens.faceVarying:
                        st_ind = st_primvar.GetIndices()
                        uv_indices = np.array(st_ind) if st_ind else indices
                        is_face_varying = True

                triangulated_faces = []
                original_face_to_triangles = {}

                if is_face_varying:
                    unrolled_vertices = points[indices]
                    unrolled_uvs = uv_data[uv_indices]

                    idx = 0
                    tri_idx = 0
                    for face_i, count in enumerate(counts):
                        face_tris = []
                        for i in range(1, count - 1):
                            triangulated_faces.append([idx, idx + i, idx + i + 1])
                            face_tris.append(tri_idx)
                            tri_idx += 1
                        original_face_to_triangles[face_i] = face_tris
                        idx += count

                    points_out = unrolled_vertices
                    uvs_out = unrolled_uvs
                else:
                    idx = 0
                    tri_idx = 0
                    for face_i, count in enumerate(counts):
                        face_tris = []
                        for i in range(1, count - 1):
                            triangulated_faces.append(
                                [indices[idx], indices[idx + i], indices[idx + i + 1]]
                            )
                            face_tris.append(tri_idx)
                            tri_idx += 1
                        original_face_to_triangles[face_i] = face_tris
                        idx += count

                    points_out = points
                    uvs_out = (
                        uv_data
                        if uv_data is not None and len(uv_data) == len(points)
                        else None
                    )

                triangulated_faces = np.array(triangulated_faces)
                subsets = [p for p in prim.GetChildren() if p.IsA(UsdGeom.Subset)]

                if subsets:
                    assigned_faces = set()
                    for sub in subsets:
                        subset = UsdGeom.Subset(sub)
                        sub_indices = subset.GetIndicesAttr().Get()
                        if not sub_indices:
                            continue
                            
                        assigned_faces.update(sub_indices)

                        sub_tris = []
                        for orig_f in sub_indices:
                            sub_tris.extend(original_face_to_triangles[orig_f])

                        if not sub_tris:
                            continue

                        faces_subset = triangulated_faces[sub_tris]
                        tri_mesh = trimesh.Trimesh(
                            vertices=points_out, faces=faces_subset, process=False
                        )
                        if uvs_out is not None:
                            tri_mesh.visual = trimesh.visual.TextureVisuals(uv=uvs_out)

                        tex = get_texture_for_prim(sub)
                        img_path = os.path.join(base_dir, tex) if tex else None
                        if img_path and use_reconstructed:
                            img_path = img_path + "_reconstructed.png"

                        tri_mesh.visual.material = build_material(img_path)
                        meshes.append(tri_mesh)
                        
                    # Handle unassigned faces
                    unassigned_faces = set(range(len(counts))) - assigned_faces
                    if unassigned_faces:
                        sub_tris = []
                        for orig_f in unassigned_faces:
                            sub_tris.extend(original_face_to_triangles[orig_f])
                            
                        if sub_tris:
                            faces_subset = triangulated_faces[sub_tris]
                            tri_mesh = trimesh.Trimesh(
                                vertices=points_out, faces=faces_subset, process=False
                            )
                            if uvs_out is not None:
                                tri_mesh.visual = trimesh.visual.TextureVisuals(uv=uvs_out)
                                
                            tex = get_texture_for_prim(prim)
                            img_path = os.path.join(base_dir, tex) if tex else None
                            if img_path and use_reconstructed:
                                img_path = img_path + "_reconstructed.png"
                                
                            tri_mesh.visual.material = build_material(img_path)
                            meshes.append(tri_mesh)
                else:
                    tri_mesh = trimesh.Trimesh(
                        vertices=points_out, faces=triangulated_faces, process=False
                    )
                    if uvs_out is not None:
                        tri_mesh.visual = trimesh.visual.TextureVisuals(uv=uvs_out)

                    tex = get_texture_for_prim(prim)
                    img_path = os.path.join(base_dir, tex) if tex else None
                    if img_path and use_reconstructed:
                        img_path = img_path + "_reconstructed.png"

                    tri_mesh.visual.material = build_material(img_path)
                    meshes.append(tri_mesh)

        if meshes:
            scene = trimesh.Scene(meshes)
            
            up_axis = UsdGeom.GetStageUpAxis(stage)
            if up_axis == UsdGeom.Tokens.z:
                # Convert Z-up to Y-up
                transform = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])
                for node_name in scene.graph.nodes_geometry:
                    scene.graph.update(node_name, matrix=transform)
            elif up_axis == UsdGeom.Tokens.y:
                # Already Y-up, no rotation needed, unless previously there was a bug
                # where Sketchfab models were Y-up but needed rotation? Wait, Sketchfab models are usually Y-up.
                # If they were falling over, it's because the unconditional rotation was flipping them!
                pass

            scene.export(proxy_path)
            return proxy_path
        else:
            print("[Core Python] No Mesh geometry found in USD file.")

    except Exception as e:
        print(f"[Core Python] Error during native geometry extraction: {e}")

    return None


def generate_gaussian_splat(proxy_path, num_splats=100000):
    """
    Converts the generated _proxy.glb mesh into a colored 3D Gaussian Splat
    representation (.splat, 32 bytes per splat, gsplat OpenCV Y-down convention)
    by area-weighted surface sampling so the 3DGS and Hybrid tabs work without
    manually loading a separate .splat/.ply asset.
    """
    if not proxy_path or not os.path.exists(proxy_path):
        return None

    base = proxy_path[:-10] if proxy_path.endswith("_proxy.glb") else proxy_path.rsplit(".", 1)[0]
    splat_path = base + "_gaussians.splat"
    try:
        loaded = trimesh.load(proxy_path, force="scene")
        geoms = (
            list(loaded.dump())
            if isinstance(loaded, trimesh.Scene)
            else [loaded]
        )
        geoms = [
            g for g in geoms
            if isinstance(g, trimesh.Trimesh) and len(g.faces) > 0 and g.area > 0
        ]
        if not geoms:
            return None

        areas = np.array([float(g.area) for g in geoms], dtype=np.float64)
        total_area = float(areas.sum())
        if total_area <= 0:
            return None

        counts = np.maximum(1, np.round(num_splats * areas / total_area).astype(int))
        all_pts = []
        all_rgba = []
        for g, cnt in zip(geoms, counts):
            sampled = trimesh.sample.sample_surface(g, int(cnt), sample_color=True)
            pts = np.asarray(sampled[0], dtype=np.float32)
            colors = sampled[2] if len(sampled) > 2 and sampled[2] is not None else None
            if colors is None or len(colors) != len(pts):
                rgba = np.full((len(pts), 4), [200, 210, 215, 240], dtype=np.uint8)
            else:
                rgba = np.asarray(colors, dtype=np.uint8)
                if rgba.shape[1] == 3:
                    alpha = np.full((len(pts), 1), 240, dtype=np.uint8)
                    rgba = np.hstack([rgba, alpha])
                else:
                    rgba[:, 3] = 240
            all_pts.append(pts)
            all_rgba.append(rgba)

        pts = np.vstack(all_pts)
        rgba = np.vstack(all_rgba)
        n = len(pts)
        if n == 0:
            return None

        # Center at bounding box and convert glTF/Three.js Y-up to gsplat OpenCV Y-down
        bbox_min = pts.min(axis=0)
        bbox_max = pts.max(axis=0)
        center = (bbox_min + bbox_max) * 0.5
        rel = pts - center
        pos_cv = np.empty_like(rel, dtype="<f4")
        pos_cv[:, 0] = rel[:, 0]
        pos_cv[:, 1] = -rel[:, 1]
        pos_cv[:, 2] = -rel[:, 2]

        max_dim = float(np.max(bbox_max - bbox_min))
        iso_scale = float(np.sqrt(total_area / (n * np.pi)) * 1.15)
        iso_scale = float(np.clip(iso_scale, max(max_dim * 0.0012, 0.003), max(max_dim * 0.0085, 0.015)))

        dtype = np.dtype([
            ("pos", "<f4", 3),
            ("scale", "<f4", 3),
            ("rgba", "u1", 4),
            ("rot", "u1", 4),
        ])
        records = np.empty(n, dtype=dtype)
        records["pos"] = pos_cv
        records["scale"] = iso_scale
        records["rgba"] = rgba
        records["rot"] = np.array([255, 128, 128, 128], dtype=np.uint8)

        with open(splat_path, "wb") as f:
            f.write(records.tobytes())
        print(f"[Core Python] Generated 3DGS proxy splat ({n} splats): {splat_path}")
        return splat_path
    except Exception as e:
        print(f"[Core Python] Warning: 3DGS splat conversion failed: {e}")
        return None


def compute_image_quality_metrics(orig_path, recon_path):
    """
    Computes objective PSNR (dB) and windowed SSIM (0..1) between original and
    NTC-reconstructed textures using pure NumPy + Pillow (no scikit-image needed).
    """
    if not orig_path or not recon_path:
        return None, None
    if not os.path.exists(orig_path) or not os.path.exists(recon_path):
        return None, None
    try:
        img_a = Image.open(orig_path).convert("RGB")
        img_b = Image.open(recon_path).convert("RGB")
        if img_a.size != img_b.size:
            img_b = img_b.resize(img_a.size, Image.Resampling.BILINEAR)

        a = np.asarray(img_a, dtype=np.float64)
        b = np.asarray(img_b, dtype=np.float64)
        mse = float(np.mean((a - b) ** 2))
        if mse <= 1e-12:
            psnr_db = 99.9
        else:
            psnr_db = float(10.0 * np.log10((255.0 ** 2) / mse))

        # BT.601 luma for fast 8x8 block SSIM
        ya = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
        yb = 0.299 * b[:, :, 0] + 0.587 * b[:, :, 1] + 0.114 * b[:, :, 2]
        h, w = ya.shape
        bh, bw = (h // 8) * 8, (w // 8) * 8
        if bh >= 8 and bw >= 8:
            pa = ya[:bh, :bw].reshape(bh // 8, 8, bw // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 64)
            pb = yb[:bh, :bw].reshape(bh // 8, 8, bw // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 64)
            mu_a = pa.mean(axis=1)
            mu_b = pb.mean(axis=1)
            va = pa.var(axis=1)
            vb = pb.var(axis=1)
            cov = ((pa - mu_a[:, None]) * (pb - mu_b[:, None])).mean(axis=1)
            c1 = (0.01 * 255.0) ** 2
            c2 = (0.03 * 255.0) ** 2
            ssim_map = ((2.0 * mu_a * mu_b + c1) * (2.0 * cov + c2)) / (
                (mu_a ** 2 + mu_b ** 2 + c1) * (va + vb + c2)
            )
            ssim_val = float(np.clip(np.mean(ssim_map), 0.0, 1.0))
        else:
            ssim_val = None

        return round(psnr_db, 2), (round(ssim_val, 4) if ssim_val is not None else None)
    except Exception as e:
        print(f"[Core Python] Warning: PSNR/SSIM computation failed: {e}")
        return None, None


def run_ntc_compression(usd_path, texture_paths, target_bpp, target_steps="150"):
    """
    Executes the native C++ NVIDIA RTXNTC compressor compiled inside the Docker container.
    """
    compressed_assets = []
    base_dir = os.path.dirname(usd_path)

    for idx, tex_path in enumerate(texture_paths):
        clean_tex_path = tex_path.replace("@", "").lstrip("./")

        actual_tex_path = None

        direct_path = os.path.normpath(os.path.join(base_dir, clean_tex_path))
        if os.path.exists(direct_path):
            actual_tex_path = direct_path
        else:
            base_name_to_find = os.path.basename(clean_tex_path)
            print(f"[Core Python] Searching for: {base_name_to_find}...")

            for root, dirs, files in os.walk(base_dir):
                if base_name_to_find in files:
                    actual_tex_path = os.path.join(root, base_name_to_find)
                    break

        if not actual_tex_path:
            print(
                f"[Core Python] Warning: Missing {clean_tex_path}. None found in {base_dir}"
            )
            base_name = os.path.basename(clean_tex_path)
            compressed_assets.append(
                {
                    "original": base_name,
                    "original_path": clean_tex_path,
                    "status": "Skipped - File missing",
                    "bypass_reason": "Texture reference is not available as a physical file.",
                }
            )
            continue

        output_ntc_file = f"{actual_tex_path}.ntc"
        base_name = os.path.basename(actual_tex_path)

        print(
            f"[Core Python] NTC: Starting compression for {base_name} in {target_bpp} BPP..."
        )

        # Execute the NTC-CLI compressor
        cmd = [
            "ntc-cli",
            actual_tex_path,
            "-c",
            "-o",
            output_ntc_file,
            "-b",
            str(target_bpp),
            "-S",
            str(target_steps),
        ]

        try:
            start_time = time.time()
            result = subprocess.run(cmd, check=True, capture_output=True, text=True)
            elapsed = time.time() - start_time

            ntc_size_mb = os.path.getsize(output_ntc_file) / (1024 * 1024)
            bpp_float = float(target_bpp)
            raw_vram_mb = ntc_size_mb * (32.0 / bpp_float)
            vram_saved = raw_vram_mb - ntc_size_mb
            reduction = 100 - ((ntc_size_mb / raw_vram_mb) * 100)

            reconstructed_img_path = actual_tex_path + "_reconstructed.png"

            # Extract to a subfolder to grab the actual decompressed image
            import shutil

            extract_dir = actual_tex_path + "_extracted"
            os.makedirs(extract_dir, exist_ok=True)

            decompress_cmd = [
                "ntc-cli",
                output_ntc_file,
                "-i",
                extract_dir,
                "--imageFormat",
                "PNG",
            ]
            result = subprocess.run(
                decompress_cmd, check=True, capture_output=True, text=True
            )

            # Move the extracted PNG to the expected path
            for f in os.listdir(extract_dir):
                if f.lower().endswith(".png"):
                    shutil.copy(os.path.join(extract_dir, f), reconstructed_img_path)
                    break

            psnr_value = "N/A"
            for line in result.stdout.splitlines():
                if "PSNR" in line or "psnr" in line or "Avg" in line:
                    psnr_value = line.strip()

            psnr_db, ssim_val = compute_image_quality_metrics(
                actual_tex_path, reconstructed_img_path
            )
            if psnr_db is not None:
                psnr_value = f"PSNR: {psnr_db:.2f} dB" + (
                    f" | SSIM: {ssim_val:.4f}" if ssim_val is not None else ""
                )

            compressed_assets.append(
                {
                    "original": base_name,
                    "status": "Compressed",
                    "original_path": actual_tex_path,
                    "reconstructed_path": reconstructed_img_path,
                    "ntc_file": os.path.basename(output_ntc_file),
                    "compression_time_sec": round(elapsed, 2),
                    "raw_vram_mb": round(raw_vram_mb, 2),
                    "ntc_vram_mb": round(ntc_size_mb, 2),
                    "vram_saved_mb": round(vram_saved, 2),
                    "vram_reduction": f"{round(reduction, 1)}%",
                    "psnr_db": psnr_db,
                    "ssim": ssim_val,
                    "metrics": psnr_value,
                }
            )

        except subprocess.CalledProcessError as e:
            print(f"[Core Python] NTC Error for {base_name}: {e.stderr}")
            compressed_assets.append(
                {
                    "original": base_name,
                    "original_path": actual_tex_path,
                    "status": "Failed",
                    "error": "Compression failed. Check Docker logs.",
                }
            )

    return compressed_assets


def has_valid_ntc_quality(compressed_assets):
    """
    A quality tab is valid only when an actual loose texture was compressed.
    """
    for asset in compressed_assets:
        status = str(asset.get("status", "")).lower()
        if "skipped" in status or "failed" in status:
            continue
        if asset.get("original_path") and asset.get("reconstructed_path"):
            return True
    return False


def summarize_ntc_state(telemetry, found_textures):
    compressed_assets = telemetry.get("ntc_compressed_files", [])
    has_quality = has_valid_ntc_quality(compressed_assets)
    telemetry["has_ntc_quality"] = has_quality
    telemetry["ntc_bypassed"] = not has_quality

    if has_quality:
        telemetry["texture_processing_status"] = "compressed"
        telemetry["ntc_bypass_reason"] = ""
        psnrs = [a["psnr_db"] for a in compressed_assets if isinstance(a.get("psnr_db"), (int, float))]
        ssims = [a["ssim"] for a in compressed_assets if isinstance(a.get("ssim"), (int, float))]
        if psnrs:
            telemetry["avg_psnr_db"] = round(sum(psnrs) / len(psnrs), 2)
        if ssims:
            telemetry["avg_ssim"] = round(sum(ssims) / len(ssims), 4)
        return

    if not found_textures:
        telemetry["texture_processing_status"] = "bypassed_no_external_textures"
        telemetry["ntc_bypass_reason"] = (
            "No UsdUVTexture file inputs were found. Structural telemetry is available, "
            "but NTC texture compression was not applicable."
        )
        return

    skipped_count = sum(
        1
        for asset in compressed_assets
        if "skipped" in str(asset.get("status", "")).lower()
    )
    failed_count = sum(
        1
        for asset in compressed_assets
        if "failed" in str(asset.get("status", "")).lower() or asset.get("error")
    )

    if skipped_count == len(found_textures):
        telemetry["texture_processing_status"] = "bypassed_embedded_or_missing_textures"
        telemetry["ntc_bypass_reason"] = (
            "Texture references exist, but they are missing from the mounted workspace, "
            "so NTC was bypassed."
        )
    elif failed_count:
        telemetry["texture_processing_status"] = "compression_failed"
        telemetry["ntc_bypass_reason"] = (
            "Texture references were found, but all accessible NTC compression attempts failed."
        )
    else:
        telemetry["texture_processing_status"] = "bypassed_unknown"
        telemetry["ntc_bypass_reason"] = (
            "No NTC quality artifact was produced for the discovered texture references."
        )


def analyze_usd_stage(file_path, target_bpp="5", target_steps="150", unpack_ms=0.0):
    """
    Analyzes the USD stage to extract mesh geometry and trigger material processing.
    """
    init_core_tracer("nequ3d-core-worker")
    parent_ctx = extract_parent_context(
        {"traceparent": os.environ.get("TRACEPARENT", "")}
        if os.environ.get("TRACEPARENT")
        else None
    )
    try:
        with start_span(
            "nequ3d.core.analyze_usd_stage",
            {
                "nequ3d.asset.path": os.path.basename(file_path),
                "nequ3d.ntc.target_bpp": str(target_bpp),
                "nequ3d.ntc.target_steps": str(target_steps),
            },
            parent_context=parent_ctx,
        ):
            return _analyze_usd_stage_inner(file_path, target_bpp, target_steps, unpack_ms)
    finally:
        flush_otel()


def _analyze_usd_stage_inner(file_path, target_bpp="5", target_steps="150", unpack_ms=0.0):
    t_open0 = time.perf_counter()
    stage = Usd.Stage.Open(file_path)
    if not stage:
        return json.dumps({"error": f"Failed to open USD stage: {file_path}"})

    stage_timings = {"unpack_ms": round(float(unpack_ms), 1)}
    trace_hex = current_trace_id_hex()

    telemetry = {
        "schema_version": 3,
        "status": "success",
        "source_asset": os.environ.get("NEQU3D_SOURCE_ASSET") or file_path,
        "trace_id": trace_hex,
        "stage_timings_ms": stage_timings,
        "total_prim_count": 0,
        "mesh_count": 0,
        "material_count": 0,
        "total_vertices": 0,
        "total_faces": 0,
        "prim_names": [],
        "texture_count": 0,
        "ntc_compressed_files": [],
        "ntc_bypassed": True,
        "ntc_bypass_reason": "",
        "has_ntc_quality": False,
        "texture_processing_status": "pending",
        "proxy_glb_path": "",
        "proxy_ntc_glb_path": "",
        "zones": [],
        "twin_manifest_path": "",
        "annotations_usda": "",
        "composed_usda": "",
    }

    found_textures = []

    with start_span("nequ3d.core.usd_traverse"):
        for prim in stage.Traverse():
            telemetry["total_prim_count"] += 1

            if prim.IsA(UsdGeom.Mesh):
                telemetry["mesh_count"] += 1
                mesh = UsdGeom.Mesh(prim)
                telemetry["prim_names"].append(f"Mesh: {prim.GetName()}")

                counts = mesh.GetFaceVertexCountsAttr().Get()
                if counts:
                    telemetry["total_faces"] += len(counts)

                points = mesh.GetPointsAttr().Get()
                if points:
                    telemetry["total_vertices"] += len(points)

            if prim.IsA(UsdShade.Material):
                telemetry["material_count"] += 1

            if prim.IsA(UsdShade.Shader):
                shader = UsdShade.Shader(prim)
                if shader.GetIdAttr().Get() == "UsdUVTexture":
                    file_attr = shader.GetInput("file")
                    if file_attr:
                        tex_path = str(file_attr.Get())
                        if tex_path:
                            found_textures.append(tex_path)
                            telemetry["texture_count"] += 1
    stage_timings["usd_traverse_ms"] = round((time.perf_counter() - t_open0) * 1000.0, 1)

    if found_textures:
        print(
            f"[Core Python] Initialization: Physical NTC compression for {len(found_textures)} textures..."
        )
        t_ntc0 = time.perf_counter()
        with start_span(
            "nequ3d.core.ntc_compress",
            {
                "nequ3d.texture_count": len(found_textures),
                "nequ3d.ntc.bpp": str(target_bpp),
                "nequ3d.ntc.steps": str(target_steps),
            },
        ):
            telemetry["ntc_compressed_files"] = run_ntc_compression(
                file_path, found_textures, target_bpp, target_steps
            )
        stage_timings["ntc_ms"] = round((time.perf_counter() - t_ntc0) * 1000.0, 1)

    summarize_ntc_state(telemetry, found_textures)

    print("[Core Python] Action: Generating Proxy Mesh (GLB) for Web Viewer...")
    t_glb0 = time.perf_counter()
    with start_span("nequ3d.core.generate_proxy_glb"):
        proxy_path = generate_proxy_mesh(
            file_path, suffix="_proxy.glb", use_reconstructed=False
        )
    stage_timings["proxy_glb_ms"] = round((time.perf_counter() - t_glb0) * 1000.0, 1)

    if proxy_path:
        telemetry["proxy_glb_path"] = proxy_path
        telemetry["proxy_scaled_to_meters"] = True
        t_splat0 = time.perf_counter()
        with start_span("nequ3d.core.generate_3dgs_splat"):
            splat_path = generate_gaussian_splat(proxy_path)
        stage_timings["splat_3dgs_ms"] = round((time.perf_counter() - t_splat0) * 1000.0, 1)
        if splat_path:
            telemetry["environment_splat_path"] = splat_path

    if telemetry["has_ntc_quality"]:
        print("[Core Python] Action: Generating Proxy NTC Mesh (GLB)...")
        with start_span("nequ3d.core.generate_proxy_ntc_glb"):
            proxy_ntc_path = generate_proxy_mesh(
                file_path, suffix="_proxy_ntc.glb", use_reconstructed=True
            )
        if proxy_ntc_path:
            telemetry["proxy_ntc_glb_path"] = proxy_ntc_path

    print("[Core Python] Action: Building twin_manifest + OpenUSD annotation layers...")
    source_asset = telemetry.get("source_asset") or file_path
    t_twin0 = time.perf_counter()
    with start_span("nequ3d.core.package_twin_simready"):
        try:
            manifest = build_twin_manifest(
                file_path, telemetry=telemetry, source_asset=source_asset
            )
            layer_paths = persist_twin_layers(file_path, manifest)
            telemetry["twin_manifest"] = {
                "zone_count": len(manifest.get("zones") or []),
                "prim_count": len(manifest.get("prims") or []),
                "up_axis": manifest.get("up_axis"),
                "meters_per_unit": manifest.get("meters_per_unit"),
                "integrity": manifest.get("integrity"),
            }
            telemetry["twin_manifest_path"] = layer_paths.get("twin_manifest_path", "")
            telemetry["annotations_usda"] = layer_paths.get("annotations_usda", "")
            telemetry["composed_usda"] = layer_paths.get("composed_usda", "")
            telemetry["twin_dir"] = layer_paths.get("twin_dir", "")
            telemetry["zones"] = [
                {
                    "id": z.get("id"),
                    "label": z.get("label"),
                    "status": z.get("status"),
                    "prim_count": len(z.get("prim_paths") or []),
                    "bbox": z.get("bbox"),
                }
                for z in (manifest.get("zones") or [])
            ]

            export_root = os.environ.get(
                "NEQU3D_OMNIVERSE_EXPORT",
                os.path.join(os.path.dirname(file_path), "..", "exports", "omniverse"),
            )
            export_root = os.path.abspath(export_root)
            asset_name = os.path.splitext(os.path.basename(source_asset))[0]
            export_info = package_omniverse_export(
                layer_paths["twin_dir"],
                export_root,
                asset_name,
                manifest,
                extra_files=[
                    p
                    for p in (
                        telemetry.get("proxy_glb_path"),
                        telemetry.get("proxy_ntc_glb_path"),
                    )
                    if p
                ],
                telemetry=telemetry,
            )
            telemetry["omniverse_export_dir"] = export_info.get("export_dir", "")
            telemetry["simready_ready"] = bool(
                (export_info.get("checklist") or {}).get("ready_for_kit_import")
            )
            telemetry["simready_checklist"] = export_info.get("checklist")
            telemetry["provenance"] = export_info.get("provenance")
        except Exception as e:
            print(f"[Core Python] Warning: twin/Omniverse packaging failed: {e}")
            telemetry["twin_error"] = str(e)
    stage_timings["twin_simready_ms"] = round((time.perf_counter() - t_twin0) * 1000.0, 1)

    print("Telemetry: " + json.dumps(telemetry))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raw_path = sys.argv[1]
        bpp_target = sys.argv[2] if len(sys.argv) > 2 else "5"
        steps_target = sys.argv[3] if len(sys.argv) > 3 else "150"

        # Automatic USDZ archive extraction
        t_unpack0 = time.perf_counter()
        working_path = unpack_usdz(raw_path)
        unpack_elapsed_ms = (time.perf_counter() - t_unpack0) * 1000.0

        # Integrity sidecar for Reality Scan / source asset (NetSecOps)
        try:
            write_integrity_sidecar(
                raw_path, meta={"pipeline": "nequ3d-core", "kind": "source_scan"}
            )
        except Exception as e:
            print(f"[Core Python] Warning: integrity sidecar failed: {e}")

        # Stash source for twin_manifest
        # analyze_usd_stage reads telemetry source via optional env
        os.environ["NEQU3D_SOURCE_ASSET"] = raw_path
        analyze_usd_stage(working_path, bpp_target, steps_target, unpack_ms=unpack_elapsed_ms)
    else:
        print("[ERROR] Missing input file path")
        sys.exit(1)
