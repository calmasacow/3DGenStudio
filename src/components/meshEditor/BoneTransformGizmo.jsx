// Translate gizmo for the selected bone, shown in the mesh-editor viewport while
// Auto Rig's bone-edit mode is on.
//
// It drives a proxy Object3D rather than a bone: the bones live in `rigRef`'s own
// scene graph, which is deliberately never mounted into the editor's Canvas (the
// viewport draws the rig as a baked line overlay). So the gizmo moves a stand-in
// at the joint's world position and reports that position back, and the page
// applies it to the real bone.
//
// Orbit is not fought over: CameraRig's OrbitControls is `makeDefault`, which is
// how drei's TransformControls knows to suspend it mid-drag, and the editor
// leaves the left mouse button unbound for exactly this kind of tool.
import { useEffect, useMemo, useRef } from 'react'
import { TransformControls } from '@react-three/drei'
import * as THREE from 'three'

export default function BoneTransformGizmo({
  skeleton,
  boneIndex,
  onDragStart,
  onDrag,
  onDragEnd,
}) {
  const proxy = useMemo(() => new THREE.Object3D(), [])
  const draggingRef = useRef(false)

  const joints = skeleton?.joints
  const hasBone = boneIndex != null && joints && boneIndex >= 0 && boneIndex * 3 + 2 < joints.length
  const x = hasBone ? joints[boneIndex * 3] : 0
  const y = hasBone ? joints[boneIndex * 3 + 1] : 0
  const z = hasBone ? joints[boneIndex * 3 + 2] : 0

  // Follow the joint — a new selection, an undo, a numeric nudge from the panel.
  // Skipped mid-drag: the position is then coming *from* the gizmo, and writing
  // it back would fight the very drag that produced it.
  useEffect(() => {
    if (!hasBone || draggingRef.current) return
    proxy.position.set(x, y, z)
    proxy.updateMatrixWorld()
  }, [proxy, hasBone, x, y, z])

  if (!hasBone) return null

  return (
    <>
      <primitive object={proxy} />
      <TransformControls
        object={proxy}
        mode="translate"
        space="world"
        size={0.7}
        onMouseDown={() => {
          draggingRef.current = true
          onDragStart?.()
        }}
        onObjectChange={() => {
          if (draggingRef.current) onDrag?.(proxy.position)
        }}
        onMouseUp={() => {
          draggingRef.current = false
          onDragEnd?.(proxy.position)
        }}
      />
    </>
  )
}
