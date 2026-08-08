import {
  BATCH_VARIABLE_TYPES,
  articleFor,
  getBatchAssetLabel,
  getGroupLabel,
  getVariableLabel,
  isBatchAssetValue,
  isFileVariableType,
  toBatchBoolean
} from '../../utils/batchHelpers'
import { getAssetPreviewUrl } from '../../utils/graphHelpers'

// Column 1: the batch's declared variables, and the groups that fill them.
// A group is one iteration — one full pass through every stage.
export default function BatchVariablesColumn({
  variables,
  groups,
  locked,
  pendingAssetKey,
  onAddVariable,
  onUpdateVariable,
  onRemoveVariable,
  onAddGroup,
  onUpdateGroup,
  onRemoveGroup,
  onDuplicateGroup,
  onSetGroupValue,
  onPickGroupAsset
}) {
  // An image/mesh variable is filled by picking a file, not by typing one: the
  // dropdown is the only control, and it stays on its placeholder so choosing
  // the same source twice still opens the picker.
  const renderAssetValue = (group, variable) => {
    const value = group.values?.[variable.id]
    const assetValue = isBatchAssetValue(value) ? value : null
    const previewUrl = assetValue ? getAssetPreviewUrl(assetValue.thumbnail) : null
    const isPending = pendingAssetKey === `${group.id}:${variable.id}`

    return (
      <div className="batch-asset-picker">
        {assetValue ? (
          <div className="batch-asset-picker__chip">
            {previewUrl ? (
              <img className="batch-asset-picker__thumb" src={previewUrl} alt="" />
            ) : (
              <span className="material-symbols-outlined batch-asset-picker__icon">
                {variable.type === 'mesh' ? 'deployed_code' : 'image'}
              </span>
            )}
            <span className="batch-asset-picker__name" title={getBatchAssetLabel(assetValue)}>
              {getBatchAssetLabel(assetValue)}
            </span>
            <button
              type="button"
              className="batch-icon-btn"
              onClick={() => onSetGroupValue(group.id, variable.id, null)}
              disabled={locked || isPending}
              title="Clear"
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
        ) : (
          <span className="batch-asset-picker__empty">
            {isPending ? 'Adding…' : `No ${variable.type} selected`}
          </span>
        )}

        <select
          className="batch-select"
          value=""
          onChange={event => {
            if (!event.target.value) return
            onPickGroupAsset?.(group.id, variable, event.target.value)
          }}
          disabled={locked || isPending}
        >
          <option value="">
            {assetValue ? 'Change…' : `Select ${articleFor(variable.type)} ${variable.type}…`}
          </option>
          <option value="library">From Assets</option>
          <option value="local">Local Computer</option>
        </select>
      </div>
    )
  }

  return (
    <div className="batch-column batch-column--variables">
      <div className="batch-column__header">
        <span className="batch-column__title font-label">PARAMETERS</span>
        <span className="batch-column__subtitle">{groups.length} run{groups.length === 1 ? '' : 's'}</span>
      </div>

      <div className="batch-column__body">
        <section className="batch-section">
          <div className="batch-section__header">
            <span className="batch-section__title font-label">VARIABLES</span>
            <button type="button" className="batch-btn batch-btn--ghost" onClick={onAddVariable} disabled={locked}>
              <span className="material-symbols-outlined">add</span>
              Add
            </button>
          </div>

          {variables.length === 0 ? (
            <p className="batch-empty">
              Declare a variable, then bind it in a stage. Each group supplies its own value.
            </p>
          ) : (
            <div className="batch-variable-list">
              {variables.map((variable, index) => (
                <div key={variable.id} className="batch-variable-row">
                  <input
                    type="text"
                    className="batch-input"
                    placeholder={`Variable ${index + 1}`}
                    value={variable.name || ''}
                    onChange={event => onUpdateVariable(variable.id, { name: event.target.value })}
                    disabled={locked}
                  />
                  <select
                    className="batch-select batch-select--compact"
                    value={variable.type}
                    onChange={event => onUpdateVariable(variable.id, { type: event.target.value })}
                    disabled={locked}
                  >
                    {BATCH_VARIABLE_TYPES.map(type => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="batch-icon-btn"
                    onClick={() => onRemoveVariable(variable.id)}
                    disabled={locked}
                    title="Remove variable"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="batch-section">
          <div className="batch-section__header">
            <span className="batch-section__title font-label">GROUPS · ONE RUN EACH</span>
            <button
              type="button"
              className="batch-btn batch-btn--ghost"
              onClick={onAddGroup}
              disabled={locked || variables.length === 0}
              title={variables.length === 0 ? 'Declare a variable first' : 'Add a group'}
            >
              <span className="material-symbols-outlined">add</span>
              Add
            </button>
          </div>

          {groups.length === 0 ? (
            <p className="batch-empty">
              Every group runs the whole chain once. Leave a value blank to fall back to the stage&apos;s manual value.
            </p>
          ) : (
            <div className="batch-group-list">
              {groups.map((group, groupIndex) => (
                <div key={group.id} className="batch-group-card">
                  <div className="batch-group-card__header">
                    <input
                      type="text"
                      className="batch-input batch-input--title"
                      placeholder={`Group ${groupIndex + 1}`}
                      value={group.name || ''}
                      onChange={event => onUpdateGroup(group.id, { name: event.target.value })}
                      disabled={locked}
                    />
                    <button
                      type="button"
                      className="batch-icon-btn"
                      onClick={() => onDuplicateGroup(group.id)}
                      disabled={locked}
                      title="Duplicate group"
                    >
                      <span className="material-symbols-outlined">content_copy</span>
                    </button>
                    <button
                      type="button"
                      className="batch-icon-btn"
                      onClick={() => onRemoveGroup(group.id)}
                      disabled={locked}
                      title="Remove group"
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </div>

                  <div className="batch-group-card__values">
                    {variables.map((variable, variableIndex) => {
                      // A picked file is a chip plus its own controls, so it is
                      // not wrapped in a label the way a single input is.
                      const Wrapper = isFileVariableType(variable.type) ? 'div' : 'label'
                      return (
                      <Wrapper key={variable.id} className="batch-field">
                        <span className="batch-field__label font-label">
                          {getVariableLabel(variable, variableIndex)}
                        </span>
                        {isFileVariableType(variable.type) ? (
                          renderAssetValue(group, variable)
                        ) : variable.type === 'boolean' ? (
                          // Three states, not a checkbox: `false` is a real value,
                          // so an unticked box could not be told apart from "this
                          // group doesn't set it" — which is what makes a group sparse.
                          <select
                            className="batch-select"
                            value={group.values?.[variable.id] === undefined || group.values?.[variable.id] === ''
                              ? ''
                              : String(toBatchBoolean(group.values[variable.id]))}
                            onChange={event => onSetGroupValue(
                              group.id,
                              variable.id,
                              event.target.value === '' ? '' : event.target.value === 'true'
                            )}
                            disabled={locked}
                          >
                            <option value="">fallback to stage value</option>
                            <option value="true">True</option>
                            <option value="false">False</option>
                          </select>
                        ) : variable.type === 'number' ? (
                          <input
                            type="number"
                            className="batch-input"
                            placeholder="fallback to stage value"
                            value={group.values?.[variable.id] ?? ''}
                            onChange={event => onSetGroupValue(group.id, variable.id, event.target.value)}
                            disabled={locked}
                          />
                        ) : (
                          <textarea
                            className="batch-textarea"
                            rows={2}
                            placeholder="fallback to stage value"
                            value={group.values?.[variable.id] ?? ''}
                            onChange={event => onSetGroupValue(group.id, variable.id, event.target.value)}
                            disabled={locked}
                          />
                        )}
                      </Wrapper>
                      )
                    })}
                  </div>

                  <span className="batch-group-card__badge font-label">
                    RUN {groupIndex + 1} · {getGroupLabel(group, groupIndex)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
