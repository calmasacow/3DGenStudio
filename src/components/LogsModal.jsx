import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { API_BASE } from '../config'
import './LogsModal.css'

// How often the open panel asks for new bytes. Each poll is a stat + a read of
// only what was appended, so this stays cheap even against a busy ComfyUI log.
const POLL_MS = 1500

const desktopBridge = typeof window !== 'undefined' ? window.genStudioServices : null
const isDesktop = typeof window !== 'undefined' && Boolean(window.genStudioDesktop?.isDesktop)

function formatBytes(bytes) {
  if (!bytes) return 'empty'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function LogsModal({ onClose }) {
  const [sources, setSources] = useState([])
  const [logDir, setLogDir] = useState('')
  const [activeId, setActiveId] = useState('desktop')
  const [text, setText] = useState('')
  // The trailing incomplete line a service is still writing. Replaced (not
  // appended) on every poll, so a half-written entry never gets duplicated.
  const [pending, setPending] = useState('')
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Byte offset to resume from. A ref, not state, so the poll loop always reads
  // the current value without being re-created on every chunk.
  const offsetRef = useRef(null)
  // Bumped whenever the selected log changes; a response tagged with a stale
  // token is dropped instead of being appended to the wrong log.
  const requestTokenRef = useRef(0)
  const scrollRef = useRef(null)

  const activeSource = sources.find((s) => s.id === activeId) || null

  const selectSource = useCallback((id) => {
    requestTokenRef.current += 1
    offsetRef.current = null
    setActiveId(id)
    setText('')
    setPending('')
    setError('')
    setLoading(true)
    setFollow(true)
  }, [])

  // One loop drives both the catalogue (sizes in the sidebar) and the tail of
  // the selected log. setTimeout rather than setInterval so a slow response can
  // never stack up requests.
  useEffect(() => {
    let cancelled = false
    let timer = null

    const tick = async () => {
      const token = requestTokenRef.current
      try {
        const since = offsetRef.current
        const [listRes, sliceRes] = await Promise.all([
          fetch(`${API_BASE}/logs`, { cache: 'no-store' }),
          fetch(
            `${API_BASE}/logs/${activeId}${since === null ? '' : `?since=${since}`}`,
            { cache: 'no-store' },
          ),
        ])
        if (cancelled || token !== requestTokenRef.current) return
        if (!listRes.ok) throw new Error(`Could not list logs (${listRes.status})`)
        if (!sliceRes.ok) throw new Error(`Could not read the log (${sliceRes.status})`)

        const list = await listRes.json()
        const slice = await sliceRes.json()
        if (cancelled || token !== requestTokenRef.current) return

        setSources(list.sources || [])
        setLogDir(list.dir || '')
        // `reset` means the file was truncated or rotated under us — which is
        // exactly what a restart does, since the desktop app clears the logs at
        // startup. Replace rather than append so the view follows the new file.
        setText((prev) => (slice.reset ? slice.text : prev + slice.text))
        setPending(slice.pending || '')
        offsetRef.current = slice.nextOffset
        setError('')
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not read the logs.')
      } finally {
        if (!cancelled) {
          setLoading(false)
          timer = setTimeout(tick, POLL_MS)
        }
      }
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeId])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const body = useMemo(() => {
    const combined = pending ? `${text}${pending}` : text
    if (!filter.trim()) return combined
    const needle = filter.trim().toLowerCase()
    return combined
      .split('\n')
      .filter((line) => line.toLowerCase().includes(needle))
      .join('\n')
  }, [text, pending, filter])

  // Stick to the bottom while following. Runs after the new body is painted, so
  // scrollHeight already accounts for it.
  useEffect(() => {
    if (!follow || !scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [body, follow])

  // Any manual scroll away from the bottom drops out of follow mode; scrolling
  // back to the bottom re-arms it. Same behaviour as a terminal pager.
  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setFollow(atBottom)
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(body)
    } catch {
      setError('Could not copy to the clipboard.')
    }
  }

  const handleDownload = () => {
    const blob = new Blob([body], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = activeSource?.file || `${activeId}.log`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleOpenFolder = async () => {
    const result = await desktopBridge?.openLogsFolder?.()
    if (result && !result.ok) setError(result.error || 'Could not open the log folder.')
  }

  const isEmpty = !loading && body.length === 0

  return createPortal(
    <div className="logs-overlay" onMouseDown={onClose}>
      <div
        className="logs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="logs-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="logs-header">
          <div className="logs-title-group">
            <span className="material-symbols-outlined">terminal</span>
            <div>
              <h2 className="logs-title" id="logs-modal-title">Logs</h2>
              <p className="logs-subtitle">
                {logDir ? `Current session — ${logDir}` : 'Current session'}
              </p>
            </div>
          </div>
          <button type="button" className="logs-close" onClick={onClose} aria-label="Close logs">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="logs-body">
          <nav className="logs-sources" aria-label="Log sources">
            {sources.map((source) => (
              <button
                type="button"
                key={source.id}
                className={`logs-source ${source.id === activeId ? 'logs-source--active' : ''}`}
                onClick={() => selectSource(source.id)}
                title={source.description}
              >
                <span className={`logs-source-dot ${source.size > 0 ? 'logs-source-dot--live' : ''}`} />
                <span className="logs-source-text">
                  <span className="logs-source-label">{source.label}</span>
                  <span className="logs-source-meta">{formatBytes(source.size)}</span>
                </span>
              </button>
            ))}
          </nav>

          <section className="logs-view">
            <div className="logs-toolbar">
              <div className="logs-filter">
                <span className="material-symbols-outlined">search</span>
                <input
                  type="text"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter lines"
                  aria-label="Filter log lines"
                />
                {filter && (
                  <button type="button" onClick={() => setFilter('')} title="Clear filter">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                )}
              </div>
              <button
                type="button"
                className={`logs-tool-btn ${follow ? 'logs-tool-btn--on' : ''}`}
                onClick={() => setFollow((on) => !on)}
                title={follow ? 'Following new output' : 'Jump to the end and follow'}
              >
                <span className="material-symbols-outlined">vertical_align_bottom</span>
                Follow
              </button>
              <button type="button" className="logs-tool-btn" onClick={handleCopy} title="Copy what is shown">
                <span className="material-symbols-outlined">content_copy</span>
                Copy
              </button>
              <button type="button" className="logs-tool-btn" onClick={handleDownload} title="Save what is shown to a file">
                <span className="material-symbols-outlined">download</span>
                Save
              </button>
              {isDesktop && (
                <button type="button" className="logs-tool-btn" onClick={handleOpenFolder} title="Open the log folder">
                  <span className="material-symbols-outlined">folder_open</span>
                  Folder
                </button>
              )}
            </div>

            {error && (
              <p className="logs-error">
                <span className="material-symbols-outlined">error</span>
                {error}
              </p>
            )}

            <pre className="logs-output" ref={scrollRef} onScroll={handleScroll} tabIndex={0}>
              {loading && !body ? 'Loading…' : body}
              {isEmpty && (
                !isDesktop
                  ? 'These logs are recorded by the 3D Gen Studio desktop app. Running from a browser, each service logs to the terminal that started it.'
                  : activeSource && !activeSource.exists
                    ? `Nothing logged yet this session.\n\n${activeSource.description}`
                    : filter
                      ? 'No lines match the filter.'
                      : 'This log is empty.'
              )}
            </pre>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
