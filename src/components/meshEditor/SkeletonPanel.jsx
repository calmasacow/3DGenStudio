// Right-hand panel shown in Auto Rig mode when the current mesh is rigged.
// Two tabs: "Skeleton" (a collapsible hierarchy tree of every bone) and
// "Animations".
//
// Bone selection is two-way with the viewport: clicking a bone row selects it
// (which highlights it on the mesh via SkeletonOverlay), and clicking a bone on
// the mesh selects the matching row here and scrolls it into view.
//
// The Skeleton tab doubles as the bone EDITOR: the "Edit" toggle in its header
// turns the tree into an editable one (rename, delete, drop unused bones) and
// arms the translate gizmo in the viewport — this is where an Auto Rig mistake
// gets fixed. Every operation is handed up through the `edit` prop bundle; the
// panel owns no rig state of its own.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ANIMATION_REFERENCES, animationPreviewUrl } from '../../utils/animationLibrary'
import AnimationClipItem from './AnimationClipItem'

const EMPTY_SET = new Set()

// Build a children-index map + root list from the flat `parents` array.
function buildHierarchy(parents) {
  const children = new Map()
  const roots = []
  if (!parents) return { children, roots }
  parents.forEach((parent, index) => {
    if (parent < 0 || parent == null) {
      roots.push(index)
    } else {
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(index)
    }
  })
  return { children, roots }
}

// A bone's share of the mesh's total skin weight, as a display string. This is
// the number that makes deleting safe to judge: 0% means the bone moves nothing.
function influenceLabel(influence, index) {
  if (!influence?.hasSkin) return null
  const weight = influence.weights[index] || 0
  if (!(influence.total > 0) || weight <= 0) return '0%'
  const pct = (weight / influence.total) * 100
  return pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`
}

function BoneNode({ index, depth, names, childMap, selectedBone, onSelectBone, collapsed, forcedOpen, onToggle, rowRefs, edit }) {
  const kids = childMap.get(index) || []
  const hasKids = kids.length > 0
  // A branch stays open if the user hasn't collapsed it, or if it's an ancestor
  // of the selected bone (so a bone picked on the mesh is always revealed).
  const isCollapsed = collapsed.has(index) && !forcedOpen.has(index)
  const isSelected = selectedBone === index

  return (
    <li className="mesh-editor-bone-tree__item">
      <div
        ref={el => { if (el) rowRefs.current.set(index, el); else rowRefs.current.delete(index) }}
        className={`mesh-editor-bone-tree__row ${isSelected ? 'mesh-editor-bone-tree__row--selected' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={() => onSelectBone(index)}
        title={names[index]}
      >
        {hasKids ? (
          <button
            type="button"
            className="mesh-editor-bone-tree__toggle"
            onClick={e => { e.stopPropagation(); onToggle(index) }}
            title={isCollapsed ? 'Expand' : 'Collapse'}
          >
            <span className="material-symbols-outlined">
              {isCollapsed ? 'chevron_right' : 'expand_more'}
            </span>
          </button>
        ) : (
          <span className="mesh-editor-bone-tree__toggle mesh-editor-bone-tree__toggle--leaf" />
        )}
        <span className="material-symbols-outlined mesh-editor-bone-tree__icon">
          {hasKids ? 'account_tree' : 'radio_button_unchecked'}
        </span>
        <span className="mesh-editor-bone-tree__name">{names[index]}</span>
        {edit?.active && (() => {
          const label = influenceLabel(edit.influence, index)
          if (!label) return null
          return (
            <span
              className={`mesh-editor-bone-tree__weight ${label === '0%' ? 'mesh-editor-bone-tree__weight--none' : ''}`}
              title={label === '0%'
                ? 'This bone moves no vertices'
                : `${edit.influence.counts[index]} vertices, ${label} of the mesh's skin weight`}
            >
              {label}
            </span>
          )
        })()}
        {edit?.active && (
          <>
            <button
              type="button"
              className="mesh-editor-bone-tree__action"
              onClick={e => { e.stopPropagation(); edit.onAddChild(index) }}
              title={`Add a child bone under ${names[index]}`}
            >
              <span className="material-symbols-outlined">add</span>
            </button>
            <button
              type="button"
              className="mesh-editor-bone-tree__action mesh-editor-bone-tree__action--danger"
              onClick={e => { e.stopPropagation(); edit.onDelete(index) }}
              title={`Delete ${names[index]} — its weights fold into its parent`}
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </>
        )}
      </div>
      {hasKids && !isCollapsed && (
        <ul className="mesh-editor-bone-tree__children">
          {kids.map(child => (
            <BoneNode
              key={child}
              index={child}
              depth={depth + 1}
              names={names}
              childMap={childMap}
              selectedBone={selectedBone}
              onSelectBone={onSelectBone}
              collapsed={collapsed}
              forcedOpen={forcedOpen}
              onToggle={onToggle}
              rowRefs={rowRefs}
              edit={edit}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

// Editing surface for the selected bone: rename, nudge along an axis, delete.
// The numeric fields are the precise counterpart to the viewport gizmo — dragging
// is for finding the spot, typing is for matching the other side of the body.
function BoneEditCard({ index, name, position, influence, canTakeWeights, edit }) {
  const [draftName, setDraftName] = useState(name)
  const [draftAxes, setDraftAxes] = useState(null)
  const [x, y, z] = position

  // Adopt whatever the rig now says whenever it changes underneath (selection,
  // gizmo drag, undo) — except for the field being typed in.
  useEffect(() => { setDraftName(name) }, [name])
  useEffect(() => { setDraftAxes(null) }, [index, x, y, z])

  const commitName = () => {
    if (draftName.trim() && draftName !== name) edit.onRename(index, draftName)
    else setDraftName(name)
  }

  const commitAxis = (axis, raw) => {
    const value = Number.parseFloat(raw)
    setDraftAxes(null)
    if (!Number.isFinite(value) || value === position[axis]) return
    const next = [...position]
    next[axis] = value
    edit.onMove(index, next)
  }

  const label = influenceLabel(influence, index)

  return (
    <div className="mesh-editor-bone-edit__card">
      <label className="mesh-editor-bone-edit__row">
        <span className="mesh-editor-panel__hint">Name</span>
        <input
          className="mesh-editor-panel__input"
          value={draftName}
          onChange={e => setDraftName(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') { setDraftName(name); e.currentTarget.blur() }
          }}
        />
      </label>

      <div className="mesh-editor-bone-edit__axes">
        {['X', 'Y', 'Z'].map((axisName, axis) => (
          <label key={axisName} className="mesh-editor-bone-edit__axis">
            <span className="mesh-editor-panel__hint">{axisName}</span>
            <input
              className="mesh-editor-panel__input"
              type="number"
              step="0.01"
              value={draftAxes?.[axis] ?? position[axis].toFixed(4)}
              onChange={e => {
                const next = draftAxes ? [...draftAxes] : position.map(v => v.toFixed(4))
                next[axis] = e.target.value
                setDraftAxes(next)
              }}
              onBlur={e => commitAxis(axis, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            />
          </label>
        ))}
      </div>

      <span className="mesh-editor-panel__hint">
        {label
          ? `${influence.counts[index]} vertices · ${label} of skin weight`
          : 'No skin weights on this mesh'}
      </span>

      {/* A bone that moves nothing is either an attachment point or a joint that
          still needs its share of the surface — say which, and offer the fix. */}
      {label === '0%' && canTakeWeights && (
        <button
          type="button"
          className="mesh-editor-bone-edit__capture"
          onClick={() => edit.onTakeWeights(index)}
          title="Give this bone the parent's vertices that lie past it, blended across the joint"
        >
          <span className="material-symbols-outlined">colorize</span>
          <span>Take weights from parent</span>
        </button>
      )}

      <div className="mesh-editor-bone-edit__foot">
        <button
          type="button"
          className="mesh-editor-bone-edit__action-btn"
          onClick={() => edit.onAddChild(index)}
          title="Add a child bone under this one, then drag the gizmo to place it"
        >
          <span className="material-symbols-outlined">add</span>
          <span>Add child</span>
        </button>
        <button
          type="button"
          className="mesh-editor-bone-edit__action-btn mesh-editor-bone-edit__action-btn--danger"
          onClick={() => edit.onDelete(index)}
          title="Delete this bone — its weights fold into its parent and its children reattach there"
        >
          <span className="material-symbols-outlined">delete</span>
          <span>Delete bone</span>
        </button>
      </div>
    </div>
  )
}

export default function SkeletonPanel({ skeleton, selectedBone, onSelectBone, animation, edit }) {
  const [tab, setTab] = useState('skeleton')
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [animSearch, setAnimSearch] = useState('')
  const rowRefs = useRef(new Map())

  // Animations tab: filter clips by name and track which are ticked for saving.
  const allClips = useMemo(() => animation?.clips || [], [animation?.clips])
  const checkedSet = animation?.checkedAnimations || EMPTY_SET
  const checkedCount = checkedSet.size
  const filteredClips = useMemo(() => {
    const q = animSearch.trim().toLowerCase()
    if (!q) return allClips
    return allClips.filter(c => c.name.toLowerCase().includes(q))
  }, [allClips, animSearch])

  const names = skeleton?.names || []
  const { children, roots } = useMemo(() => buildHierarchy(skeleton?.parents), [skeleton])

  const toggle = index => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  // Ancestors of the selected bone are force-expanded during render so a bone
  // picked on the mesh is always revealed without mutating the collapse state.
  const forcedOpen = useMemo(() => {
    const open = new Set()
    if (selectedBone == null || !skeleton?.parents) return open
    let p = skeleton.parents[selectedBone]
    while (p != null && p >= 0) {
      open.add(p)
      p = skeleton.parents[p]
    }
    return open
  }, [selectedBone, skeleton])

  // Scroll the selected bone's row into view when the selection changes.
  useEffect(() => {
    if (selectedBone == null) return
    rowRefs.current.get(selectedBone)?.scrollIntoView({ block: 'nearest' })
  }, [selectedBone])

  const boneCount = skeleton?.jointCount ?? names.length

  return (
    <aside className="mesh-editor-layers-panel mesh-editor-skeleton-panel">
      <div className="mesh-editor-skeleton-panel__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'skeleton'}
          className={`mesh-editor-skeleton-panel__tab ${tab === 'skeleton' ? 'mesh-editor-skeleton-panel__tab--active' : ''}`}
          onClick={() => setTab('skeleton')}
        >
          <span className="material-symbols-outlined">accessibility_new</span>
          <span>Skeleton</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'animations'}
          className={`mesh-editor-skeleton-panel__tab ${tab === 'animations' ? 'mesh-editor-skeleton-panel__tab--active' : ''}`}
          onClick={() => setTab('animations')}
        >
          <span className="material-symbols-outlined">animation</span>
          <span>Animations</span>
        </button>
      </div>

      {tab === 'skeleton' ? (
        <div className="mesh-editor-skeleton-panel__body">
          <div className="mesh-editor-layers-panel__header">
            <span className="mesh-editor-layers-panel__title">Bones</span>
            <span className="mesh-editor-panel__hint">{boneCount}</span>
            {edit?.available && (
              <button
                type="button"
                className={`mesh-editor-bone-edit__toggle ${edit.active ? 'mesh-editor-bone-edit__toggle--on' : ''}`}
                onClick={edit.onToggle}
                aria-pressed={!!edit.active}
                title={edit.active
                  ? 'Leave bone editing'
                  : 'Move, rename and delete bones to fix what Auto Rig got wrong'}
              >
                <span className="material-symbols-outlined">{edit.active ? 'check' : 'edit'}</span>
                <span>{edit.active ? 'Done' : 'Edit'}</span>
              </button>
            )}
          </div>

          {edit?.active && (
            <div className="mesh-editor-bone-edit">
              <div className="mesh-editor-bone-edit__bar">
                <button
                  type="button"
                  className="mesh-editor-bone-edit__icon-btn"
                  onClick={edit.onUndo}
                  disabled={!edit.canUndo}
                  title="Undo the last bone edit"
                >
                  <span className="material-symbols-outlined">undo</span>
                </button>
                <button
                  type="button"
                  className="mesh-editor-bone-edit__icon-btn"
                  onClick={edit.onRedo}
                  disabled={!edit.canRedo}
                  title="Redo"
                >
                  <span className="material-symbols-outlined">redo</span>
                </button>
                <button
                  type="button"
                  className="mesh-editor-bone-edit__icon-btn mesh-editor-bone-edit__icon-btn--wide"
                  onClick={edit.onRevert}
                  disabled={!edit.dirty}
                  title="Put every bone back where it was when you started editing"
                >
                  <span className="material-symbols-outlined">restart_alt</span>
                  <span>Revert</span>
                </button>
                {edit.dirty && (
                  <span className="mesh-editor-bone-edit__dirty" title="The skeleton has unsaved edits">
                    edited
                  </span>
                )}
              </div>

              <button
                type="button"
                className={`mesh-editor-anim__floor-btn ${edit.moveChildren ? 'mesh-editor-anim__floor-btn--on' : ''}`}
                onClick={edit.onToggleMoveChildren}
                aria-pressed={!!edit.moveChildren}
                title="On: dragging a joint carries the bones below it. Off: only that joint moves, children stay put."
              >
                <span className="material-symbols-outlined">
                  {edit.moveChildren ? 'check_box' : 'check_box_outline_blank'}
                </span>
                <span>Move children with bone</span>
              </button>

              {edit.unusedCount > 0 && (
                <div className="mesh-editor-bone-edit__cleanup">
                  <span className="material-symbols-outlined">auto_delete</span>
                  <span>
                    {edit.unusedCount} bone{edit.unusedCount === 1 ? '' : 's'} move nothing
                  </span>
                  <button
                    type="button"
                    className="mesh-editor-bonemap__mini-btn"
                    onClick={edit.onRemoveUnused}
                    title="Delete every bone whose branch has no skin weight at all"
                  >
                    Remove
                  </button>
                </div>
              )}

              {selectedBone != null && names[selectedBone] ? (
                <BoneEditCard
                  index={selectedBone}
                  name={names[selectedBone]}
                  position={[
                    skeleton.joints[selectedBone * 3],
                    skeleton.joints[selectedBone * 3 + 1],
                    skeleton.joints[selectedBone * 3 + 2],
                  ]}
                  influence={edit.influence}
                  canTakeWeights={!!edit.influence?.hasSkin && skeleton.parents?.[selectedBone] >= 0}
                  edit={edit}
                />
              ) : (
                <span className="mesh-editor-panel__hint">
                  Select a bone — in the list or on the mesh — to move, rename or delete it.
                </span>
              )}
            </div>
          )}

          {roots.length === 0 ? (
            <div className="mesh-editor-layers-panel__empty">No bones in this skeleton.</div>
          ) : (
            <ul className="mesh-editor-bone-tree">
              {roots.map(root => (
                <BoneNode
                  key={root}
                  index={root}
                  depth={0}
                  names={names}
                  childMap={children}
                  selectedBone={selectedBone}
                  onSelectBone={onSelectBone}
                  collapsed={collapsed}
                  forcedOpen={forcedOpen}
                  onToggle={toggle}
                  rowRefs={rowRefs}
                  edit={edit}
                />
              ))}
            </ul>
          )}
          <span className="mesh-editor-panel__hint">
            {edit?.active
              ? 'Drag the gizmo to move the selected joint — the mesh stays put, only the pivot it bends around changes.'
              : 'Click a bone to highlight it on the mesh. Click a bone on the mesh to select it here.'}
          </span>
        </div>
      ) : (
        <div className="mesh-editor-skeleton-panel__body">
          <div className="mesh-editor-anim__controls">
            <label className="mesh-editor-anim__field">
              <span className="mesh-editor-panel__hint">Reference mesh</span>
              <select
                className="mesh-editor-panel__input mesh-editor-panel__select"
                value={animation?.referenceId || ''}
                onChange={e => animation?.onSelectReference(e.target.value)}
                disabled={animation?.loading}
              >
                <option value="" disabled>Select a reference…</option>
                {ANIMATION_REFERENCES.map(ref => (
                  <option key={ref.id} value={ref.id}>{ref.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--primary"
              onClick={animation?.onOpenMapping}
              disabled={!animation?.referenceId || animation?.loading}
              title="Map the reference skeleton's bones to your mesh"
            >
              <span className="material-symbols-outlined">
                {animation?.loading ? 'progress_activity' : (animation?.hasMapping ? 'edit' : 'link')}
              </span>
              <span>{animation?.loading ? 'Loading…' : (animation?.hasMapping ? 'Edit mapping' : 'Map bones')}</span>
            </button>
          </div>

          {animation?.error && (
            <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-anim__error">
              <span className="material-symbols-outlined">error</span>
              <span>{animation.error}</span>
            </div>
          )}

          {!animation?.referenceId ? (
            <div className="mesh-editor-layers-panel__empty">
              Select a reference mesh, then map its bones to animate your mesh.
            </div>
          ) : !animation?.hasMapping ? (
            <div className="mesh-editor-layers-panel__empty">
              Map the reference bones to your mesh to load its animations.
            </div>
          ) : (
            <>
              <button
                type="button"
                className={`mesh-editor-anim__floor-btn ${animation?.alignFloor ? 'mesh-editor-anim__floor-btn--on' : ''}`}
                onClick={animation?.onToggleAlignFloor}
                title="Sit the animated mesh on the floor grid"
                aria-pressed={!!animation?.alignFloor}
              >
                <span className="material-symbols-outlined">
                  {animation?.alignFloor ? 'check_box' : 'check_box_outline_blank'}
                </span>
                <span>Auto-align to floor</span>
              </button>

              {animation?.canAdjustArms && (
                <div className="mesh-editor-anim__arms">
                  <div className="mesh-editor-anim__arms-head">
                    <span className="mesh-editor-panel__hint">Expand / Contract arms</span>
                    <button
                      type="button"
                      className="mesh-editor-anim__arms-reset"
                      onClick={() => animation.onArmExtensionChange(0)}
                      title="Reset arm spread"
                    >
                      <span className="material-symbols-outlined">restart_alt</span>
                    </button>
                  </div>
                  <div className="mesh-editor-anim__arms-row">
                    <input
                      type="range" min="-100" max="100" step="1"
                      value={animation.armExtension}
                      onChange={e => animation.onArmExtensionChange(Number(e.target.value))}
                    />
                    <span className="mesh-editor-anim__arms-val">{animation.armExtension}%</span>
                  </div>
                </div>
              )}

              <div className="mesh-editor-layers-panel__header">
                <span className="mesh-editor-layers-panel__title">Animations</span>
                <span className="mesh-editor-panel__hint">{filteredClips.length}{animSearch.trim() ? ` / ${allClips.length}` : ''}</span>
              </div>

              <div className="mesh-editor-anim__search">
                <span className="material-symbols-outlined">search</span>
                <input
                  type="text"
                  value={animSearch}
                  onChange={e => setAnimSearch(e.target.value)}
                  placeholder="Search animations…"
                  aria-label="Search animations by name"
                />
                {animSearch && (
                  <button
                    type="button"
                    className="mesh-editor-anim__search-clear"
                    onClick={() => setAnimSearch('')}
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </div>

              <div className="mesh-editor-anim__list">
                {filteredClips.length === 0 ? (
                  <div className="mesh-editor-layers-panel__empty">No animations match “{animSearch.trim()}”.</div>
                ) : filteredClips.map(clip => (
                  <AnimationClipItem
                    key={clip.name}
                    name={clip.name}
                    previewUrl={animationPreviewUrl(animation.referenceId, clip.name)}
                    selected={animation.selectedAnimation === clip.name}
                    busy={animation.retargeting === clip.name}
                    checked={checkedSet.has(clip.name)}
                    onSelect={() => animation.onSelectAnimation(clip.name)}
                    onToggleChecked={() => animation.onToggleChecked(clip.name)}
                  />
                ))}
              </div>

              <button
                type="button"
                className="mesh-editor-btn mesh-editor-btn--primary mesh-editor-anim__save"
                onClick={animation?.onSave}
                disabled={checkedCount === 0 || animation?.saving}
                title="Save the mesh with the selected animations embedded as a new version"
              >
                <span className="material-symbols-outlined">
                  {animation?.saving ? 'progress_activity' : 'save'}
                </span>
                <span>
                  {animation?.saving
                    ? 'Saving…'
                    : `Save mesh with ${checkedCount} animation${checkedCount === 1 ? '' : 's'}`}
                </span>
              </button>
              <span className="mesh-editor-panel__hint">
                Click an animation to preview it. Tick the ones to embed, then save the mesh as a new version.
              </span>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
