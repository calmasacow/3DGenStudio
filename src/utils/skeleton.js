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
export function extractSkeletonFromObject(object) {
  const root = object?.scene || object
  if (!root) return null

  root.updateMatrixWorld(true)

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
  if (bones.length === 0) return null

  const indexOf = new Map(bones.map((bone, i) => [bone, i]))
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

  // A bone's parent may be a plain node; walk up until we find another bone.
  // `parents[i]` is the index of bone i's nearest bone-ancestor, or -1 for roots
  // — this is the hierarchy the Skeleton tree view renders from.
  const segments = []
  const parents = new Array(bones.length).fill(-1)
  bones.forEach((bone, i) => {
    let parent = bone.parent
    while (parent && !boneSet.has(parent)) parent = parent.parent
    if (parent && indexOf.has(parent)) {
      const p = indexOf.get(parent)
      parents[i] = p
      segments.push(
        joints[p * 3], joints[p * 3 + 1], joints[p * 3 + 2],
        joints[i * 3], joints[i * 3 + 1], joints[i * 3 + 2],
      )
    }
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
