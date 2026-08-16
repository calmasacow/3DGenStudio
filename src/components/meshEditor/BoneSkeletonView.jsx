// A small, self-contained 3D skeleton viewer used inside the Bone-mapping modal
// so you can rotate/pan a rig and click its bones to see where each one is
// (helpful when a bone's name alone doesn't tell you which limb it drives).
//
// IMPORTANT: it renders from the PLAIN data returned by
// `extractSkeletonFromObject` (joints/segments/names), NOT the live THREE scene.
// The reference/target scenes are shared objects also used for retargeting and
// preview — dropping them into another <Canvas> via <primitive> would reparent
// them and break those flows. Rebuilding the bones as our own geometry (like
// SkeletonOverlay does) keeps the source objects untouched.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, Html, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'

const BONE_COLOR = '#6c8cff'
const JOINT_COLOR = '#c9d4ff'
const MAPPED_COLOR = '#5ad19a'
const SELECTED_COLOR = '#8ff5ff'

// Joints are drawn small on purpose: dense rigs (spine, fingers) overlap badly
// with fat dots, which makes picking a specific bone near-impossible. The hit
// sphere is a little larger than the dot so clicking stays forgiving, but not
// so large that neighbouring joints swallow each other's clicks.
const JOINT_SCALE = 0.011
const HIT_SCALE = 0.026

// Bounds (center + radius) of the skeleton's joints, for camera framing.
function computeBounds(joints) {
  const box = new THREE.Box3()
  const p = new THREE.Vector3()
  for (let i = 0; i < joints.length; i += 3) {
    box.expandByPoint(p.set(joints[i], joints[i + 1], joints[i + 2]))
  }
  if (box.isEmpty()) return { center: [0, 0, 0], radius: 1 }
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(box.getSize(p).length() * 0.5, 1e-3)
  return { center: [center.x, center.y, center.z], radius }
}

function Scene({ skeleton, selectedBone, mappedBones, onSelectBone, isDragging, registerReset }) {
  const { center, radius } = useMemo(() => computeBounds(skeleton.joints), [skeleton])
  const invalidate = useThree(s => s.invalidate)
  const camRef = useRef(null)
  const controlsRef = useRef(null)

  const lineGeometry = useMemo(() => {
    if (!skeleton.segments?.length) return null
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(skeleton.segments, 3))
    return geo
  }, [skeleton])

  const jointRadius = Math.max(radius * JOINT_SCALE, 1e-4)
  const hitRadius = Math.max(radius * HIT_SCALE, jointRadius * 2)

  // Camera framed from the front, a little above center.
  const camPos = useMemo(
    () => [center[0], center[1] + radius * 0.15, center[2] + radius * 2.6],
    [center, radius],
  )

  // Panning can push the rig off-screen; give the modal a way to re-frame it.
  const resetView = useCallback(() => {
    const cam = camRef.current
    const controls = controlsRef.current
    if (!cam || !controls) return
    cam.position.set(camPos[0], camPos[1], camPos[2])
    controls.target.set(center[0], center[1], center[2])
    controls.update()
    invalidate()
  }, [camPos, center, invalidate])

  useEffect(() => {
    registerReset?.(resetView)
    return () => registerReset?.(null)
  }, [registerReset, resetView])

  const selectedIndex = selectedBone == null
    ? -1
    : skeleton.names.findIndex(n => n === selectedBone)

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault position={camPos} fov={40} near={radius * 0.01} far={radius * 40} />
      <OrbitControls
        ref={controlsRef}
        target={center}
        makeDefault
        enablePan
        screenSpacePanning
        panSpeed={1}
        zoomSpeed={0.9}
        minDistance={radius * 0.12}
        maxDistance={radius * 15}
        mouseButtons={{
          LEFT: THREE.MOUSE.ROTATE,
          MIDDLE: THREE.MOUSE.PAN,
          RIGHT: THREE.MOUSE.PAN,
        }}
        touches={{ ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }}
      />
      <ambientLight intensity={0.9} />

      {lineGeometry && (
        <lineSegments geometry={lineGeometry}>
          <lineBasicMaterial color={BONE_COLOR} transparent opacity={0.85} />
        </lineSegments>
      )}

      {skeleton.names.map((name, i) => {
        const x = skeleton.joints[i * 3]
        const y = skeleton.joints[i * 3 + 1]
        const z = skeleton.joints[i * 3 + 2]
        const isSelected = i === selectedIndex
        const isMapped = mappedBones?.has(name)
        const color = isSelected ? SELECTED_COLOR : isMapped ? MAPPED_COLOR : JOINT_COLOR
        return (
          <group key={`${name}_${i}`} position={[x, y, z]}>
            {/* Visible joint dot */}
            <mesh>
              <sphereGeometry args={[isSelected ? jointRadius * 1.8 : jointRadius, 12, 12]} />
              <meshBasicMaterial color={color} />
            </mesh>
            {/* Slightly larger invisible hit target so small joints stay clickable */}
            <mesh
              onClick={e => {
                e.stopPropagation()
                // Ignore the click that ends a rotate/pan drag over a joint.
                if (isDragging?.(e)) return
                onSelectBone(name)
              }}
              onPointerOver={e => { e.stopPropagation(); document.body.style.cursor = 'pointer' }}
              onPointerOut={() => { document.body.style.cursor = '' }}
            >
              <sphereGeometry args={[hitRadius, 8, 8]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            {isSelected && (
              <Html center zIndexRange={[20, 0]} className="mesh-editor-bonemap-view__label-anchor">
                <div className="mesh-editor-bonemap-view__label">{name}</div>
              </Html>
            )}
          </group>
        )
      })}
    </>
  )
}

export default function BoneSkeletonView({
  title,
  skeleton,
  selectedBone = null,
  mappedBones = null,
  onSelectBone,
  onBackgroundClick,
}) {
  const hasBones = skeleton && skeleton.names?.length
  const resetRef = useRef(null)
  const downRef = useRef(null)

  const registerReset = useCallback(fn => { resetRef.current = fn }, [])

  // Right/middle-button events are camera moves (pan), and a left-button press
  // that travelled is a rotate — neither should count as a click on a bone or
  // on the background.
  const isDragging = useCallback(e => {
    if (e?.button != null && e.button !== 0) return true
    const down = downRef.current
    if (!down || e?.clientX == null) return false
    return Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
  }, [])

  return (
    <div className="mesh-editor-bonemap-view">
      <div className="mesh-editor-bonemap-view__head">
        <span className="mesh-editor-bonemap-view__title">{title}</span>
        <span className="mesh-editor-bonemap-view__selected">
          {selectedBone || 'Click a bone'}
        </span>
        <button
          type="button"
          className="mesh-editor-bonemap-view__reset"
          onClick={() => resetRef.current?.()}
          disabled={!hasBones}
          title="Reset view — drag to rotate, right-drag (or middle-drag) to pan, scroll to zoom"
        >
          <span className="material-symbols-outlined">filter_center_focus</span>
        </button>
      </div>
      <div
        className="mesh-editor-bonemap-view__canvas"
        onPointerDown={e => { downRef.current = { x: e.clientX, y: e.clientY } }}
        onContextMenu={e => e.preventDefault()}
      >
        {hasBones ? (
          <Canvas
            dpr={[1, 2]}
            gl={{ antialias: true, alpha: true }}
            frameloop="demand"
            onPointerMissed={e => { if (!isDragging(e)) onBackgroundClick?.() }}
          >
            <Scene
              skeleton={skeleton}
              selectedBone={selectedBone}
              mappedBones={mappedBones}
              onSelectBone={onSelectBone}
              isDragging={isDragging}
              registerReset={registerReset}
            />
          </Canvas>
        ) : (
          <div className="mesh-editor-bonemap-view__empty">No skeleton</div>
        )}
      </div>
    </div>
  )
}
