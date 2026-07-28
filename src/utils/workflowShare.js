// Shareable workflow bundle (.3dgw)
//
// An imported ComfyUI workflow is more than its raw graph: the user also
// configures which node inputs become parameters and which nodes become saved
// outputs (each with a label + value type). A plain ComfyUI JSON export loses
// that configuration, so sharing one would force the recipient to redo it.
//
// The .3dgw format is a JSON envelope that bundles the original workflow graph
// together with the configured inputs/outputs, so importing it restores a fully
// configured workflow in one step.

export const WORKFLOW_SHARE_FORMAT = '3dgenstudio-workflow'
export const WORKFLOW_SHARE_VERSION = 1
export const WORKFLOW_SHARE_EXTENSION = '.3dgw'

// Build the .3dgw payload from a saved workflow. Keeps only the fields needed to
// recreate it via importComfyWorkflow; availableInputs/availableOutputs are
// re-derived from workflowJson on import so they don't need to travel along.
export function buildShareableWorkflow(workflow) {
  return {
    format: WORKFLOW_SHARE_FORMAT,
    version: WORKFLOW_SHARE_VERSION,
    exportedAt: new Date().toISOString(),
    name: workflow?.name || 'Workflow',
    workflowJson: workflow?.workflowJson ?? null,
    parameters: (workflow?.parameters || []).map(parameter => ({
      id: parameter.id,
      name: parameter.name,
      valueType: parameter.valueType,
      // Only String/Number parameters carry an allowed-value list; omit the key
      // entirely for the rest so bundles stay as small as they were.
      ...(Array.isArray(parameter.enums) && parameter.enums.length > 0
        ? { enums: [...parameter.enums] }
        : {})
    })),
    outputs: (workflow?.outputs || []).map(output => ({
      nodeId: output.nodeId,
      name: output.name,
      valueType: output.valueType
    }))
  }
}

// True when a parsed JSON file is a .3dgw bundle (vs. a raw ComfyUI workflow).
export function isShareableWorkflow(data) {
  return Boolean(
    data &&
    typeof data === 'object' &&
    data.format === WORKFLOW_SHARE_FORMAT &&
    data.workflowJson
  )
}

// Turn a workflow name into a safe ".3dgw" download filename.
export function sanitizeWorkflowFilename(name) {
  const base = String(name || 'workflow')
    .trim()
    .replace(/[^a-z0-9-_ ]/gi, '')
    .replace(/\s+/g, '_')
  return `${base || 'workflow'}${WORKFLOW_SHARE_EXTENSION}`
}

// Trigger a browser download of the workflow as a .3dgw file.
export function downloadShareableWorkflow(workflow) {
  const payload = buildShareableWorkflow(workflow)
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = sanitizeWorkflowFilename(workflow?.name)
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
