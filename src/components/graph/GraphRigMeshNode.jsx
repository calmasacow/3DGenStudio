import { memo, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import {
  DEFAULT_INPUT_ID,
  DEFAULT_OUTPUT_ID,
  buildMeshEditorPath,
  getAssetPreviewUrl,
  getConnectorPosition,
  getConnectorTypeMeta
} from '../../utils/graphHelpers'
import { AUTO_RIG_BONE_NAME_OPTIONS } from '../../utils/meshTools'
import LastActionInfo from './LastActionInfo'

// Rig Mesh node: takes a single connected mesh, runs it through the SkinTokens /
// TokenRig rigging service (the same Auto Rig the Mesh Editor uses) and saves the
// rigged GLB as a new VERSION of the connected mesh. Its output connector only
// appears once a rig has been saved, so downstream nodes consume a rigged mesh.
//
// Presentational: the Auto Rig options live in the node's parameter draft and the
// run itself is driven by GraphPage (data.onRunNodeAction).
const GraphRigMeshNode = memo(function GraphRigMeshNode({ data }) {
  const navigate = useNavigate()
  const updateNodeInternals = useUpdateNodeInternals()
  const draft = data.actionDraft
  const isProcessing = data.status === 'processing'
  const isDraftCollapsed = Boolean(data.isDraftCollapsed)
  // The panel stays mounted during a run (locked, not unmounted) so the options
  // the user typed are still there afterwards.
  const fieldsDisabled = isProcessing
  const inputConnectors = useMemo(() => (
    data.inputConnectors || [{ id: DEFAULT_INPUT_ID, type: 'mesh', isConnected: false }]
  ), [data.inputConnectors])
  const inputSource = (data.inputSources || []).find(source => source.type === 'mesh') || null
  const sourceAsset = inputSource?.asset || null
  const outputConnector = data.outputConnector || { id: DEFAULT_OUTPUT_ID, type: 'mesh' }
  const outputMeta = getConnectorTypeMeta('mesh')
  const hasOutputAsset = Boolean(data.asset?.id)
  const previewUrl = getAssetPreviewUrl(data.asset?.thumbnail || null)
  const nodeDisplayName = data.name || data.asset?.name || 'RIG MESH'
  const errorMessage = data.metadata?.error || ''
  const meshEditorPath = data.asset?.id
    ? buildMeshEditorPath({
        asset: data.asset,
        projectId: data.projectId,
        nodeId: data.id,
        returnTo: `/projects/${data.projectId}`
      })
    : ''
  const metaLabel = isProcessing
    ? (Number.isFinite(data.progress) ? `${data.progress}%` : 'Rigging…')
    : sourceAsset
      ? `Input mesh · ${sourceAsset.name || inputSource?.label || 'Mesh'}`
      : 'Connect a mesh input, then run Auto Rig.'

  useEffect(() => {
    updateNodeInternals(String(data.id))
  }, [data.id, inputConnectors, hasOutputAsset, outputConnector.id, updateNodeInternals])

  const setField = (field, value) => data.onDraftFieldChange?.(data.id, field, value)

  const openMeshPreview = () => {
    if (data.asset?.filename) {
      data.onOpenMeshPreview?.(data.asset)
    }
  }

  const renderToggle = (field, label, hint) => (
    <div className="params-card__field">
      <label className="params-card__checkbox-label nodrag">
        <div
          className={`params-card__checkbox ${draft?.[field] ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`}
          onClick={() => !fieldsDisabled && setField(field, !draft?.[field])}
        >
          {draft?.[field] && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
        </div>
        <span>{label}</span>
      </label>
      {hint && <span className="image-card__param-hint">{hint}</span>}
    </div>
  )

  const renderNumber = (field, label, { min, max, step, hint }) => (
    <div className="params-card__field">
      <label className="params-card__label font-label">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className="params-card__input nodrag"
        value={draft?.[field] ?? ''}
        disabled={fieldsDisabled}
        onChange={event => setField(field, event.target.value === '' ? '' : Number(event.target.value))}
      />
      {hint && <span className="image-card__param-hint">{hint}</span>}
    </div>
  )

  return (
    <div className="graph-node graph-node--rigMesh">
      {inputConnectors.map((connector, index) => {
        const connectorMeta = getConnectorTypeMeta(connector.type || 'mesh')

        return (
          <div
            key={connector.id}
            className="graph-node__connector graph-node__connector--input"
            style={getConnectorPosition(index, inputConnectors.length)}
          >
            <Handle
              type="target"
              id={connector.id}
              position={Position.Left}
              className="graph-node__handle graph-node__handle--input"
              style={{ borderColor: connectorMeta.color }}
            />
            <span
              className="graph-node__connector-badge font-label"
              style={{
                color: connectorMeta.color,
                background: connectorMeta.background,
                borderColor: connectorMeta.color
              }}
              title="Mesh to rig"
            >
              {connectorMeta.letter}
            </span>
          </div>
        )
      })}

      <div className={`graph-node__card image-card ${isProcessing ? 'image-card--loading image-card--locked' : ''}`}>
        <div className="image-card__actions">
          <button
            type="button"
            className="image-card__action-btn image-card__delete nodrag"
            onClick={() => data.onDelete?.(data.id)}
            title="Delete node"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
          </button>
        </div>

        <div className="image-card__thumb graph-node__thumb">
          {hasOutputAsset ? (
            <div className="image-card__thumb-item nodrag" style={{ position: 'relative', cursor: 'pointer' }} onClick={openMeshPreview}>
              {previewUrl ? (
                <img src={previewUrl} alt={data.asset?.name || nodeDisplayName} className="image-card__thumb-image" />
              ) : (
                <div className="image-card__thumb-placeholder">
                  <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(172,137,255,0.5)' }}>accessibility_new</span>
                </div>
              )}
              <button
                type="button"
                className="image-card__edit-action-btn nodrag"
                style={{ position: 'absolute', bottom: '8px', right: '8px' }}
                onClick={event => { event.stopPropagation(); openMeshPreview() }}
                title="Open 3D preview"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>play_arrow</span>
                3D
              </button>
            </div>
          ) : (
            <div className="image-card__thumb-placeholder">
              <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(172,137,255,0.2)' }}>accessibility_new</span>
            </div>
          )}

          <div className="image-card__edit-preview-indicator font-label">
            {sourceAsset ? `INPUT • ${sourceAsset.name}` : 'INPUT • MESH'}
          </div>
        </div>

        <div className="image-card__info">
          <div className="image-card__row">
            <input
              type="text"
              className="image-card__name graph-node__name-input nodrag"
              value={nodeDisplayName}
              placeholder="RIG MESH"
              onChange={event => data.onNodeNameChange?.(data.id, event.target.value)}
              onBlur={event => data.onNodeNameCommit?.(data.id, event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
            <div className="image-card__badges">
              {data.metadata?.lastActionParams && (
                <LastActionInfo lastActionParams={data.metadata.lastActionParams} />
              )}
              <span
                className="image-card__source"
                style={{
                  color: outputMeta.color,
                  background: outputMeta.background
                }}
              >
                RIG
              </span>
            </div>
          </div>

          <p className="image-card__meta font-label">{metaLabel}</p>

          {isProcessing && data.progressDetail && (
            <p className="image-card__meta font-label">{data.progressDetail}</p>
          )}

          {isProcessing && Number.isFinite(data.progress) && (
            <div className="image-card__progress graph-node__progress" aria-hidden="true">
              <div
                className="image-card__progress-bar"
                style={{ width: `${Math.max(0, Math.min(100, data.progress || 0))}%` }}
              />
            </div>
          )}

          {!isProcessing && errorMessage && (
            <p className="image-card__meta font-label graph-node__error">{errorMessage}</p>
          )}

          <div className="graph-node__ports-summary font-label">
            <span className="graph-node__port-label">Input · {sourceAsset ? 'Mesh connected' : 'empty'}</span>
            <span className="graph-node__port-label graph-node__port-label--output">
              Output · {hasOutputAsset ? outputMeta.label : 'after rigging'}
            </span>
          </div>

          <div className="image-card__attributes graph-node__actions-panel">
            <div className="image-card__edit-actions">
              <div className="graph-node__primary-actions">
                <button
                  className="image-card__edit-action-btn nodrag"
                  onClick={() => data.onToggleDraftCollapsed?.(data.id)}
                  title={isDraftCollapsed ? 'Show the parameters' : 'Hide the parameters'}
                  aria-expanded={!isDraftCollapsed}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                    {isDraftCollapsed ? 'expand_more' : 'expand_less'}
                  </span>
                  {isDraftCollapsed ? 'Params' : 'Hide'}
                </button>
                {meshEditorPath && (
                  <button className="image-card__edit-action-btn graph-node__edit-action nodrag" onClick={() => navigate(meshEditorPath)}>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>edit_square</span>
                    Edit
                  </button>
                )}
              </div>

              {isProcessing && (
                <div className="graph-node__panel-lock-note font-label">
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>lock</span>
                  Parameters locked while rigging
                </div>
              )}

              {!isDraftCollapsed && draft && (
                <div className={`image-card__edit-panel nodrag${isProcessing ? ' image-card__edit-panel--locked' : ''}`}>
                  <span className="graph-node__panel-title font-label">AUTO RIG</span>

                  <div className="params-card__field">
                    <label className="params-card__label font-label">Name</label>
                    <input
                      type="text"
                      className="params-card__input nodrag"
                      placeholder={sourceAsset ? `${sourceAsset.name} (rigged)` : 'Rigged mesh name'}
                      value={draft.name || ''}
                      disabled={fieldsDisabled}
                      onChange={event => setField('name', event.target.value)}
                    />
                    <span className="image-card__param-hint">Name of the version saved on the input mesh</span>
                  </div>

                  <div className="params-card__field">
                    <label className="params-card__label font-label">Bone names</label>
                    <select
                      className="params-card__select nodrag"
                      value={draft.rename_bones || 'mixamo'}
                      disabled={fieldsDisabled}
                      onChange={event => setField('rename_bones', event.target.value)}
                    >
                      {AUTO_RIG_BONE_NAME_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    <span className="image-card__param-hint">Rename the generated bones to a standard humanoid convention for retargeting</span>
                  </div>

                  {renderToggle('use_transfer', 'Preserve texture & scale', 'Transfer the rig onto the original mesh (keeps its texture and scale). Recommended.')}
                  {renderToggle('use_postprocess', 'Voxel-skin postprocess', 'Clean up skin weights with a voxel pass to reduce bleed across disconnected parts')}
                  {renderToggle('keep_loaded', 'Keep model loaded in memory', 'Keep the rig model in (GPU) memory for fast repeat rigs')}

                  <span className="graph-node__panel-title font-label">GENERATION (ADVANCED)</span>
                  {renderNumber('top_k', 'Top-k', { min: 1, max: 200, step: 1, hint: 'Top-k sampling' })}
                  {renderNumber('top_p', 'Top-p', { min: 0.1, max: 1, step: 0.01, hint: 'Nucleus (top-p) sampling' })}
                  {renderNumber('temperature', 'Temperature', { min: 0.1, max: 2, step: 0.1 })}
                  {renderNumber('repetition_penalty', 'Repetition penalty', { min: 0.5, max: 3, step: 0.1 })}
                  {renderNumber('num_beams', 'Beams', { min: 1, max: 20, step: 1, hint: 'Beam-search width' })}

                  <div className="graph-node__linked-input font-label">
                    {sourceAsset
                      ? `Rigs ${sourceAsset.name} and saves the result as a new version of it`
                      : 'Connect a mesh output to this node to enable Auto Rig'}
                  </div>

                  <button
                    className="gen-btn nodrag"
                    onClick={() => data.onRunNodeAction?.(data.id)}
                    disabled={!sourceAsset || isProcessing}
                  >
                    <span className="material-symbols-outlined">{isProcessing ? 'progress_activity' : 'accessibility_new'}</span>
                    {isProcessing ? 'RIGGING…' : 'RUN AUTO RIG'}
                  </button>

                  <span className="image-card__param-hint">
                    Auto Rig runs on the SkinTokens rigging service (Settings → Rigging). Needs an NVIDIA GPU.
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {hasOutputAsset && (
        <div className="graph-node__connector graph-node__connector--output" style={getConnectorPosition(0, 1)}>
          <span
            className="graph-node__connector-badge font-label"
            style={{
              color: outputMeta.color,
              background: outputMeta.background,
              borderColor: outputMeta.color
            }}
            title={outputMeta.label}
          >
            {outputMeta.letter}
          </span>
          <Handle
            type="source"
            id={outputConnector.id}
            position={Position.Right}
            className="graph-node__handle graph-node__handle--output"
            style={{ borderColor: outputMeta.color }}
          />
        </div>
      )}
    </div>
  )
})

export default GraphRigMeshNode
