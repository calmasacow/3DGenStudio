// Saved-motion picker for the Auto Rig → Kimodo tab.
//
// The library used to be an inline list in the panel, which stopped working the
// moment it held more than a handful: the panel is a narrow column that already
// carries the prompt form, the mapping step, the hand-curl sliders and the clip
// gallery, so a growing list pushed everything else off-screen. A popup gives
// the list the whole window, room for the prompt text that actually identifies a
// motion, and somewhere sensible to put search and bulk actions.
//
// Selection is the primary interaction: check several, then apply or delete them
// in one go. The per-row play button is kept for the common case of applying one,
// which used to be a single click and should stay one.
import { useEffect, useMemo, useRef, useState } from 'react'

// Rows render eagerly. A few thousand is fine for a plain list, and the search
// box narrows anything larger long before scrolling becomes the problem —
// virtualization would cost more than it buys here.
export default function MotionLibraryModal({
  motions = [],
  loading = false,
  error = null,
  busy = false,
  busyId = null,
  progress = null,
  applyDisabled = false,
  applyDisabledReason = '',
  onApply,
  onDelete,
  onClose,
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const searchRef = useRef(null)

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // The search box is why this popup exists, so put the caret in it.
  useEffect(() => { searchRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return motions
    return motions.filter(m =>
      (m.name || '').toLowerCase().includes(q) || (m.prompt || '').toLowerCase().includes(q))
  }, [motions, search])

  // Selection survives filtering — checking something, refining the search and
  // checking something else has to accumulate, or multi-select is useless on a
  // list too long to see at once. So the count is over everything selected, not
  // only what is currently visible.
  const selectedMotions = useMemo(
    () => motions.filter(m => selected.has(m.id)),
    [motions, selected],
  )
  const visibleSelectedCount = filtered.filter(m => selected.has(m.id)).length
  const allVisibleSelected = filtered.length > 0 && visibleSelectedCount === filtered.length

  const toggle = id => {
    setConfirmDelete(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAllVisible = () => {
    setConfirmDelete(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (allVisibleSelected) filtered.forEach(m => next.delete(m.id))
      else filtered.forEach(m => next.add(m.id))
      return next
    })
  }

  const applySelected = () => {
    if (!selectedMotions.length) return
    onApply?.(selectedMotions)
  }

  const deleteSelected = async () => {
    if (!selectedMotions.length) return
    if (!confirmDelete) { setConfirmDelete(true); return }
    setConfirmDelete(false)
    const ids = new Set(selectedMotions.map(m => m.id))
    await onDelete?.(selectedMotions)
    setSelected(prev => new Set([...prev].filter(id => !ids.has(id))))
  }

  return (
    <div className="mesh-editor-bonemap__overlay" onClick={onClose}>
      <div className="mesh-editor-motionpick" onClick={e => e.stopPropagation()}>
        <div className="mesh-editor-bonemap__header">
          <div>
            <h2 className="mesh-editor-bonemap__title">Saved motions</h2>
            <p className="mesh-editor-bonemap__subtitle">
              Every motion you have generated, from any project. Applying one retargets it onto
              the mesh you have open — no GPU and no regeneration.
            </p>
          </div>
          <button type="button" className="mesh-editor-bonemap__close" onClick={onClose} title="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="mesh-editor-motionpick__toolbar">
          <div className="mesh-editor-anim__search mesh-editor-motionpick__search">
            <span className="material-symbols-outlined">search</span>
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name or prompt"
              aria-label="Search saved motions"
            />
            {search && (
              <button type="button" className="mesh-editor-anim__search-clear" onClick={() => setSearch('')}>
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>

          <button
            type="button"
            className="mesh-editor-btn"
            onClick={toggleAllVisible}
            disabled={!filtered.length || busy}
          >
            <span className="material-symbols-outlined">
              {allVisibleSelected ? 'check_box' : 'select_all'}
            </span>
            <span>{allVisibleSelected ? 'Deselect these' : 'Select these'}</span>
          </button>

          <span className="mesh-editor-panel__hint mesh-editor-motionpick__count">
            {search.trim() ? `${filtered.length} of ${motions.length}` : `${motions.length} saved`}
            {selected.size ? ` · ${selected.size} selected` : ''}
          </span>
        </div>

        {error && (
          <div className="mesh-editor-feedback mesh-editor-feedback--error mesh-editor-motionpick__error">
            <span className="material-symbols-outlined">error</span>
            <span>{error}</span>
          </div>
        )}

        <div className="mesh-editor-motionpick__list">
          {loading && !motions.length ? (
            <div className="mesh-editor-layers-panel__empty">Loading…</div>
          ) : !motions.length ? (
            <div className="mesh-editor-layers-panel__empty">
              Nothing saved yet. Every motion you generate is kept here automatically.
            </div>
          ) : !filtered.length ? (
            <div className="mesh-editor-layers-panel__empty">No motion matches “{search.trim()}”.</div>
          ) : (
            filtered.map(motion => {
              const checked = selected.has(motion.id)
              const rowBusy = busyId === motion.id
              return (
                <div
                  key={motion.id}
                  className={`mesh-editor-motionpick__row ${checked ? 'mesh-editor-motionpick__row--on' : ''}`}
                  onClick={() => toggle(motion.id)}
                  role="checkbox"
                  aria-checked={checked}
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(motion.id) }
                  }}
                >
                  <span className="material-symbols-outlined mesh-editor-motionpick__check">
                    {checked ? 'check_box' : 'check_box_outline_blank'}
                  </span>

                  <span className="mesh-editor-motionpick__text">
                    <span className="mesh-editor-motionpick__name">{motion.name}</span>
                    {/* The prompt is what actually distinguishes two motions once
                        the auto-generated names start repeating. */}
                    {motion.prompt && motion.prompt !== motion.name && (
                      <span className="mesh-editor-motionpick__prompt">{motion.prompt}</span>
                    )}
                  </span>

                  <span className="mesh-editor-motionpick__meta">
                    {motion.duration ? `${motion.duration.toFixed(1)}s` : '—'}
                    {motion.frameCount ? ` · ${motion.frameCount}f` : ''}
                    {motion.inPlace ? ' · in-place' : ''}
                    {motion.createdAt ? ` · ${new Date(motion.createdAt).toLocaleDateString()}` : ''}
                  </span>

                  {/* Applying one motion was a single click before this popup
                      existed; keep it one. Stops the row's own toggle. */}
                  <button
                    type="button"
                    className="mesh-editor-motionpick__play"
                    onClick={e => { e.stopPropagation(); onApply?.([motion]) }}
                    disabled={busy || applyDisabled}
                    title={applyDisabled ? applyDisabledReason : 'Apply this motion to the open mesh'}
                  >
                    <span className="material-symbols-outlined">
                      {rowBusy ? 'progress_activity' : 'play_circle'}
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="mesh-editor-bonemap__footer">
          <span className="mesh-editor-panel__hint">
            {busy && progress
              ? `Applying ${progress.done} of ${progress.total}…`
              : applyDisabled
                ? applyDisabledReason
                : 'Click a row to select it. Applied motions appear in the clip list.'}
          </span>
          <div className="mesh-editor-bonemap__footer-actions">
            <button
              type="button"
              className={`mesh-editor-btn ${confirmDelete ? 'mesh-editor-motionpick__danger' : ''}`}
              onClick={deleteSelected}
              disabled={!selected.size || busy}
              title={confirmDelete
                ? 'Click again to delete permanently'
                : 'Delete the selected motions'}
            >
              <span className="material-symbols-outlined">
                {confirmDelete ? 'delete_forever' : 'delete'}
              </span>
              <span>
                {confirmDelete
                  ? `Delete ${selected.size} permanently?`
                  : `Delete${selected.size ? ` (${selected.size})` : ''}`}
              </span>
            </button>
            <button
              type="button"
              className="mesh-editor-btn mesh-editor-btn--primary"
              onClick={applySelected}
              disabled={!selected.size || busy || applyDisabled}
            >
              <span className="material-symbols-outlined">
                {busy ? 'progress_activity' : 'playlist_add'}
              </span>
              <span>{busy ? 'Applying…' : `Apply${selected.size ? ` (${selected.size})` : ''}`}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
