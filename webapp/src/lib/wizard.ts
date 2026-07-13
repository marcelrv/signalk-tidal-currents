import { bboxAreaSqDeg, geometryBbox, pointInGeometry } from './geo';
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

/**
 * "Live forecast" (grib2/utcef forecast/nowcast files, go stale, need
 * periodic re-fetch) vs "always-available backup" (static harmonic
 * constituents or precomputed UTCEF tables, valid indefinitely once
 * downloaded) — the plain-language split the wizard presents to the user.
 * Keyed off `update_check.method` rather than raw `type`, since a `utcef`
 * source can be either a forecast table or a static station pack.
 */
export type WizardTier = 'live' | 'backup';

export function tierOf(row: SourceRow): WizardTier {
  return row.source.update_check.method === 'expiry' ? 'live' : 'backup';
}

/**
 * Ranks rows best-first within a tier: smaller bounding-box area (higher
 * resolution proxy — same heuristic as Auto-Sort Priority, `sources.ts`
 * `datasetCoverageAreaSqDeg`) first, then declared size ascending, then
 * `TYPE_ORDER` as a final tiebreak. A row with unknown area or size sorts
 * after rows with a known value in that criterion. This is why the
 * full-globe OpenCPN harmonic pack — whose bounding box is the whole
 * planet — will essentially never win against a real regional dataset.
 */
function rowAreaSqDeg(row: SourceRow): number | null {
  const bbox = geometryBbox(row.geometry);
  return bbox ? bboxAreaSqDeg(bbox) : null;
}

export function rankRows(rows: SourceRow[]): SourceRow[] {
  return rows
    .map((row) => ({ row, area: rowAreaSqDeg(row) }))
    .sort((a, b) => {
      if (a.area == null && b.area != null) return 1;
      if (a.area != null && b.area == null) return -1;
      if (a.area != null && b.area != null && a.area !== b.area) return a.area - b.area;

      const sizeA = a.row.sizeBytes;
      const sizeB = b.row.sizeBytes;
      if (sizeA === null && sizeB !== null) return 1;
      if (sizeA !== null && sizeB === null) return -1;
      if (sizeA !== null && sizeB !== null && sizeA !== sizeB) return sizeA - sizeB;

      return TYPE_ORDER[a.row.source.type] - TYPE_ORDER[b.row.source.type];
    })
    .map(({ row }) => row);
}

/** Partitions rows by `tierOf`, each list ranked best-first via `rankRows`. */
export function groupByTier(rows: SourceRow[]): { live: SourceRow[]; backup: SourceRow[] } {
  const live: SourceRow[] = [];
  const backup: SourceRow[] = [];
  for (const r of rows) (tierOf(r) === 'live' ? live : backup).push(r);
  return { live: rankRows(live), backup: rankRows(backup) };
}
