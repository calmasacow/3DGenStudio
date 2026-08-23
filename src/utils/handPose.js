// Static hand pose (finger curl) for retargeted clips.
//
// Kimodo cannot animate fingers at all: it denoises the 30-joint SOMA skeleton
// and expands to 77 by filling every knuckle from a single constant relaxed-hand
// pose, so all 44 finger joints are byte-identical in every frame of every clip.
// A punch therefore lands with whatever hand the target rig was modelled with —
// usually open and splayed.
//
// This module closes that gap by baking a CONSTANT finger pose into a clip.
// Nothing here is animation; it is one pose held for the clip's duration, which
// is exactly what the model is missing.
//
// Kept out of animationLibrary.js so it depends on nothing but three — which is
// what lets the curl-direction logic below be tested headlessly in node.
import { AnimationClip, Quaternion, QuaternionKeyframeTrack, Vector3 } from 'three'

// A full fist at curl = 1. The proximal knuckle bends least, which is what keeps
// a closed hand from looking like a claw.
const MAX_FINGER_CURL = (80 * Math.PI) / 180
const PROXIMAL_WEIGHT = 0.55
// A thumb is budgeted by TOTAL fold, not per joint like a finger.
//
// Per-joint was wrong and it is what sent the thumb round the back of the hand: a
// four-bone thumb accumulated 30 + 55 + 55 = 140 deg, well past the ~90 deg a real
// thumb closes through, so it overshot the palm and kept going. Budgeting the
// total keeps the fold bounded no matter how many bones the rig gives the thumb.
const MAX_THUMB_TOTAL = (90 * Math.PI) / 180

// Distribution of that budget from the base outward. The metacarpal carries most
// of it (a thumb closes mainly by swinging across the palm, not by curling like a
// finger), the joints above it progressively less.
const THUMB_DISTRIBUTION = [0.45, 0.35, 0.2]

function thumbJointAngles(jointCount, curl) {
  if (jointCount <= 0) return []
  const weights = Array.from({ length: jointCount }, (_, i) => THUMB_DISTRIBUTION[i]
    ?? THUMB_DISTRIBUTION[THUMB_DISTRIBUTION.length - 1])
  const total = weights.reduce((sum, w) => sum + w, 0) || 1
  return weights.map(w => (w / total) * curl * MAX_THUMB_TOTAL)
}

// Walk a hand's descendants into one chain per finger. Purely structural: no bone
// names are consulted, so it works on rigs that call their fingers anything.
// Chains stop at a branch, and single-bone chains are skipped — those are
// attachment points and end markers, not fingers.
function fingerChains(handBone) {
  const chains = []
  for (const child of handBone.children) {
    if (!child.isBone) continue
    const chain = []
    let node = child
    while (node) {
      chain.push(node)
      const kids = node.children.filter(c => c.isBone)
      node = kids.length === 1 ? kids[0] : null
    }
    if (chain.length >= 2) chains.push(chain)
  }
  return chains
}

// 'left' | 'right' | null, from a bone name.
function sideOf(name) {
  const s = String(name || '').toLowerCase()
  if (/(^|[._-])(l|left)([._-]|\d|$)/.test(s) || s.includes('left')) return 'left'
  if (/(^|[._-])(r|right)([._-]|\d|$)/.test(s) || s.includes('right')) return 'right'
  return null
}

// The target bones the source's hands map to, tagged with which side each is.
//
// The side is read from the SOURCE name first, on purpose. Source rigs are known
// quantities — Kimodo's are LeftHand/RightHand, mesh2motion's are hand_l/hand_r —
// whereas the target is whatever the user's rig happens to call things. The
// target name is only a fallback for a mapping that came from somewhere odd.
function mappedHandBones(targetScene, mapping) {
  const wanted = new Map()
  for (const [target, source] of Object.entries(mapping || {})) {
    const s = String(source).toLowerCase()
    if (!s.includes('hand') || /thumb|index|middle|ring|pinky|finger/.test(s)) continue
    wanted.set(target, sideOf(source) || sideOf(target))
  }
  const bones = []
  targetScene.traverse(o => {
    if (o.isBone && wanted.has(o.name)) bones.push({ bone: o, side: wanted.get(o.name) })
  })
  return bones
}

// Accept a single number (everything), or a flat
// { left, right, leftThumb, rightThumb }, and normalise to per-hand
// { fingers, thumb }. Thumbs are independent of the fingers rather than derived
// from them: how far a thumb should fold depends on the motion (a fist wraps it,
// a sword grip does not) and on the rig, so it is not something to infer.
function normalizeCurl(curl) {
  if (typeof curl === 'number') {
    return { left: { fingers: curl, thumb: curl }, right: { fingers: curl, thumb: curl } }
  }
  const num = v => Number(v) || 0
  return {
    left: { fingers: num(curl?.left), thumb: num(curl?.leftThumb) },
    right: { fingers: num(curl?.right), thumb: num(curl?.rightThumb) },
    // 'auto' | 'x' | 'y' | 'z', plus a manual direction flip. Both apply to the
    // thumb only; the fingers' axis is derived reliably from the knuckles.
    thumbAxis: curl?.thumbAxis || 'auto',
    thumbFlip: !!curl?.thumbFlip,
  }
}

const anyCurl = amount => amount.left.fingers > 0 || amount.left.thumb > 0
  || amount.right.fingers > 0 || amount.right.thumb > 0

const isThumb = chain => /thumb/i.test(chain[0].name)

// World-space direction from a chain's base to its tip.
function chainDirection(chain, out) {
  const base = new Vector3(), tip = new Vector3()
  chain[0].getWorldPosition(base)
  chain[chain.length - 1].getWorldPosition(tip)
  return out.subVectors(tip, base)
}

// The thumb needs its OWN bend axis, recomputed AT EVERY JOINT.
//
// Two separate reasons, both of which showed up on real rigs:
//
//  1. Fingers curl about the line across the knuckles. A thumb points roughly
//     ALONG that line — it sticks out sideways — so rotating it about the same
//     axis barely flexes it and mostly abducts it. At full curl the thumb opened
//     away from an otherwise closed fist.
//  2. A finger is a planar hinge: one axis serves all of its joints. A thumb's
//     joints are NOT coplanar, so reusing a single axis down the chain compounds
//     into a twist — the thumb rotates about its own length instead of folding,
//     which is what it looked like.
//
// So each joint flexes toward the palm from wherever it currently points, using
// its own current segment direction. `palmDir` is where the fingertips travel
// when curling, and rotating a vector v about cross(v, target) sweeps v toward
// target.
// The thumb's bend axis, taken from the RIG'S OWN CONVENTION rather than guessed
// from geometry.
//
// Three geometric guesses were tried on real rigs and all folded the thumb badly:
// reusing the fingers' knuckle axis (a thumb points along it, so it abducted
// instead of flexing), aiming at the palm, and continuing the thumb's rest
// curvature (a relaxed thumb's "bend" is mostly its SPLAY away from the index, so
// continuing it opened the thumb further — the original complaint).
//
// What is reliable is that riggers orient every digit's bones with the same local
// convention. The fingers' world bend axis is known-good, so express it in a
// finger bone's LOCAL frame to recover that convention, then read it back out in
// each thumb bone's frame. No anatomy is assumed; the rig states it.
//
// Recomputed per joint from the bone's CURRENT world rotation, so the chain curls
// as each joint moves, and so a thumb's non-coplanar joints do not compound into
// a twist the way one shared axis does.
function localBendConvention(chains, worldAxis) {
  const finger = chains.find(chain => !isThumb(chain))
  if (!finger) return null
  const inverse = finger[0].getWorldQuaternion(new Quaternion()).invert()
  return worldAxis.clone().applyQuaternion(inverse)
}

// Explicit local axis, when the caller has given up on inference and picked one.
// A rig's digit bones bend about one of their own local axes; which one is a
// convention, and after several failed attempts at deducing it, choosing from
// three options with live feedback beats another heuristic.
const MANUAL_AXES = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
}

function conventionAxis(bone, localAxis, sign) {
  const axis = localAxis.clone().applyQuaternion(bone.getWorldQuaternion(new Quaternion()))
  if (axis.lengthSq() < 1e-12) return null
  return axis.normalize().multiplyScalar(sign)
}

// Fallback for a rig whose bone orientations carry no usable convention (every
// bone at identity, as some simple or procedurally built rigs are): flex each
// joint toward the palm from wherever it currently points.
function jointFlexAxis(chain, index, palmDir) {
  const here = new Vector3(), next = new Vector3()
  // The tip has no segment of its own, so it follows the one leading into it.
  const from = index + 1 < chain.length ? index : index - 1
  if (from < 0) return null
  chain[from].getWorldPosition(here)
  chain[from + 1].getWorldPosition(next)
  const direction = next.sub(here)
  if (direction.lengthSq() < 1e-12) return null
  const axis = direction.normalize().cross(palmDir)
  // Degenerate once the segment points straight into the palm: the axis is then
  // numerically arbitrary, and there is nothing left to fold anyway.
  return axis.lengthSq() < 1e-6 ? null : axis.normalize()
}

// Rotate every joint of every chain about its own axis (world space), parent-first
// so each joint sees its already-rotated parent — which is what makes the segments
// compound into a curl rather than all leaning the same way.
//
// Returns only the bones it actually moved, so callers do not emit constant tracks
// for bones sitting at their rest rotation — with the thumb on its own slider,
// posing just the thumb used to write 15 tracks where 3 would do.
function curlChains(chains, fingerAxis, palmDir, amount, thumbConvention = null, thumbSign = 1) {
  const R = new Quaternion(), parentWorld = new Quaternion(), delta = new Quaternion()
  const touched = []
  for (const chain of chains) {
    const thumb = isThumb(chain) && !!palmDir
    const curl = thumb ? amount.thumb : amount.fingers
    if (!(curl > 0)) continue
    const localAxis = thumb ? thumbConvention : null
    // The tip bone has no children, so rotating it moves nothing; the budget is
    // spread over the joints that actually bend.
    const thumbAngles = thumb ? thumbJointAngles(Math.max(chain.length - 1, 1), curl) : null
    chain.forEach((bone, index) => {
      const axis = thumb
        ? (localAxis ? conventionAxis(bone, localAxis, thumbSign) : jointFlexAxis(chain, index, palmDir))
        : fingerAxis
      if (!axis) return
      const angle = thumb
        ? (thumbAngles[index] ?? 0)
        : curl * MAX_FINGER_CURL * (index === 0 ? PROXIMAL_WEIGHT : 1)
      if (!(Math.abs(angle) > 1e-6) || !bone.parent) return
      R.setFromAxisAngle(axis, angle)
      bone.parent.getWorldQuaternion(parentWorld)
      // localNew = (parentWorld⁻¹ · R · parentWorld) · localCurrent
      delta.copy(parentWorld).invert().multiply(R).multiply(parentWorld)
      bone.quaternion.premultiply(delta).normalize()
      bone.updateMatrixWorld(true)
      touched.push(bone)
    })
  }
  return touched
}

// Which way is "inward"? Not answerable by asking which direction shortens the
// chain — bending it either way pulls the tip in by exactly the same amount
// (measured: 6.2418 both ways on a straight three-bone finger). Two genuine
// asymmetries do carry the answer, tried in order.
function curlSign(chains, axis) {
  // 1. Rest curvature. Character hands are almost always modelled with a slight
  //    natural bend, and that bend goes toward the palm — so continuing it is
  //    continuing the curl. cross(segment1, segment2) is the axis that bend
  //    turns about; agreeing with it means curling the same way.
  const bend = new Vector3()
  const a = new Vector3(), b = new Vector3(), c = new Vector3()
  const s1 = new Vector3(), s2 = new Vector3()
  for (const chain of chains) {
    if (chain.length < 3 || /thumb/i.test(chain[0].name)) continue
    chain[0].getWorldPosition(a)
    chain[1].getWorldPosition(b)
    chain[2].getWorldPosition(c)
    s1.subVectors(b, a)
    s2.subVectors(c, b)
    if (s1.lengthSq() < 1e-12 || s2.lengthSq() < 1e-12) continue
    bend.add(s1.normalize().cross(s2.normalize()))
  }
  const along = bend.dot(axis)
  if (Math.abs(along) > 1e-4) return Math.sign(along)

  // 2. Dead-flat rest pose (some stylised rigs). The thumb sits on the palm
  //    side, so inward is whichever direction carries the fingertips toward it.
  //    This one needs the name, which is why it is the fallback rather than the
  //    primary test.
  const thumb = chains.find(chain => /thumb/i.test(chain[0].name))
  if (!thumb) return 1
  const thumbTip = thumb[thumb.length - 1].getWorldPosition(new Vector3())
  const fingers = chains.filter(chain => chain !== thumb)
  const reach = new Vector3(), mid = new Vector3(), across = new Vector3()
  for (const chain of fingers) {
    chain[0].getWorldPosition(a)
    chain[chain.length - 1].getWorldPosition(b)
    reach.add(b).sub(a)
    mid.add(b)
  }
  if (!fingers.length || reach.lengthSq() < 1e-12) return 1
  mid.divideScalar(fingers.length)
  // Curling about +axis sweeps the tips toward cross(axis, reach); if that points
  // at the thumb, +axis is inward.
  across.crossVectors(axis, reach.normalize())
  return across.dot(thumbTip.sub(mid)) >= 0 ? 1 : -1
}

// Constant finger-pose tracks for one clip. `curl` is 0..1, either a single
// number for everything or { left, right, leftThumb, rightThumb } to pose each
// hand and thumb independently — a punch wants a fist on one side and an open
// guard on the other, and a sword grip wants folded fingers with a free thumb.
//
// Returns [] when there is nothing to add, so callers can concat unconditionally.
// Bones the clip already animates are left alone — that keeps this safe to apply
// to the mesh2motion references, whose clips DO animate fingers.
export function buildHandPoseTracks({ targetScene, targetSkinnedMesh, mapping, curl, duration }) {
  const amount = normalizeCurl(curl)
  if (!anyCurl(amount) || !targetScene || !mapping) return []

  const hands = mappedHandBones(targetScene, mapping)
  if (!hands.length) return []

  // Measure against the rest pose. The local rotations this produces are relative
  // to each bone's parent, so they stay correct once the body is animating — the
  // fingers simply travel with the hand.
  targetSkinnedMesh?.skeleton?.pose()
  targetScene.updateMatrixWorld(true)

  const posed = new Map()
  for (const { bone: hand, side } of hands) {
    // A hand whose side could not be identified follows the larger of the two
    // sides, so it still responds rather than silently ignoring the control.
    const handCurl = side ? amount[side] : {
      fingers: Math.max(amount.left.fingers, amount.right.fingers),
      thumb: Math.max(amount.left.thumb, amount.right.thumb),
    }
    if (!(handCurl.fingers > 0 || handCurl.thumb > 0)) continue

    const chains = fingerChains(hand)
    if (chains.length < 2) continue   // need at least two knuckles to find the axis

    // Fingers curl about the axis running ACROSS the knuckles — no palm-normal
    // maths and no assumption about which way the hand faces.
    //
    // The thumb is excluded and the widest-separated PAIR of bases is used rather
    // than the first and last child. Child order is arbitrary (rigs put the thumb
    // first or last), and including the thumb tilts the line off the knuckles
    // entirely: on a test rig it turned a clean +Z knuckle line into
    // (-1, -1.2, -0.6), which then curled the fingers sideways.
    const knuckles = chains.filter(chain => !/thumb/i.test(chain[0].name))
    const bases = (knuckles.length >= 2 ? knuckles : chains)
      .map(chain => chain[0].getWorldPosition(new Vector3()))
    let widest = -1
    let axis = null
    for (let i = 0; i < bases.length; i += 1) {
      for (let j = i + 1; j < bases.length; j += 1) {
        const d = bases[i].distanceToSquared(bases[j])
        if (d > widest) { widest = d; axis = bases[j].clone().sub(bases[i]) }
      }
    }
    if (!axis || axis.lengthSq() < 1e-12) continue
    axis.normalize()

    // Which sign is inward depends on handedness and on the rig's axis
    // conventions, so it is derived from the hand's own geometry.
    if (curlSign(chains, axis) < 0) axis.negate()

    // Where the fingertips travel when curling — i.e. into the palm. Rotating a
    // vector about `axis` by +θ moves it toward axis × v, and `axis` has just been
    // signed so that is inward, so this is the palm direction without needing a
    // palm normal or knowing which way the hand faces. The thumb aims at it.
    const reach = new Vector3()
    const one = new Vector3()
    for (const chain of chains) {
      if (isThumb(chain)) continue
      reach.add(chainDirection(chain, one))
    }
    let palmDir = null
    if (reach.lengthSq() > 1e-12) {
      palmDir = new Vector3().crossVectors(axis, reach.normalize())
      if (palmDir.lengthSq() < 1e-8) palmDir = null
      else palmDir.normalize()
    }

    const reset = () => { targetSkinnedMesh?.skeleton?.pose(); targetScene.updateMatrixWorld(true) }

    // Which way the convention folds the thumb still depends on how the rigger
    // oriented it, so do not trust it — measure it. Unlike a finger (where both
    // directions shorten the chain identically, so nothing can be measured), a
    // thumb starts off to the side of the palm, so "did the tip move toward the
    // palm" is a real, asymmetric question with a real answer.
    // A manually chosen axis skips inference entirely, including the measured
    // sign check — the flip toggle is the user's to set.
    const manual = MANUAL_AXES[amount.thumbAxis]
    let convention = manual ? manual.clone() : localBendConvention(chains, axis)
    let thumbSign = amount.thumbFlip ? -1 : 1
    const thumb = chains.find(isThumb)
    if (!manual && convention && thumb && palmDir && handCurl.thumb > 0) {
      const tip = thumb[thumb.length - 1]
      const start = tip.getWorldPosition(new Vector3()).dot(palmDir)
      curlChains(chains, axis, palmDir, { fingers: 0, thumb: 0.5 }, convention, 1)
      const moved = tip.getWorldPosition(new Vector3()).dot(palmDir) - start
      reset()

      // A rig whose bones all sit at identity yields a "convention" that is just
      // the knuckle axis again — which a thumb points along, so it barely moves.
      // Rejecting it here is what stops the original bug reappearing whenever the
      // rig has nothing to say. Scale-relative so it holds in cm or metres.
      const reach = chainDirection(thumb, new Vector3()).length()
      if (Math.abs(moved) < reach * 0.05) convention = null
      else if (moved < 0) thumbSign = -1
    }
    if (manual && amount.thumbFlip) {
      // Keep the flip meaningful for the fallback path too.
      thumbSign = -1
    }

    // Thumb geometry and bone orientation vary enough between rigs that synthetic
    // test rigs cannot stand in for a real one — three geometric strategies all
    // passed synthetic tests and still folded a real thumb badly. This dumps
    // everything needed to rebuild a hand exactly: set window.__handPoseDebug =
    // true, move a thumb slider, and copy the object.
    if (typeof window !== 'undefined' && window.__handPoseDebug) {
      const round = v => +v.toFixed(4)
      console.debug('[handPose]', hand.name, {
        chains: chains.map(chain => ({
          thumb: isThumb(chain),
          bones: chain.map(bone => ({
            name: bone.name,
            position: bone.position.toArray().map(round),
            quaternion: bone.quaternion.toArray().map(round),
            world: bone.getWorldPosition(new Vector3()).toArray().map(round),
          })),
        })),
        knuckleAxis: axis.toArray().map(round),
        palmDir: palmDir ? palmDir.toArray().map(round) : null,
        thumbConvention: convention ? convention.toArray().map(round) : null,
        thumbSign,
      })
    }

    for (const bone of curlChains(chains, axis, palmDir, handCurl, convention, thumbSign)) {
      posed.set(bone.name, bone.quaternion.clone())
    }
    reset()
  }

  const tracks = []
  const span = Math.max(duration || 0, 1 / 30)
  const times = new Float32Array([0, span])
  for (const [name, q] of posed) {
    tracks.push(new QuaternionKeyframeTrack(
      `.bones[${name}].quaternion`,
      times,
      new Float32Array([q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]),
    ))
  }
  return tracks
}

// Add a constant hand pose to an already-retargeted clip, leaving any finger the
// clip already animates untouched. Returns a new clip (or the original when the
// pose is a no-op).
export function withHandPose(clip, { targetScene, targetSkinnedMesh, mapping, curl }) {
  if (!clip || !anyCurl(normalizeCurl(curl))) return clip
  const existing = new Set(clip.tracks.map(t => t.name))
  const tracks = buildHandPoseTracks({
    targetScene, targetSkinnedMesh, mapping, curl, duration: clip.duration,
  }).filter(t => !existing.has(t.name))
  if (!tracks.length) return clip
  const posed = new AnimationClip(clip.name, clip.duration, [...clip.tracks, ...tracks])
  posed.userData = { ...(clip.userData || {}) }
  return posed
}
