"""Collision-hull generation.

A render mesh is the wrong shape to collide against: it is too dense for a
physics broadphase, and engines require convex parts anyway. This produces the
simplified convex proxy an engine actually wants.

  decomposition  CoACD approximates the concave shape with several convex hulls.
                 This is the useful one — a single hull swallows every cavity, so
                 a mug collides as a solid lump and a doorway cannot be walked
                 through.
  convex_hull    One hull around everything. Always works, no extra dependency.
  box / sphere   Primitive proxies, for when "roughly this big" is enough.

The result is returned as a GLB scene with one node per hull, named
`collision_01`, `collision_02`, … The caller renames them to whatever convention
its target engine uses (Unreal's `UCX_<mesh>_##`, for instance) — engine naming
is an export concern, not a geometry one.
"""
from __future__ import annotations

import numpy as np
import trimesh

from ..schemas import CollisionOptions

try:  # Optional: the service still offers convex_hull/box/sphere without it.
    import coacd
except Exception:  # pragma: no cover
    coacd = None

try:  # Already a hard dependency of the service; stay defensive anyway.
    import pymeshlab as ml
except Exception:  # pragma: no cover
    ml = None


def _decimate(mesh: trimesh.Trimesh, target_faces: int) -> trimesh.Trimesh:
    """Coarsely decimate before decomposition.

    CoACD's cost is driven by the input triangle count, and it is superlinear: a
    13k-face mesh takes minutes where a 2k-face version of the same shape takes
    seconds and yields hulls that are indistinguishable in use. A collider does
    not need surface detail — only the volume — so the detail is spent for nothing.
    Mirrors autoretopo's pre_decimate; see services/autoretopo/remesh.py.
    """
    if target_faces <= 0 or len(mesh.faces) <= target_faces or ml is None:
        return mesh
    try:
        ms = ml.MeshSet()
        ms.add_mesh(ml.Mesh(np.asarray(mesh.vertices, float), np.asarray(mesh.faces, np.int64)))
        ms.meshing_decimation_quadric_edge_collapse(
            targetfacenum=int(target_faces), qualitythr=0.3,
            preservenormal=True, optimalplacement=True, autoclean=True)
        mm = ms.current_mesh()
        return trimesh.Trimesh(np.asarray(mm.vertex_matrix()),
                               np.asarray(mm.face_matrix(), np.int64), process=False)
    except Exception:  # noqa: BLE001 — decomposing the full-resolution mesh still works
        return mesh


def _simplify_hull(hull: trimesh.Trimesh, max_vertices: int) -> trimesh.Trimesh:
    """Cap a hull's vertex count.

    Physics engines bound the *vertices* per convex hull (PhysX allows 255) and
    silently re-cook or reject anything above it, so that — not the face count —
    is the budget worth enforcing.

    Rather than decimate and hope the result is still convex, this picks a subset
    of the hull's own vertices by farthest-point sampling and re-hulls them. The
    convex hull of a subset of a convex point set is necessarily convex, so the
    result cannot come out subtly concave; it is at worst marginally tighter than
    the original, and the sampling keeps that tightening spread evenly rather than
    lopping off one side.
    """
    points = np.asarray(hull.vertices, dtype=float)
    if max_vertices <= 0 or len(points) <= max_vertices:
        return hull

    chosen = [0]
    distance = np.linalg.norm(points - points[0], axis=1)
    for _ in range(max_vertices - 1):
        index = int(np.argmax(distance))
        chosen.append(index)
        distance = np.minimum(distance, np.linalg.norm(points - points[index], axis=1))

    try:
        return trimesh.convex.convex_hull(points[chosen])
    except Exception:  # noqa: BLE001 — a denser hull beats no hull
        return hull


def run_collision(mesh: trimesh.Trimesh, options: CollisionOptions,
                  progress=None) -> tuple[trimesh.Scene, dict]:
    def emit(stage, frac, msg=""):
        if progress:
            progress(stage, frac, msg)

    method = options.method
    hulls: list[trimesh.Trimesh] = []
    fallback_reason = ""

    if method == "box":
        emit("hull", 0.5, "Building a box proxy…")
        hulls = [mesh.bounding_box.copy()]
    elif method == "sphere":
        emit("hull", 0.5, "Building a sphere proxy…")
        hulls = [mesh.bounding_sphere.copy()]
    elif method == "convex_hull":
        emit("hull", 0.5, "Building the convex hull…")
        hulls = [mesh.convex_hull.copy()]
    else:
        if coacd is None:
            # Degrade rather than fail: a single hull is still a usable collider,
            # and the caller is told why it only got one.
            fallback_reason = ("CoACD is not installed on the Mesh Tools service — "
                               "fell back to a single convex hull.")
            emit("hull", 0.5, "CoACD unavailable — using a convex hull…")
            hulls = [mesh.convex_hull.copy()]
        else:
            emit("decimate", 0.1, "Preparing the mesh…")
            source = _decimate(mesh, int(options.input_faces))

            emit("decompose", 0.2, f"Decomposing {len(source.faces):,} faces into convex parts…")
            try:
                coacd.set_log_level("error")
            except Exception:  # noqa: BLE001 — older builds have no log control
                pass
            parts = coacd.run_coacd(
                coacd.Mesh(np.asarray(source.vertices, dtype=np.float64),
                           np.asarray(source.faces, dtype=np.int32)),
                threshold=float(options.threshold),
                max_convex_hull=int(options.max_hulls),
                resolution=int(options.resolution),
                mcts_nodes=int(options.mcts_nodes),
                mcts_iterations=int(options.mcts_iterations),
                mcts_max_depth=int(options.mcts_max_depth),
                preprocess_resolution=int(options.preprocess_resolution),
                seed=int(options.seed),
            )
            emit("hulls", 0.7, f"Building {len(parts)} hulls…")
            for vertices, faces in parts:
                part = trimesh.Trimesh(np.asarray(vertices, dtype=np.float64),
                                       np.asarray(faces, dtype=np.int64), process=False)
                if len(part.faces) >= 4:
                    hulls.append(part.convex_hull)

    if not hulls:
        raise RuntimeError("Collision generation produced no hulls.")

    emit("simplify", 0.85, "Simplifying hulls…")
    hulls = [_simplify_hull(hull, int(options.max_hull_vertices)) for hull in hulls]

    scene = trimesh.Scene()
    for index, hull in enumerate(hulls, start=1):
        scene.add_geometry(hull, node_name=f"collision_{index:02d}",
                           geom_name=f"collision_{index:02d}")

    # How much bigger the proxy is than the shape it stands in for. >1 means the
    # hulls have bridged over cavities — the usual sign that a single hull (or too
    # few parts) is swallowing the detail that makes the shape playable.
    # A mesh that is not a closed volume has no meaningful interior, so its own
    # convex hull becomes the reference instead; `volume_basis` says which was used
    # so the number is never read as something it is not.
    if mesh.is_volume:
        reference, basis = abs(float(mesh.volume)), "mesh"
    else:
        try:
            reference, basis = abs(float(mesh.convex_hull.volume)), "convex_hull"
        except Exception:  # noqa: BLE001
            reference, basis = 0.0, "none"
    hull_volume = float(sum(abs(h.volume) for h in hulls))

    stats = {
        "method": method,
        "parts": len(hulls),
        "faces": int(sum(len(h.faces) for h in hulls)),
        "vertices": int(sum(len(h.vertices) for h in hulls)),
        "source_faces": int(len(mesh.faces)),
        "volume_ratio": round(hull_volume / reference, 3) if reference > 1e-12 else None,
        "volume_basis": basis,
        "fallback": fallback_reason or None,
    }

    emit("done", 1.0, "Collision complete.")
    return scene, stats
