// Move/rotate gizmo on the selected bone while the animation edit dock is open. The
// drag edits the CURRENT FRAME of the clip that is playing.
//
// It cannot be attached to the bone: the mixer rewrites every bone from the clip on
// every frame, so a transform written onto the bone would be gone before the next
// paint. So the gizmo drives a proxy Object3D that sits at the bone's world transform,
// and the page turns each drag into a write to the clip's track — which the mixer then
// applies back onto the bone. The bone follows because the CLIP changed, which is also
// why the edit survives, is undoable, and is what gets saved.
//
// The proxy is a root-level object, so its local transform IS its world transform —
// which is what the page's world→bone-local conversion expects.
//
// Orbit is not fought over: CameraRig's OrbitControls is `makeDefault`, which is how
// drei's TransformControls knows to suspend it mid-drag (same as BoneTransformGizmo).
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { TransformControls } from '@react-three/drei'
import * as THREE from 'three'

export default function AnimationBoneGizmo({
  bone,                 // the live THREE.Bone being edited, or null
  mode = 'rotate',      // 'translate' | 'rotate'
  onDragStart,
  onDrag,               // (proxy) — read .position / .quaternion (world)
  onDragEnd,
}) {
  const proxy = useMemo(() => new THREE.Object3D(), [])
  const draggingRef = useRef(false)
  const handlers = useRef({ onDragStart, onDrag, onDragEnd })
  useEffect(() => { handlers.current = { onDragStart, onDrag, onDragEnd } },
    [onDragStart, onDrag, onDragEnd])

  // Follow the bone every frame: scrubbing, a numeric edit, an undo and playback all
  // move it, and none of them go through this component. Skipped mid-drag, when the
  // transform is coming FROM the gizmo and writing it back would fight the drag.
  useFrame(() => {
    if (!bone || draggingRef.current) return
    bone.getWorldPosition(proxy.position)
    bone.getWorldQuaternion(proxy.quaternion)
    proxy.updateMatrixWorld()
  })

  // A bone change mid-drag would strand `draggingRef` — and with it the frame sync.
  useEffect(() => () => { draggingRef.current = false }, [bone, mode])

  if (!bone) return null

  return (
    <>
      <primitive object={proxy} />
      <TransformControls
        object={proxy}
        mode={mode}
        // World axes to translate along (predictable against the grid), the bone's own
        // axes to rotate about (bend and twist are local by nature on a limb).
        space={mode === 'rotate' ? 'local' : 'world'}
        size={0.7}
        onMouseDown={() => {
          draggingRef.current = true
          handlers.current.onDragStart?.(mode)
        }}
        onObjectChange={() => {
          if (draggingRef.current) handlers.current.onDrag?.(proxy, mode)
        }}
        onMouseUp={() => {
          draggingRef.current = false
          handlers.current.onDragEnd?.(mode)
        }}
      />
    </>
  )
}
