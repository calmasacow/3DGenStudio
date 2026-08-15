import { useEffect, useState } from 'react'
import FolderBrowserDialog from './FolderBrowserDialog'
import {
  EXPORT_FORMATS,
  browseFolders,
  exportObject3D,
  isGlbUrl,
  loadGlbBlob,
  loadObject3DFromUrl,
  lodFileName,
  mergeCollisionForUnreal,
  sanitizeBaseName,
  writeExportedFiles
} from '../utils/meshExport'
import {
  COLLISION_METHOD_OPTIONS,
  DEFAULT_COLLISION_OPTIONS,
  DEFAULT_INSPECT_OPTIONS,
  convertMesh,
  defaultLodRatios,
  ensureDesktopService,
  generateCollision,
  generateLods,
  inspectMesh
} from '../utils/meshTools'
import './ExportMeshDialog.css'

const LAST_OUTPUT_FOLDER_KEY = 'exportMeshDialog:lastOutputFolder'

// Reusable export popup. Provide either `getObject3D` (an async function that
// returns the in-memory THREE.Object3D to export) or `meshUrl` (a mesh URL the
// dialog loads itself). `defaultName` seeds the output file name.
//
// Engine presets (Blender/Unity/Unreal/FBX) are only offered in `meshUrl` mode:
// they exist to carry the rig + animation clips of saved assets, while
// `getObject3D` callers (the mesh editor) hand over rig-free geometry.
export default function ExportMeshDialog({ getObject3D, meshUrl, defaultName = 'mesh', onClose }) {
  const [format, setFormat] = useState('glb')
  const [fileName, setFileName] = useState(sanitizeBaseName(defaultName))
  const [outputFolder, setOutputFolder] = useState('')
  const [showFolderBrowser, setShowFolderBrowser] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Game-ready extras. All three are opt-in: they cost real time (gltfpack runs
  // once per level, CoACD is seconds, the check uploads the mesh) and most
  // exports do not need them.
  const [lodEnabled, setLodEnabled] = useState(false)
  const [lodLevels, setLodLevels] = useState(4)
  const [collisionEnabled, setCollisionEnabled] = useState(false)
  const [collisionMethod, setCollisionMethod] = useState(DEFAULT_COLLISION_OPTIONS.method)
  const [checking, setChecking] = useState(false)
  const [report, setReport] = useState(null)

  const formats = getObject3D ? EXPORT_FORMATS.filter(entry => entry.kind === 'local') : EXPORT_FORMATS
  const selectedFormat = formats.find(entry => entry.value === format) || formats[0]
  const lodRatios = defaultLodRatios(lodLevels)
  // Unreal is the one target that wants collision *inside* the render mesh file,
  // under its UCX naming convention. Everywhere else it ships as its own file.
  const embedsCollision = collisionEnabled && selectedFormat.preset === 'unreal'

  // Recall the last folder used, but drop it silently if it no longer exists.
  useEffect(() => {
    const saved = localStorage.getItem(LAST_OUTPUT_FOLDER_KEY)
    if (!saved) return
    browseFolders(saved)
      .then(() => setOutputFolder(saved))
      .catch(() => localStorage.removeItem(LAST_OUTPUT_FOLDER_KEY))
  }, [])

  // Source GLB for the preset paths. When the asset is already a .glb, use its
  // original bytes (perfect fidelity — skin weights, clips and textures
  // untouched); otherwise serialize through three.js, which now carries the
  // loaded animations onto the exported GLB.
  const getSourceGlbBlob = async base => {
    if (!getObject3D && meshUrl && isGlbUrl(meshUrl)) {
      const response = await fetch(meshUrl)
      if (!response.ok) {
        throw new Error('Could not fetch the source mesh.')
      }
      return await response.blob()
    }
    const object = getObject3D ? await getObject3D() : await loadObject3DFromUrl(meshUrl)
    if (!object) {
      throw new Error('No mesh is available to export.')
    }
    const files = await exportObject3D(object, { format: 'glb', baseName: base })
    return files[0].blob
  }

  // Run the Game-Ready check against exactly the mesh that is about to be
  // written. Read-only — it never blocks or changes the export, it only tells you
  // what an engine will complain about before you find out in the engine.
  const handleCheck = async () => {
    setChecking(true)
    setError('')
    setReport(null)
    try {
      await ensureDesktopService('meshtools')
      const base = sanitizeBaseName(fileName)
      const glbBlob = await getSourceGlbBlob(base)
      setReport(await inspectMesh(glbBlob, {
        options: DEFAULT_INSPECT_OPTIONS,
        fileName: `${base}.glb`,
      }))
    } catch (err) {
      setError(err.message || 'The Game-Ready check failed.')
    } finally {
      setChecking(false)
    }
  }

  // Turn one source GLB into the file(s) the selected format needs. Used for
  // every artefact that starts life as a GLB blob — the simplified LOD levels and
  // the collision hulls — so they all land in the same format as the main export.
  const filesFromGlb = async (glbBlob, base, onProgress) => {
    if (selectedFormat.value === 'glb') {
      return [{ filename: `${base}.glb`, blob: glbBlob }]
    }
    if (selectedFormat.kind === 'preset') {
      const { blob } = await convertMesh(glbBlob, {
        options: { preset: selectedFormat.preset },
        fileName: `${base}.glb`,
        onProgress,
      })
      return [{ filename: `${base}.${selectedFormat.extension}`, blob }]
    }
    const object = await loadGlbBlob(glbBlob)
    return await exportObject3D(object, { format: selectedFormat.value, baseName: base })
  }

  const handleExport = async () => {
    const folder = outputFolder.trim()
    const base = sanitizeBaseName(fileName)

    if (!folder) {
      setError('Choose an output folder first.')
      return
    }

    setExporting(true)
    setError('')
    setSuccess('')
    setProgress(null)

    try {
      const files = []
      const notes = []
      const needsService = selectedFormat.kind === 'preset' || lodEnabled || collisionEnabled
      // LOD0 keeps the primary file's name unless a chain was requested.
      const primaryBase = lodEnabled ? lodFileName(base, 0) : base

      if (needsService) {
        setProgress({ frac: 0.03, message: 'Starting the Mesh Tools service…' })
        await ensureDesktopService('meshtools')
      }

      // The extras all derive from one source GLB, generated once.
      let sourceGlb = null
      if (lodEnabled || collisionEnabled || selectedFormat.value === 'glb' || selectedFormat.kind === 'preset') {
        setProgress({ frac: 0.06, message: 'Preparing source GLB…' })
        sourceGlb = await getSourceGlbBlob(base)
      }

      // Simplify from the ORIGINAL source, before any collision merge — hulls
      // must not be fed to the simplifier.
      let lods = []
      if (lodEnabled) {
        setProgress({ frac: 0.12, message: `Generating ${lodRatios.length} LOD levels…` })
        lods = await generateLods(sourceGlb, {
          ratios: lodRatios,
          fileName: `${base}.glb`,
          onProgress: evt => setProgress({ frac: 0.12 + 0.2 * (evt.frac ?? 0), message: evt.message }),
        })
      }

      let collisionGlb = null
      if (collisionEnabled) {
        setProgress({ frac: 0.35, message: 'Generating collision hulls…' })
        const { blob, stats } = await generateCollision(sourceGlb, {
          options: { ...DEFAULT_COLLISION_OPTIONS, method: collisionMethod },
          fileName: `${base}.glb`,
          onProgress: evt => setProgress({
            frac: 0.35 + 0.15 * (evt.frac ?? 0),
            message: evt.message || 'Generating collision hulls…',
          }),
        })
        collisionGlb = blob
        const tool = stats?.tool
        if (tool) {
          notes.push(`${tool.parts} collision hull${tool.parts === 1 ? '' : 's'}`)
          if (tool.fallback) notes.push(tool.fallback)
        }
      }

      // ── Primary file (LOD0) ────────────────────────────────────────────────
      setProgress({ frac: 0.55, message: 'Exporting the mesh…' })
      if (embedsCollision) {
        // Unreal: the hulls have to travel inside the render mesh, so the primary
        // file is rebuilt from a merged GLB rather than the untouched source.
        const merged = await mergeCollisionForUnreal(sourceGlb, collisionGlb, primaryBase)
        files.push(...await filesFromGlb(merged.blob, primaryBase, evt => setProgress({
          frac: 0.55 + 0.25 * (evt.frac ?? 0),
          message: evt.message || 'Converting to FBX…',
        })))
        notes.push(`${merged.hullCount} UCX collision node${merged.hullCount === 1 ? '' : 's'} embedded`)
      } else if (selectedFormat.value === 'glb') {
        // Byte-passthrough when the source is a .glb (rig/animations/textures
        // untouched); three.js re-export otherwise.
        files.push({ filename: `${primaryBase}.glb`, blob: sourceGlb })
      } else if (selectedFormat.kind !== 'preset') {
        const object = getObject3D ? await getObject3D() : await loadObject3DFromUrl(meshUrl)
        if (!object) {
          throw new Error('No mesh is available to export.')
        }
        files.push(...await exportObject3D(object, { format: selectedFormat.value, baseName: primaryBase }))
      } else {
        const { blob, stats } = await convertMesh(sourceGlb, {
          options: { preset: selectedFormat.preset },
          fileName: `${primaryBase}.glb`,
          onProgress: evt => setProgress({
            frac: 0.55 + 0.25 * (evt.frac ?? 0),
            message: evt.message || 'Converting to FBX…',
          }),
        })
        files.push({ filename: `${primaryBase}.fbx`, blob })
        const tool = stats?.tool
        if (tool) {
          const clipCount = Array.isArray(tool.clips) ? tool.clips.length : 0
          notes.push(`${tool.bones || 0} bones, ${clipCount} animation clip${clipCount === 1 ? '' : 's'}`)
        }
      }

      // ── Remaining LOD levels ───────────────────────────────────────────────
      const reduced = lods.filter(lod => !lod.passthrough)
      for (let index = 0; index < reduced.length; index += 1) {
        const lod = reduced[index]
        const span = 0.12 / Math.max(1, reduced.length)
        setProgress({
          frac: 0.8 + span * index,
          message: `Exporting LOD${lod.level} (${lod.triangles ? lod.triangles.toLocaleString() : '…'} triangles)…`,
        })
        files.push(...await filesFromGlb(lod.blob, lodFileName(base, lod.level)))
      }
      if (reduced.length) {
        notes.push(`${reduced.length + 1} LOD levels`)
      }
      // Say so when a level could not reach its target. The files are still
      // written and still valid — they are just coarser than requested, and
      // silently shipping an LOD3 that is barely smaller than LOD0 is worse than
      // saying why.
      const seamLimited = lods.filter(lod => lod.seamLimited).length
      if (seamLimited) {
        notes.push(`${seamLimited} level${seamLimited === 1 ? '' : 's'} stopped short of target to protect the UV seams`)
      }

      // ── Standalone collision file ──────────────────────────────────────────
      if (collisionEnabled && !embedsCollision) {
        setProgress({ frac: 0.93, message: 'Exporting collision hulls…' })
        files.push(...await filesFromGlb(collisionGlb, `${base}_collision`))
      }

      setProgress({ frac: 0.97, message: 'Writing files…' })
      const result = await writeExportedFiles(folder, files)
      localStorage.setItem(LAST_OUTPUT_FOLDER_KEY, folder)
      const writtenNames = (result?.written || files.map(file => file.filename)).join(', ')
      const noteText = notes.length ? ` — ${notes.join(', ')}` : ''
      setSuccess(`Exported ${files.length} file${files.length === 1 ? '' : 's'}: ${writtenNames}${noteText}`)
    } catch (err) {
      setError(err.message || 'Failed to export the mesh.')
    } finally {
      setExporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="export-mesh-overlay" role="presentation" onClick={onClose}>
      <div
        className="export-mesh"
        role="dialog"
        aria-modal="true"
        aria-label="Export mesh"
        onClick={event => event.stopPropagation()}
      >
        <div className="export-mesh__header">
          <h3 className="export-mesh__title font-headline">Export mesh</h3>
          <button type="button" className="export-mesh__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="export-mesh__body">
          <label className="export-mesh__field">
            <span className="export-mesh__label">Format</span>
            <select
              className="export-mesh__select"
              value={format}
              onChange={event => { setFormat(event.target.value); setSuccess('') }}
            >
              {formats.map(entry => (
                <option key={entry.value} value={entry.value}>{entry.label}</option>
              ))}
            </select>
          </label>

          <label className="export-mesh__field">
            <span className="export-mesh__label">File name</span>
            <div className="export-mesh__filename-row">
              <input
                className="export-mesh__input"
                value={fileName}
                onChange={event => setFileName(event.target.value)}
                spellCheck={false}
              />
              <span className="export-mesh__ext">.{selectedFormat.extension}</span>
            </div>
          </label>

          <label className="export-mesh__field">
            <span className="export-mesh__label">Output folder</span>
            <div className="export-mesh__folder-row">
              <input
                className="export-mesh__input"
                value={outputFolder}
                onChange={event => setOutputFolder(event.target.value)}
                placeholder="Choose a folder to export to"
                spellCheck={false}
              />
              <button
                type="button"
                className="export-mesh__browse"
                onClick={() => setShowFolderBrowser(true)}
              >
                <span className="material-symbols-outlined">folder_open</span>
                Browse
              </button>
            </div>
          </label>

          {selectedFormat.hint && (
            <p className="export-mesh__hint">{selectedFormat.hint}</p>
          )}

          <div className="export-mesh__extras">
            <label className="export-mesh__check">
              <input
                type="checkbox"
                checked={lodEnabled}
                onChange={event => { setLodEnabled(event.target.checked); setSuccess('') }}
              />
              <span>Generate LOD chain</span>
            </label>
            {lodEnabled && (
              <div className="export-mesh__extra-body">
                <label className="export-mesh__inline-field">
                  <span>Levels</span>
                  <select
                    className="export-mesh__select export-mesh__select--inline"
                    value={String(lodLevels)}
                    onChange={event => setLodLevels(Number(event.target.value))}
                  >
                    {[2, 3, 4, 5, 6].map(n => <option key={n} value={String(n)}>{n}</option>)}
                  </select>
                </label>
                <p className="export-mesh__hint">
                  Writes {lodRatios.map((_, index) => `${sanitizeBaseName(fileName)}_LOD${index}`).join(', ')}
                  {' '}at {lodRatios.map(r => `${Math.round(r * 100)}%`).join(' / ')} of the source triangle count.
                  Each level is simplified from the original, not from the level above it.
                </p>
              </div>
            )}

            <label className="export-mesh__check">
              <input
                type="checkbox"
                checked={collisionEnabled}
                onChange={event => { setCollisionEnabled(event.target.checked); setSuccess('') }}
              />
              <span>Generate collision mesh</span>
            </label>
            {collisionEnabled && (
              <div className="export-mesh__extra-body">
                <label className="export-mesh__inline-field">
                  <span>Method</span>
                  <select
                    className="export-mesh__select export-mesh__select--inline"
                    value={collisionMethod}
                    onChange={event => setCollisionMethod(event.target.value)}
                  >
                    {COLLISION_METHOD_OPTIONS.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <p className="export-mesh__hint">
                  {embedsCollision
                    ? `Hulls are embedded in the FBX as UCX_${sanitizeBaseName(fileName)}_01… nodes, which Unreal picks up automatically on import.`
                    : `Written as a separate ${sanitizeBaseName(fileName)}_collision file. In Unity, add it under a Mesh Collider with Convex enabled.`}
                </p>
              </div>
            )}

            <div className="export-mesh__check-row">
              <button
                type="button"
                className="export-mesh__btn export-mesh__btn--secondary"
                onClick={handleCheck}
                disabled={checking || exporting}
                title="Analyze this mesh against engine-readiness budgets before exporting"
              >
                {checking ? 'Checking…' : 'Run Game-Ready check'}
              </button>
              {report && (
                <span className={`export-mesh__verdict export-mesh__verdict--${
                  report.summary.fail ? 'fail' : report.summary.warn ? 'warn' : 'pass'
                }`}>
                  {report.summary.fail
                    ? `${report.summary.fail} blocking issue${report.summary.fail === 1 ? '' : 's'}`
                    : report.summary.warn
                      ? `${report.summary.warn} warning${report.summary.warn === 1 ? '' : 's'}`
                      : 'Game-ready'}
                </span>
              )}
            </div>

            {report && (
              <ul className="export-mesh__findings">
                {report.checks
                  .filter(check => check.status === 'fail' || check.status === 'warn')
                  .map(check => (
                    <li key={check.id} className={`export-mesh__finding export-mesh__finding--${check.status}`}>
                      <strong>{check.label}:</strong> {check.value}
                      {check.detail ? ` — ${check.detail}` : ''}
                    </li>
                  ))}
                {!report.summary.fail && !report.summary.warn && (
                  <li className="export-mesh__finding export-mesh__finding--pass">
                    Everything passed — nothing to fix before importing.
                  </li>
                )}
              </ul>
            )}
          </div>

          {progress && (
            <div className="export-mesh__progress" role="status">
              <div className="export-mesh__progress-track">
                <div
                  className="export-mesh__progress-bar"
                  style={{ width: `${Math.round(Math.min(1, Math.max(0, progress.frac)) * 100)}%` }}
                />
              </div>
              <span className="export-mesh__progress-message">{progress.message}</span>
            </div>
          )}

          {error && <div className="export-mesh__message export-mesh__message--error">{error}</div>}
          {success && <div className="export-mesh__message export-mesh__message--success">{success}</div>}
        </div>

        <div className="export-mesh__actions">
          <button type="button" className="export-mesh__btn export-mesh__btn--secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="export-mesh__btn export-mesh__btn--primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>

      {showFolderBrowser && (
        <FolderBrowserDialog
          initialPath={outputFolder.trim()}
          onSelect={path => { setOutputFolder(path); setShowFolderBrowser(false) }}
          onClose={() => setShowFolderBrowser(false)}
        />
      )}
    </div>
  )
}
