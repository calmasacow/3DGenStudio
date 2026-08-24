// The skeleton overlay for an ANIMATED mesh: same look as SkeletonOverlay, but the
// bone positions are read off the live skeleton every frame instead of the rest-pose
// snapshot `extractSkeletonFromObject` produced.
//
// Why a separate component: the static overlay is fed plain arrays and memoises its
// geometry, which is exactly right when nothing moves. Here every joint moves every
// frame, so the buffers are preallocated once and rewritten in place.
//
// World positions, deliberately: the animated scene is rendered inside a `<group>`
// that carries the floor offset (see AnimatedMeshPreview), so anything read out of
// the bones already includes it — and this overlay must therefore be a SIBLING of
// that group, not a child, or the offset would be applied twice.
//
// It also publishes what it drew through `onJoints`, because the viewport's
// click-to-select-a-bone picker has to hit-test the bones the user can SEE. Against
// the rest-pose joints it would select whatever bone happens to be nearest the
// click in the bind pose — a different bone from the one drawn under the cursor.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import * as THREE from 'three'
import { BONE_COLOR, JOINT_COLOR, SELECTED_COLOR } from './SkeletonOverlay'

const _v = new THREE.Vector3()

export default function AnimatedSkeletonOverlay({
  root,               // the animated scene root (bones live under it)
  skinnedMesh,        // the SkinnedMesh whose skeleton is being played
  visible = true,
  selectedName = null,
  onJoints = null,    // (names, positions) — same arrays each frame, read synchronously
}) {
  const markerRef = useRef(null)
  const labelRef = useRef(null)
  const onJointsRef = useRef(onJoints)
  useEffect(() => { onJointsRef.current = onJoints }, [onJoints])

  // Bones, parent→child pairs and the buffers to draw them. Rebuilt only when the
  // skeleton itself changes (a re-rig, a different mesh).
  const rig = useMemo(() => {
    const bones = skinnedMesh?.skeleton?.bones
    if (!bones?.length) return null
    const index = new Map(bones.map((b, i) => [b, i]))
    const pairs = []
    bones.forEach((bone, i) => {
      const parent = index.get(bone.parent)
      if (parent !== undefined) pairs.push(parent, i)
    })
    return {
      bones,
      names: bones.map(b => b.name),
      pairs,
      positions: new Float32Array(bones.length * 3),
      segments: new Float32Array(pairs.length * 3),
    }
  }, [skinnedMesh])

  const jointGeometry = useMemo(() => {
    if (!rig) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(rig.positions, 3))
    return geo
  }, [rig])

  const lineGeometry = useMemo(() => {
    if (!rig?.pairs.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(rig.segments, 3))
    return geo
  }, [rig])

  // Dot and marker sizes from the rig's own extent, so they read at any scale —
  // measured once from the bind pose (the animated extent wobbles per frame, and a
  // marker that breathes with the walk cycle is a distraction, not information).
  const scale = useMemo(() => {
    if (!rig) return { joint: 0.02, marker: 0.007 }
    const box = new THREE.Box3()
    rig.bones.forEach(b => box.expandByPoint(b.getWorldPosition(_v)))
    const size = Math.max(box.getSize(_v).length(), 1e-4)
    return { joint: Math.max(size * 0.02, 1e-4), marker: Math.max(size * 0.007, 1e-4) }
  }, [rig])

  const selectedIndex = useMemo(() => {
    if (!rig || !selectedName) return -1
    return rig.names.indexOf(selectedName)
  }, [rig, selectedName])

  useEffect(() => () => {
    jointGeometry?.dispose()
    lineGeometry?.dispose()
  }, [jointGeometry, lineGeometry])

  // Everything the frame loop writes to lives behind this ref. The buffers and
  // geometries are mutable per-frame scratch, but they are created in useMemo, and
  // eslint's react-hooks/immutability rule treats memoised values as read-only — a
  // ref is the sanctioned handle for state that is meant to be written in place.
  const frameRef = useRef(null)
  useEffect(() => {
    frameRef.current = rig ? { ...rig, jointGeometry, lineGeometry } : null
  }, [rig, jointGeometry, lineGeometry])

  useFrame(() => {
    const f = frameRef.current
    if (!f || !visible) return
    // The mixer wrote new bone transforms in AnimatedMeshPreview's own useFrame this
    // frame, but world matrices are only refreshed at render — so refresh them here
    // or the overlay trails the mesh by a frame.
    root?.updateMatrixWorld(true)

    const { bones, positions, segments, pairs } = f
    for (let i = 0; i < bones.length; i++) {
      bones[i].getWorldPosition(_v).toArray(positions, i * 3)
    }
    for (let p = 0; p < pairs.length; p++) {
      const j = pairs[p] * 3
      segments[p * 3] = positions[j]
      segments[p * 3 + 1] = positions[j + 1]
      segments[p * 3 + 2] = positions[j + 2]
    }
    if (f.jointGeometry) f.jointGeometry.attributes.position.needsUpdate = true
    if (f.lineGeometry) f.lineGeometry.attributes.position.needsUpdate = true

    if (selectedIndex >= 0) {
      const o = selectedIndex * 3
      markerRef.current?.position.set(positions[o], positions[o + 1], positions[o + 2])
      labelRef.current?.position.set(positions[o], positions[o + 1], positions[o + 2])
    }

    onJointsRef.current?.(f.names, positions)
  })

  if (!visible || !rig) return null

  return (
    <group renderOrder={40}>
      {lineGeometry && (
        <lineSegments geometry={lineGeometry} renderOrder={40} frustumCulled={false}>
          <lineBasicMaterial color={BONE_COLOR} transparent opacity={0.95} depthTest={false} depthWrite={false} />
        </lineSegments>
      )}
      {jointGeometry && (
        <points geometry={jointGeometry} renderOrder={41} frustumCulled={false}>
          <pointsMaterial
            color={JOINT_COLOR}
            size={scale.joint}
            sizeAttenuation
            transparent
            depthTest={false}
            depthWrite={false}
          />
        </points>
      )}
      {selectedIndex >= 0 && (
        <>
          <mesh ref={markerRef} renderOrder={42}>
            <sphereGeometry args={[scale.marker, 16, 16]} />
            <meshBasicMaterial color={SELECTED_COLOR} transparent opacity={0.95} depthTest={false} depthWrite={false} />
          </mesh>
          {/* Own group, so the label tracks the joint without inheriting the
              marker's geometry scale. */}
          <group ref={labelRef}>
            <Html center zIndexRange={[20, 0]} className="mesh-editor-bone-label__anchor">
              <div className="mesh-editor-bone-label">{selectedName}</div>
            </Html>
          </group>
        </>
      )}
    </group>
  )
}
