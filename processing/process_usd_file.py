import json
import os
import sys

from pxr import Usd, UsdGeom, UsdShade


def analyze_usd_stage(file_path):
    print(f"Analyzing USD stage: {file_path}")
    if not os.path.exists(file_path):
        print(f"File not found: {file_path}")
        sys.exit(1)

    stage = Usd.Stage.Open(file_path)
    if not stage:
        print(f"Failed to open USD stage: {file_path}")
        sys.exit(1)

    # Telemetry data of USD object(s)
    mesh_count = 0
    material_count = 0
    total_prim_count = 0
    prim_names = []

    for prim in stage.Traverse():
        total_prim_count += 1
        if prim.IsA(UsdGeom.Mesh):
            mesh_count += 1
            prim_names.append(f"Mesh: {prim.GetName()}")
        if prim.IsA(UsdShade.Material):
            material_count += 1

    telemetry = {
        "status": "success",
        "total_prim_count": total_prim_count,
        "mesh_count": mesh_count,
        "material_count": material_count,
        "prim_names": prim_names[:5],
    }

    print(f"Telemetry: {json.dumps(telemetry)}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        analyze_usd_stage(sys.argv[1])
    else:
        print("Missing input file path")
        sys.exit(1)
