// Enum support for ComfyUI workflow parameters.
//
// A String or Number parameter can carry an `enums` array that restricts it to a
// fixed list of allowed values. Every AI panel renders such a parameter as a
// dropdown instead of a free-form field, so the value can only ever be one the
// workflow actually accepts.
//
// Values keep their real type in storage (numbers stay numbers) while <select>
// values are always strings — hence resolveWorkflowEnumValue, which maps a picked
// option back to its typed entry.

const ENUM_VALUE_TYPES = ['string', 'number']

// The allowed values of a parameter, or null when it isn't an enum parameter.
export function getWorkflowParameterEnums(parameter) {
  if (!Array.isArray(parameter?.enums)) return null

  const values = parameter.enums.filter(value => typeof value === 'string' || typeof value === 'number')
  return values.length > 0 ? values : null
}

export function isEnumWorkflowValueType(valueType) {
  return ENUM_VALUE_TYPES.includes(valueType)
}

// Options for a <select>, or null when the parameter has no enums. A current
// value outside the list is kept as an extra option so an older saved value is
// never silently rewritten.
export function getWorkflowEnumOptions(parameter, currentValue) {
  const enums = getWorkflowParameterEnums(parameter)
  if (!enums) return null

  const options = enums.map(value => ({ value: String(value), label: String(value) }))

  if (currentValue !== undefined && currentValue !== null && currentValue !== ''
    && !options.some(option => option.value === String(currentValue))) {
    options.unshift({ value: String(currentValue), label: `${currentValue} (custom)` })
  }

  return options
}

// Map a <select> value (always a string) back to the typed enum entry.
export function resolveWorkflowEnumValue(parameter, rawValue) {
  const enums = getWorkflowParameterEnums(parameter)
  const match = enums?.find(value => String(value) === String(rawValue))
  return match === undefined ? rawValue : match
}

// Parse the workflow editor's enum field (one value per line) into stored values.
export function parseWorkflowEnumsInput(text, valueType) {
  if (!isEnumWorkflowValueType(valueType)) return []

  const values = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (valueType === 'number') {
      const numeric = Number(trimmed)
      if (!Number.isFinite(numeric) || values.includes(numeric)) continue
      values.push(numeric)
      continue
    }

    if (!values.includes(trimmed)) values.push(trimmed)
  }

  return values
}

// Render stored enums back into the editor field (one value per line).
export function formatWorkflowEnumsInput(enums) {
  return Array.isArray(enums) ? enums.join('\n') : ''
}
