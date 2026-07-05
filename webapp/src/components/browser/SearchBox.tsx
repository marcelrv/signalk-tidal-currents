import { useAppStore } from '../../store/useAppStore';
import { Icon } from '../shared/Icon';

/** Search-as-you-type across name/description/region/tags (PRD §5.1). */
export function SearchBox() {
  const query = useAppStore((s) => s.filters.query);
  const setFilters = useAppStore((s) => s.setFilters);
  return (
    <div className="relative min-w-0 flex-1">
      <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        value={query}
        onChange={(e) => setFilters({ query: e.target.value })}
        placeholder="Search datasets"
        aria-label="Search datasets"
        className="min-h-11 w-full rounded-xl border border-border bg-surface pl-9 pr-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
      />
    </div>
  );
}
