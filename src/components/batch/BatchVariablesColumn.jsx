import {
  BATCH_VARIABLE_TYPES,
  getGroupLabel,
  getVariableLabel
} from '../../utils/batchHelpers'

// Column 1: the batch's declared variables, and the groups that fill them.
// A group is one iteration — one full pass through every stage.
export default function BatchVariablesColumn({
  variables,
  groups,
  locked,
  onAddVariable,
  onUpdateVariable,
  onRemoveVariable,
  onAddGroup,
  onUpdateGroup,
  onRemoveGroup,
  onDuplicateGroup,
  onSetGroupValue
}) {
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
                    {variables.map((variable, variableIndex) => (
                      <label key={variable.id} className="batch-field">
                        <span className="batch-field__label font-label">
                          {getVariableLabel(variable, variableIndex)}
                        </span>
                        {variable.type === 'number' ? (
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
                      </label>
                    ))}
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
