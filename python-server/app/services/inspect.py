"""Game-Ready check — read-only analysis of whether a mesh is fit to ship.

Every other tool in this service *changes* the mesh. This one only measures it,
and returns a report the UI renders as a red/amber/green checklist:

    {"checks": [{"id", "group", "label", "status", "value", "detail", "fix"}, …],
     "summary": {"pass": n, "warn": n, "fail": n},
     "stats": {…}}

`status` is pass / warn / fail / info. `fix` names the Mesh Editor mode that
resolves the finding ("optimize", "autouv", "autoretopo", "repair") so the panel
can offer a one-click jump; None when there is no in-app fix.

What "game-ready" means is not universal — a hero prop and a background rock have
different budgets — so every threshold comes from InspectOptions rather than being
baked in here.

Nothing in this module mutates its input.
"""
from __future__ import annotations

import numpy as np
import trimesh

from ..schemas import InspectOptions
from .repair import topology_counts


def _fmt_int(value) -> str:
    return f"{int(value):,}"


def _check(checks: list, *, id: str, group: str, label: str, status: str,
           value, detail: str = "", fix: str | None = None) -> None:
    checks.append({
        "id": id,
        "group": group,
        "label": label,
        "status": status,
        "value": str(value),
        "detail": detail,
        "fix": fix,
    })


# ── UV analysis ─────────────────────────────────────────────────────────────

def _uv_overlap_fraction(uv: np.ndarray, faces: np.ndarray, grid: int,
                         max_faces: int) -> tuple[float, bool]:
    """Fraction of covered texels that more than one triangle writes to.

    Overlapping UVs are the classic reason a bake or a lightmap comes out
    corrupted: two surfaces fight over the same texels. Detecting it exactly means
    triangle-triangle intersection in 2D; rasterising into a counter grid gets the
    same answer to within a texel for a fraction of the cost, which is all a
    pass/warn/fail needs.

    Mirrored parts that *intentionally* share UVs will show up here too — that is
    a legitimate finding, since it is exactly what breaks baking.

    Returns (fraction, approximate). `approximate` is True when the face count
    forced us to sample rather than raster every triangle.
    """
    face_count = len(faces)
    approximate = False
    if face_count > max_faces:
        # Uniform stride keeps the sample spread across the whole atlas instead of
        # concentrating on whichever region happens to be first in the buffer.
        step = int(np.ceil(face_count / max_faces))
        faces = faces[::step]
        approximate = True

    counts = np.zeros((grid, grid), dtype=np.int32)

    # UVs outside [0,1] tile in engines, so wrapped islands are folded back onto
    # the grid before rasterising. The fold is per *triangle*, by the tile its
    # lowest corner sits in — not per coordinate. A per-coordinate `% 1.0` would
    # send every whole number to 0, which both collapses the extremely common
    # exactly-at-1.0 atlas edge and turns a triangle sitting in tile [1,2] into a
    # single point. Shifting the whole triangle keeps its shape and area intact.
    raw = uv[faces]  # (F, 3, 2)
    tri = raw - np.floor(raw.min(axis=1))[:, None, :]
    px = tri * (grid - 1)

    lo = np.floor(px.min(axis=1)).astype(np.int32)
    hi = np.ceil(px.max(axis=1)).astype(np.int32)
    np.clip(lo, 0, grid - 1, out=lo)
    np.clip(hi, 0, grid - 1, out=hi)

    a, b, c = px[:, 0], px[:, 1], px[:, 2]
    # Signed area x2; degenerate (zero-area) UV triangles cover nothing.
    denom = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])

    for i in range(len(faces)):
        det = denom[i]
        if abs(det) < 1e-12:
            continue
        x0, x1 = lo[i, 0], hi[i, 0]
        y0, y1 = lo[i, 1], hi[i, 1]
        if x1 < x0 or y1 < y0:
            continue
        xs = np.arange(x0, x1 + 1, dtype=np.float64)
        ys = np.arange(y0, y1 + 1, dtype=np.float64)
        gx, gy = np.meshgrid(xs, ys)
        # Barycentric containment at pixel centres.
        w0 = ((b[i, 0] - a[i, 0]) * (gy - a[i, 1]) - (gx - a[i, 0]) * (b[i, 1] - a[i, 1])) / det
        w1 = ((gx - a[i, 0]) * (c[i, 1] - a[i, 1]) - (c[i, 0] - a[i, 0]) * (gy - a[i, 1])) / det
        inside = (w0 >= 0) & (w1 >= 0) & (w0 + w1 <= 1)
        if inside.any():
            counts[y0:y1 + 1, x0:x1 + 1][inside] += 1

    covered = int((counts > 0).sum())
    if covered == 0:
        return 0.0, approximate
    return float((counts > 1).sum()) / covered, approximate


def _texel_density(mesh: trimesh.Trimesh, uv: np.ndarray, resolution: int) -> dict | None:
    """Texels per world unit per face, summarised.

    Uneven texel density is why one wall of a prop looks crisp and the next looks
    smeared. The spread (p95/p5) matters more than the absolute number: a
    consistent atlas can always be re-scaled, an inconsistent one cannot.
    """
    faces = mesh.faces
    tri3d = mesh.vertices[faces]
    world_area = np.linalg.norm(
        np.cross(tri3d[:, 1] - tri3d[:, 0], tri3d[:, 2] - tri3d[:, 0]), axis=1
    ) * 0.5

    tri_uv = uv[faces]
    uv_area = np.abs(
        (tri_uv[:, 1, 0] - tri_uv[:, 0, 0]) * (tri_uv[:, 2, 1] - tri_uv[:, 0, 1])
        - (tri_uv[:, 2, 0] - tri_uv[:, 0, 0]) * (tri_uv[:, 1, 1] - tri_uv[:, 0, 1])
    ) * 0.5

    valid = (world_area > 1e-12) & (uv_area > 1e-12)
    if not valid.any():
        return None

    density = np.sqrt(uv_area[valid]) * resolution / np.sqrt(world_area[valid])
    p5, median, p95 = np.percentile(density, [5, 50, 95])
    return {
        "median": float(median),
        "p5": float(p5),
        "p95": float(p95),
        "spread": float(p95 / p5) if p5 > 1e-9 else float("inf"),
    }


# ── Scene-level analysis ────────────────────────────────────────────────────

def _material_info(scene: trimesh.Scene) -> dict:
    """Count distinct materials and texture images across the scene.

    Each material is a draw call; each texture is VRAM. Both are counted by object
    identity, so the same material shared by ten nodes counts once — which is what
    an engine's batching actually sees.
    """
    materials: dict[int, object] = {}
    textures: dict[int, tuple] = {}

    for geom in scene.geometry.values():
        visual = getattr(geom, "visual", None)
        material = getattr(visual, "material", None)
        if material is None:
            continue
        materials[id(material)] = material
        for attr in ("baseColorTexture", "image", "emissiveTexture",
                     "normalTexture", "occlusionTexture", "metallicRoughnessTexture"):
            image = getattr(material, attr, None)
            if image is None:
                continue
            size = getattr(image, "size", None)
            textures[id(image)] = tuple(size) if size else (0, 0)

    largest = max((max(s) for s in textures.values()), default=0)
    return {
        "material_count": len(materials),
        "texture_count": len(textures),
        "largest_texture": int(largest),
        "mesh_count": len(scene.geometry),
    }


# ── Entry point ─────────────────────────────────────────────────────────────

def run_inspect(scene: trimesh.Scene, mesh: trimesh.Trimesh,
                options: InspectOptions, progress=None) -> dict:
    """Analyse `mesh` (world-space, flattened) plus `scene` (for material counts)."""

    def emit(stage, frac, msg=""):
        if progress:
            progress(stage, frac, msg)

    checks: list[dict] = []
    stats: dict = {}

    faces = np.asarray(mesh.faces, dtype=np.int64)
    vertices = np.asarray(mesh.vertices, dtype=float)
    face_count = int(len(faces))
    vertex_count = int(len(vertices))
    stats["faces"] = face_count
    stats["vertices"] = vertex_count

    # ── Geometry ────────────────────────────────────────────────────────────
    emit("geometry", 0.1, "Measuring geometry…")

    budget = int(options.tri_budget)
    if face_count > budget * 2:
        tri_status, tri_detail = "fail", f"More than double the {_fmt_int(budget)} triangle budget."
    elif face_count > budget:
        tri_status, tri_detail = "warn", f"Over the {_fmt_int(budget)} triangle budget."
    else:
        tri_status, tri_detail = "pass", f"Within the {_fmt_int(budget)} triangle budget."
    _check(checks, id="tri_count", group="Geometry", label="Triangle count",
           status=tri_status, value=_fmt_int(face_count), detail=tri_detail,
           fix="optimize" if tri_status != "pass" else None)

    _check(checks, id="vertex_count", group="Geometry", label="Vertex count",
           status="info", value=_fmt_int(vertex_count))

    # ── Topology ────────────────────────────────────────────────────────────
    emit("topology", 0.25, "Checking topology…")
    topo = topology_counts(vertices, faces)
    stats["topology"] = topo

    if topo["non_manifold_edges"] > 0:
        _check(checks, id="non_manifold", group="Topology", label="Non-manifold edges",
               status="fail", value=_fmt_int(topo["non_manifold_edges"]),
               detail="Edges shared by more than two faces. Baking, boolean ops and physics "
                      "cooking all fail on these.",
               fix="repair")
    else:
        _check(checks, id="non_manifold", group="Topology", label="Non-manifold edges",
               status="pass", value="0")

    if topo["boundary_edges"] > 0:
        _check(checks, id="boundary", group="Topology", label="Open edges",
               status="warn", value=_fmt_int(topo["boundary_edges"]),
               detail="The surface is not closed. Fine for a plane or a shell, a hole in "
                      "anything meant to be solid.",
               fix="repair")
    else:
        _check(checks, id="boundary", group="Topology", label="Open edges",
               status="pass", value="0")

    _check(checks, id="watertight", group="Topology", label="Watertight",
           status="pass" if topo["watertight"] else "warn",
           value="Yes" if topo["watertight"] else "No",
           fix=None if topo["watertight"] else "autoretopo")

    # Degenerate + duplicate faces — cheap to detect, poisonous downstream
    # (zero-area faces produce NaN normals; duplicates cause z-fighting).
    try:
        # trimesh returns a boolean mask on some versions and an index array on
        # others; both spellings mean "the faces that survive".
        nondegenerate = np.asarray(mesh.nondegenerate_faces())
        kept = int(nondegenerate.sum()) if nondegenerate.dtype == bool else int(len(nondegenerate))
        degenerate = max(0, face_count - kept)
    except Exception:  # noqa: BLE001 — trimesh version differences; not worth failing the report
        degenerate = 0
    _check(checks, id="degenerate", group="Topology", label="Degenerate faces",
           status="warn" if degenerate else "pass", value=_fmt_int(degenerate),
           detail="Zero-area triangles produce invalid normals." if degenerate else "",
           fix="repair" if degenerate else None)

    if face_count:
        unique_faces = len(np.unique(np.sort(faces, axis=1), axis=0))
        duplicate = int(face_count - unique_faces)
    else:
        duplicate = 0
    _check(checks, id="duplicate_faces", group="Topology", label="Duplicate faces",
           status="warn" if duplicate else "pass", value=_fmt_int(duplicate),
           detail="Coincident triangles z-fight and double-shade." if duplicate else "",
           fix="repair" if duplicate else None)

    # ── UVs ─────────────────────────────────────────────────────────────────
    emit("uvs", 0.4, "Analysing UVs…")
    uv = getattr(getattr(mesh, "visual", None), "uv", None)
    uv = np.asarray(uv, dtype=float) if uv is not None else None
    has_uv = uv is not None and len(uv) == vertex_count and len(uv) > 0
    stats["has_uv"] = bool(has_uv)

    if not has_uv:
        _check(checks, id="uv_present", group="UVs", label="UV coordinates",
               status="fail", value="Missing",
               detail="Nothing can be textured, baked or lightmapped without UVs.",
               fix="autouv")
    else:
        _check(checks, id="uv_present", group="UVs", label="UV coordinates",
               status="pass", value="Present")

        emit("uvs", 0.5, "Rasterising UV islands…")
        overlap, approximate = _uv_overlap_fraction(
            uv, faces, int(options.uv_overlap_grid), int(options.uv_scan_max_faces))
        stats["uv_overlap"] = overlap
        overlap_pct = overlap * 100
        suffix = " (sampled)" if approximate else ""
        if overlap > 0.05:
            uv_status, uv_detail = "fail", ("Islands are stacked on top of each other. Baking and "
                                            "lightmapping will write conflicting data into the same texels.")
        elif overlap > 0.005:
            uv_status, uv_detail = "warn", "A small amount of island overlap — check mirrored parts."
        else:
            uv_status, uv_detail = "pass", ""
        _check(checks, id="uv_overlap", group="UVs", label="UV overlap",
               status=uv_status, value=f"{overlap_pct:.1f}%{suffix}", detail=uv_detail,
               fix="autouv" if uv_status != "pass" else None)

        out_of_range = int(np.count_nonzero((uv < -1e-6) | (uv > 1 + 1e-6)))
        _check(checks, id="uv_range", group="UVs", label="UVs outside 0–1",
               status="warn" if out_of_range else "pass",
               value=_fmt_int(out_of_range),
               detail="Coordinates outside the unit square rely on texture wrapping — "
                      "intentional for tiling materials, a bug for a baked atlas." if out_of_range else "",
               fix="autouv" if out_of_range else None)

        density = _texel_density(mesh, uv, int(options.texture_resolution))
        stats["texel_density"] = density
        if density is None:
            _check(checks, id="texel_density", group="UVs", label="Texel density",
                   status="info", value="n/a")
        else:
            spread = density["spread"]
            if spread > 8:
                d_status = "warn"
                d_detail = "Texel density varies widely across the mesh — some faces will look much softer than others."
            elif spread > 4:
                d_status = "warn"
                d_detail = "Noticeable texel-density variation across the mesh."
            else:
                d_status, d_detail = "pass", ""
            _check(checks, id="texel_density", group="UVs", label="Texel density",
                   status=d_status,
                   value=f"{density['median']:.0f} px/m (×{spread:.1f} spread)",
                   detail=d_detail, fix="autouv" if d_status != "pass" else None)

    # ── Materials ───────────────────────────────────────────────────────────
    emit("materials", 0.75, "Counting materials…")
    mat = _material_info(scene)
    stats["materials"] = mat

    over_materials = mat["material_count"] > int(options.max_material_count)
    _check(checks, id="material_count", group="Materials", label="Materials",
           status="warn" if over_materials else "pass",
           value=_fmt_int(mat["material_count"]),
           detail=f"Each material is a draw call; more than {options.max_material_count} is "
                  "worth merging into an atlas." if over_materials else "")

    _check(checks, id="texture_count", group="Materials", label="Textures",
           status="info", value=_fmt_int(mat["texture_count"]),
           detail=f"Largest is {mat['largest_texture']}px." if mat["largest_texture"] else "")

    _check(checks, id="submesh_count", group="Materials", label="Sub-meshes",
           status="info", value=_fmt_int(mat["mesh_count"]))

    # ── Transform ───────────────────────────────────────────────────────────
    emit("transform", 0.9, "Checking scale and pivot…")
    if vertex_count:
        lo = vertices.min(axis=0)
        hi = vertices.max(axis=0)
        extents = hi - lo
        largest = float(extents.max())
        diagonal = float(np.linalg.norm(extents)) or 1.0
        stats["extents"] = [float(v) for v in extents]

        if largest > options.max_extent:
            s_status = "warn"
            s_detail = (f"Larger than {options.max_extent:g} m — the source is probably in "
                        "centimetres. Unreal expects cm, Unity and glTF expect metres.")
        elif largest < options.min_extent:
            s_status = "warn"
            s_detail = f"Smaller than {options.min_extent:g} m — check the source units."
        else:
            s_status, s_detail = "pass", ""
        _check(checks, id="scale", group="Transform", label="Size",
               status=s_status,
               value=" × ".join(f"{v:.3g}" for v in extents) + " m",
               detail=s_detail)

        centre = (lo + hi) * 0.5
        offset = float(np.linalg.norm(centre)) / diagonal
        if options.expect_ground_pivot:
            ground_gap = abs(float(lo[1])) / diagonal
            horizontal = float(np.linalg.norm([centre[0], centre[2]])) / diagonal
            grounded = ground_gap < 0.02 and horizontal < 0.02
            _check(checks, id="pivot", group="Transform", label="Pivot",
                   status="pass" if grounded else "warn",
                   value="Origin, on the ground" if grounded else "Offset",
                   detail="" if grounded else
                          "The mesh does not sit on Y=0 centred at the origin, so it will not "
                          "snap to the floor when placed in a level.",
                   fix=None if grounded else "ground_pivot")
        else:
            centred = offset < 0.25
            _check(checks, id="pivot", group="Transform", label="Pivot",
                   status="pass" if centred else "warn",
                   value="Centred" if centred else f"{offset * 100:.0f}% off centre",
                   detail="" if centred else
                          "The geometry is far from its origin, which makes the asset rotate "
                          "about a point outside itself.",
                   fix=None if centred else "centre_pivot")

    has_normals = bool(getattr(mesh, "vertex_normals", None) is not None and len(mesh.vertex_normals))
    _check(checks, id="normals", group="Geometry", label="Vertex normals",
           status="pass" if has_normals else "warn",
           value="Present" if has_normals else "Missing")

    emit("done", 1.0, "Check complete.")

    summary = {"pass": 0, "warn": 0, "fail": 0, "info": 0}
    for entry in checks:
        summary[entry["status"]] = summary.get(entry["status"], 0) + 1

    return {"checks": checks, "summary": summary, "stats": stats}
