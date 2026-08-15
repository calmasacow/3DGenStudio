import { useCallback, useState } from 'react'
import Viewer from './Viewer'
import ExportMeshDialog from './ExportMeshDialog'
import './MeshPreviewDialog.css'

export default function MeshPreviewDialog({ asset, titleId = 'mesh-preview-dialog-title', onClose }) {
  const [showNormals, setShowNormals] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [showShadows, setShowShadows] = useState(false)
  const [showAlbedo, setShowAlbedo] = useState(false)
  const [showWireframe, setShowWireframe] = useState(false)
  const [skeletonEnabled, setSkeletonEnabled] = useState(false)
  const [showLightSlider, setShowLightSlider] = useState(false)
  const [lightIntensity, setLightIntensity] = useState(2.2)
  const [showExport, setShowExport] = useState(false)
  // Whether a rig was found is only known once the mesh has loaded, so it is
  // tracked as the url it was found for — switching assets then invalidates it
  // (and the skeleton overlay) without needing a reset effect. The face/vertex
  // counts are keyed the same way.
  const [riggedUrl, setRiggedUrl] = useState(null)
  const [loadedStats, setLoadedStats] = useState(null)

  const handleModelLoaded = useCallback(({ modelUrl, isRigged, stats }) => {
    setRiggedUrl(isRigged ? modelUrl : null)
    setLoadedStats(stats ? { ...stats, modelUrl } : null)
  }, [])

  if (!asset) {
    return null
  }

  const isRigged = Boolean(asset.url) && riggedUrl === asset.url
  const showSkeleton = isRigged && skeletonEnabled
  const stats = loadedStats?.modelUrl === asset.url ? loadedStats : null

  return (
    <div className="mesh-preview-dialog-overlay" role="presentation" onClick={onClose}>
      <div className="mesh-preview-dialog mesh-preview-dialog--viewer" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={event => event.stopPropagation()}>
        <div className="mesh-preview-dialog__header">
          <h2 id={titleId} className="mesh-preview-dialog__title font-headline">{asset.name}</h2>
          <button type="button" className="mesh-preview-dialog__close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="mesh-preview-dialog__body mesh-preview-dialog__body--viewer">
          <div className="mesh-preview-dialog__viewer">
            <div className="mesh-preview-dialog__toolbar nodrag">
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showNormals ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowNormals(current => !current)}
                aria-pressed={showNormals}
                title="Toggle normal material"
              >
                N
              </button>
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showAlbedo ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowAlbedo(current => !current)}
                aria-pressed={showAlbedo}
                title="Toggle albedo (unlit) / PBR"
              >
                A
              </button>
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showWireframe ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowWireframe(current => !current)}
                aria-pressed={showWireframe}
                title="Toggle wireframe"
              >
                W
              </button>
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showGrid ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowGrid(current => !current)}
                aria-pressed={showGrid}
                title="Toggle grid"
              >
                G
              </button>
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showLightSlider ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowLightSlider(current => !current)}
                aria-pressed={showLightSlider}
                title="Adjust light"
              >
                L
              </button>
              <button
                type="button"
                className={`mesh-preview-dialog__tool ${showShadows ? 'mesh-preview-dialog__tool--active' : ''}`}
                onClick={() => setShowShadows(current => !current)}
                aria-pressed={showShadows}
                title="Toggle shadows"
              >
                S
              </button>
              {isRigged && (
                <button
                  type="button"
                  className={`mesh-preview-dialog__tool ${showSkeleton ? 'mesh-preview-dialog__tool--active' : ''}`}
                  onClick={() => setSkeletonEnabled(current => !current)}
                  aria-pressed={showSkeleton}
                  title="Toggle skeleton"
                >
                  R
                </button>
              )}
              {showLightSlider && (
                <div className="mesh-preview-dialog__light-panel">
                  <input
                    type="range"
                    min="0.4"
                    max="4"
                    step="0.1"
                    value={lightIntensity}
                    onChange={event => setLightIntensity(Number(event.target.value))}
                  />
                </div>
              )}
            </div>
            <Viewer
              height="100%"
              modelUrl={asset.url}
              showNormals={showNormals}
              showGrid={showGrid}
              showShadows={showShadows}
              showAlbedo={showAlbedo}
              showWireframe={showWireframe}
              showSkeleton={showSkeleton}
              onModelLoaded={handleModelLoaded}
              lightIntensity={lightIntensity}
              fitMode="center"
            />
            {stats && (
              <div className="mesh-preview-dialog__stats">
                <span><strong>{stats.faceCount.toLocaleString()}</strong> faces</span>
                <span><strong>{stats.vertexCount.toLocaleString()}</strong> verts</span>
              </div>
            )}
          </div>
        </div>
        <div className="mesh-preview-dialog__actions">
          <button type="button" className="mesh-preview-dialog__btn mesh-preview-dialog__btn--secondary" onClick={() => setShowExport(true)}>
            Export
          </button>
          <button type="button" className="mesh-preview-dialog__btn mesh-preview-dialog__btn--secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {showExport && (
        <ExportMeshDialog
          meshUrl={asset.url}
          defaultName={asset.name || 'mesh'}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}
