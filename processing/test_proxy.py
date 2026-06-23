import sys
import os
import uuid
import numpy as np
import trimesh
from PIL import Image
from pxr import Usd, UsdGeom, UsdShade

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
            print(f"Loaded texture: {img_path}")
        except Exception as e:
            print(f"Failed to load image: {e}")
    return trimesh.visual.material.PBRMaterial(**kwargs)

def test_proxy(usd_path):
    stage = Usd.Stage.Open(usd_path)
    base_dir = os.path.dirname(usd_path)
    
    meshes = []
    
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.Mesh):
            mesh = UsdGeom.Mesh(prim)
            points = np.array(mesh.GetPointsAttr().Get())
            counts = np.array(mesh.GetFaceVertexCountsAttr().Get())
            indices = np.array(mesh.GetFaceVertexIndicesAttr().Get())
            
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
            
            # Map original face index to triangulated faces
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
                    
                    # Gather triangulated faces for this subset
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
                    tri_mesh.visual.material = build_material(img_path)
                    meshes.append(tri_mesh)
            else:
                tri_mesh = trimesh.Trimesh(vertices=points_out, faces=triangulated_faces, process=False)
                if uvs_out is not None:
                    tri_mesh.visual = trimesh.visual.TextureVisuals(uv=uvs_out)
                
                tex = get_texture_for_prim(prim)
                img_path = os.path.join(base_dir, tex) if tex else None
                tri_mesh.visual.material = build_material(img_path)
                meshes.append(tri_mesh)

    if meshes:
        scene = trimesh.Scene(meshes)
        transform = trimesh.transformations.rotation_matrix(np.pi / 2, [1, 0, 0])
        for node_name in scene.graph.nodes_geometry:
            scene.graph.update(node_name, matrix=transform)
        scene.export(usd_path + "_test.glb")
        print("Success")

if __name__ == "__main__":
    test_proxy(sys.argv[1])
