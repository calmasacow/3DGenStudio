// "None" support for ComfyUI file (image / video / mesh) workflow parameters.
//
// ComfyUI has no notion of an optional input, so every file parameter used to be
// mandatory here: a graph node or a kanban card refused to run until each one had
// a source. Workflows that only sometimes need an extra image input can now bind
// such a parameter to "None". The app then sends the NONE marker instead of a file
// reference and the server uploads nothing for it, leaving the value already baked
// into the saved workflow JSON in place (its `defaultValue`) — which is what that
// input was set to when the workflow was imported.

// Value used by the source dropdowns to mean "send nothing".
export const WORKFLOW_INPUT_NONE = 'none'
export const WORKFLOW_INPUT_NONE_LABEL = 'None (send nothing)'
export const WORKFLOW_INPUT_NONE_HINT = 'Nothing is sent for this input — the workflow keeps its own saved value.'

export function isWorkflowInputNone(source) {
  return String(source ?? '') === WORKFLOW_INPUT_NONE
}

// The value stored in a run's inputValues for a "None" parameter. It has to be an
// explicit marker rather than an omitted key: the server still rejects a file
// parameter that was left unset by mistake (e.g. from an MCP call), so silence
// must be spelled out to be honoured.
export function createWorkflowInputNoneValue() {
  return { __none: true }
}

export function isWorkflowInputNoneValue(value) {
  return Boolean(value) && typeof value === 'object' && value.__none === true
}
