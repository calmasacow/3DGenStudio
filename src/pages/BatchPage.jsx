import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import BatchVariablesColumn from '../components/batch/BatchVariablesColumn'
import BatchStageColumn from '../components/batch/BatchStageColumn'
import BatchResultsGrid from '../components/batch/BatchResultsGrid'
import { useProjects } from '../context/ProjectContext'
import { useBatchRun } from '../context/BatchRunContext'
import {
  buildImageEditorPath,
  buildMeshEditorPath,
  filterImageGenerationWorkflows,
  filterImageEditWorkflows,
  filterMeshGenerationWorkflows
} from '../utils/graphHelpers'
import {
  createEmptyBatchConfig,
  createGroup,
  createStage,
  createStageDefaultBindings,
  createStageDefaultInputs,
  createVariable,
  deriveCellsFromAssets,
  normalizeBatchConfig,
  validateBatch
} from '../utils/batchHelpers'
import './BatchPage.css'

const AUTOSAVE_DELAY = 700

// A "Batch" preset project: run one linear chain of ComfyUI workflows once per
// group of parameter values. Each executed cell becomes a normal project Card
// carrying its asset, so results behave like any other generation.
export default function BatchPage({ project }) {
  const navigate = useNavigate()
  const {
    getBatchConfig,
    saveBatchConfig,
    getComfyWorkflows,
    getProjectAssets
  } = useProjects()

  const [config, setConfig] = useState(createEmptyBatchConfig)
  const [workflows, setWorkflows] = useState([])
  const [assets, setAssets] = useState([])
  const [loading, setLoading] = useState(true)
  const [saveStatus, setSaveStatus] = useState('idle')
  const [showSettings, setShowSettings] = useState(false)
  // Collapsed by default: a long problem list used to push the whole workspace
  // below the fold. The count stays visible either way.
  const [problemsOpen, setProblemsOpen] = useState(false)
  // Stages and results compete for vertical space, so only one is shown at a
  // time rather than cropping both.
  const [activeTab, setActiveTab] = useState('stages')

  const saveTimerRef = useRef(null)
  const lastSavedRef = useRef('')
  const hydratedRef = useRef(false)

  // Any workflow can be a stage: the chain mixes image generation, image edit
  // and mesh generation, so the union of the three filtered lists is offered
  // rather than a single category.
  const stageWorkflows = useMemo(() => {
    const byId = new Map()
    for (const workflow of [
      ...filterImageGenerationWorkflows(workflows),
      ...filterImageEditWorkflows(workflows),
      ...filterMeshGenerationWorkflows(workflows)
    ]) {
      byId.set(String(workflow.id), workflow)
    }
    return Array.from(byId.values())
  }, [workflows])

  const workflowsById = useMemo(() => {
    const map = {}
    for (const workflow of stageWorkflows) {
      map[String(workflow.id)] = workflow
    }
    return map
  }, [stageWorkflows])

  const refreshAssets = useCallback(async () => {
    try {
      setAssets(await getProjectAssets(project.id, { includeChildren: true }))
    } catch (err) {
      console.error('Failed to refresh batch results:', err)
    }
  }, [getProjectAssets, project.id])

  // The run lives above the router, so opening a result in an editor and coming
  // back finds the batch still going with its grid intact.
  const { runState, resultsVersion, startBatch, cancelBatch } = useBatchRun(project.id)
  const isRunning = runState.status === 'running' || runState.status === 'cancelling'

  // Re-fetch as each cell settles so thumbnails appear while the batch runs, and
  // once on return from an editor so anything finished while away shows up.
  useEffect(() => {
    if (!loading) {
      refreshAssets()
    }
  }, [resultsVersion, loading, refreshAssets])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      try {
        const [configResponse, workflowList] = await Promise.all([
          getBatchConfig(project.id),
          getComfyWorkflows()
        ])
        if (cancelled) return
        setConfig(normalizeBatchConfig(configResponse?.state))
        setWorkflows(workflowList || [])
        lastSavedRef.current = JSON.stringify(normalizeBatchConfig(configResponse?.state))
        hydratedRef.current = true
        await refreshAssets()
      } catch (err) {
        console.error('Failed to load the batch project:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [getBatchConfig, getComfyWorkflows, project.id, refreshAssets])

  // Debounced autosave of the whole document, diffed so idle renders don't write.
  useEffect(() => {
    if (loading || !hydratedRef.current) {
      return undefined
    }

    const serialized = JSON.stringify(config)
    if (serialized === lastSavedRef.current) {
      return undefined
    }

    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus('saving')
      try {
        await saveBatchConfig(project.id, config)
        lastSavedRef.current = serialized
        setSaveStatus('saved')
      } catch (err) {
        console.error('Failed to save the batch config:', err)
        setSaveStatus('error')
      }
    }, AUTOSAVE_DELAY)

    return () => clearTimeout(saveTimerRef.current)
  }, [config, loading, project.id, saveBatchConfig])

  // --- Config mutation -----------------------------------------------------

  const patchConfig = useCallback((updater) => {
    setConfig(current => updater(normalizeBatchConfig(current)))
  }, [])

  const handleAddVariable = useCallback(() => {
    patchConfig(current => ({ ...current, variables: [...current.variables, createVariable()] }))
  }, [patchConfig])

  const handleUpdateVariable = useCallback((variableId, patch) => {
    patchConfig(current => ({
      ...current,
      variables: current.variables.map(item => (item.id === variableId ? { ...item, ...patch } : item))
    }))
  }, [patchConfig])

  // Dropping a variable also drops its values and unbinds any stage that used
  // it, so the document never references something that no longer exists.
  const handleRemoveVariable = useCallback((variableId) => {
    patchConfig(current => ({
      ...current,
      variables: current.variables.filter(item => item.id !== variableId),
      groups: current.groups.map(group => {
        const values = { ...(group.values || {}) }
        delete values[variableId]
        return { ...group, values }
      }),
      stages: current.stages.map(stage => ({
        ...stage,
        bindings: Object.fromEntries(
          Object.entries(stage.bindings || {}).filter(([, binding]) => binding?.variableId !== variableId)
        )
      }))
    }))
  }, [patchConfig])

  const handleAddGroup = useCallback(() => {
    patchConfig(current => ({ ...current, groups: [...current.groups, createGroup()] }))
  }, [patchConfig])

  const handleUpdateGroup = useCallback((groupId, patch) => {
    patchConfig(current => ({
      ...current,
      groups: current.groups.map(group => (group.id === groupId ? { ...group, ...patch } : group))
    }))
  }, [patchConfig])

  const handleRemoveGroup = useCallback((groupId) => {
    patchConfig(current => ({ ...current, groups: current.groups.filter(group => group.id !== groupId) }))
  }, [patchConfig])

  const handleDuplicateGroup = useCallback((groupId) => {
    patchConfig(current => {
      const index = current.groups.findIndex(group => group.id === groupId)
      if (index === -1) return current
      const source = current.groups[index]
      const copy = { ...createGroup(source.name ? `${source.name} copy` : ''), values: { ...(source.values || {}) } }
      const groups = [...current.groups]
      groups.splice(index + 1, 0, copy)
      return { ...current, groups }
    })
  }, [patchConfig])

  const handleSetGroupValue = useCallback((groupId, variableId, value) => {
    patchConfig(current => ({
      ...current,
      groups: current.groups.map(group => (
        group.id === groupId
          ? { ...group, values: { ...(group.values || {}), [variableId]: value } }
          : group
      ))
    }))
  }, [patchConfig])

  const handleAddStage = useCallback(() => {
    patchConfig(current => ({ ...current, stages: [...current.stages, createStage()] }))
  }, [patchConfig])

  // Changing the workflow invalidates every binding and manual value, since they
  // were keyed to the previous workflow's parameter ids. The replacement is
  // seeded from the new workflow's own defaults so the stage starts valid
  // instead of reporting one problem per parameter per group.
  const handleUpdateStage = useCallback((stageId, patch) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages.map((stage, stageIndex) => {
        if (stage.id !== stageId) return stage
        const isWorkflowChange = patch.workflowId !== undefined && String(patch.workflowId) !== String(stage.workflowId)
        if (!isWorkflowChange) {
          return { ...stage, ...patch }
        }
        const nextWorkflow = workflowsById[String(patch.workflowId)] || null
        return {
          ...stage,
          ...patch,
          inputs: createStageDefaultInputs(nextWorkflow),
          bindings: createStageDefaultBindings(nextWorkflow, current.stages, stageIndex)
        }
      })
    }))
  }, [patchConfig, workflowsById])

  const handleRemoveStage = useCallback((stageId) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages
        .filter(stage => stage.id !== stageId)
        .map(stage => ({
          ...stage,
          bindings: Object.fromEntries(
            Object.entries(stage.bindings || {}).filter(([, binding]) => binding?.stageId !== stageId)
          )
        }))
    }))
  }, [patchConfig])

  // Reordering can put a stage before the one it consumed, so any binding that
  // would now point forwards is cleared rather than left silently broken.
  const handleMoveStage = useCallback((stageId, direction) => {
    patchConfig(current => {
      const index = current.stages.findIndex(stage => stage.id === stageId)
      const nextIndex = index + direction
      if (index === -1 || nextIndex < 0 || nextIndex >= current.stages.length) {
        return current
      }

      const stages = [...current.stages]
      const [moved] = stages.splice(index, 1)
      stages.splice(nextIndex, 0, moved)

      const orderById = new Map(stages.map((stage, position) => [stage.id, position]))
      return {
        ...current,
        stages: stages.map((stage, position) => ({
          ...stage,
          bindings: Object.fromEntries(
            Object.entries(stage.bindings || {}).filter(([, binding]) => (
              binding?.source !== 'stage' || (orderById.get(binding.stageId) ?? Infinity) < position
            ))
          )
        }))
      }
    })
  }, [patchConfig])

  const handleSetBinding = useCallback((stageId, parameterId, binding) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages.map(stage => (
        stage.id === stageId
          ? { ...stage, bindings: { ...(stage.bindings || {}), [parameterId]: binding } }
          : stage
      ))
    }))
  }, [patchConfig])

  const handleSetManualInput = useCallback((stageId, parameterId, value) => {
    patchConfig(current => ({
      ...current,
      stages: current.stages.map(stage => (
        stage.id === stageId
          ? { ...stage, inputs: { ...(stage.inputs || {}), [parameterId]: value } }
          : stage
      ))
    }))
  }, [patchConfig])

  // --- Results -------------------------------------------------------------

  // Batch results are ordinary Cards; an asset carries the clientKey of the card
  // it is linked to, which is how each one finds its cell.
  const assetsByCardKey = useMemo(() => {
    const map = {}
    for (const asset of assets) {
      if (asset?.cardKey) {
        map[asset.cardKey] = asset
      }
    }
    return map
  }, [assets])

  // A live run owns the grid; with no run in flight the last run is rebuilt from
  // the cards already in the project, so results survive a reload.
  const displayCells = useMemo(() => {
    if (runState.status !== 'idle') {
      return runState.cells
    }
    return deriveCellsFromAssets(assets, { groups: normalizeBatchConfig(config).groups, stages: normalizeBatchConfig(config).stages })
  }, [assets, config, runState])

  const handleOpenAsset = useCallback((asset) => {
    const path = asset.type === 'mesh'
      ? buildMeshEditorPath({ asset, projectId: project.id, returnTo: `/projects/${project.id}` })
      : buildImageEditorPath({ asset, projectId: project.id, returnTo: `/projects/${project.id}` })
    if (path) navigate(path)
  }, [navigate, project.id])

  // --- Run -----------------------------------------------------------------

  const problems = useMemo(
    () => validateBatch({ config, workflowsById }),
    [config, workflowsById]
  )

  const normalized = normalizeBatchConfig(config)
  const plannedRuns = normalized.groups.length * normalized.stages.length
  const completedCount = Object.values(displayCells).filter(cell => cell?.status === 'completed').length

  return (
    <div className="batch-page">
      <Header
        onSettingsClick={() => setShowSettings(true)}
        title={project?.name || 'Batch'}
        centerTitle
        projectId={project?.id}
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <div className="batch-page__toolbar">
        <div className="batch-page__toolbar-left">
          <span className="batch-page__badge font-label">BATCH</span>

          <div className="batch-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'stages'}
              className={`batch-tab ${activeTab === 'stages' ? 'batch-tab--active' : ''}`}
              onClick={() => setActiveTab('stages')}
            >
              STAGES
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'results'}
              className={`batch-tab ${activeTab === 'results' ? 'batch-tab--active' : ''}`}
              onClick={() => setActiveTab('results')}
            >
              RESULTS
              {completedCount > 0 && <span className="batch-tab__count">{completedCount}</span>}
            </button>
          </div>

          <span className="batch-page__summary">
            {normalized.groups.length} group{normalized.groups.length === 1 ? '' : 's'}
            {' · '}
            {normalized.stages.length} stage{normalized.stages.length === 1 ? '' : 's'}
            {' · '}
            {plannedRuns} run{plannedRuns === 1 ? '' : 's'}
          </span>
          <span className={`batch-page__save batch-page__save--${saveStatus}`}>
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save failed' : saveStatus === 'saved' ? 'Saved' : ''}
          </span>
        </div>

        <div className="batch-page__toolbar-right">
          {isRunning ? (
            <button type="button" className="batch-btn batch-btn--danger" onClick={cancelBatch}>
              <span className="material-symbols-outlined">stop</span>
              {runState.status === 'cancelling' ? 'Stopping after this run…' : 'Stop'}
            </button>
          ) : (
            <button
              type="button"
              className="batch-btn batch-btn--primary"
              onClick={() => startBatch({ project, workflowsById, config })}
              disabled={loading || problems.length > 0 || plannedRuns === 0}
              title={problems.length > 0 ? 'Resolve the problems listed below first' : 'Run every group through every stage'}
            >
              <span className="material-symbols-outlined">play_arrow</span>
              Run batch
            </button>
          )}
        </div>
      </div>

      {problems.length > 0 && !isRunning && (
        <div className="batch-page__problems">
          <button
            type="button"
            className="batch-page__problems-toggle"
            onClick={() => setProblemsOpen(current => !current)}
            aria-expanded={problemsOpen}
          >
            <span className="material-symbols-outlined">
              {problemsOpen ? 'expand_less' : 'expand_more'}
            </span>
            <span className="batch-page__problems-title font-label">
              {problems.length} thing{problems.length === 1 ? '' : 's'} to fix before running
            </span>
          </button>
          {problemsOpen && (
            <ul className="batch-page__problems-list">
              {problems.map((problem, index) => (
                <li key={`${problem.scope}-${index}`}>{problem.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <main className="batch-page__main">
        {loading ? (
          <div className="batch-page__loading font-label">Loading batch…</div>
        ) : activeTab === 'stages' ? (
          <div className="batch-page__columns">
            <BatchVariablesColumn
              variables={normalized.variables}
              groups={normalized.groups}
              locked={isRunning}
              onAddVariable={handleAddVariable}
              onUpdateVariable={handleUpdateVariable}
              onRemoveVariable={handleRemoveVariable}
              onAddGroup={handleAddGroup}
              onUpdateGroup={handleUpdateGroup}
              onRemoveGroup={handleRemoveGroup}
              onDuplicateGroup={handleDuplicateGroup}
              onSetGroupValue={handleSetGroupValue}
            />

            {normalized.stages.map((stage, stageIndex) => (
              <BatchStageColumn
                key={stage.id}
                stage={stage}
                stageIndex={stageIndex}
                stages={normalized.stages}
                variables={normalized.variables}
                groups={normalized.groups}
                workflows={stageWorkflows}
                workflow={workflowsById[String(stage.workflowId)] || null}
                locked={isRunning}
                onUpdateStage={handleUpdateStage}
                onSetBinding={handleSetBinding}
                onSetManualInput={handleSetManualInput}
                onRemoveStage={handleRemoveStage}
                onMoveStage={handleMoveStage}
              />
            ))}

            <div className="batch-column batch-column--add">
              <button
                type="button"
                className="batch-add-stage"
                onClick={handleAddStage}
                disabled={isRunning}
              >
                <span className="material-symbols-outlined">add</span>
                <span>Add stage</span>
                <span className="batch-add-stage__hint">
                  A stage runs once per group and can consume any earlier stage&apos;s output.
                </span>
              </button>
            </div>
          </div>
        ) : (
          <BatchResultsGrid
            groups={normalized.groups}
            stages={normalized.stages}
            cells={displayCells}
            assetsByCardKey={assetsByCardKey}
            onOpenAsset={handleOpenAsset}
          />
        )}
      </main>

      <Footer variant="kanban" />
    </div>
  )
}
