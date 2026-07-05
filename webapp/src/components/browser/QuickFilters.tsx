import { useState } from 'react';

import { useAppStore } from '../../store/useAppStore';
import { CatalogSourceType } from '../../api/types';
import { Icon } from '../shared/Icon';
import { Modal } from '../shared/Modal';

const TYPES: Array<{ value: CatalogSourceType; label: string }> = [
  { value: 'utcef', label: 'UTCEF' },
  { value: 'grib2', label: 'GRIB2' },
  { value: 'harmonic', label: 'Harmonic' },
];

/**
 * Quick filters shared by both List and Map views (PRD §5.1). Everything
 * lives on ONE horizontally-scrollable line: the type pills, a single "Tags"
 * chip, and the currently-active tag chips. The full tag vocabulary (a dozen+
 * entries in the real catalog) opens in a bottom sheet instead of being
 * splashed across the screen — on a 7" helm display the old tag wall consumed
 * more height than the dataset list itself.
 */
export function QuickFilters({ availableTags }: { availableTags: string[] }) {
  const filters = useAppStore((s) => s.filters);
  const setFilters = useAppStore((s) => s.setFilters);
  const [tagsOpen, setTagsOpen] = useState(false);

  const toggleType = (t: CatalogSourceType) => {
    const next = new Set(filters.types);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setFilters({ types: next });
  };
  const toggleTag = (tag: string) => {
    const next = new Set(filters.tags);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    setFilters({ tags: next });
  };

  const pillClass = (active: boolean) =>
    `min-h-9 shrink-0 rounded-full px-3.5 text-xs font-medium transition-colors ${
      active ? 'bg-accent text-bg' : 'bg-surface-2 text-muted'
    }`;

  return (
    <div className="no-scrollbar -mx-3 flex items-center gap-1.5 overflow-x-auto px-3" role="group" aria-label="Filters">
      <button
        type="button"
        onClick={() => setFilters({ types: new Set() })}
        className={pillClass(filters.types.size === 0)}
        aria-pressed={filters.types.size === 0}
      >
        All
      </button>
      {TYPES.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => toggleType(value)}
          className={pillClass(filters.types.has(value))}
          aria-pressed={filters.types.has(value)}
        >
          {label}
        </button>
      ))}
      {availableTags.length > 0 && (
        <>
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />
          <button
            type="button"
            onClick={() => setTagsOpen(true)}
            className={`flex items-center gap-1.5 ${pillClass(filters.tags.size > 0)}`}
            aria-haspopup="dialog"
          >
            <Icon name="tag" className="h-3.5 w-3.5" />
            Tags
            {filters.tags.size > 0 && (
              <span className="rounded-full bg-bg/25 px-1.5 text-[11px] font-semibold tabular-nums">{filters.tags.size}</span>
            )}
          </button>
          {[...filters.tags].map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              aria-label={`Remove tag filter ${tag}`}
              className="flex min-h-9 shrink-0 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-3 text-xs text-accent"
            >
              {tag}
              <Icon name="x" className="h-3 w-3" />
            </button>
          ))}
        </>
      )}
      {tagsOpen && (
        <Modal title="Filter by tag" onClose={() => setTagsOpen(false)}>
          <div className="flex flex-wrap gap-2 pb-2 pt-1">
            {availableTags.map((tag) => {
              const active = filters.tags.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  aria-pressed={active}
                  className={`flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm ${
                    active ? 'bg-accent font-medium text-bg' : 'bg-surface-2 text-muted'
                  }`}
                >
                  {active && <Icon name="check" className="h-3.5 w-3.5" />}
                  {tag}
                </button>
              );
            })}
          </div>
          {filters.tags.size > 0 && (
            <button
              type="button"
              onClick={() => setFilters({ tags: new Set() })}
              className="min-h-11 text-sm font-medium text-accent"
            >
              Clear all tags
            </button>
          )}
        </Modal>
      )}
    </div>
  );
}
