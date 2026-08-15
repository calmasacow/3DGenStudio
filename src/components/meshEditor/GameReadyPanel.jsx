// Game-Ready check mode left panel. Runs the read-only inspection on the Python
// mesh-tools service and renders the report as a grouped red/amber/green
// checklist. Unlike every other tool panel there is no Keep/Revert — nothing is
// modified — but findings that the editor can fix carry a button that switches to
// the mode that fixes them.
// Presentational: option state + handlers come from MeshEditorPage.
import { NumberField, ToggleField } from './MeshToolField'

const STATUS_META = {
  pass: { icon: 'check_circle', color: '#4caf50', label: 'Pass' },
  warn: { icon: 'warning', color: '#e0a030', label: 'Warning' },
  fail: { icon: 'cancel', color: '#e35d5d', label: 'Fail' },
  info: { icon: 'info', color: '#7f8ea3', label: 'Info' },
}

// What a finding's fix button does. `mode` hands the user off to the tool that
// resolves it; `action` applies the correction there and then, for findings whose
// fix is a single unambiguous operation with no parameters to choose.
const FIXES = {
  optimize: { kind: 'mode', label: 'Optimize', icon: 'build' },
  autouv: { kind: 'mode', label: 'Auto UV', icon: 'build' },
  autoretopo: { kind: 'mode', label: 'Auto Retopo', icon: 'build' },
  repair: { kind: 'mode', label: 'Repair', icon: 'build' },
  ground_pivot: { kind: 'action', label: 'Set pivot on the ground', icon: 'vertical_align_bottom' },
  centre_pivot: { kind: 'action', label: 'Centre the pivot', icon: 'filter_center_focus' },
}

function CheckRow({ check, onFix, disabled }) {
  const meta = STATUS_META[check.status] || STATUS_META.info
  const fix = check.fix ? FIXES[check.fix] : null

  return (
    <div className="mesh-editor-check-row">
      <span
        className="material-symbols-outlined mesh-editor-check-row__icon"
        style={{ color: meta.color }}
        title={meta.label}
      >
        {meta.icon}
      </span>
      <div className="mesh-editor-check-row__body">
        <div className="mesh-editor-check-row__head">
          <span className="mesh-editor-check-row__label">{check.label}</span>
          <strong className="mesh-editor-check-row__value">{check.value}</strong>
        </div>
        {check.detail && <span className="mesh-editor-check-row__detail">{check.detail}</span>}
        {fix && (
          <button
            type="button"
            className="mesh-editor-check-row__fix"
            onClick={() => onFix(check.fix)}
            disabled={disabled}
            title={fix.kind === 'action'
              ? `${fix.label} — applies straight away, undoable`
              : `Switch to ${fix.label} to fix this`}
          >
            <span className="material-symbols-outlined">{fix.icon}</span>
            <span>{fix.kind === 'action' ? fix.label : `Fix in ${fix.label}`}</span>
          </button>
        )}
      </div>
    </div>
  )
}

export default function GameReadyPanel({
  options,
  setOption,
  running,
  report,
  onRun,
  onFix,
  disabled,
}) {
  const o = options
  const fieldsDisabled = disabled || running

  // Preserve the order the service emitted the checks in — it runs cheap
  // structural checks before expensive ones, which happens to also be the order
  // they matter in.
  const groups = []
  for (const check of report?.checks || []) {
    const existing = groups.find(group => group.name === check.group)
    if (existing) existing.checks.push(check)
    else groups.push({ name: check.group, checks: [check] })
  }

  const summary = report?.summary
  const blocking = summary ? summary.fail : 0
  const warnings = summary ? summary.warn : 0

  return (
    <>{/* GAME-READY CHECK */}
      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Game-Ready Check</span>
        <button
          type="button"
          className="mesh-editor-btn mesh-editor-btn--primary"
          onClick={onRun}
          disabled={disabled || running}
          title="Analyze the mesh against the budgets below — nothing is modified"
        >
          <span className="material-symbols-outlined">{running ? 'progress_activity' : 'fact_check'}</span>
          <span>{running ? 'Checking…' : 'Run Check'}</span>
        </button>

        {report && !running && (
          <div
            className="mesh-editor-check-summary"
            style={{ borderColor: blocking ? '#e35d5d' : warnings ? '#e0a030' : '#4caf50' }}
          >
            <span
              className="material-symbols-outlined"
              style={{ color: blocking ? '#e35d5d' : warnings ? '#e0a030' : '#4caf50' }}
            >
              {blocking ? 'cancel' : warnings ? 'warning' : 'check_circle'}
            </span>
            <span>
              {blocking
                ? `${blocking} blocking issue${blocking === 1 ? '' : 's'}`
                : warnings
                  ? `Ready, with ${warnings} warning${warnings === 1 ? '' : 's'}`
                  : 'Game-ready — everything passed.'}
            </span>
          </div>
        )}
      </div>

      {groups.map(group => (
        <div className="mesh-editor-panel__section" key={group.name}>
          <span className="mesh-editor-panel__section-title">{group.name}</span>
          {group.checks.map(check => (
            <CheckRow key={check.id} check={check} onFix={onFix} disabled={running} />
          ))}
        </div>
      ))}

      <div className="mesh-editor-panel__section">
        <span className="mesh-editor-panel__section-title">Budgets</span>
        <NumberField label="Triangle budget" min={1} max={100000000} step={1000}
          value={o.tri_budget} onChange={v => setOption('tri_budget', v)} disabled={fieldsDisabled}
          hint="Warns above this, fails at double it" />
        <NumberField label="Texture resolution" min={16} max={16384} step={256}
          value={o.texture_resolution} onChange={v => setOption('texture_resolution', v)} disabled={fieldsDisabled}
          hint="Atlas size texel density is measured against" />
        <NumberField label="Max materials" min={1} max={1000} step={1}
          value={o.max_material_count} onChange={v => setOption('max_material_count', v)} disabled={fieldsDisabled}
          hint="Each material costs a draw call" />
        <ToggleField label="Expect pivot on the ground" value={o.expect_ground_pivot}
          onChange={v => setOption('expect_ground_pivot', v)} disabled={fieldsDisabled}
          hint="For props and characters that must snap to the floor when placed in a level" />
      </div>

      <div className="mesh-editor-panel__notes">
        <span className="mesh-editor-panel__hint">The check runs on the Python mesh-tools service (Settings → Mesh Tools).</span>
        <span className="mesh-editor-panel__hint">Nothing is modified — this only reports.</span>
      </div>
    </>
  )
}
