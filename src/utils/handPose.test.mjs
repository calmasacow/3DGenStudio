// Curl-direction check for handPose.js. No test framework — run it directly:
//
//     node src/utils/handPose.test.mjs
//
// This exists because the curl DIRECTION is the one part of the hand pose that
// cannot be eyeballed from the code, and the first two attempts at it were wrong:
//
//   1. "curl the way that brings the fingertips closer to the wrist" — useless.
//      Bending a chain either way shortens it by exactly the same amount
//      (6.2418 both ways on a straight three-bone finger).
//   2. Taking the knuckle axis from the first and last child of the hand — the
//      thumb is a child too, and rigs order it first or last, which tilted a
//      clean +Z knuckle line to (-1, -1.2, -0.6) and curled the fingers sideways.
//
// The two rigs below have OPPOSITE palm directions on purpose, so a hard-coded
// sign passes neither, and each exercises a different branch of curlSign: the
// first has rest curvature, the second is dead flat and must fall back to the
// thumb.
//
// KNOWN GAP, so nobody reads more into a green run than is there: these cases do
// NOT discriminate the thumb's axis strategy. A single palm-derived axis and the
// current per-joint / rest-curvature one both produce a plausible fold on rigs
// this regular, and both pass. They cover direction, sides and track counts;
// thumb QUALITY on a real hand still has to be judged by eye. Set
// window.__handPoseDebug = true in the browser to dump a real rig's thumb
// geometry, which is what a faithful test case would need.
import { AnimationClip, Bone, Object3D, Skeleton, SkinnedMesh, Vector3 } from 'three'
import { withHandPose } from './handPose.js'

// Right hand: fingers along +X, knuckles spread along +Z. `restBend` rotates each
// joint about +Z, which carries +X toward +Y — so the palm is +Y. The thumb sits
// at -Y, i.e. the palm side of a FLAT rig. The two cues therefore disagree, which
// is what lets each test pin down one branch.
function buildHand({ restBend }) {
  const root = new Object3D()
  const hand = new Bone()
  hand.name = 'RightHand'
  root.add(hand)
  const bones = [hand]

  for (const [finger, name] of ['Index', 'Middle', 'Ring', 'Pinky'].entries()) {
    let parent = hand
    for (let i = 0; i < 3; i += 1) {
      const bone = new Bone()
      bone.name = `RightHand${name}${i + 1}`
      if (i === 0) bone.position.set(2, 0, finger * 1.2)
      else {
        bone.position.set(2, 0, 0)
        if (restBend) bone.rotateOnAxis(new Vector3(0, 0, 1), 0.12)
      }
      parent.add(bone)
      bones.push(bone)
      parent = bone
    }
  }

  let parent = hand
  for (let i = 0; i < 3; i += 1) {
    const bone = new Bone()
    bone.name = `RightHandThumb${i + 1}`
    bone.position.set(i === 0 ? 1 : 1.4, i === 0 ? -1.2 : 0, i === 0 ? -0.6 : 0)
    parent.add(bone)
    bones.push(bone)
    parent = bone
  }

  root.updateMatrixWorld(true)
  const mesh = new SkinnedMesh()
  mesh.skeleton = new Skeleton(bones)
  root.add(mesh)
  return { root, mesh, bones }
}

const meanTipY = bones => bones
  .filter(b => /(Index|Middle|Ring|Pinky)3$/.test(b.name))
  .reduce((sum, b) => sum + b.getWorldPosition(new Vector3()).y, 0) / 4

let failures = 0
for (const { restBend, label, expect } of [
  { restBend: true, label: 'rest curvature -> palm +Y', expect: 'up' },
  { restBend: false, label: 'flat rig, thumb -> palm -Y', expect: 'down' },
]) {
  const rig = buildHand({ restBend })
  const before = meanTipY(rig.bones)

  const posed = withHandPose(new AnimationClip('t', 1, []), {
    targetScene: rig.root,
    targetSkinnedMesh: rig.mesh,
    mapping: { RightHand: 'RightHand' },
    curl: 1,
  })

  for (const track of posed.tracks) {
    const name = /\.bones\[(.+?)\]/.exec(track.name)[1]
    rig.bones.find(b => b.name === name)
      .quaternion.set(track.values[0], track.values[1], track.values[2], track.values[3])
  }
  rig.root.updateMatrixWorld(true)
  const after = meanTipY(rig.bones)

  const ok = expect === 'up' ? after > before + 0.5 : after < before - 0.5
  if (!ok) failures += 1
  console.log(
    `${label.padEnd(28)} tracks=${String(posed.tracks.length).padStart(2)}  `
    + `tipY ${before.toFixed(2)} -> ${after.toFixed(2)}  ${ok ? 'ok' : '*** CURLED THE WRONG WAY ***'}`,
  )
}

// --- per-hand independence -------------------------------------------------
// One rig, both hands, and only the right slider raised. The left hand must come
// back untouched — the side is resolved from the mapping's SOURCE name, so this
// also covers that lookup.
{
  const left = buildHand({ restBend: true })
  const right = buildHand({ restBend: true })
  left.bones[0].name = 'LeftHand'
  for (const bone of left.bones) bone.name = bone.name.replace(/^RightHand/, 'LeftHand')

  const root = new Object3D()
  root.add(left.root, right.root)
  root.updateMatrixWorld(true)
  const mesh = new SkinnedMesh()
  mesh.skeleton = new Skeleton([...left.bones, ...right.bones])
  root.add(mesh)

  const posed = withHandPose(new AnimationClip('t', 1, []), {
    targetScene: root,
    targetSkinnedMesh: mesh,
    mapping: { LeftHand: 'LeftHand', RightHand: 'RightHand' },
    curl: { left: 0, right: 1, leftThumb: 0, rightThumb: 1 },
  })

  const names = posed.tracks.map(t => /\.bones\[(.+?)\]/.exec(t.name)[1])
  const leftPosed = names.filter(n => n.startsWith('LeftHand')).length
  const rightPosed = names.filter(n => n.startsWith('RightHand')).length
  // 4 fingers x 3 + thumb x 2: the thumb's TIP is skipped, since rotating a bone
  // with no children moves nothing.
  const ok = leftPosed === 0 && rightPosed === 14
  if (!ok) failures += 1
  console.log(
    `${'right only, left untouched'.padEnd(28)} tracks=${String(posed.tracks.length).padStart(2)}  `
    + `left=${leftPosed} right=${rightPosed}  ${ok ? 'ok' : '*** SIDES NOT INDEPENDENT ***'}`,
  )
}

// --- thumb axis ------------------------------------------------------------
// The bug this guards: a thumb sticks out SIDEWAYS, roughly along the knuckle
// line the fingers curl about — so rotating it about that same line does not
// flex it, it abducts it, and at 100% the thumb visibly opened away from an
// otherwise closed fist. The thumb gets an axis derived from its own direction
// and the palm instead.
//
// This rig's thumb points along +Z (the knuckle axis) with the palm at +Y, which
// is precisely the degenerate case: under the old shared axis it barely moves.
{
  const root = new Object3D()
  const hand = new Bone(); hand.name = 'RightHand'; root.add(hand)
  const bones = [hand]
  for (const [finger, name] of ['Index', 'Middle', 'Ring', 'Pinky'].entries()) {
    let parent = hand
    for (let i = 0; i < 3; i += 1) {
      const bone = new Bone()
      bone.name = `RightHand${name}${i + 1}`
      if (i === 0) bone.position.set(2, 0, finger * 1.2)
      else { bone.position.set(2, 0, 0); bone.rotateOnAxis(new Vector3(0, 0, 1), 0.12) }
      parent.add(bone); bones.push(bone); parent = bone
    }
  }
  let parent = hand
  for (let i = 0; i < 3; i += 1) {
    const bone = new Bone(); bone.name = `RightHandThumb${i + 1}`
    bone.position.set(i === 0 ? 0.5 : 0, 0, i === 0 ? -1.2 : -1.4)   // points -Z, sideways
    parent.add(bone); bones.push(bone); parent = bone
  }
  root.updateMatrixWorld(true)
  const mesh = new SkinnedMesh(); mesh.skeleton = new Skeleton(bones); root.add(mesh)

  const thumbTip = bones.find(b => b.name === 'RightHandThumb3')
  const before = thumbTip.getWorldPosition(new Vector3()).y

  const posed = withHandPose(new AnimationClip('t', 1, []), {
    targetScene: root, targetSkinnedMesh: mesh,
    mapping: { RightHand: 'RightHand' },
    curl: { right: 0, rightThumb: 1 },   // thumb ONLY, so nothing else can move it
  })
  for (const track of posed.tracks) {
    const name = /\.bones\[(.+?)\]/.exec(track.name)[1]
    bones.find(b => b.name === name).quaternion.set(...track.values.slice(0, 4))
  }
  root.updateMatrixWorld(true)
  const after = thumbTip.getWorldPosition(new Vector3()).y

  // Palm is +Y, so a folding thumb must rise. Only the 3 thumb bones get tracks.
  const ok = after > before + 0.5 && posed.tracks.length === 2   // tip contributes nothing
  if (!ok) failures += 1
  console.log(
    `${'thumb folds across palm'.padEnd(28)} tracks=${String(posed.tracks.length).padStart(2)}  `
    + `thumbY ${before.toFixed(2)} -> ${after.toFixed(2)}  ${ok ? 'ok' : '*** THUMB DID NOT FOLD ***'}`,
  )
}

// --- kinked thumb follows the rig's own bend --------------------------------
// The previous rig's thumb is a straight chain, so it exercises only the palm
// fallback. A real thumb is KINKED — the metacarpal goes out and forward, the
// phalanges angle off it — and that kink IS the rig stating where the thumb
// folds, which is a better signal than any inference from the palm.
//
// Two things are asserted. Every segment must end up pointing more toward the
// palm than it started (it folded, not splayed), AND the angle between the
// segments must GROW (it deepened the bend the rig already had, rather than
// rotating the thumb rigidly or twisting it about its own length).
{
  const root = new Object3D()
  const hand = new Bone(); hand.name = 'RightHand'; root.add(hand)
  const bones = [hand]
  for (const [finger, name] of ['Index', 'Middle', 'Ring', 'Pinky'].entries()) {
    let parent = hand
    for (let i = 0; i < 3; i += 1) {
      const bone = new Bone()
      bone.name = `RightHand${name}${i + 1}`
      if (i === 0) bone.position.set(2, 0, finger * 1.2)
      else { bone.position.set(2, 0, 0); bone.rotateOnAxis(new Vector3(0, 0, 1), 0.12) }
      parent.add(bone); bones.push(bone); parent = bone
    }
  }
  // Kinked thumb: each segment heads a different way, none of them coplanar.
  const thumbOffsets = [[0.6, -0.3, -1.2], [1.2, 0.1, -0.8], [0.9, 0.5, -0.2]]
  let parent = hand
  for (let i = 0; i < 3; i += 1) {
    const bone = new Bone(); bone.name = `RightHandThumb${i + 1}`
    bone.position.set(...thumbOffsets[i])
    parent.add(bone); bones.push(bone); parent = bone
  }
  root.updateMatrixWorld(true)
  const mesh = new SkinnedMesh(); mesh.skeleton = new Skeleton(bones); root.add(mesh)

  const thumb = ['RightHandThumb1', 'RightHandThumb2', 'RightHandThumb3'].map(n => bones.find(b => b.name === n))
  const palm = new Vector3(0, 1, 0)   // this rig's palm, per the finger rest bend
  const segAngles = () => thumb.slice(0, -1).map((b, i) => {
    const a = b.getWorldPosition(new Vector3())
    const c = thumb[i + 1].getWorldPosition(new Vector3())
    return c.sub(a).normalize().angleTo(palm)
  })

  const segDirs = () => thumb.slice(0, -1).map((b, i) => {
    const a = b.getWorldPosition(new Vector3())
    return thumb[i + 1].getWorldPosition(new Vector3()).sub(a).normalize()
  })
  const innerAngle = dirs => dirs[0].angleTo(dirs[1])

  const before = segAngles()
  const bendBefore = innerAngle(segDirs())
  const posed = withHandPose(new AnimationClip('t', 1, []), {
    targetScene: root, targetSkinnedMesh: mesh,
    mapping: { RightHand: 'RightHand' },
    curl: { right: 0, rightThumb: 1 },
  })
  for (const track of posed.tracks) {
    const name = /\.bones\[(.+?)\]/.exec(track.name)[1]
    bones.find(b => b.name === name).quaternion.set(...track.values.slice(0, 4))
  }
  root.updateMatrixWorld(true)
  const after = segAngles()
  const bendAfter = innerAngle(segDirs())

  const folded = after.every((angle, i) => angle < before[i] - 0.05)
  const deepened = bendAfter > bendBefore + 0.05
  const ok = folded && deepened
  if (!ok) failures += 1
  console.log(
    `${'kinked thumb follows rig bend'.padEnd(28)} `
    + `to-palm ${before.map(v => (v * 180 / Math.PI).toFixed(0)).join('/')} -> `
    + `${after.map(v => (v * 180 / Math.PI).toFixed(0)).join('/')}deg, `
    + `bend ${(bendBefore * 180 / Math.PI).toFixed(0)} -> ${(bendAfter * 180 / Math.PI).toFixed(0)}deg  `
    + `${ok ? 'ok' : (folded ? '*** BEND DID NOT DEEPEN ***' : '*** A SEGMENT SPLAYED ***')}`,
  )
}

// --- oriented rig: the convention path ---------------------------------------
// Every rig above leaves its bones at identity rotations, which is NOT how real
// rigs are built: Mixamo and friends orient each digit bone so its local frame
// follows its own direction, and the same local axis is the bend axis on every
// digit — thumb included. That convention is what handPose reads.
//
// Here each bone is given a real orientation, and the thumb is rolled about its
// own length so no geometric guess from world-space directions would find its
// bend plane. Only transferring the fingers' LOCAL axis gets it right.
{
  const root = new Object3D()
  const hand = new Bone(); hand.name = 'RightHand'; root.add(hand)
  const bones = [hand]

  // Local +Z is the bend axis for every digit; bones point along their local +X.
  const digit = (name, base, roll) => {
    let parent = hand
    for (let i = 0; i < 3; i += 1) {
      const bone = new Bone()
      bone.name = `RightHand${name}${i + 1}`
      bone.position.copy(i === 0 ? base : new Vector3(2, 0, 0))
      // Roll about the bone's own length: changes the local frame, not the shape.
      if (i === 0 && roll) bone.rotateOnAxis(new Vector3(1, 0, 0), roll)
      if (i > 0) bone.rotateOnAxis(new Vector3(0, 0, 1), 0.1)   // slight rest bend
      parent.add(bone); bones.push(bone); parent = bone
    }
  }
  ;['Index', 'Middle', 'Ring', 'Pinky'].forEach((n, f) => digit(n, new Vector3(2, 0, f * 1.2), 0))
  // The thumb sits low and is rolled 90deg, as a real thumb's frame is.
  digit('Thumb', new Vector3(1, -1.5, -1), Math.PI / 2)

  root.updateMatrixWorld(true)
  const mesh = new SkinnedMesh(); mesh.skeleton = new Skeleton(bones); root.add(mesh)

  const tip = bones.find(b => b.name === 'RightHandThumb3')
  const fingerTip = bones.find(b => b.name === 'RightHandMiddle3')
  const before = tip.getWorldPosition(new Vector3())
  const fingerBefore = fingerTip.getWorldPosition(new Vector3())

  const posed = withHandPose(new AnimationClip('t', 1, []), {
    targetScene: root, targetSkinnedMesh: mesh,
    mapping: { RightHand: 'RightHand' },
    curl: { right: 1, rightThumb: 1 },
  })
  for (const track of posed.tracks) {
    const name = /\.bones\[(.+?)\]/.exec(track.name)[1]
    bones.find(b => b.name === name).quaternion.set(...track.values.slice(0, 4))
  }
  root.updateMatrixWorld(true)

  // The fingers define where the palm is; the thumb must travel the same way.
  const palmWay = fingerTip.getWorldPosition(new Vector3()).sub(fingerBefore).normalize()
  const thumbWay = tip.getWorldPosition(new Vector3()).sub(before)
  const agreement = thumbWay.lengthSq() > 1e-6 ? thumbWay.clone().normalize().dot(palmWay) : 0
  const ok = thumbWay.length() > 0.3 && agreement > 0
  if (!ok) failures += 1
  console.log(
    `${'oriented rig, thumb convention'.padEnd(28)} `
    + `thumb moved ${thumbWay.length().toFixed(2)}, agreement with fingers ${agreement.toFixed(2)}  `
    + `${ok ? 'ok' : '*** THUMB WENT ITS OWN WAY ***'}`,
  )
}

process.exit(failures ? 1 : 0)
