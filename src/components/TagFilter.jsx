// components/TagFilter.jsx
// Multi-select tag picker used by the Assets library and the asset selector
// modal. Selecting several tags NARROWS the result set (an asset must carry all
// of them) — adding a tag never brings more assets back.
import { useEffect, useMemo, useRef, useState } from 'react';
import './TagFilter.css';

export default function TagFilter({ options = [], selected = [], onChange, disabled = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleClickOutside = event => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    const handleEscape = event => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen]);

  const normalizedSearch = search.trim().toLowerCase();

  const visibleOptions = useMemo(() => {
    if (!normalizedSearch) return options;
    return options.filter(option => option.tag.includes(normalizedSearch));
  }, [options, normalizedSearch]);

  const toggleTag = tag => {
    const next = selected.includes(tag)
      ? selected.filter(entry => entry !== tag)
      : [...selected, tag];
    onChange(next);
  };

  const summary = selected.length === 0
    ? 'All tags'
    : selected.length === 1
      ? selected[0]
      : `${selected.length} tags`;

  return (
    <div className="tag-filter" ref={containerRef}>
      <button
        type="button"
        className={`tag-filter__trigger ${selected.length > 0 ? 'tag-filter__trigger--active' : ''}`}
        onClick={() => setIsOpen(open => !open)}
        disabled={disabled || options.length === 0}
        aria-expanded={isOpen}
        title={selected.length > 0 ? `Filtering on: ${selected.join(', ')}` : 'Filter by tag'}
      >
        <span className="material-symbols-outlined">sell</span>
        <span className="tag-filter__summary">{summary}</span>
        <span className="material-symbols-outlined tag-filter__caret">
          {isOpen ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {selected.length > 0 && (
        <button
          type="button"
          className="tag-filter__clear"
          onClick={() => onChange([])}
          title="Clear tag filter"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      )}

      {isOpen && (
        <div className="tag-filter__panel">
          <div className="tag-filter__search">
            <span className="material-symbols-outlined">search</span>
            <input
              type="text"
              className="tag-filter__search-input"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Find a tag"
              autoFocus
            />
          </div>
          <div className="tag-filter__options">
            {visibleOptions.length === 0 ? (
              <div className="tag-filter__empty">No matching tag</div>
            ) : (
              visibleOptions.map(option => (
                <label key={option.tag} className="tag-filter__option">
                  <input
                    type="checkbox"
                    checked={selected.includes(option.tag)}
                    onChange={() => toggleTag(option.tag)}
                  />
                  <span className="tag-filter__option-label">{option.tag}</span>
                  <span className="tag-filter__option-count">{option.count}</span>
                </label>
              ))
            )}
          </div>
          {selected.length > 0 && (
            <button type="button" className="tag-filter__reset" onClick={() => onChange([])}>
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
