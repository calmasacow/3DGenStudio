// Skeleton extraction for the bone overlays (mesh editor + mesh preview).
//
// Kept in its own module — separate from utils/meshEditor.js — so that plain
// viewers can read a rig without pulling in the editor's heavy CSG/BVH deps and
// their global THREE prototype patches. utils/meshEditor.js re-exports these.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// Extract a skeleton from a loaded object graph (a GLTF scene / SkinnedMesh)
// for display as a line overlay in the editor. Returns plain data in WORLD space
// — the same space `loadEditableGeometryFromObject` bakes the editable geometry
// into (it applies child.matrixWorld and does NOT recenter), so the returned
// segments line up with the displayed mesh. Returns null when there is no rig.
//
// Shape: {
//   jointCount,
//   joints:   Float32Array [x,y,z, ...]                 // one per bone
//   segments: Float32Array [x1,y1,z1, x2,y2,z2, ...]     // parent→child bone pairs
//   names:    string[]                                   // bone names, parallel to joints
//   parents:  number[]                                   // parent bone index per bone, -1 for roots
//   size:     number                                     // bbox diagonal (for sizing joint dots)
// }
// The bone objects of an object graph, in the order every "bone index" in the
// editor refers to.
//
// IMPORTANT: this is traverse order, which is NOT necessarily the order of
// `skeleton.bones` — and `skinIndex` addresses the latter. Anything that touches
// skin weights has to map between the two through the bone objects themselves
// (see utils/meshRigEdit.js); assuming they coincide corrupts weights silently on
// the rigs where they don't.
export function collectSkeletonBones(root) {
  if (!root) return []

  const bones = []
  const boneSet = new Set()
  root.traverse(child => {
    if (child.isBone) {
      bones.push(child)
      boneSet.add(child)
    }
  })
  // Some exporters don't tag nodes as Bone; fall back to any SkinnedMesh's skeleton.
  if (bones.length === 0) {
    root.traverse(child => {
      if (child.isSkinnedMesh && child.skeleton?.bones?.length) {
        for (const bone of child.skeleton.bones) {
          if (!boneSet.has(bone)) {
            bones.push(bone)
            boneSet.add(bone)
          }
        }
      }
    })
  }
  return bones
}

// `parents[i]` is the index of bone i's nearest bone-ancestor, or -1 for roots —
// a bone's parent may be a plain node, so the chain is walked up until another
// bone is found. This is the hierarchy the Skeleton tree view renders from.
export function boneParentIndices(bones) {
  const boneSet = new Set(bones)
  const indexOf = new Map(bones.map((bone, i) => [bone, i]))
  return bones.map(bone => {
    let parent = bone.parent
    while (parent && !boneSet.has(parent)) parent = parent.parent
    return parent && indexOf.has(parent) ? indexOf.get(parent) : -1
  })
}

export function extractSkeletonFromObject(object) {
  const root = object?.scene || object
  if (!root) return null

  root.updateMatrixWorld(true)

  const bones = collectSkeletonBones(root)
  if (bones.length === 0) return null

  const tmp = new THREE.Vector3()
  const joints = new Float32Array(bones.length * 3)
  const names = new Array(bones.length)
  const box = new THREE.Box3()

  bones.forEach((bone, i) => {
    bone.getWorldPosition(tmp)
    joints[i * 3] = tmp.x
    joints[i * 3 + 1] = tmp.y
    joints[i * 3 + 2] = tmp.z
    names[i] = bone.name || `bone_${i}`
    box.expandByPoint(tmp)
  })

  const parents = boneParentIndices(bones)
  const segments = []
  parents.forEach((p, i) => {
    if (p < 0) return
    segments.push(
      joints[p * 3], joints[p * 3 + 1], joints[p * 3 + 2],
      joints[i * 3], joints[i * 3 + 1], joints[i * 3 + 2],
    )
  })

  const size = box.isEmpty() ? 1 : box.getSize(tmp).length()

  return {
    jointCount: bones.length,
    joints,
    segments: new Float32Array(segments),
    names,
    parents,
    size: size || 1,
  }
}

// Keep only the named bones, re-linking each survivor to its nearest surviving
// ancestor so the hierarchy stays connected.
//
// Used by the bone-mapping modal's source view. The Kimodo skeleton carries all
// 77 SOMA joints because the FK chain needs them, but only the 23 the model
// actually animates are offered for mapping — drawing the other 54 (44 of them
// finger joints that never move) made the picture disagree with the list beside
// it, which reads as a bug rather than as a deliberate restriction.
//
// Returns the skeleton unchanged when `allowed` covers everything, and null when
// it covers nothing.
export function filterSkeleton(skeleton, allowed) {
  if (!skeleton?.names?.length || !allowed) return skeleton
  const keep = allowed instanceof Set ? allowed : new Set(allowed)

  const kept = []
  skeleton.names.forEach((name, i) => { if (keep.has(name)) kept.push(i) })
  if (kept.length === skeleton.names.length) return skeleton
  if (!kept.length) return null

  const remap = new Map(kept.map((oldIndex, newIndex) => [oldIndex, newIndex]))

  const joints = new Float32Array(kept.length * 3)
  const names = new Array(kept.length)
  const parents = new Int32Array(kept.length)
  const segments = []

  kept.forEach((oldIndex, newIndex) => {
    joints[newIndex * 3] = skeleton.joints[oldIndex * 3]
    joints[newIndex * 3 + 1] = skeleton.joints[oldIndex * 3 + 1]
    joints[newIndex * 3 + 2] = skeleton.joints[oldIndex * 3 + 2]
    names[newIndex] = skeleton.names[oldIndex]

    // Walk up until a kept ancestor is found, so dropping an intermediate bone
    // splices its children onto the chain instead of orphaning them.
    let p = skeleton.parents[oldIndex]
    while (p >= 0 && !remap.has(p)) p = skeleton.parents[p]
    parents[newIndex] = p >= 0 ? remap.get(p) : -1
  })

  // Second pass: bone order is not guaranteed parent-first, so segments are only
  // safe to build once every joint position has been written.
  parents.forEach((p, i) => {
    if (p < 0) return
    segments.push(
      joints[p * 3], joints[p * 3 + 1], joints[p * 3 + 2],
      joints[i * 3], joints[i * 3 + 1], joints[i * 3 + 2],
    )
  })

  return {
    jointCount: kept.length,
    joints,
    segments: new Float32Array(segments),
    names,
    parents,
    size: skeleton.size,
  }
}

// Shift extracted skeleton data by a world-space offset.
//
// The overlay is baked world-space positions, not live bones, so anything that
// moves the editable geometry (recentring the pivot, for one) has to move this
// too — otherwise the rig visibly detaches and hangs where the mesh used to be.
export function translateSkeleton(skeleton, offsetX, offsetY, offsetZ) {
  if (!skeleton) return skeleton

  const shift = source => {
    if (!source?.length) return source
    const out = new Float32Array(source.length)
    for (let i = 0; i < source.length; i += 3) {
      out[i] = source[i] + offsetX
      out[i + 1] = source[i + 1] + offsetY
      out[i + 2] = source[i + 2] + offsetZ
    }
    return out
  }

  return { ...skeleton, joints: shift(skeleton.joints), segments: shift(skeleton.segments) }
}

// Parse an in-memory GLB (ArrayBuffer) and extract its skeleton overlay data.
// Used for the rigged result returned by the rig service. Returns null on no rig.
export function extractSkeletonFromGlbBuffer(arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      new GLTFLoader().parse(
        arrayBuffer,
        '',
        gltf => {
          const scene = gltf?.scene || (Array.isArray(gltf?.scenes) ? gltf.scenes[0] : null)
          if (!scene) {
            resolve(null)
            return
          }
          try {
            resolve(extractSkeletonFromObject(scene))
          } catch {
            resolve(null)
          }
        },
        error => reject(error instanceof Error ? error : new Error('Failed to parse the rigged GLB.')),
      )
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Failed to parse the rigged GLB.'))
    }
  })
}
