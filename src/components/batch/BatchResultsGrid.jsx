import { describeCell, getGroupLabel, getStageLabel } from '../../utils/batchHelpers'
import { getAssetPreviewUrl } from '../../utils/graphHelpers'

// Rows = groups, columns = stages — the same axes as the configuration above,
// so a cell's position reads the same in both halves of the page.
//
// A cell's asset comes from the Card the run created for it (keyed by
// buildBatchCardKey); this grid only displays what those cards already hold.
export default function BatchResultsGrid({ groups, stages, cells, assetsByCardKey, onOpenAsset }) {
  if (groups.length === 0 || stages.length === 0) {
    return null
  }

  return (
    <div className="batch-results">
      <div className="batch-results__header">
        <span className="batch-column__title font-label">RESULTS</span>
        <span className="batch-column__subtitle">
          One card per result, in the project like any other generation
        </span>
      </div>

      <div className="batch-results__scroll">
        <table className="batch-results__table">
          <thead>
            <tr>
              <th className="batch-results__corner" />
              {stages.map((stage, stageIndex) => (
                <th key={stage.id} className="batch-results__col-head">
                  {getStageLabel(stage, stageIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group, groupIndex) => (
              <tr key={group.id}>
                <th className="batch-results__row-head">{getGroupLabel(group, groupIndex)}</th>
                {stages.map(stage => {
                  const cell = cells?.[`${group.id}:${stage.id}`] || null
                  const asset = cell?.cardKey ? assetsByCardKey?.[cell.cardKey] || null : null
                  const previewUrl = getAssetPreviewUrl(asset?.thumbnail || asset?.filename || null)
                  const status = cell?.status || 'idle'

                  return (
                    <td key={stage.id} className={`batch-results__cell batch-results__cell--${status}`}>
                      <button
                        type="button"
                        className="batch-results__cell-btn"
                        onClick={() => asset && onOpenAsset?.(asset)}
                        disabled={!asset}
                        title={cell?.error || (asset ? asset.name : describeCell(cell))}
                      >
                        {previewUrl ? (
                          <img className="batch-results__thumb" src={previewUrl} alt={asset?.name || ''} />
                        ) : (
                          <span className="material-symbols-outlined batch-results__icon">
                            {status === 'running' ? 'progress_activity'
                              : status === 'error' ? 'error'
                              : status === 'completed' ? 'check_circle'
                              : status === 'cancelled' ? 'block'
                              : 'schedule'}
                          </span>
                        )}
                        <span className="batch-results__caption font-label">{describeCell(cell)}</span>
                        {cell?.extraOutputs > 0 && (
                          <span className="batch-results__extra font-label">
                            +{cell.extraOutputs} more output{cell.extraOutputs === 1 ? '' : 's'}
                          </span>
                        )}
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
