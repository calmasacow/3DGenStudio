/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useProjects } from './ProjectContext'
import { useWorkflowJobs } from './WorkflowJobsContext'
import { createComfyExecutionId } from '../utils/graphHelpers'
import {
  BINDING_STAGE,
  buildBatchCardKey,
  buildResultName,
  findParentAssetForStage,
  normalizeBatchConfig,
  resolveStageInputs
} from '../utils/batchHelpers'

const BatchRunContext = createContext(null)

const IDLE_STATE = { status: 'idle', runId: null, projectId: null, cells: {}, error: null }

// The batch loop lives above the router, for the same reason WorkflowJobsContext
// does: BatchPage unmounts the moment the user opens a result in the image or
// mesh editor, and a run owned by that component would lose its whole grid (and
// its remaining iterations) on the way out.
export function BatchRunProvider({ children }) {
  const { runComfyWorkflow, setBatchCardAsset } = useProjects()
  const { registerJob, completeJob } = useWorkflowJobs()

  const [runState, setRunState] = useState(IDLE_STATE)
  // Bumped whenever a cell settles, so a mounted BatchPage knows to re-fetch the
  // project's assets and show the new thumbnail.
  const [resultsVersion, setResultsVersion] = useState(0)
  const cancelRef = useRef(false)
  const runningRef = useRef(false)

  const patchCell = useCallback((cellKey, patch) => {
    setRunState(current => ({
      ...current,
      cells: { ...current.cells, [cellKey]: { ...(current.cells[cellKey] || {}), ...patch } }
    }))
  }, [])

  const cancelBatch = useCallback(() => {
    cancelRef.current = true
    setRunState(current => (current.status === 'running' ? { ...current, status: 'cancelling' } : current))
  }, [])

  const startBatch = useCallback(async ({ project, workflowsById, config }) => {
    if (runningRef.current) {
      return null
    }
    runningRef.current = true

    const { variables, groups, stages } = normalizeBatchConfig(config)
    const runId = createComfyExecutionId('batch').slice(0, 18)
    cancelRef.current = false

    const seededCells = {}
    groups.forEach(group => {
      stages.forEach(stage => {
        seededCells[`${group.id}:${stage.id}`] = { status: 'queued' }
      })
    })
    setRunState({ status: 'running', runId, projectId: project.id, cells: seededCells, error: null })

    try {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const group = groups[groupIndex]
        // Assets produced by earlier stages in THIS group's row.
        const stageOutputs = {}

        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
          const stage = stages[stageIndex]
          const cellKey = `${group.id}:${stage.id}`

          if (cancelRef.current) {
            patchCell(cellKey, { status: 'cancelled' })
            continue
          }

          const workflow = workflowsById?.[String(stage.workflowId)] || null
          if (!workflow) {
            patchCell(cellKey, { status: 'error', error: 'No workflow selected' })
            continue
          }

          const { inputs, missing } = resolveStageInputs({
            stage, workflow, group, variables, stageOutputs, stages
          })

          if (missing.length > 0) {
            patchCell(cellKey, {
              status: 'error',
              error: missing.map(item => `${item.label}: ${item.reason}`).join(' · ')
            })
            continue
          }

          const promptId = createComfyExecutionId('batch-prompt')
          const clientId = createComfyExecutionId('batch-client')
          const cardKey = buildBatchCardKey(runId, group.id, stage.id)
          const resultName = buildResultName({ group, groupIndex, stage, stageIndex, variables })

          // The asset feeding this stage's file input. The server only adopts it
          // as a parent when the output is the same type, so an image → mesh
          // stage still produces a root mesh while mesh → mesh makes a version.
          const parentAsset = findParentAssetForStage({ stage, workflow, stageOutputs })

          patchCell(cellKey, { status: 'running', promptId, cardKey, progressPercent: 0, error: null })

          registerJob({
            id: promptId,
            projectId: project.id,
            projectName: project.name,
            page: 'batch',
            targetId: cardKey,
            kind: 'batch',
            label: resultName
          })

          try {
            const generatedAssets = await runComfyWorkflow(project.id, {
              workflowId: Number(stage.workflowId),
              name: resultName,
              inputs,
              promptId,
              clientId,
              // The server owns the result card: it creates it under this
              // deterministic clientKey and streams progress into it.
              cardId: cardKey,
              ...(parentAsset?.id ? { parentAssetId: parentAsset.id } : {})
            })

            const produced = (Array.isArray(generatedAssets) ? generatedAssets : [generatedAssets]).filter(Boolean)
            if (produced.length === 0) {
              throw new Error('The workflow returned no output')
            }

            // Only the first output feeds downstream: a row has one cell per
            // stage, so multiple outputs would make the shape ambiguous.
            const primary = produced[0]
            stageOutputs[stage.id] = primary

            // An edit / version is created without a Cards_Assets row, so the
            // result card is pointed at it explicitly. Harmless for a root asset,
            // which the server already linked.
            if (primary.id) {
              try {
                await setBatchCardAsset(project.id, cardKey, primary.id)
              } catch (linkErr) {
                console.error('Failed to link a batch result to its card:', linkErr)
              }
            }

            patchCell(cellKey, {
              status: 'completed',
              progressPercent: 100,
              assetId: primary.id ?? null,
              assetType: primary.type || null,
              parentAssetId: parentAsset?.id ?? null,
              extraOutputs: produced.length - 1
            })
            completeJob(promptId, { status: 'completed' })
          } catch (err) {
            const message = err?.message || 'Workflow failed'
            patchCell(cellKey, { status: 'error', error: message })
            completeJob(promptId, { status: 'error', error: message })
          }

          setResultsVersion(current => current + 1)
        }
      }
    } finally {
      runningRef.current = false
      setRunState(current => ({
        ...current,
        status: cancelRef.current ? 'cancelled' : 'completed'
      }))
      setResultsVersion(current => current + 1)
    }

    return runId
  }, [completeJob, patchCell, registerJob, runComfyWorkflow, setBatchCardAsset])

  const value = useMemo(() => ({
    runState,
    resultsVersion,
    startBatch,
    cancelBatch
  }), [runState, resultsVersion, startBatch, cancelBatch])

  return <BatchRunContext.Provider value={value}>{children}</BatchRunContext.Provider>
}

export function useBatchRun(projectId) {
  const context = useContext(BatchRunContext)
  if (!context) {
    throw new Error('useBatchRun must be used within BatchRunProvider')
  }

  // A run belongs to one project; another project's page must not show its grid.
  const isThisProject = context.runState.projectId === projectId
  return {
    runState: isThisProject ? context.runState : IDLE_STATE,
    resultsVersion: context.resultsVersion,
    startBatch: context.startBatch,
    cancelBatch: context.cancelBatch
  }
}

export { BINDING_STAGE }
