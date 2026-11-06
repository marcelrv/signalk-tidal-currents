// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * One shared cell index over a fixed list of positioned items (UTCEF stations,
 * legacy harmonic stations). Items are bucketed into `cellDeg` lat/lon cells;
 * every query touches only the cells its box covers, so a probe costs
 * O(items nearby) instead of O(all items) — the difference between ~µs and
 * tens of ms per point with 200k stations.
 *
 * Longitude cell indices wrap modulo 360, so probes near the antimeridian find
 * items on the other side of it. Ties between equidistant items are broken by
 * array rank (the earliest item wins), which is what the linear scans these
 * indexes replace do.
 */

const DEG2RAD = Math.PI / 180;

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

/**
 * Exact angular longitude half-width (degrees, slightly padded) of a circle of
 * angular radius `dLatDeg` centred at `lat`: asin(sin d / cos(|lat|+d)).
 * Returns 360 when the circle reaches a pole (all longitudes).
 */
export function lonHalfWidthDeg(lat: number, dLatDeg: number): number {
  const cosP = Math.cos((Math.abs(lat) + dLatDeg) * DEG2RAD);
  const ratio = cosP > 0 ? Math.sin(dLatDeg * DEG2RAD) / cosP : 2;
  if (Math.abs(lat) + dLatDeg >= 90 || ratio >= 1) return 360;
  return (Math.asin(ratio) / DEG2RAD) * 1.01 + 1e-6;
}

/**
 * True when `lon` (any range) falls inside [west, east] modulo 360 — map
 * clients (Freeboard) send viewports past ±180 (e.g. 170…190 across the
 * antimeridian) while stations are stored in −180…180.
 */
export function lonInSpan(lon: number, west: number, east: number): boolean {
  return lon + 360 * Math.ceil((west - lon) / 360) <= east;
}

export interface CellIndex<T> {
  readonly items: readonly T[];
  /** Cell key of a position (for callers bucketing other things — e.g. polygons — on the same grid). */
  keyAt(lat: number, lon: number): number;
  /** Cell key from integer cell coordinates (longitude wrapped). */
  cellKey(j: number, i: number): number;
  /**
   * The nearest item within `maxKm` (distance rounded to 10 m), earliest array
   * rank on ties; `accept` filters candidates. Null when none qualifies.
   */
  nearestWithin(lat: number, lon: number, maxKm: number, accept?: (item: T) => boolean): T | null;
  /** Calls `fn(item, roundedKm, rank)` for every item within `maxKm`. */
  within(lat: number, lon: number, maxKm: number, fn: (item: T, km: number, rank: number) => void): void;
  /** Items inside a lon/lat box (inclusive; longitudes compared modulo 360), in array order. */
  inBbox(west: number, south: number, east: number, north: number): T[];
}

export function createCellIndex<T>(
  items: readonly T[],
  latOf: (item: T) => number,
  lonOf: (item: T) => number,
  cellDeg = 0.5,
): CellIndex<T> {
  const nLon = Math.round(360 / cellDeg);
  const jOff = Math.ceil(90 / cellDeg) + 1;
  const wrap = (i: number) => ((i % nLon) + nLon) % nLon;
  const cellKey = (j: number, i: number): number => (j + jOff) * nLon + wrap(i);
  // Positions as typed arrays: the probe loops below touch them for every
  // candidate, and a typed-array read is far cheaper than a callback.
  const lats = new Float64Array(items.length);
  const lons = new Float64Array(items.length);
  // Cell → ranks (array indexes) of its items, ascending.
  const cells = new Map<number, number[]>();
  for (let r = 0; r < items.length; r++) {
    lats[r] = latOf(items[r]);
    lons[r] = lonOf(items[r]);
    const k = cellKey(Math.floor(lats[r] / cellDeg), Math.floor(lons[r] / cellDeg));
    const list = cells.get(k);
    if (list) list.push(r);
    else cells.set(k, [r]);
  }
  // Each cell's ranks sorted by latitude (then rank), so the d = 0 probe below
  // finds the items within metres of a point by binary search even when a cell
  // holds thousands of them (a harbour with dense stations). Box scans don't
  // care about the order; inBbox re-sorts by rank.
  for (const list of cells.values()) if (list.length > 8) list.sort((a, b) => lats[a] - lats[b] || a - b);
  const EMPTY: number[] = [];

  // Query state of nearestWithin (synchronous and non-reentrant, so shared
  // instead of allocating closures per probe).
  let qLat = 0;
  let qLon = 0;
  let qMaxKm = 0;
  let qBest = -1;
  let qBestD = Infinity;
  let qAccept: ((item: T) => boolean) | undefined;
  const consider = (r: number) => {
    if (qAccept && !qAccept(items[r])) return;
    const d = Math.round(distanceKm(qLat, qLon, lats[r], lons[r]) * 100) / 100;
    if (d <= qMaxKm && (d < qBestD || (d === qBestD && r < qBest))) {
      qBest = r;
      qBestD = d;
    }
  };
  /** The d = 0 candidates of one cell: items within metres of the probe. */
  const considerNear = (j: number, i: number) => {
    const list = cells.get(cellKey(j, i)) ?? EMPTY;
    let n = 0;
    if (list.length > 8) {
      // First entry with lat >= qLat - 1e-3 (the list is lat-sorted).
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lats[list[mid]] < qLat - 1e-3) lo = mid + 1;
        else hi = mid;
      }
      n = lo;
    }
    for (; n < list.length; n++) {
      const r = list[n];
      if (list.length > 8 && lats[r] >= qLat + 1e-3) break;
      if (Math.abs(lats[r] - qLat) < 1e-3 && Math.abs(lons[r] - qLon) < 1e-2) consider(r);
    }
  };

  /** Cell-coordinate box (padded) around a circle of `maxKm`; null when a linear pass is cheaper. */
  const boxFor = (lat: number, lon: number, maxKm: number) => {
    // Padded (110 km/deg < the true ~111.19) and the longitude span taken at the
    // poleward edge, so the box never under-covers; callers test exact distance.
    const dLat = maxKm / 110;
    const dLon = lonHalfWidthDeg(lat, dLat);
    const polar = dLon >= 360;
    const j0 = Math.floor((lat - dLat) / cellDeg);
    const j1 = Math.floor((lat + dLat) / cellDeg);
    const i0 = Math.floor((lon - dLon) / cellDeg);
    const i1 = polar ? i0 + nLon - 1 : Math.min(Math.floor((lon + dLon) / cellDeg), i0 + nLon - 1);
    if ((j1 - j0 + 1) * (i1 - i0 + 1) > items.length) return null; // more cells than items: scan the items
    return { j0, j1, i0, i1 };
  };

  return {
    items,
    keyAt: (lat, lon) => cellKey(Math.floor(lat / cellDeg), Math.floor(lon / cellDeg)),
    cellKey,

    nearestWithin(lat, lon, maxKm, accept) {
      qLat = lat;
      qLon = lon;
      qMaxKm = maxKm;
      qBest = -1;
      qBestD = Infinity;
      qAccept = accept;
      // Fast path: probing at (or within metres of) an item — the common case
      // when /grid asks about its own in-view stations. A d = 0 hit in the
      // probe's own cell cannot be beaten, so the neighbourhood scan is
      // skipped. A rounded d = 0 means < 5 m, so besides the probe's own cell
      // only a neighbour whose edge is within that margin can hold one
      // (stations on regular grids often sit exactly on cell edges).
      const cj = Math.floor(lat / cellDeg);
      const ci = Math.floor(lon / cellDeg);
      const mLat = 1e-4;
      const mLon = mLat / Math.max(Math.cos(lat * DEG2RAD), 0.01);
      considerNear(cj, ci);
      const southEdge = lat - cj * cellDeg < mLat;
      const northEdge = (cj + 1) * cellDeg - lat < mLat;
      const westEdge = lon - ci * cellDeg < mLon;
      const eastEdge = (ci + 1) * cellDeg - lon < mLon;
      if (southEdge) considerNear(cj - 1, ci);
      if (northEdge) considerNear(cj + 1, ci);
      if (westEdge) {
        considerNear(cj, ci - 1);
        if (southEdge) considerNear(cj - 1, ci - 1);
        if (northEdge) considerNear(cj + 1, ci - 1);
      }
      if (eastEdge) {
        considerNear(cj, ci + 1);
        if (southEdge) considerNear(cj - 1, ci + 1);
        if (northEdge) considerNear(cj + 1, ci + 1);
      }
      if (qBestD === 0) return items[qBest];

      const box = boxFor(lat, lon, maxKm);
      if (!box) {
        for (let r = 0; r < items.length; r++) consider(r);
      } else {
        for (let j = box.j0; j <= box.j1; j++) {
          for (let i = box.i0; i <= box.i1; i++) {
            const list = cells.get(cellKey(j, i)) ?? EMPTY;
            for (let n = 0; n < list.length; n++) consider(list[n]);
          }
        }
      }
      return qBest < 0 ? null : items[qBest];
    },

    within(lat, lon, maxKm, fn) {
      const visit = (r: number) => {
        const d = Math.round(distanceKm(lat, lon, lats[r], lons[r]) * 100) / 100;
        if (d <= maxKm) fn(items[r], d, r);
      };
      const box = Number.isFinite(maxKm) ? boxFor(lat, lon, maxKm) : null;
      if (!box) {
        for (let r = 0; r < items.length; r++) visit(r);
        return;
      }
      for (let j = box.j0; j <= box.j1; j++) {
        for (let i = box.i0; i <= box.i1; i++) for (const r of cells.get(cellKey(j, i)) ?? EMPTY) visit(r);
      }
    },

    inBbox(west, south, east, north) {
      const found: number[] = [];
      const j0 = Math.floor(south / cellDeg);
      const j1 = Math.floor(north / cellDeg);
      const wide = east - west >= 360;
      const i0 = wide ? 0 : Math.floor(west / cellDeg);
      const i1 = wide ? nLon - 1 : Math.floor(east / cellDeg);
      const take = (r: number) => {
        const lat = lats[r];
        if (lat >= south && lat <= north && lonInSpan(lons[r], west, east)) found.push(r);
      };
      if ((j1 - j0 + 1) * (i1 - i0 + 1) > items.length) {
        for (let r = 0; r < items.length; r++) take(r);
      } else {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const list = cells.get(cellKey(j, i)) ?? EMPTY;
            for (let n = 0; n < list.length; n++) take(list[n]);
          }
        }
      }
      // Array order (typed-array sort: numeric and fast).
      const ranks = Uint32Array.from(found).sort();
      const out = new Array<T>(ranks.length);
      for (let n = 0; n < ranks.length; n++) out[n] = items[ranks[n]];
      return out;
    },
  };
}
