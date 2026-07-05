import { pointInGeometry } from './geo';
import { SourceRow } from './sources';

/** Fallback tie-break when two candidates have the same (or both unknown) size — mirrors the backend's DEFAULT_PRIORITY. */
const TYPE_ORDER: Record<SourceRow['source']['type'], number> = { grib2: 0, utcef: 1, harmonic: 2 };

/**
 * Rows covering a position, ranked by ascending total download size (PRD
 * §5.2 / §10 Q2 — the only concrete, honest metric the catalog provides).
 * Tested against each row's OWN geometry (a per-region row uses that
 * region's polygon, not the whole source's), since only one region of a
 * multi-region source may actually cover the position.
 */
export function coveringRows(rows: SourceRow[], lat: number, lon: number): SourceRow[] {
  return rows
    .filter((r) => pointInGeometry(r.geometry, lat, lon))
    .sort((a, b) => {
      const sizeA = a.sizeBytes;
      const sizeB = b.sizeBytes;
      if (sizeA === null && sizeB === null) return TYPE_ORDER[a.source.type] - TYPE_ORDER[b.source.type];
      if (sizeA === null) return 1; // unknown-size (forecast) rows sort last
      if (sizeB === null) return -1;
      return sizeA - sizeB || TYPE_ORDER[a.source.type] - TYPE_ORDER[b.source.type];
    });
}
