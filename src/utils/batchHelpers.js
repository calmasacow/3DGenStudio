// Batch Processing document model.
//
// A batch runs one linear chain of ComfyUI workflows ("stages") once per
// "group". A group is ONE ITERATION: a row of values for the batch's declared
// variables. Groups are sparse — a variable a group leaves blank falls back to
// whatever the stage has set manually.
//
//   variables: [{ id, name, type }]                  declared once for the batch
//   groups:    [{ id, name, values: { [variableId]: value } }]   one per iteration
//   stages:    [{ id, name, workflowId, bindings: { [parameterId]: binding } }]
//
// A binding is one of:
//   { source: 'manual' }                      use the stage's own value
//   { source: 'variable', variableId }        use the current group's value
//   { source: 'stage', stageId, outputType }  use an earlier stage's output asset
//
// Results are NOT stored in this document. Each executed cell becomes a normal
// Card carrying its asset, addressed by a deterministic clientKey — see
// buildBatchCardKey below.

import { getWorkflowParameterValueType, isFileWorkflowValueType } from './graphHelpers'

export const BATCH_VARIABLE_TYPES = ['string', 'number']

export const BINDING_MANUAL = 'manual'
export const BINDING_VARIABLE = 'variable'
export const BINDING_STAGE = 'stage'

let localIdCounter = 0
function createLocalId(prefix) {
  localIdCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${localIdCounter.toString(36)}`
}

export function createEmptyBatchConfig() {
  return {
    version: 1,
    variables: [],
    groups: [],
    stages: [],
    lastRunId: null
  }
}

export function normalizeBatchConfig(state) {
  const base = createEmptyBatchConfig()
  if (!state || typeof state !== 'object') {
    return base
  }

  return {
    ...base,
    ...state,
    variables: Array.isArray(state.variables) ? state.variables : [],
    groups: Array.isArray(state.groups) ? state.groups : [],
    stages: Array.isArray(state.stages) ? state.stages : []
  }
}

export function createVariable(name = '', type = 'string') {
  return { id: createLocalId('var'), name, type: BATCH_VARIABLE_TYPES.includes(type) ? type : 'string' }
}

export function createGroup(name = '') {
  return { id: createLocalId('grp'), name, values: {} }
}

export function createStage(name = '') {
  return { id: createLocalId('stg'), name, workflowId: '', inputs: {}, bindings: {} }
}

// Seed a stage's manual values from the workflow's own defaults. Without this
// every parameter starts empty and the batch reports one "No value set" problem
// per parameter per group before the user has done anything wrong.
export function createStageDefaultInputs(workflow) {
  const inputs = {}
  for (const parameter of workflow?.parameters || []) {
    const valueType = getWorkflowParameterValueType(parameter)
    if (isFileWorkflowValueType(valueType)) {
      continue
    }
    if (valueType === 'boolean') {
      inputs[parameter.id] = Boolean(parameter.defaultValue ?? false)
      continue
    }
    const defaultValue = parameter.defaultValue
    if (defaultValue !== undefined && defaultValue !== null && String(defaultValue) !== '') {
      inputs[parameter.id] = defaultValue
    }
  }
  return inputs
}

// A file parameter has exactly one legal source — an earlier stage — so bind it
// to the immediately preceding one rather than leaving it in an invalid state.
export function createStageDefaultBindings(workflow, stages, stageIndex) {
  const previousStage = stageIndex > 0 ? stages[stageIndex - 1] : null
  if (!previousStage) {
    return {}
  }

  const bindings = {}
  for (const parameter of workflow?.parameters || []) {
    if (isFileWorkflowValueType(getWorkflowParameterValueType(parameter))) {
      bindings[parameter.id] = { source: BINDING_STAGE, stageId: previousStage.id }
    }
  }
  return bindings
}

// --- Naming --------------------------------------------------------------

export function getVariableLabel(variable, index) {
  return String(variable?.name || '').trim() || `Variable ${index + 1}`
}

export function getGroupLabel(group, index) {
  return String(group?.name || '').trim() || `Group ${index + 1}`
}

export function getStageLabel(stage, index) {
  return String(stage?.name || '').trim() || `Stage ${index + 1}`
}

// A stage name is a template: `{{variable}}` tokens are replaced with the
// current group's value. The stage name is what the produced asset is called, so
// this is how a result carries the values that made it into its own name —
// e.g. "{{name}} - {{texture resolution}}px".
export const VARIABLE_TOKEN_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g

export function variableToken(variable, index) {
  return `{{${getVariableLabel(variable, index)}}}`
}

export function resolveNameTemplate(template, { group, variables }) {
  const text = String(template || '')
  if (!text.includes('{{')) {
    return text
  }

  return text.replace(VARIABLE_TOKEN_PATTERN, (whole, rawToken) => {
    const token = String(rawToken).trim().toLowerCase()
    const index = (variables || []).findIndex(
      (variable, position) => getVariableLabel(variable, position).toLowerCase() === token
    )
    if (index === -1) {
      // Unknown token: leave it visible rather than silently blanking the name.
      return whole
    }
    const value = group?.values?.[variables[index].id]
    return value === undefined || value === null ? '' : String(value)
  })
}

// The stage name resolved for one group, falling back to "Stage N" when the
// template is empty or resolves to nothing.
export function resolveStageName(stage, stageIndex, { group, variables }) {
  const resolved = resolveNameTemplate(stage?.name, { group, variables }).trim()
  return resolved || `Stage ${stageIndex + 1}`
}

// --- Bindings ------------------------------------------------------------

export function getBinding(stage, parameterId) {
  return stage?.bindings?.[parameterId] || { source: BINDING_MANUAL }
}

// Which stages can feed this one: strictly earlier in the chain, so the graph
// can never contain a cycle by construction.
export function getUpstreamStages(stages, stageIndex) {
  return stages.slice(0, Math.max(0, stageIndex))
}

// Image/mesh/video parameters can only be fed by an earlier stage's output —
// there is nothing else in a batch to point them at. Everything else can take a
// manual value or a variable.
export function getBindingOptionsForParameter(parameter, { variables, stages, stageIndex }) {
  const valueType = getWorkflowParameterValueType(parameter)
  const isFileValue = isFileWorkflowValueType(valueType)
  const upstream = getUpstreamStages(stages, stageIndex)

  const options = []
  if (!isFileValue) {
    options.push({ value: `${BINDING_MANUAL}:`, label: 'Manual value', source: BINDING_MANUAL })
    for (const variable of variables) {
      const index = variables.indexOf(variable)
      options.push({
        value: `${BINDING_VARIABLE}:${variable.id}`,
        label: `Variable · ${getVariableLabel(variable, index)}`,
        source: BINDING_VARIABLE,
        variableId: variable.id
      })
    }
  }

  for (const stage of upstream) {
    const index = stages.indexOf(stage)
    options.push({
      value: `${BINDING_STAGE}:${stage.id}`,
      label: `Output of ${getStageLabel(stage, index)}`,
      source: BINDING_STAGE,
      stageId: stage.id
    })
  }

  if (isFileValue && upstream.length === 0) {
    options.push({ value: `${BINDING_MANUAL}:`, label: 'No source available', source: BINDING_MANUAL })
  }

  return options
}

export function bindingToSelectValue(binding) {
  if (binding?.source === BINDING_VARIABLE) {
    return `${BINDING_VARIABLE}:${binding.variableId}`
  }
  if (binding?.source === BINDING_STAGE) {
    return `${BINDING_STAGE}:${binding.stageId}`
  }
  return `${BINDING_MANUAL}:`
}

export function selectValueToBinding(selectValue) {
  const [source, ref] = String(selectValue || '').split(':')
  if (source === BINDING_VARIABLE && ref) {
    return { source: BINDING_VARIABLE, variableId: ref }
  }
  if (source === BINDING_STAGE && ref) {
    return { source: BINDING_STAGE, stageId: ref }
  }
  return { source: BINDING_MANUAL }
}

// --- Resolution ----------------------------------------------------------

function coerceValue(parameter, rawValue) {
  const valueType = getWorkflowParameterValueType(parameter)
  if (valueType === 'number') {
    const numeric = Number(rawValue)
    return Number.isFinite(numeric) ? numeric : null
  }
  if (valueType === 'boolean') {
    return Boolean(rawValue)
  }
  return rawValue
}

// Resolve every parameter of one stage for one group.
// `stageOutputs` maps stageId -> the asset produced by that stage in THIS group's
// iteration, so a stage binding reads the value from the same row.
// Returns { inputs, missing[] } — `missing` names the parameters that could not
// be resolved, which is what blocks the run and what the UI reports.
export function resolveStageInputs({ stage, workflow, group, variables, stageOutputs, stages }) {
  const inputs = {}
  const missing = []

  for (const parameter of workflow?.parameters || []) {
    const binding = getBinding(stage, parameter.id)
    const valueType = getWorkflowParameterValueType(parameter)
    const isFileValue = isFileWorkflowValueType(valueType)

    if (binding.source === BINDING_STAGE) {
      const producedAsset = stageOutputs?.[binding.stageId] || null
      if (!producedAsset?.id) {
        const sourceStage = (stages || []).find(item => item.id === binding.stageId)
        const sourceIndex = (stages || []).indexOf(sourceStage)
        missing.push({
          parameterId: parameter.id,
          label: parameter.name || parameter.label || parameter.id,
          reason: `${getStageLabel(sourceStage, sourceIndex)} produced no ${valueType} output`
        })
        continue
      }
      inputs[parameter.id] = `asset:${producedAsset.id}`
      continue
    }

    if (binding.source === BINDING_VARIABLE) {
      const rawValue = group?.values?.[binding.variableId]
      // A group that leaves the variable blank falls back to the stage's manual
      // value — that is what makes groups sparse.
      if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
        const fallback = stage?.inputs?.[parameter.id]
        if (fallback === undefined || fallback === null || String(fallback).trim() === '') {
          const variable = (variables || []).find(item => item.id === binding.variableId)
          const variableIndex = (variables || []).indexOf(variable)
          missing.push({
            parameterId: parameter.id,
            label: parameter.name || parameter.label || parameter.id,
            reason: `${getVariableLabel(variable, variableIndex)} is empty and no manual fallback is set`
          })
          continue
        }
        inputs[parameter.id] = coerceValue(parameter, fallback)
        continue
      }
      inputs[parameter.id] = coerceValue(parameter, rawValue)
      continue
    }

    // Manual.
    if (isFileValue) {
      missing.push({
        parameterId: parameter.id,
        label: parameter.name || parameter.label || parameter.id,
        reason: 'Bind this input to an earlier stage'
      })
      continue
    }

    const manualValue = stage?.inputs?.[parameter.id]
    if (valueType === 'boolean') {
      inputs[parameter.id] = Boolean(manualValue)
      continue
    }
    if (manualValue === undefined || manualValue === null || String(manualValue).trim() === '') {
      missing.push({
        parameterId: parameter.id,
        label: parameter.name || parameter.label || parameter.id,
        reason: 'No value set'
      })
      continue
    }
    inputs[parameter.id] = coerceValue(parameter, manualValue)
  }

  return { inputs, missing }
}

// Whole-batch readiness. Stage bindings are assumed satisfiable at plan time
// (the producing stage runs first); only missing values are reported here.
export function validateBatch({ config, workflowsById }) {
  const problems = []
  const { variables, groups, stages } = normalizeBatchConfig(config)

  if (stages.length === 0) {
    problems.push({ scope: 'batch', message: 'Add at least one workflow stage' })
  }
  if (groups.length === 0) {
    problems.push({ scope: 'batch', message: 'Add at least one group — each group is one run' })
  }

  stages.forEach((stage, stageIndex) => {
    const workflow = workflowsById?.[String(stage.workflowId)] || null
    if (!workflow) {
      problems.push({ scope: 'stage', stageId: stage.id, message: `${getStageLabel(stage, stageIndex)}: no workflow selected` })
      return
    }

    // Pretend every upstream stage produced something, so only genuinely
    // unset values surface here rather than ordering artefacts.
    const pretendOutputs = {}
    stages.slice(0, stageIndex).forEach(upstream => { pretendOutputs[upstream.id] = { id: -1 } })

    groups.forEach((group, groupIndex) => {
      const { missing } = resolveStageInputs({ stage, workflow, group, variables, stageOutputs: pretendOutputs, stages })
      missing.forEach(item => {
        problems.push({
          scope: 'cell',
          stageId: stage.id,
          groupId: group.id,
          message: `${getGroupLabel(group, groupIndex)} · ${getStageLabel(stage, stageIndex)} · ${item.label}: ${item.reason}`
        })
      })
    })
  })

  return problems
}

// The types a workflow declares it will produce, e.g. ['mesh'].
export function getWorkflowOutputTypes(workflow) {
  return (workflow?.outputs || [])
    .map(output => String(output?.valueType || '').toLowerCase())
    .filter(Boolean)
}

// The upstream asset this stage consumes as a file input, if any. It is offered
// to the server as `parentAssetId` so a derived result is stored under what it
// came from: an image edited from an image becomes that image's edit, a mesh
// derived from a mesh becomes that mesh's version.
//
// It must be the input whose type MATCHES THE OUTPUT, not simply the first file
// input. "Texture Mesh with Trellis2" takes [image, mesh] and returns a mesh:
// offering the image makes the server reject the parent on type mismatch and the
// result lands as a new root instead of a version. Parameter order is arbitrary,
// so the declared output type is what decides.
export function findParentAssetForStage({ stage, workflow, stageOutputs }) {
  const outputTypes = getWorkflowOutputTypes(workflow)
  const candidates = []

  for (const parameter of workflow?.parameters || []) {
    const valueType = getWorkflowParameterValueType(parameter)
    if (!isFileWorkflowValueType(valueType)) {
      continue
    }
    const binding = getBinding(stage, parameter.id)
    if (binding.source !== BINDING_STAGE) {
      continue
    }
    const upstream = stageOutputs?.[binding.stageId]
    if (upstream?.id) {
      candidates.push({ upstream, valueType })
    }
  }

  if (candidates.length === 0) {
    return null
  }

  // Best: the produced asset's own type matches something this workflow outputs.
  const byAssetType = candidates.find(candidate => (
    outputTypes.includes(String(candidate.upstream.type || '').toLowerCase())
  ))
  if (byAssetType) {
    return byAssetType.upstream
  }

  // Next best: the parameter's declared type matches, for when a run result came
  // back without a usable `type`.
  const byParameterType = candidates.find(candidate => outputTypes.includes(candidate.valueType))
  if (byParameterType) {
    return byParameterType.upstream
  }

  // The workflow declares no output type we can match on: fall back to the first
  // file input. A genuine mismatch is still safe — the server compares types and
  // creates a root asset instead of a wrongly-parented one.
  return outputTypes.length === 0 ? candidates[0].upstream : null
}

export function describeCell(cell) {
  if (!cell) return 'Not run'
  switch (cell.status) {
    case 'queued': return 'Queued'
    case 'running': return Number.isFinite(cell.progressPercent) ? `${cell.progressPercent}%` : 'Running…'
    case 'completed': return 'Done'
    case 'cancelled': return 'Cancelled'
    case 'error': return cell.error || 'Failed'
    default: return 'Not run'
  }
}

// --- Result cards ---------------------------------------------------------

// Every executed cell writes to a Card addressed by this key. It is passed to
// /comfyui/run as `cardId`, which the server resolves as Cards.clientKey — so
// the card is created on first use and carries the run's live progress and then
// its asset, exactly like a Kanban generation. The key is self-describing, which
// is how the results grid maps cards back to their cell without extra storage.
export function buildBatchCardKey(runId, groupId, stageId) {
  return `batch:${runId}:${groupId}:${stageId}`
}

export function parseBatchCardKey(cardKey) {
  const parts = String(cardKey || '').split(':')
  if (parts.length !== 4 || parts[0] !== 'batch') {
    return null
  }
  return { runId: parts[1], groupId: parts[2], stageId: parts[3] }
}

// What the produced asset is called. The stage name drives it, so a template
// like "{{name}} - {{texture resolution}}px" names each result after the values
// that made it. A stage left unnamed falls back to "Group · Stage N".
// Rebuild the results grid from what is already in the project, so reopening a
// batch shows its last results instead of an empty "Not run" grid. Cards are
// addressed by a self-describing key, so the assets alone are enough — only the
// newest run is shown, since that is the one the grid's shape matches.
export function deriveCellsFromAssets(assets, { groups, stages }) {
  const groupIds = new Set((groups || []).map(group => group.id))
  const stageIds = new Set((stages || []).map(stage => stage.id))

  const byRun = new Map()
  for (const asset of assets || []) {
    const parsed = parseBatchCardKey(asset?.cardKey)
    if (!parsed || !groupIds.has(parsed.groupId) || !stageIds.has(parsed.stageId)) {
      continue
    }
    if (!byRun.has(parsed.runId)) {
      byRun.set(parsed.runId, { cells: {}, newest: 0 })
    }
    const bucket = byRun.get(parsed.runId)
    bucket.newest = Math.max(bucket.newest, Number(asset.createdAt) || 0)
    bucket.cells[`${parsed.groupId}:${parsed.stageId}`] = {
      status: 'completed',
      cardKey: asset.cardKey,
      assetId: asset.id,
      assetType: asset.type || null
    }
  }

  let newestRun = null
  for (const [runId, bucket] of byRun) {
    if (!newestRun || bucket.newest > newestRun.newest) {
      newestRun = { runId, ...bucket }
    }
  }

  return newestRun ? newestRun.cells : {}
}

export function buildResultName({ group, groupIndex, stage, stageIndex, variables }) {
  const hasTemplate = String(stage?.name || '').trim() !== ''
  const stageName = resolveStageName(stage, stageIndex, { group, variables })
  return hasTemplate ? stageName : `${getGroupLabel(group, groupIndex)} · ${stageName}`
}
