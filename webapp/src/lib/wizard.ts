import { CatalogSource } from '../api/types';
import { bboxContains, pointInGeometry } from './geo';
import { totalSizeBytes } from './sources';

/** Fallback tie-break when two candidates have the same (or both unknown) size — mirrors the backend's DEFAULT_PRIORITY. */
const TYPE_ORDER: Record<CatalogSource['type'], number> = { grib2: 0, utcef: 1, harmonic: 2 };

/**
 * Sources covering a position, ranked by ascending total download size (PRD
 * §5.2 / §10 Q2 — the only concrete, honest metric the catalog provides).
 * Bounding-box containment is the fast filter; boundary_geometry
 * containment narrows it to the actually-covering shape.
 */
export function coveringSources(sources: CatalogSource[], lat: number, lon: number): CatalogSource[] {
  return sources
    .filter((s) => bboxContains(s.region.bounding_box, lat, lon) && pointInGeometry(s.region.boundary_geometry, lat, lon))
    .sort((a, b) => {
      const sizeA = totalSizeBytes(a);
      const sizeB = totalSizeBytes(b);
      if (sizeA === null && sizeB === null) return TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
      if (sizeA === null) return 1; // unknown-size (forecast) sources sort last
      if (sizeB === null) return -1;
      return sizeA - sizeB || TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    });
}
