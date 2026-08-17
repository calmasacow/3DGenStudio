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

# name -> (bake pass, colour space, principled input to rewire or None).
#
# Blender has no METALLIC bake pass (its passes are AO, COMBINED, DIFFUSE, EMIT,
# ENVIRONMENT, GLOSSY, NORMAL, POSITION, ROUGHNESS, SHADOW, TRANSMISSION, UV), so
# metallic is captured by temporarily routing the high-poly's Metallic input into
# an Emission shader and baking EMIT. Roughness has a native pass and needs no
# such trick.
#
# Everything except base colour is DATA, not colour, so it is written Non-Color:
# an sRGB-tagged roughness map would come back gamma-encoded and read wrong.
#
# Order matters and is the iteration order below: the metallic rewire replaces the
# material's Surface link, so it has to run after any pass that reads the real
# shader.
BAKE_PASSES = {
    "normal": ("NORMAL", "Non-Color", None),
    "ao": ("AO", "Non-Color", None),
    "base_color": ("DIFFUSE", "sRGB", None),
    "roughness": ("ROUGHNESS", "Non-Color", None),
    "metallic": ("EMIT", "Non-Color", "Metallic"),
}

BAKE_ORDER = ["normal", "ao", "base_color", "roughness", "metallic"]

# Passes that bake natively but still map to a Principled input, so the "this came
# from a constant, the map is flat" check applies to them as well.
PROBE_INPUTS = {"roughness": "Roughness"}

# glTF packs occlusion/roughness/metallic into one texture's R/G/B. Producing that
# packed form means three.js can hand it to all three material slots as a single
# object, which is both what the format wants and what lets its exporter skip
# recompositing the channels.
ORM_CHANNELS = ["ao", "roughness", "metallic"]
# Neutral values for channels that were not baked: no occlusion, fully rough,
# non-metal. Only the baked channels are ever read back on the client, so these
# are padding rather than claims about the material.
ORM_NEUTRAL = {"ao": 255, "roughness": 255, "metallic": 0}


def emit(stage: str, frac: float, message: str = "") -> None:
    print(f"{SENTINEL}{json.dumps({'type': 'progress', 'stage': stage, 'frac': round(frac, 4), 'message': message})}", flush=True)


def fail(code: int, error: str) -> None:
    print(f"{SENTINEL}{json.dumps({'type': 'result', 'ok': False, 'error': error})}", flush=True)
    sys.exit(code)


def principled_input_is_linked(objects, input_name: str) -> bool:
    """Is a Principled BSDF input driven by a node graph rather than a constant?

    Used by the passes that need no rewiring (roughness has a native bake) so they
    can report a flat result for the same reason the rewired ones do. Without this
    a constant-roughness source would silently produce a flat map with no warning,
    while constant metallic warned — an inconsistency that only shows up as
    surprise later.
    """
    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if not material or not material.use_nodes:
                continue
            bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            socket = bsdf.inputs.get(input_name) if bsdf else None
            if socket is not None and socket.is_linked:
                return True
    return False


def rewire_to_emit(objects, input_name: str) -> bool:
    """Route a Principled BSDF input into an Emission shader so EMIT can bake it.

    Returns True when a *texture* (or any node graph) actually drives the input on
    at least one material. When it is only a constant, the bake still succeeds but
    produces a flat map — which is strictly worse than the scalar it came from, so
    the caller reports that rather than pretending the map is useful.

    Blender's glTF importer wires metallic/roughness through a Separate Color node
    fed by the packed ORM texture, so the upstream socket here is normally that
    node's B (or G) output. Linking a single float output into Emission's Color
    broadcasts it across RGB, which is exactly what a data bake wants.
    """
    driven_by_graph = False
    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if not material or not material.use_nodes:
                continue
            tree = material.node_tree
            bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
            if not bsdf or not output:
                continue
            socket = bsdf.inputs.get(input_name)
            if socket is None:
                continue

            emission = tree.nodes.new("ShaderNodeEmission")
            if socket.is_linked:
                tree.links.new(socket.links[0].from_socket, emission.inputs["Color"])
                driven_by_graph = True
            else:
                value = float(socket.default_value)
                emission.inputs["Color"].default_value = (value, value, value, 1.0)
            tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return driven_by_graph


def pack_orm(written: dict, outdir, resolution: int) -> tuple[str | None, list]:
    """Compose the baked AO/roughness/metallic into one R/G/B texture.

    Returns (filename, channels_actually_baked). Skipped unless at least two of
    the three exist — a single channel is better served by its own map.
    """
    present = [name for name in ORM_CHANNELS if name in written]
    if len(present) < 2:
        return None, present

    try:
        import numpy as np
        from PIL import Image
    except Exception as exc:  # noqa: BLE001 — the individual maps are still returned
        print(f"ORM packing unavailable ({exc}); returning separate maps.", flush=True)
        return None, present

    planes = []
    for name in ORM_CHANNELS:
        if name in written:
            image = Image.open(outdir / written[name]).convert("L")
            if image.size != (resolution, resolution):
                image = image.resize((resolution, resolution), Image.LANCZOS)
            planes.append(np.asarray(image, dtype=np.uint8))
        else:
            planes.append(np.full((resolution, resolution), ORM_NEUTRAL[name], dtype=np.uint8))

    Image.fromarray(np.dstack(planes), mode="RGB").save(outdir / "orm.png")
    return "orm.png", present


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

    flat_channels = []
    ordered = [name for name in BAKE_ORDER if name in maps]

    for index, map_name in enumerate(ordered):
        pass_type, colorspace, rewire_input = BAKE_PASSES[map_name]
        frac = 0.25 + 0.7 * (index / len(ordered))
        emit("bake", frac, f"Baking {map_name.replace('_', ' ')}…")

        # Either way, a channel whose source is a constant bakes to a flat map,
        # which is strictly worse than the scalar it came from — report it.
        if rewire_input:
            if not rewire_to_emit(high_objects, rewire_input):
                flat_channels.append(map_name)
        elif map_name in PROBE_INPUTS:
            if not principled_input_is_linked(high_objects, PROBE_INPUTS[map_name]):
                flat_channels.append(map_name)

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

    emit("pack", 0.96, "Packing ORM…")
    orm_name, orm_channels = pack_orm(written, outdir, resolution)
    if orm_name:
        written["orm"] = orm_name

    emit("done", 1.0, "Bake complete.")
    stats = {
        "maps": written,
        "resolution": resolution,
        "low_faces": len(low.data.polygons),
        "high_faces": int(sum(len(o.data.polygons) for o in high_objects)),
        "samples": scene.cycles.samples,
        # Which of the ORM channels carry real baked data, so the client only binds
        # the material slots that were actually measured.
        "orm_channels": orm_channels if orm_name else [],
        # Channels whose source was a constant, not a texture — the map is flat.
        "flat_channels": flat_channels,
    }
    print(f"{SENTINEL}{json.dumps({'type': 'result', 'ok': True, 'stats': stats})}", flush=True)


if __name__ == "__main__":
    main()
