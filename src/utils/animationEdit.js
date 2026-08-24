// Frame-level editing of a RETARGETED animation clip (Auto Rig → Animation edit
// dock). Pure functions over a THREE.AnimationClip: nothing here touches React,
// the mixer or the scene.
//
// What is being edited, and why it works the way it does:
//
// `retargetAnimationClip` bakes on a UNIFORM GRID — one key on every frame at
// ~30 fps (`frameCount = round(duration * fps) + 1`), one QuaternionKeyframeTrack
// per mapped bone plus one hip `.position` track, all sharing the same `times`
// array. So a frame IS an index: frame f of a quaternion track lives at
// `values[f * 4 … f * 4 + 3]`. No key search, no resampling.
//
// That density is also why a single-frame edit is NOT what you usually want: its
// neighbours are 33 ms away, so a lone edited frame reads as a pop rather than a
// correction. Hence `scope`: an edit is a DELTA (target minus what the frame
// currently holds) applied to the frame and, with a cosine falloff, to its
// neighbours — or to the whole clip when the pose is wrong throughout. Editing one
// frame in isolation stays available for deliberate spikes.
//
// Rotations are edited as Euler degrees because that is the only readable form of
// a quaternion, and written back as a delta quaternion premultiplied onto each
// affected key — never as re-composed Euler per frame, which would throw away the
// bake's continuity and flip axes wherever the Euler decomposition jumps.
import { Euler, Quaternion } from 'three'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI

export const EDIT_SCOPES = [
  { value: 'falloff', label: 'Falloff' },
  { value: 'frame', label: 'This frame' },
  { value: 'clip', label: 'Whole clip' },
]
export const DEFAULT_EDIT_SCOPE = 'falloff'
// Below these, an edit is discarded as "no change". Not arbitrary: the fields show
// a rounded number, so committing the value on screen asks for a delta of up to a
// few 1e-4 units — and a quaternion read out of a float32 track, decomposed to
// Euler and recomposed, differs from itself by ~0.016°. Both are invisible, and
// recording them would mark a clip hand-edited (and so no longer rebakeable) for
// pressing Enter.
const MIN_ROTATION_DELTA_DEG = 0.02
const MIN_POSITION_DELTA = 1e-6
export const DEFAULT_EDIT_SPAN = 8      // frames either side, ~0.27s at 30fps
export const MAX_EDIT_SPAN = 120

// Scratch objects: these functions run per keystroke over every frame of a track.
const _q = new Quaternion()
const _qTarget = new Quaternion()
const _qDelta = new Quaternion()
const _qStep = new Quaternion()
const _euler = new Euler()

// ".bones[Hips].position" / "Hips.quaternion" → { boneName, kind }.
// Playback tracks use the ".bones[...]" form (the mixer resolves them against the
// SkinnedMesh); the plain form is what BVH/glTF clips carry.
export function parseTrackName(name) {
  const m = /^(?:\.bones\[(.+?)\]|(.+?))\.(quaternion|position)$/.exec(name || '')
  if (!m) return null
  return { boneName: m[1] ?? m[2], kind: m[3] }
}

// Describe a clip for the edit dock: the frame grid, plus one row per animated
// bone carrying whichever of its tracks exist.
//
// `editable` is per bone and means "this bone's tracks sit on the clip's frame
// grid". Generated tracks do not: `withHandPose` appends 2-key constant tracks for
// the finger bones, and those are rebuilt from the Hand-curl sliders on every
// bake, so an edit to one would be silently discarded. They are listed (so their
// absence is not a mystery) and locked.
export function describeClip(clip) {
  if (!clip?.tracks?.length) return null

  // The grid is the longest track's timeline — every retargeted track shares it.
  let grid = null
  for (const track of clip.tracks) {
    if (!grid || track.times.length > grid.length) grid = track.times
  }
  const frameCount = grid ? grid.length : 0
  if (frameCount < 2) return null
  const duration = clip.duration || grid[frameCount - 1] || 0
  const fps = duration > 0 ? (frameCount - 1) / duration : 30

  const byBone = new Map()
  for (const track of clip.tracks) {
    const parsed = parseTrackName(track.name)
    if (!parsed) continue
    let row = byBone.get(parsed.boneName)
    if (!row) {
      // Track order out of the retargeter is a parent-first traversal of the
      // target skeleton, so insertion order is already hierarchy order.
      row = { boneName: parsed.boneName, rotation: null, position: null, editable: true, keyCount: 0 }
      byBone.set(parsed.boneName, row)
    }
    if (parsed.kind === 'quaternion') row.rotation = track.name
    else row.position = track.name
    row.keyCount = Math.max(row.keyCount, track.times.length)
    if (track.times.length !== frameCount) row.editable = false
  }

  return { fps, frameCount, duration, times: grid, bones: [...byBone.values()] }
}

export function frameTime(description, frame) {
  if (!description) return 0
  const clamped = Math.max(0, Math.min(description.frameCount - 1, Math.round(frame) || 0))
  return description.times[clamped] ?? 0
}

function findTrack(clip, trackName) {
  return clip?.tracks?.find(t => t.name === trackName) || null
}

// The three numbers to show for one track at one frame: Euler degrees for a
// rotation, raw units for a position.
export function readFrameValues(clip, trackName, frame) {
  const track = findTrack(clip, trackName)
  if (!track) return null
  const parsed = parseTrackName(trackName)
  if (!parsed) return null
  const f = Math.max(0, Math.min(track.times.length - 1, Math.round(frame) || 0))
  if (parsed.kind === 'quaternion') {
    _q.fromArray(track.values, f * 4)
    _euler.setFromQuaternion(_q, 'XYZ')
    return [_euler.x * RAD2DEG, _euler.y * RAD2DEG, _euler.z * RAD2DEG]
  }
  const o = f * 3
  return [track.values[o], track.values[o + 1], track.values[o + 2]]
}

// Cosine falloff: 1 at the edited frame, 0 at ±span, smooth in between (no
// derivative jump at the seam, unlike a linear ramp).
function editWeight(distance, scope, span) {
  if (scope === 'clip') return 1
  if (scope === 'frame') return distance === 0 ? 1 : 0
  if (distance === 0) return 1
  if (distance >= span) return 0
  return 0.5 * (1 + Math.cos((Math.PI * distance) / span))
}

// Apply an edit and return { before, after } snapshots of the whole track's values
// for the undo stack (a few KB per op — a 4s rotation track is 121 × 4 floats).
// Returns null when there is nothing to do: unknown track, off-grid track, or a
// value that already matches.
export function applyFrameEdit(clip, trackName, frame, nextXYZ, {
  scope = DEFAULT_EDIT_SCOPE, span = DEFAULT_EDIT_SPAN,
} = {}) {
  const track = findTrack(clip, trackName)
  const parsed = parseTrackName(trackName)
  if (!track || !parsed) return null
  const stride = parsed.kind === 'quaternion' ? 4 : 3
  const n = Math.floor(track.values.length / stride)
  if (n < 1) return null
  const f = Math.max(0, Math.min(n - 1, Math.round(frame) || 0))
  const reach = Math.max(1, Math.round(span) || 1)

  // null/undefined means "leave this axis alone" — and must be checked BEFORE the
  // Number() cast, since Number(null) is 0, i.e. a silent "drive this axis to zero".
  const target = [0, 1, 2].map(i => {
    const raw = nextXYZ?.[i]
    if (raw === null || raw === undefined || raw === '') return null
    const v = Number(raw)
    return Number.isFinite(v) ? v : null
  })
  if (target.every(v => v === null)) return null

  const before = Float32Array.from(track.values)

  if (parsed.kind === 'quaternion') {
    // Delta in the bone's own parent space, so it composes with whatever the bake
    // already does on the neighbouring frames instead of replacing it.
    _q.fromArray(track.values, f * 4)
    const current = new Euler().setFromQuaternion(_q, 'XYZ')
    _euler.set(
      (target[0] ?? current.x * RAD2DEG) * DEG2RAD,
      (target[1] ?? current.y * RAD2DEG) * DEG2RAD,
      (target[2] ?? current.z * RAD2DEG) * DEG2RAD,
      'XYZ',
    )
    _qTarget.setFromEuler(_euler)
    // Normalize before measuring OR applying: `Quaternion.invert()` is a conjugate,
    // so a key that came back from float32 storage a hair off unit length turns into
    // a delta that is a hair off unit SCALE — and its `w` then reads as ~0.026° of
    // rotation that is not there, which would defeat the no-op check below.
    _qDelta.copy(_qTarget).multiply(_q.invert()).normalize()
    const deltaDeg = 2 * Math.acos(Math.min(1, Math.abs(_qDelta.w))) * RAD2DEG
    if (deltaDeg < MIN_ROTATION_DELTA_DEG) return null
    for (let i = 0; i < n; i++) {
      const w = editWeight(Math.abs(i - f), scope, reach)
      if (w <= 0) continue
      _qStep.identity().slerp(_qDelta, w)
      _q.fromArray(track.values, i * 4).premultiply(_qStep).normalize()
      _q.toArray(track.values, i * 4)
    }
  } else {
    const o = f * 3
    const delta = [0, 1, 2].map(a => (target[a] === null ? 0 : target[a] - track.values[o + a]))
    if (delta.every(d => Math.abs(d) < MIN_POSITION_DELTA)) return null
    for (let i = 0; i < n; i++) {
      const w = editWeight(Math.abs(i - f), scope, reach)
      if (w <= 0) continue
      for (let a = 0; a < 3; a++) track.values[i * 3 + a] += delta[a] * w
    }
  }

  return { before, after: Float32Array.from(track.values) }
}

// Put a snapshot back (undo / redo). In place, so the clip object stays the one
// the mixer is already playing.
export function restoreTrackValues(clip, trackName, snapshot) {
  const track = findTrack(clip, trackName)
  if (!track || !snapshot || track.values.length !== snapshot.length) return false
  track.values.set(snapshot)
  return true
}
