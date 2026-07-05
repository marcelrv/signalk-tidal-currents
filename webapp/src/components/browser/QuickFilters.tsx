import { useAppStore } from '../../store/useAppStore';
import { CatalogSourceType } from '../../api/types';

const TYPES: Array<{ value: CatalogSourceType; label: string }> = [
  { value: 'utcef', label: 'UTCEF' },
  { value: 'grib2', label: 'GRIB2' },
  { value: 'harmonic', label: 'Harmonic' },
];

/** Quick filters shared by both List and Map views (PRD §5.1): pill toggles + free tag filtering. Filtering keys strictly off the catalog `type` field. */
export function QuickFilters({ availableTags }: { availableTags: string[] }) {
  const filters = useAppStore((s) => s.filters);
  const setFilters = useAppStore((s) => s.setFilters);

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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by type">
        <button
          type="button"
          onClick={() => setFilters({ types: new Set() })}
          className={`min-h-11 rounded-full border px-4 text-sm ${filters.types.size === 0 ? 'border-accent bg-accent/10 text-accent' : 'border-muted/40 text-muted'}`}
          aria-pressed={filters.types.size === 0}
        >
          All
        </button>
        {TYPES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            onClick={() => toggleType(value)}
            className={`min-h-11 rounded-full border px-4 text-sm ${filters.types.has(value) ? 'border-accent bg-accent/10 text-accent' : 'border-muted/40 text-muted'}`}
            aria-pressed={filters.types.has(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {availableTags.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by tag">
          {availableTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              className={`min-h-11 rounded-full border px-3 text-xs ${filters.tags.has(tag) ? 'border-accent bg-accent/10 text-accent' : 'border-muted/40 text-muted'}`}
              aria-pressed={filters.tags.has(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
