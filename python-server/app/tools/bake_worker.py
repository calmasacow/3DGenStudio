"""High-to-low poly texture bake worker (headless Blender).

Runs `bpy` in ISOLATION: invoked as a subprocess by app/services/bake.py
(`python bake_worker.py --low low.glb --high high.glb --outdir dir --options o.json`).
Never import this module from the service — bpy is not thread-safe, holds ~1GB
RSS once imported, and a crash inside Blender must not take the API down.

This is the step that makes Auto Retopo and Optimize non-destructive. On their
own they hand back clean topology with the detail *deleted*; baking captures that
detail as a normal map (plus AO and a base-colour transfer) so the low-poly mesh
still reads as the high-poly one.

Blender's "selected to active" bake casts rays from the low-poly surface out to
the high-poly one, which is why both meshes are loaded into a single scene and
the low-poly is made active. The low-poly must carry UVs — there is nowhere to
write otherwise.

Protocol: progress/result JSON lines on stdout prefixed with GENSTUDIO_EVT
(bpy prints its own "Info:" noise, the parent ignores non-matching lines).
Exit codes: 0 ok, 2 bake error, 3 validation failed, 4 bpy missing.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SENTINEL = "GENSTUDIO_EVT "  # keep in sync with app/services/bake.py

# type -> (bake pass, colour space, description). Tangent-space normals and AO
# are the two that actually carry the lost detail; the colour transfer exists so
# a retopologised mesh does not also lose its texture.
BAKE_PASSES = {
    "normal": ("NORMAL", "Non-Color"),
    "ao": ("AO", "Non-Color"),
    "base_color": ("DIFFUSE", "sRGB"),
}


def emit(stage: str, frac: float, message: str = "") -> None:
    print(f"{SENTINEL}{json.dumps({'type': 'progress', 'stage': stage, 'frac': round(frac, 4), 'message': message})}", flush=True)


def fail(code: int, error: str) -> None:
    print(f"{SENTINEL}{json.dumps({'type': 'result', 'ok': False, 'error': error})}", flush=True)
    sys.exit(code)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--low", required=True)
    parser.add_argument("--high", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--options", required=True)
    args = parser.parse_args()

    options = json.loads(Path(args.options).read_text(encoding="utf-8"))
    resolution = int(options.get("resolution", 2048))
    maps = [m for m in options.get("maps", ["normal", "ao"]) if m in BAKE_PASSES]
    if not maps:
        fail(3, "No valid bake maps were requested.")

    try:
        import bpy
    except Exception as exc:  # noqa: BLE001
        fail(4, f"Blender (bpy) is not available on the mesh-tools service: {exc}")

    emit("scene", 0.05, "Preparing the scene…")
    bpy.ops.wm.read_factory_settings(use_empty=True)

    def import_glb(path: str) -> list:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        return [o for o in bpy.data.objects if o not in before and o.type == "MESH"]

    emit("import", 0.12, "Importing the low-poly mesh…")
    low_objects = import_glb(args.low)
    if not low_objects:
        fail(3, "The low-poly file contains no mesh.")
    low = low_objects[0]

    if not low.data.uv_layers:
        fail(3, "The low-poly mesh has no UVs. Run Auto UV before baking.")

    emit("import", 0.2, "Importing the high-poly mesh…")
    high_objects = import_glb(args.high)
    if not high_objects:
        fail(3, "The high-poly source file contains no mesh.")

    # A bake target needs a material with an image node to write into.
    material = bpy.data.materials.new(name="BakeTarget")
    material.use_nodes = True
    low.data.materials.clear()
    low.data.materials.append(material)

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(options.get("samples", 8))
    bake = scene.render.bake
    bake.use_selected_to_active = True

    # Cage extrusion is a distance, so a fixed default is only ever right for one
    # mesh size: 5cm is generous on a 1m prop and invisible on a 20m building.
    # 0 means "scale it to this mesh" — 2% of the bounding-box diagonal, which
    # reaches far enough to catch protruding detail without punching through to
    # surfaces on the far side.
    cage = float(options.get("cage_extrusion", 0.0))
    if cage <= 0.0:
        diagonal = max(low.dimensions.x, 1e-6) ** 2 + low.dimensions.y ** 2 + low.dimensions.z ** 2
        cage = 0.02 * (diagonal ** 0.5)
        emit("scene", 0.22, f"Auto cage extrusion: {cage:.4f}m")
    bake.cage_extrusion = cage
    bake.max_ray_distance = float(options.get("max_ray_distance", 0.0))
    # Margin dilates the baked islands outward so mip-mapping and bilinear
    # filtering cannot sample the empty gutter and bleed seams into the surface.
    bake.margin = int(options.get("margin", 8))
    bake.use_clear = True

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    written = {}

    for index, map_name in enumerate(maps):
        pass_type, colorspace = BAKE_PASSES[map_name]
        frac = 0.25 + 0.7 * (index / len(maps))
        emit("bake", frac, f"Baking {map_name.replace('_', ' ')}…")

        image = bpy.data.images.new(f"bake_{map_name}", width=resolution, height=resolution,
                                    alpha=False, float_buffer=False)
        image.colorspace_settings.name = colorspace

        node = material.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = image
        material.node_tree.nodes.active = node

        # Selection defines the bake: every high-poly object selected, the
        # low-poly selected *and* active as the destination.
        bpy.ops.object.select_all(action="DESELECT")
        for obj in high_objects:
            obj.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low

        bake_kwargs = {"type": pass_type, "use_clear": True}
        if pass_type == "DIFFUSE":
            # Without this the transfer bakes lighting into the albedo.
            bake_kwargs["pass_filter"] = {"COLOR"}

        try:
            bpy.ops.object.bake(**bake_kwargs)
        except Exception as exc:  # noqa: BLE001
            fail(2, f"Baking {map_name} failed: {exc}")

        path = outdir / f"{map_name}.png"
        image.filepath_raw = str(path)
        image.file_format = "PNG"
        image.save()
        written[map_name] = path.name

        material.node_tree.nodes.remove(node)
        bpy.data.images.remove(image)

    emit("done", 1.0, "Bake complete.")
    stats = {
        "maps": written,
        "resolution": resolution,
        "low_faces": len(low.data.polygons),
        "high_faces": int(sum(len(o.data.polygons) for o in high_objects)),
        "samples": scene.cycles.samples,
    }
    print(f"{SENTINEL}{json.dumps({'type': 'result', 'ok': True, 'stats': stats})}", flush=True)


if __name__ == "__main__":
    main()
