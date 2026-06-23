# Libraries
import json
import os
import subprocess
import sys
import time
import zipfile  # Built-in library for ZIP/USDZ handling
import uuid

import numpy as np
import trimesh
from PIL import Image
from pxr import Usd, UsdGeom, UsdShade  # type: ignore


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
        "baseColorFactor": [255, 255, 255, 255]
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
    print(f"[Core Python] Generating structural proxy GLB: {proxy_path} (Reconstructed: {use_reconstructed})")

    try:
        stage = Usd.Stage.Open(usd_path)
        if not stage:
            print(f"[Core Python] Error: Could not open USD scene: {usd_path}")
            return None

        base_dir = os.path.dirname(usd_path)
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
                            triangulated_faces.append([indices[idx], indices[idx + i], indices[idx + i + 1]])
                            face_tris.append(tri_idx)
                            tri_idx += 1
                        original_face_to_triangles[face_i] = face_tris
                        idx += count

                    points_out = points
                    uvs_out = uv_data if uv_data is not None and len(uv_data) == len(points) else None

                triangulated_faces = np.array(triangulated_faces)
                subsets = [p for p in prim.GetChildren() if p.IsA(UsdGeom.Subset)]

                if subsets:
                    for sub in subsets:
                        subset = UsdGeom.Subset(sub)
                        sub_indices = subset.GetIndicesAttr().Get()

                        sub_tris = []
                        for orig_f in sub_indices:
                            sub_tris.extend(original_face_to_triangles[orig_f])

                        if not sub_tris:
                            continue

                        faces_subset = triangulated_faces[sub_tris]
                        tri_mesh = trimesh.Trimesh(vertices=points_out, faces=faces_subset, process=False)
                        if uvs_out is not None:
                            tri_mesh.visual = trimesh.visual.TextureVisuals(uv=uvs_out)

                        tex = get_texture_for_prim(sub)
                        img_path = os.path.join(base_dir, tex) if tex else None
                        if img_path and use_reconstructed:
                            img_path = img_path + "_reconstructed.png"
                        
                        tri_mesh.visual.material = build_material(img_path)
                        meshes.append(tri_mesh)
                else:
                    tri_mesh = trimesh.Trimesh(vertices=points_out, faces=triangulated_faces, process=False)
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
            transform = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
            for node_name in scene.graph.nodes_geometry:
                scene.graph.update(node_name, matrix=transform)

            scene.export(proxy_path)
            return proxy_path
        else:
            print("[Core Python] No Mesh geometry found in USD file.")

    except Exception as e:
        print(f"[Core Python] Error during native geometry extraction: {e}")

    return None


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
                "--imageFormat", "PNG"
            ]
            result = subprocess.run(decompress_cmd, check=True, capture_output=True, text=True)
            
            # Move the extracted PNG to the expected path
            for f in os.listdir(extract_dir):
                if f.lower().endswith(".png"):
                    shutil.copy(os.path.join(extract_dir, f), reconstructed_img_path)
                    break

            psnr_value = "N/A"
            for line in result.stdout.splitlines():
                if "PSNR" in line or "psnr" in line or "Avg" in line:
                    psnr_value = line.strip()

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


def analyze_usd_stage(file_path, target_bpp="5", target_steps="150"):
    """
    Analyzes the USD stage to extract mesh geometry and trigger material processing.
    """
    stage = Usd.Stage.Open(file_path)
    if not stage:
        return json.dumps({"error": f"Failed to open USD stage: {file_path}"})

    telemetry = {
        "schema_version": 2,
        "status": "success",
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
    }

    found_textures = []

    for prim in stage.Traverse():
        telemetry["total_prim_count"] += 1

        if prim.IsA(UsdGeom.Mesh):
            telemetry["mesh_count"] += 1
            mesh = UsdGeom.Mesh(prim)
            telemetry["prim_names"].append(f"Mesh: {prim.GetName()}")

            counts = mesh.GetFaceVertexCountsAttr().Get()
            if counts:
                telemetry["total_faces"] += len(counts)

            indices = mesh.GetFaceVertexIndicesAttr().Get()
            if indices:
                telemetry["total_vertices"] += len(set(indices))

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

    if found_textures:
        print(
            f"[Core Python] Initialization: Physical NTC compression for {len(found_textures)} textures..."
        )
        telemetry["ntc_compressed_files"] = run_ntc_compression(
            file_path, found_textures, target_bpp, target_steps
        )

    summarize_ntc_state(telemetry, found_textures)

    print("[Core Python] Action: Generating Proxy Mesh (GLB) for Web Viewer...")
    proxy_path = generate_proxy_mesh(file_path, suffix="_proxy.glb", use_reconstructed=False)
    if proxy_path:
        telemetry["proxy_glb_path"] = proxy_path

    if telemetry["has_ntc_quality"]:
        print("[Core Python] Action: Generating Proxy NTC Mesh (GLB)...")
        proxy_ntc_path = generate_proxy_mesh(file_path, suffix="_proxy_ntc.glb", use_reconstructed=True)
        if proxy_ntc_path:
            telemetry["proxy_ntc_glb_path"] = proxy_ntc_path

    print("Telemetry: " + json.dumps(telemetry))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raw_path = sys.argv[1]
        bpp_target = sys.argv[2] if len(sys.argv) > 2 else "5"
        steps_target = sys.argv[3] if len(sys.argv) > 3 else "150"

        # Automatic USDZ archive extraction
        working_path = unpack_usdz(raw_path)

        analyze_usd_stage(working_path, bpp_target, steps_target)
    else:
        print("[ERROR] Missing input file path")
        sys.exit(1)
