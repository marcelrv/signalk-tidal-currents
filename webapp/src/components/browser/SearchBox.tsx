import { useAppStore } from '../../store/useAppStore';

/** Search-as-you-type across name/description/region/tags (PRD §5.1). */
export function SearchBox() {
  const query = useAppStore((s) => s.filters.query);
  const setFilters = useAppStore((s) => s.setFilters);
  return (
    <input
      type="search"
      value={query}
      onChange={(e) => setFilters({ query: e.target.value })}
      placeholder="Search datasets…"
      aria-label="Search datasets"
      className="min-h-11 w-full rounded border border-muted/40 bg-surface px-3 text-fg placeholder:text-muted"
    />
  );
}
