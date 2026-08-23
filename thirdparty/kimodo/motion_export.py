"""Turn one Kimodo sample into a BVH clip, optionally converted to in-place.

Kept apart from motion_server.py because this is the only part with opinions
about the MOTION rather than about serving it, and it is the part worth reading
twice: the in-place conversion below is a deliberate choice, not a clamp.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import torch

from kimodo.exports.bvh import motion_to_bvh
from kimodo.skeleton import global_rots_to_local_rots

# Everything below is in METRES (model space). motion_to_bvh scales to
# centimetres on the way out, to match the BONES-SEED BVH convention.
_X, _Y, _Z = 0, 1, 2

# Export against the STANDARD T-POSE, not the BONES-SEED rest pose.
#
# This is not a stylistic choice. With standard_tpose=False (upstream's default)
# the BVH hierarchy's OFFSETs describe a rest pose whose up-axis is +X -- the
# skeleton lies flat along X -- and each frame's rotations carry the correction
# that stands it upright. Blender is fine with that, because it only ever renders
# posed frames.
#
# Retargeting is not. three's BVHLoader reconstructs the bind pose from the
# OFFSETs with IDENTITY rotations (Skeleton.pose()), so the retargeter measures
# every delta against that flat-along-X pose, and the constant "stand upright"
# rotation ends up baked onto the target's bones -- limbs rotated off to one side
# for the whole clip. It also renders as a horizontal line in the bone-mapping
# preview, which is the visible tell.
#
# standard_tpose=True uses neutral_joints (a real Y-up T-pose: head above hips,
# arms out to +/-X, feet on the floor) AND leaves the rotations in that same
# frame, so hierarchy and animation finally agree.
_STANDARD_TPOSE = True


def _hips_rest_offset(skeleton) -> tuple[float, float, float]:
    """The Hips OFFSET motion_to_bvh will write, in METRES.

    Needed because BVH root translation is cumulative: three's BVHLoader (and
    Blender) place the animated hips at ``offset + position channel``, while
    Skeleton.pose() places the BOUND hips at ``offset`` alone. Feeding the raw
    pelvis position through as the channel therefore puts the animated hips a
    whole nominal body-height above the bound ones, which scales the retargeted
    hip motion wrongly and floats the character.

    Mirrors motion_to_bvh's own choice, including its nominal 1 m substitution
    when the skeleton's root sits at the origin (which SOMA's does -- base.py
    asserts it).
    """
    neutral = skeleton.neutral_joints if _STANDARD_TPOSE else skeleton.bvh_neutral_joints
    root = neutral[int(skeleton.root_idx)].detach().cpu()
    if bool((root == 0).all()):
        return (0.0, 1.0, 0.0)
    return (float(root[_X]), float(root[_Y]), float(root[_Z]))


def _sample(output: dict, key: str, index: int) -> np.ndarray | None:
    """Pull sample `index` out of a batched model output entry."""
    value = output.get(key)
    if value is None:
        return None
    array = np.asarray(value)
    return array[index] if array.ndim and array.shape[0] > index else array


def make_in_place(root_positions: torch.Tensor, smooth_root_pos: np.ndarray | None) -> torch.Tensor:
    """Strip locomotion from the root track while keeping the motion's texture.

    The naive in-place conversion pins the hips to a constant X/Z, which also
    flattens the side-to-side weight shift and forward lean that make a walk read
    as a walk — you get a character sliding its feet under a rigid pelvis.

    Kimodo hands us a better signal for free: ``smooth_root_pos`` is the model's
    own low-frequency root trajectory, i.e. exactly the locomotion component and
    none of the per-step sway. Subtracting its horizontal DRIFT removes the travel
    and leaves the sway on top of it.

    Vertical motion is untouched throughout — jumps still leave the ground and
    crouches still lower the body. Rotation is untouched too, so "turns left"
    still turns; it just turns on the spot.
    """
    result = root_positions.clone()
    if smooth_root_pos is not None and np.asarray(smooth_root_pos).ndim == 2:
        smooth = torch.as_tensor(
            np.asarray(smooth_root_pos), dtype=result.dtype, device=result.device
        )
        drift = smooth[:, [_X, _Z]] - smooth[0:1, [_X, _Z]]
        result[:, [_X, _Z]] -= drift
    else:
        # No smoothed root in the output (older checkpoints): fall back to the
        # hard pin. Loses the sway, but never leaves the clip travelling.
        result[:, _X] = result[0, _X]
        result[:, _Z] = result[0, _Z]
    return result


def build_rest_pose_bvh(fps: float = 30.0) -> tuple[str, dict]:
    """A BVH of the SOMA-77 skeleton standing at rest, with no motion.

    The browser needs the SOURCE skeleton to offer bone mapping, and making the
    user generate a clip first just to see the bone list is a bad trade. This
    builds the same hierarchy that generated clips use — identical joint names,
    parents and rest offsets — from the skeleton asset alone: no checkpoint, no
    text encoder, no GPU.

    Consistency matters more than it looks. Retargeting measures each source
    bone's rotation as a delta from its REST pose, so a source skeleton built
    from a different rest pose than the clips (upstream also ships a standard
    T-pose variant) would bias every frame. Passing identity rotations through
    the same ``standard_tpose=False`` path the clips use is what keeps the two
    in agreement.

    Two identical frames rather than one: a zero-length clip is an awkward edge
    case for parsers downstream, and the second frame costs nothing.
    """
    skeleton = _rest_skeleton()
    joints = int(skeleton.nbjoints)
    local_rot_mats = torch.eye(3).reshape(1, 1, 3, 3).repeat(2, joints, 1, 1)
    # Zero, not the hip height: the Hips OFFSET already stands the skeleton up,
    # and the position channel is added on top of it (see _hips_rest_offset).
    root_positions = torch.zeros(2, 3)

    bvh_text = motion_to_bvh(
        local_rot_mats, root_positions, skeleton=skeleton, fps=fps, standard_tpose=_STANDARD_TPOSE
    )
    return bvh_text, {
        "frames": 2,
        "fps": float(fps),
        "joints": joints,
        "skeleton": skeleton.name,
        "bones": list(skeleton.bone_order_names),
    }


def _rest_skeleton():
    from kimodo.skeleton import SOMASkeleton77

    return SOMASkeleton77()


def build_bvh(
    output: dict,
    model: Any,
    *,
    sample_index: int = 0,
    in_place: bool = False,
) -> tuple[str, dict]:
    """Convert one generated sample to BVH text.

    Returns ``(bvh_text, stats)``. The skeleton is always somaskel77: Kimodo-SOMA
    models denoise on the compact somaskel30 but convert their OUTPUT up to 77
    joints, so ``posed_joints`` / ``global_rot_mats`` are already 77-joint here
    and only the skeleton object needs swapping.
    """
    # Kimodo exposes exactly this mapping itself (somaskel30 -> somaskel77 for
    # SOMA models, unchanged otherwise), so use it rather than re-deriving it.
    skeleton = model.output_skeleton
    if "somaskel" not in skeleton.name:
        raise ValueError(
            f"BVH export needs a SOMA skeleton; this model uses {skeleton.name!r}. "
            "Use a Kimodo-SOMA checkpoint."
        )

    posed_joints = _sample(output, "posed_joints", sample_index)
    global_rot_mats = _sample(output, "global_rot_mats", sample_index)
    if posed_joints is None or global_rot_mats is None:
        raise ValueError("Model output is missing 'posed_joints' / 'global_rot_mats'.")

    # Do the FK maths wherever the skeleton's own buffers live, so
    # global_rots_to_local_rots does not trip over a device mismatch.
    device = skeleton.joint_parents.device if hasattr(skeleton, "joint_parents") else "cpu"
    joints_pos = torch.as_tensor(posed_joints, dtype=torch.float32, device=device)
    joints_rot = torch.as_tensor(global_rot_mats, dtype=torch.float32, device=device)

    local_rot_mats = global_rots_to_local_rots(joints_rot, skeleton)
    root_positions = joints_pos[:, int(skeleton.root_idx), :].clone()

    if in_place:
        root_positions = make_in_place(root_positions, _sample(output, "smooth_root_pos", sample_index))

    # Start every clip at the horizontal origin. Retargeting reads the hip track
    # as a delta from the source's BIND pose, so this changes nothing downstream;
    # it just means the raw BVH opens at 0,0 in Blender instead of wherever the
    # sample happened to begin.
    root_positions[:, _X] -= root_positions[0, _X].clone()
    root_positions[:, _Z] -= root_positions[0, _Z].clone()

    # Make the channel a delta from the Hips OFFSET rather than an absolute
    # position, since readers add the two together. Without this the animated
    # hips sit a nominal body-height above the bound ones.
    offset = _hips_rest_offset(skeleton)
    for axis, value in enumerate(offset):
        if value:
            root_positions[:, axis] -= value

    bvh_text = motion_to_bvh(
        local_rot_mats,
        root_positions,
        skeleton=skeleton,
        fps=model.fps,
        standard_tpose=_STANDARD_TPOSE,
    )

    frames = int(local_rot_mats.shape[0])
    stats = {
        "frames": frames,
        "fps": float(model.fps),
        "duration": round(frames / float(model.fps), 3),
        "joints": int(local_rot_mats.shape[1]),
        "skeleton": skeleton.name,
        "in_place": bool(in_place),
    }
    return bvh_text, stats
