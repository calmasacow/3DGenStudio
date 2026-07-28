// Renders a single non-image ComfyUI workflow parameter (boolean checkbox or
// text/number input). Shared by the AI control panels. Presentational.
import { getValueType } from '../../../utils/imageEditorCanvas'
import { getWorkflowEnumOptions, resolveWorkflowEnumValue } from '../../../utils/workflowEnums'
import ComfyTextButton from '../../comfy/ComfyTextButton'

export default function WorkflowParameterField({ parameter, value, onChange }) {
  const valueType = getValueType(parameter)
  const enumOptions = getWorkflowEnumOptions(parameter, value)

  if (enumOptions) {
    return (
      <label className="image-editor-label">
        {parameter.name}
        <select
          className="image-editor-input"
          value={value == null ? '' : String(value)}
          onChange={event => onChange(parameter.id, resolveWorkflowEnumValue(parameter, event.target.value))}
        >
          {enumOptions.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    )
  }

  if (valueType === 'boolean') {
    return (
      <label className="image-editor-label image-editor-label--checkbox">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={event => onChange(parameter.id, event.target.checked)}
        />
        <span>{parameter.name}</span>
      </label>
    )
  }

  if (valueType === 'number') {
    return (
      <label className="image-editor-label">
        {parameter.name}
        <input
          className="image-editor-input"
          type="number"
          value={value ?? ''}
          onChange={event => onChange(parameter.id, event.target.value)}
        />
      </label>
    )
  }

  return (
    <label className="image-editor-label">
      {parameter.name}
      <span className="comfy-textfield-wrap">
        <input
          className="image-editor-input"
          type="text"
          value={value ?? ''}
          onChange={event => onChange(parameter.id, event.target.value)}
        />
        <ComfyTextButton
          className="comfy-text-btn--corner"
          onResult={text => onChange(parameter.id, text)}
        />
      </span>
    </label>
  )
}
