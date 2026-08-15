// Optimize / LOD mode left panel. Runs the bundled gltfpack (meshoptimizer)
// binary server-side — either once at a chosen ratio, or as a whole LOD ladder —
// and offers Keep/Revert on the result.
// Presentational: option state + handlers come from MeshEditorPage.
import { RangeField, SelectField, ToggleField } from './MeshToolField'
import MeshToolResult from './MeshToolResult'
import MeshToolProgress from './MeshToolProgress'

export default function OptimizeToolsPanel({
  options,
  setOption,
  currentFaces = 0,
  running,
  result,
  progress,
  onRun,
  onKeepResult,
  onRevertResult,
  disabled,
  // LOD chain
  lodLevels,
  onLodLevelsChange,
  lodRatios = [],
  lodChain = [],
  lodSourceFaces = 0,
  lodGenerating,
  lodProgress,
  onGenerateLods,
  onApplyLod,
}) {
  const o = options
  const fieldsDisabled = disabled || running
  const targetFaces = currentFaces ? Math.max(1, Math.round(currentFaces * o.simplify_ratio)) : null
  // Which level the viewport is currently showing, matched on face count. This
  // is what distinguishes "you applied LOD2" from "you edited the mesh and these
  // numbers are now stale" — both leave currentFaces != lodSourceFaces, but only
  // the second one invalidates the chain.
  const currentLevel = lodChain.reduce((found, lod) => {
    if (found != null) return found
    const faces = lod.passthrough ? lodSourceFaces : lod.triangles
    return faces && faces === currentFaces ? lod.level : null
  }, null)

  // The chain is built from one snapshot of the mesh. Editing after that leaves
  // the numbers describing a mesh that no longer exists, so say so rather than
  // showing figures that quietly stopped being true.
  const chainStale = lodChain.length > 0 && lodSourceFaces > 0 && currentLevel == null

  return (
    <>{/* OPTIMIZE */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Optimize</span>
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={disabled || running}
          title="Simplify the mesh with gltfpack (meshoptimizer)"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'compress'}</span>
          <span>{running ? 'Optimizing…' : 'Run Optimize'}</span>
        </button>

        {running && <MeshToolProgress progress={progress} />}

        {result && (
          <MeshToolResult
            title="Optimization applied"
            rows={result.rows}
            onKeep={onKeepResult}
            onRevert={onRevertResult}
            disabled={running}
          />
        )}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Simplify</span>
        <RangeField label="Simplify ratio" min={0.001} max={1} step={0.001} decimals={3}
          value={o.simplify_ratio} onChange={v => setOption('simplify_ratio', v)} disabled={fieldsDisabled}
          hint="Target triangle count as a fraction of the original (1 = no simplification)" />
        {currentFaces ? (
          <div className="mesh-editor-texture-workflow-meta">
            <span><strong>Current faces:</strong> {currentFaces.toLocaleString()}</span>
            <span><strong>Target faces:</strong> ~{targetFaces.toLocaleString()}</span>
          </div>
        ) : null}

        <ToggleField label="Allow UV seams to break" value={!!o.allow_seam_breaking}
          onChange={v => setOption('allow_seam_breaking', v)} disabled={fieldsDisabled}
          hint="The simplifier cannot collapse edges across UV seams, so a heavily-seamed mesh stops well short of the target. Allowing seams to weld reaches the target but scrambles the texture — only useful when the mesh is untextured or you will re-bake it." />
        {o.allow_seam_breaking && (
          <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
            The texture will be distorted on any mesh that needs it.
          </span>
        )}
      </div>

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">LOD chain</span>

        <SelectField label="Levels" value={String(lodLevels)}
          onChange={value => onLodLevelsChange(Number(value))}
          disabled={fieldsDisabled || lodGenerating}
          options={[2, 3, 4, 5, 6].map(n => ({ value: String(n), label: `${n} levels` }))}
          hint="LOD0 is the mesh as it stands; each level after it roughly halves the triangle count" />

        <div className="mesh-editor-texture-workflow-meta">
          <span><strong>Ratios:</strong> {lodRatios.map(r => `${Math.round(r * 100)}%`).join(' / ')}</span>
        </div>

        <button
          type="button"
          className="mesh-editor-btn"
          onClick={onGenerateLods}
          disabled={disabled || running || lodGenerating}
          title="Build every level and report its real triangle count"
        >
          <span className="material-symbols-outlined">{lodGenerating ? 'progress_activity' : 'stacked_bar_chart'}</span>
          <span>{lodGenerating ? 'Generating…' : 'Generate LOD chain'}</span>
        </button>

        {lodGenerating && <MeshToolProgress progress={lodProgress} />}

        {chainStale && (
          <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
            Built from a {lodSourceFaces.toLocaleString()}-face mesh; the current one has{' '}
            {currentFaces.toLocaleString()}. Regenerate to match.
          </span>
        )}

        {lodChain.length > 0 && (
          <>
            <div className="mesh-editor-lod-table">
              {lodChain.map(lod => (
                <div className="mesh-editor-lod-row" key={lod.level}>
                  <span className="mesh-editor-lod-row__name">LOD{lod.level}</span>
                  <span className="mesh-editor-lod-row__ratio">
                    {/* Show what was actually reached, not what was asked for. */}
                    {lod.achievedRatio != null ? Math.round(lod.achievedRatio * 100) : Math.round(lod.ratio * 100)}%
                  </span>
                  <strong className="mesh-editor-lod-row__count">
                    {lod.seamLimited && (
                      <span className="material-symbols-outlined mesh-editor-lod-row__warn" title="Stopped early to protect the UVs">
                        warning
                      </span>
                    )}
                    {lod.triangles != null ? `${lod.triangles.toLocaleString()} tris` : `${lodSourceFaces.toLocaleString()} tris`}
                  </strong>
                  <button
                    type="button"
                    className="mesh-editor-lod-row__apply"
                    onClick={() => onApplyLod(lod.level)}
                    disabled={disabled || running || lodGenerating || currentLevel === lod.level}
                    title={currentLevel === lod.level
                      ? `LOD${lod.level} is what the viewport is showing`
                      : lod.passthrough
                        ? 'Go back to the mesh the chain was built from (undoable)'
                        : `Replace the mesh with LOD${lod.level} (undoable)`}
                  >
                    {currentLevel === lod.level ? 'current' : lod.passthrough ? 'Restore' : 'Apply'}
                  </button>
                </div>
              ))}
            </div>

            {lodChain.some(lod => lod.seamLimited) && (
              <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
                Marked levels stopped short of their target: the simplifier cannot collapse edges
                across UV seams without welding them, which would scramble the texture. Enable
                “Allow UV seams to break” above to reach the target anyway.
              </span>
            )}
            {lodChain.some(lod => lod.seamsBroken) && (
              <span className="mesh-editor-panel__hint" style={{ color: '#e0a030' }}>
                Some levels welded UV seams to reach their target — check the texture on those.
              </span>
            )}
          </>
        )}

        <span className="mesh-editor-panel__hint">
          Applying a level swaps the mesh here so you can judge it in the viewport; <em>Restore</em> on
          LOD0 brings back the mesh the chain was built from. To write every level to disk as
          <em> name_LOD0…n</em>, use Export → “Generate LOD chain”.
        </span>
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">Optimize runs the bundled gltfpack (meshoptimizer) binary.</span>
        <span className="mesh-editor-panel__hint">The result replaces the mesh; use Keep or Revert to decide.</span>
        <span className="mesh-editor-panel__hint">
          Simplifying a UV-mapped mesh may weld some UV seams — gltfpack cannot reach the target ratio otherwise.
        </span>
      </div>
    </>
  )
}
