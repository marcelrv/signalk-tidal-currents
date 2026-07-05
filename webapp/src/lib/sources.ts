import { CatalogSource, DatasetEntry, isTemplateFile } from '../api/types';

export type DisplayStatus = 'active' | 'update-available' | 'not-installed' | 'error';

/** Cross-references a catalog source against the installed-dataset inventory (PRD §4 status vocabulary). */
export function displayStatus(dataset: DatasetEntry | undefined): DisplayStatus {
  return dataset ? dataset.status : 'not-installed';
}

/** Total known download size for a source, or null when it can't be known up front (a template/forecast source has no size_bytes). */
export function totalSizeBytes(source: CatalogSource): number | null {
  let total = 0;
  for (const f of source.files) {
    if (isTemplateFile(f)) return null;
    total += f.size_bytes;
  }
  return total;
}

export function datasetForSource(datasets: DatasetEntry[], sourceId: string): DatasetEntry | undefined {
  return datasets.find((d) => d.catalogSourceId === sourceId);
}

export interface SourceFilters {
  types: Set<CatalogSource['type']>;
  query: string;
  tags: Set<string>;
}

export function matchesFilters(source: CatalogSource, filters: SourceFilters): boolean {
  if (filters.types.size > 0 && !filters.types.has(source.type)) return false;
  if (filters.tags.size > 0 && ![...filters.tags].every((t) => source.tags.includes(t))) return false;
  if (filters.query.trim()) {
    const q = filters.query.trim().toLowerCase();
    const haystack = `${source.name} ${source.description} ${source.region.name} ${source.tags.join(' ')}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/** Groups sources by provider (`source` field, PRD §5.1 "rows grouped by provider"), preserving first-seen provider order. */
export function groupByProvider(sources: CatalogSource[]): Array<{ provider: string; sources: CatalogSource[] }> {
  const order: string[] = [];
  const groups = new Map<string, CatalogSource[]>();
  for (const s of sources) {
    if (!groups.has(s.source)) {
      groups.set(s.source, []);
      order.push(s.source);
    }
    groups.get(s.source)!.push(s);
  }
  return order.map((provider) => ({ provider, sources: groups.get(provider)! }));
}
