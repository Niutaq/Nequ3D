# Libraries
import json
import os
import shutil
import subprocess
import sys
import time
import zipfile  # Built-in library for ZIP/USDZ handling


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


def generate_proxy_mesh(usd_path):
    """
    Generates a lightweight .glb (.gltf) proxy file from a heavy .usd for WebGL frontend.
    """
    proxy_path = usd_path.rsplit(".", 1)[0] + "_proxy.glb"

    # [PRODUCTION ARCHITECTURE]
    # Future implementation using e.g., usd2gltf.exe:
    # subprocess.run(["usd2gltf.exe", usd_path, proxy_path], check=True)

    # [MOCK - FRONTEND UNLOCK]
    # Uses test_glb.glb to simulate successful proxy generation.
    mock_source = os.path.join(os.path.dirname(usd_path), "..", "raw", "test_glb.glb")

    try:
        # Simulate proxy generation time
        time.sleep(1.0)
        if os.path.exists(mock_source):
            shutil.copyfile(mock_source, proxy_path)
            return proxy_path
    except Exception as e:
        print(f"[Core Python] Error: Proxy generation failed: {e}")

    return None


def run_ntc_compression(usd_path, texture_paths, target_bpp):
    """
    Executes the native C++ NVIDIA RTXNTC compressor compiled inside the Docker container.
    """
    compressed_assets = []
    base_dir = os.path.dirname(usd_path)

    for idx, tex_path in enumerate(texture_paths):
        # Remove USD-specific markers
        clean_tex_path = tex_path.replace("@", "")

        # Handle textures embedded inside USDZ archives
        if clean_tex_path.startswith("0/") or clean_tex_path.startswith("./"):
            clean_tex_path = clean_tex_path.lstrip("./").lstrip("0/")

        if not os.path.isabs(clean_tex_path):
            actual_tex_path = os.path.normpath(os.path.join(base_dir, clean_tex_path))
        else:
            actual_tex_path = clean_tex_path

        output_ntc_file = f"{actual_tex_path}.ntc"
        base_name = os.path.basename(actual_tex_path)

        if os.path.exists(actual_tex_path):
            print(
                f"[Core Python] NTC: Starting compression for {base_name} at {target_bpp} BPP..."
            )

            # Execute NTC-CLI
            cmd = [
                "ntc-cli",
                actual_tex_path,
                "-c",
                "-o",
                output_ntc_file,
                "-b",
                str(target_bpp),
                "-S",
                "150",
            ]

            try:
                start_time = time.time()
                # 1. Compression (From JPEG to .NTC neural network)
                result = subprocess.run(cmd, check=True, capture_output=True, text=True)
                elapsed = time.time() - start_time

                # VRAM Mathematics
                ntc_size_mb = os.path.getsize(output_ntc_file) / (1024 * 1024)
                bpp_float = float(target_bpp)
                raw_vram_mb = ntc_size_mb * (32.0 / bpp_float)
                vram_saved = raw_vram_mb - ntc_size_mb
                reduction = 100 - ((ntc_size_mb / raw_vram_mb) * 100)

                # --- 2. Decompression for A/B Testing ---
                # Decompress the generated .ntc network back to pixels (to _reconstructed.png)
                reconstructed_img_path = actual_tex_path + "_reconstructed.png"
                decompress_cmd = [
                    "ntc-cli",
                    output_ntc_file,
                    "-d",
                    "-o",
                    reconstructed_img_path,
                ]
                # Run decompression process in the background
                subprocess.run(decompress_cmd, check=True, capture_output=True)

                # Quality verification (PSNR)...
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
        else:
            print(f"[Core Python] Warning: File {actual_tex_path} not found on disk.")
            compressed_assets.append(
                {
                    "original": base_name,
                    "original_path": actual_tex_path,
                    "status": "Skipped - File isolated or missing",
                    "bypass_reason": "Texture reference is not available as a loose file.",
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


def analyze_usd_stage(file_path, target_bpp="5"):
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
            file_path, found_textures, target_bpp
        )

    summarize_ntc_state(telemetry, found_textures)

    print("[Core Python] Action: Generating Proxy Mesh (GLB) for Web Viewer...")
    proxy_path = generate_proxy_mesh(file_path)
    if proxy_path:
        telemetry["proxy_glb_path"] = proxy_path

    print("Telemetry: " + json.dumps(telemetry))


if __name__ == "__main__":
    if len(sys.argv) > 1:
        raw_path = sys.argv[1]
        bpp_target = sys.argv[2] if len(sys.argv) > 2 else "5"

        # Automatic USDZ archive extraction
        working_path = unpack_usdz(raw_path)

        analyze_usd_stage(working_path, bpp_target)
    else:
        print("[ERROR] Missing input file path")
        sys.exit(1)
