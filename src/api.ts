// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * REST API for tidal current predictions.
 *
 * Mounted twice by the plugin:
 *   /plugins/signalk-tidal-currents/…   (Signal K v1 plugin router — always)
 *   /signalk/v2/api/currents/…          (v2-style domain API, same routes)
 *
 * Two data sources feed the API:
 *   - harmonic STATIONS (HARMONIC/HARMONIC.IDX) — station-centric endpoints
 *   - gridded GRIB2 current fields — positional only, no station concept
 *
 * Endpoints:
 *   GET /                       — dataset summary (both sources)
 *   GET /stations?latitude=&longitude=[&limit=]    — nearest current stations (harmonics only)
 *   GET /stations?bbox=w,s,e,n[&limit=]             — every current station inside a viewport (harmonics only)
 *   GET /stations/:id           — station metadata
 *   GET /stations/:id/timeline?start=&end=[&step=] — signed speed + set/drift
 *   GET /timeline?latitude=&longitude=[&start=&end=&step=] — position timeline (GRIB and/or station)
 *   GET /vector?latitude=&longitude=[&time=]       — vector at a position (GRIB preferred, station fallback)
 *   GET /grid?bbox=w,s,e,n[&time=&maxPoints=]      — vector field over a viewport: GRIB lattice + UTCEF stations, per-point source priority
 */

import { GribSource, GridSeries, gribLatticeWindow, gribSummary } from './gribcurrents.js';
import { HarmonicsData, IdxStation } from './harmonics.js';
import { DatasetRankEntry, SourceType } from './priority.js';
import { CurrentSample, isVectorCapable, nearestCurrentStations, stationsInBbox, timeline } from './predict.js';
import {
  Claim,
  REST_FALLBACK_MAX_KM,
  ResolveCtx,
  ResolvedVector,
  claimAt,
  createResolveCtx,
  resolveAt,
  sampleClaimAt,
} from './resolve.js';
import {
  UtcefCurrentStation,
  UtcefSource,
  nearestUtcefStations,
  utcefSampleAt,
  utcefStationsInBbox,
  utcefSummary,
} from './utcef.js';

// Minimal express-compatible typings (the router instance is supplied by the
// Signal K server; this plugin has no runtime dependency on express).
interface Req {
  params: Record<string, string>;
  query: Record<string, unknown>;
}
interface Res {
  json(body: unknown): void;
  status(code: number): Res;
}
export interface RouterLike {
  get(path: string, handler: (req: Req, res: Res) => void): void;
}

export interface ApiState {
  data: HarmonicsData | null;
  error: string | null;
  /** Gridded GRIB2 current source; null/undefined when not configured. */
  grib?: GribSource | null;
  /** UTCEF current source; null/undefined when not configured. */
  utcef?: UtcefSource | null;
  /** When several sources cover a position/time, use GRIB first (default true). Superseded by sourcePriority when set. */
  preferGrib?: boolean;
  /** Explicit source-type rank (PRD §5.3 Phase 1); falls back to the preferGrib boolean when unset. */
  sourcePriority?: SourceType[];
  /**
   * Per-dataset priority stack (PRD §5.3 Phase 3), top-first. A getter (not
   * a snapshot) because the stack changes with every download/delete/reorder;
   * the provider is expected to memoize — the resolver runs per timeline
   * sample. Datasets probe only their own files; anything not covered by the
   * stack (orphan files, the legacy harmonic pair) is still found by the
   * type-rank fallback pass.
   */
  datasetRank?: () => DatasetRankEntry[];
}

export { REST_FALLBACK_MAX_KM, UTCEF_DATASET_FALLBACK_MAX_KM, resolvedStationName } from './resolve.js';
export type { ResolvedVector } from './resolve.js';

/**
 * Vector at a position/time from the best available source: a one-point
 * resolver context + resolveAt (src/resolve.ts — the single place that
 * decides who answers). `maxStationKm` bounds the station searches
 * (REST_FALLBACK_MAX_KM for the REST API, the configured limit for delta
 * publishing — never truly unbounded, so a query far from any coverage
 * returns "no data" instead of a station on the other side of the planet).
 */
export function resolveVector(
  state: ApiState,
  lat: number,
  lon: number,
  timeMs: number,
  maxStationKm = REST_FALLBACK_MAX_KM,
): ResolvedVector | null {
  return resolveAt(createResolveCtx(state, maxStationKm), lat, lon, timeMs);
}

function stationInfo(s: IdxStation, extra: Record<string, unknown> = {}) {
  return {
    id: s.id,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    type: s.isSubordinate ? 'subordinate' : 'reference',
    referenceName: s.offsets?.referenceName,
    floodDir: s.offsets?.floodDir ?? null,
    ebbDir: s.offsets?.ebbDir ?? null,
    ...extra,
  };
}

/** stationInfo-compatible view of a UTCEF current station (always vector-capable). */
function utcefStationInfo(s: UtcefCurrentStation, extra: Record<string, unknown> = {}) {
  return {
    id: s.id,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    type: 'harmonic',
    source: 'utcef' as const,
    constituents: s.constituents.length,
    vectorCapable: true,
    ...extra,
  };
}

function parsePosition(req: Req, res: Res): { lat: number; lon: number } | null {
  const lat = parseFloat(String(req.query.latitude));
  const lon = parseFloat(String(req.query.longitude));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'latitude and longitude query parameters are required' });
    return null;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.status(400).json({ error: 'latitude must be between -90 and 90, longitude between -180 and 180' });
    return null;
  }
  return { lat, lon };
}

function parseBbox(
  req: Req,
  res: Res,
): { west: number; south: number; east: number; north: number } | null {
  const parts = String(req.query.bbox ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    res.status(400).json({ error: 'bbox query parameter must be "west,south,east,north"' });
    return null;
  }
  const [west, south, east, north] = parts;
  if (south >= north || west >= east) {
    res.status(400).json({ error: 'bbox must have south < north and west < east' });
    return null;
  }
  return { west, south, east, north };
}

function parseWindow(
  req: Req,
  res: Res,
): { start: number; end: number; stepMs: number } | null {
  const start = req.query.start ? Date.parse(String(req.query.start)) : Date.now();
  const end = req.query.end ? Date.parse(String(req.query.end)) : start + 24 * 3600_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    res.status(400).json({ error: 'invalid start/end — expected ISO 8601, end after start' });
    return null;
  }
  const stepMin = Math.max(5, Math.min(120, parseInt(String(req.query.step), 10) || 10));
  if ((end - start) / (stepMin * 60_000) > 2000) {
    res.status(400).json({ error: 'window too large for the requested step' });
    return null;
  }
  return { start, end, stepMs: stepMin * 60_000 };
}

/**
 * Cell sizes (degrees) for stable spatial thinning, fine → coarse. Cell
 * boundaries are aligned to the global origin (multiples of the size from
 * lon/lat 0), NOT to the query bbox — so which stations survive thinning
 * depends only on where they are, never on the viewport. Panning at a fixed
 * density reveals/hides points from one stable set; zooming across a level
 * re-grids like a tile pyramid, as the /grid lattice does with its power-of-two
 * strides. Same philosophy, applied to irregularly-placed stations.
 */
const CELL_LADDER_DEG = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 40];

/** Upper bound on LEGACY harmonic stations gathered from a viewport before thinning — a guard against a pathological all-of-earth query, well above any real single-viewport station count. UTCEF stations are not capped (utcefStationsInBbox): stopping early in array order would make the thinned set depend on file load order. */
export const STATION_GATHER_CAP = 50_000;

interface GeoItem {
  lat: number;
  lon: number;
}

/**
 * One occupied cell's chosen representative: the item nearest its cell
 * center (even spatial coverage). Ties in distance are broken by (lat, lon)
 * so the result is deterministic regardless of input order — a regular
 * station grid puts two points exactly equidistant from a cell center, and
 * a "first seen wins" tiebreak would otherwise make the thinned set depend
 * on iteration order (and so shuffle as sources reload).
 */
function pickCellReps<T extends GeoItem>(items: T[], sizeDeg: number, limit: number): T[] | null {
  // Numeric cell keys and parallel arrays: this runs over every in-view
  // station (hundreds of thousands zoomed out), so no string keys / per-item
  // objects. Cell indices stay far below 2^19 at the finest ladder level.
  const slotOf = new Map<number, number>();
  const reps: T[] = [];
  const d2s: number[] = [];
  for (const it of items) {
    const ci = Math.floor(it.lon / sizeDeg);
    const cj = Math.floor(it.lat / sizeDeg);
    const centerLon = (ci + 0.5) * sizeDeg;
    const centerLat = (cj + 0.5) * sizeDeg;
    const d2 = (it.lon - centerLon) ** 2 + (it.lat - centerLat) ** 2;
    const key = cj * 1048576 + ci;
    const slot = slotOf.get(key);
    if (slot === undefined) {
      if (reps.length >= limit) return null; // more occupied cells than the budget: this level is too fine
      slotOf.set(key, reps.length);
      reps.push(it);
      d2s.push(d2);
    } else {
      const cur = reps[slot];
      if (d2 < d2s[slot] || (d2 === d2s[slot] && (it.lat < cur.lat || (it.lat === cur.lat && it.lon < cur.lon)))) {
        reps[slot] = it;
        d2s[slot] = d2;
      }
    }
  }
  return reps;
}

/**
 * Thin `items` down to at most `maxPoints`, keeping one representative per
 * grid cell at the finest ladder level whose occupancy fits the budget
 * (see CELL_LADDER_DEG for why this is stable across pan/zoom). Returns the
 * input untouched when it already fits — the "zoomed in, show everything"
 * case. Coarse → fine so we stop the moment a level overflows (occupancy
 * only grows as cells shrink).
 */
export function thinByCellLadder<T extends GeoItem>(items: T[], maxPoints: number): T[] {
  if (items.length <= maxPoints) return items;
  let chosen: T[] | null = null;
  for (let i = CELL_LADDER_DEG.length - 1; i >= 0; i--) {
    const reps = pickCellReps(items, CELL_LADDER_DEG[i], maxPoints);
    if (reps) chosen = reps;
    else break;
  }
  // Even the coarsest level overflows (maxPoints smaller than the number of
  // occupied 40° cells): fall back to that coarsest set, truncated.
  return chosen ?? pickCellReps(items, CELL_LADDER_DEG[CELL_LADDER_DEG.length - 1], Infinity)!.slice(0, maxPoints);
}

export function registerRoutes(router: RouterLike, state: ApiState): void {
  const gribData = () => state.grib?.get() ?? null;
  const utcefData = () => state.utcef?.get() ?? null;

  /** 503 unless at least one source (harmonics, UTCEF or GRIB) is loaded. */
  const notReady = (res: Res): boolean => {
    const u = utcefData();
    if (!state.data && !gribData() && !(u && u.currentStations.length > 0)) {
      res.status(503).json({
        error: state.error ?? 'no current data loaded (harmonics, UTCEF or GRIB2)',
      });
      return true;
    }
    return false;
  };

  router.get('/', (_req, res) => {
    if (notReady(res)) return;
    const d = state.data;
    const currents = d ? d.stations.filter((s) => s.isCurrent) : [];
    const g = gribData();
    res.json({
      harmonics: d
        ? {
            source: d.sourceDir,
            constituents: d.constituents.names.length,
            years: `${d.constituents.firstYear}–${d.constituents.firstYear + d.constituents.numYears - 1}`,
            stations: d.stations.length,
            currentStations: currents.length,
            vectorCapable: currents.filter(isVectorCapable).length,
          }
        : null,
      grib: g ? gribSummary(g) : null,
      utcef: (() => {
        const u = utcefData();
        return u ? utcefSummary(u) : null;
      })(),
      preferredSource: state.preferGrib === false ? 'station' : 'grib',
      disclaimer:
        'Predictions from community harmonic data, UTCEF datasets and/or forecast model GRIBs — not official, do not use as sole source for navigation.',
    });
  });

  router.get('/stations', (req, res) => {
    const u = utcefData();
    const haveUtcef = !!(u && u.currentStations.length > 0);
    // Station endpoints need a station-type source; either harmonics or UTCEF.
    if (!state.data && !haveUtcef) {
      res.status(503).json({ error: state.error ?? 'no station data loaded (harmonics or UTCEF)' });
      return;
    }

    // bbox mode: stations in a map viewport, not just the nearest few to a
    // single reference point. `maxPoints` (aliased by the legacy `limit`)
    // caps how many are returned — a zoomed-out client asks for a low value
    // and gets a spatially-even THINNED subset (stable across pan/zoom, see
    // thinByCellLadder), a zoomed-in client asks for more (or covers a small
    // enough area that everything fits) and gets full detail. This replaces
    // the old behaviour of truncating to the first 500 in array order, which
    // returned an arbitrary spatially-clustered subset and reshuffled as the
    // viewport moved.
    if (req.query.bbox !== undefined) {
      const bbox = parseBbox(req, res);
      if (!bbox) return;
      const maxPoints = Math.min(
        5000,
        Math.max(1, parseInt(String(req.query.maxPoints ?? req.query.limit), 10) || 500),
      );

      // Gather everything in the viewport first (capped), then thin the
      // MERGED set so harmonic + UTCEF together honour one budget.
      // `info` is built lazily — only for the stations that survive thinning.
      const gathered: Array<{ lat: number; lon: number; info: () => unknown }> = [];
      if (state.data) {
        for (const n of stationsInBbox(state.data, bbox.west, bbox.south, bbox.east, bbox.north, STATION_GATHER_CAP)) {
          gathered.push({ lat: n.station.latitude, lon: n.station.longitude, info: () => stationInfo(n.station, { vectorCapable: n.vectorCapable }) });
        }
      }
      if (u) {
        for (const s of utcefStationsInBbox(u, bbox)) {
          gathered.push({ lat: s.latitude, lon: s.longitude, info: () => utcefStationInfo(s) });
        }
      }
      res.json(thinByCellLadder(gathered, maxPoints).map((g) => g.info()));
      return;
    }

    const pos = parsePosition(req, res);
    if (!pos) return;
    const limit = Math.min(50, parseInt(String(req.query.limit), 10) || 10);
    const legacy = state.data
      ? nearestCurrentStations(state.data, pos.lat, pos.lon, limit).map((n) => ({
          distanceKm: n.distanceKm,
          info: stationInfo(n.station, { distanceKm: n.distanceKm, vectorCapable: n.vectorCapable }),
        }))
      : [];
    const utcefNear = u
      ? nearestUtcefStations(u, pos.lat, pos.lon, limit).map((n) => ({
          distanceKm: n.distanceKm,
          info: utcefStationInfo(n.station, { distanceKm: n.distanceKm }),
        }))
      : [];
    const result = [...legacy, ...utcefNear]
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit)
      .map((n) => n.info);
    res.json(result);
  });

  router.get('/stations/:id', (req, res) => {
    const s = state.data?.stations.find((st) => st.id === req.params.id);
    if (s) {
      res.json(stationInfo(s, { offsets: s.offsets }));
      return;
    }
    const us = utcefData()?.currentStations.find((st) => st.id === req.params.id);
    if (us) {
      res.json(utcefStationInfo(us));
      return;
    }
    res.status(404).json({ error: `unknown station: ${req.params.id}` });
  });

  router.get('/stations/:id/timeline', (req, res) => {
    const win = parseWindow(req, res);
    if (!win) return;

    const s = state.data?.stations.find((st) => st.id === req.params.id);
    if (s) {
      const samples = timeline(state.data!, s, win.start, win.end, win.stepMs);
      res.json({
        station: stationInfo(s),
        units: { speedKn: 'knots (signed, + = flood)', u: 'm/s east', v: 'm/s north' },
        estimated: s.isSubordinate,
        timeline: samples,
      });
      return;
    }

    const us = utcefData()?.currentStations.find((st) => st.id === req.params.id);
    if (us) {
      const samples: CurrentSample[] = [];
      for (let t = win.start; t <= win.end; t += win.stepMs) samples.push(utcefSampleAt(us, t));
      res.json({
        station: utcefStationInfo(us),
        units: { speedKn: 'knots (magnitude)', u: 'm/s east', v: 'm/s north' },
        estimated: false,
        timeline: samples,
      });
      return;
    }

    res.status(404).json({ error: `unknown station: ${req.params.id}` });
  });

  // Position-based timeline — the natural access pattern for gridded GRIB
  // data (no station in the request). Every sample goes through the same
  // resolver as /vector (resolveAt), so a window extending past the GRIB
  // forecast horizon degrades to the next source per sample rather than
  // failing, and /timeline can never disagree with /vector.
  router.get('/timeline', (req, res) => {
    if (notReady(res)) return;
    const pos = parsePosition(req, res);
    if (!pos) return;
    const win = parseWindow(req, res);
    if (!win) return;

    const ctx = createResolveCtx(state, REST_FALLBACK_MAX_KM);
    const samples: Array<CurrentSample & { source: 'grib' | 'utcef' | 'station' }> = [];
    let station: ResolvedVector | null = null; // first sample answered by a legacy station
    let utcefStation: ResolvedVector | null = null; // first sample answered by a UTCEF station
    for (let t = win.start; t <= win.end; t += win.stepMs) {
      const r = resolveAt(ctx, pos.lat, pos.lon, t);
      if (!r) continue;
      samples.push({ ...r.sample, source: r.source });
      if (r.source === 'station') station ??= r;
      else if (r.source === 'utcef') utcefStation ??= r;
    }
    if (samples.length === 0) {
      res.status(404).json({ error: 'no current data source covers this position/window' });
      return;
    }
    res.json({
      position: { latitude: pos.lat, longitude: pos.lon },
      station: station?.station ? stationInfo(station.station, { distanceKm: station.distanceKm }) : null,
      utcefStation: utcefStation?.utcefStation
        ? utcefStationInfo(utcefStation.utcefStation, { distanceKm: utcefStation.distanceKm })
        : null,
      units: {
        speedKn:
          'knots (legacy-station samples: signed along flood/ebb axis; UTCEF/GRIB samples: magnitude)',
        u: 'm/s east',
        v: 'm/s north',
      },
      timeline: samples,
    });
  });

  router.get('/vector', (req, res) => {
    if (notReady(res)) return;
    const pos = parsePosition(req, res);
    if (!pos) return;
    const time = req.query.time ? Date.parse(String(req.query.time)) : Date.now();
    if (!Number.isFinite(time)) {
      res.status(400).json({ error: 'invalid time — expected ISO 8601' });
      return;
    }
    const resolved = resolveVector(state, pos.lat, pos.lon, time);
    if (!resolved) {
      res.status(404).json({ error: 'no GRIB coverage and no vector-capable current station nearby' });
      return;
    }
    res.json({
      source: resolved.source,
      station: resolved.station
        ? stationInfo(resolved.station, { distanceKm: resolved.distanceKm })
        : resolved.utcefStation
          ? utcefStationInfo(resolved.utcefStation, { distanceKm: resolved.distanceKm })
          : null,
      sample: resolved.sample,
    });
  });

  // Current vector field over a viewport for map overlays — the gridded
  // equivalent of /stations?bbox=…. Candidate positions (GRIB lattice nodes
  // and in-view stations) are chosen here; WHO answers at each one is decided
  // by the resolver (resolveAt / claimAt in resolve.ts), exactly as /vector
  // does, so the map can never disagree with /vector or the published
  // deltas. See gridPoints for the density rule.
  router.get('/grid', (req, res) => {
    const g = gribData();
    const u = utcefData();
    const haveUtcef = !!(u && u.currentStations.length > 0);
    const stationsQ = String(req.query.stations ?? '').toLowerCase();
    const includeStations = stationsQ === '1' || stationsQ === 'true';
    if (!g && !haveUtcef && !(includeStations && state.data)) {
      res.status(503).json({ error: includeStations ? 'no GRIB, UTCEF or harmonic current data loaded' : 'no GRIB or UTCEF current data loaded' });
      return;
    }
    const bbox = parseBbox(req, res);
    if (!bbox) return;
    const time = req.query.time ? Date.parse(String(req.query.time)) : Date.now();
    if (!Number.isFinite(time)) {
      res.status(400).json({ error: 'invalid time — expected ISO 8601' });
      return;
    }
    const maxPoints = Math.min(5000, Math.max(1, parseInt(String(req.query.maxPoints), 10) || 400));
    const ctx = createResolveCtx(state, REST_FALLBACK_MAX_KM, { bbox, legacy: includeStations });
    res.json({
      time: new Date(time).toISOString(),
      units: { speedKn: 'knots (magnitude)', u: 'm/s east', v: 'm/s north' },
      points: gridPoints(ctx, bbox, time, maxPoints),
    });
  });
}

/** One /grid point: a GRIB lattice sample or a station, tagged with its source. */
export interface GridPoint {
  latitude: number;
  longitude: number;
  speedKn: number;
  direction: number;
  u: number;
  v: number;
  source: 'grib' | 'utcef' | 'station';
  stationId?: string;
}

type Bbox = { west: number; south: number; east: number; north: number };

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;
/** Numeric position key at the lattice's 1e-4° output rounding (lon folded into [0, 360)). */
const posKey = (lat: number, lon: number): number =>
  Math.round(lat * 1e4) * 4_000_000 + Math.round((((lon % 360) + 360) % 360) * 1e4);

/**
 * Geometry-only base stride of a lattice: the smallest power of two for which a
 * window of the bbox's size (`cellsX` × `cellsY` grid cells, plus the one-index
 * overhang of gribLatticeWindow on each side) holds at most `maxPoints`
 * nodes. Because the bound covers the worst window position, panning a
 * same-size view can never push the candidate count over the budget (and so
 * never triggers the candidate-thinning fallback in gridPoints).
 */
function baseStride(cellsX: number, cellsY: number, maxPoints: number): number {
  let s = 1;
  while (Math.ceil((cellsX + 2) / s) * Math.ceil((cellsY + 2) / s) > maxPoints && s < 2 ** 30) s *= 2;
  return s;
}

/** The point a resolved vector becomes at (lat, lon); null when it has no usable set/drift. */
function gridPointOf(r: ResolvedVector, lat: number, lon: number): GridPoint | null {
  const s = r.sample;
  if (s.u === null || s.v === null || s.direction === null) return null;
  const base = { latitude: lat, longitude: lon, direction: s.direction, u: s.u, v: s.v };
  if (r.source === 'grib') return { ...base, speedKn: s.speedKn, source: 'grib' };
  if (r.source === 'utcef') return { ...base, speedKn: s.speedKn, source: 'utcef', stationId: r.utcefStation!.id };
  return { ...base, speedKn: Math.abs(s.speedKn), source: 'station', stationId: r.station!.id };
}

/** One grid geometry's lattice for a request: its index window and its geometry-only base stride. */
interface LatticePlan {
  grid: GridSeries['grid'];
  win: { iMin: number; iMax: number; jMin: number; jMax: number };
  /** Power of two; depends only on the bbox size and this grid's cell size. */
  base: number;
}

/** Number of multiples of `stride` (from index 0) within [min, max]. */
const multiplesIn = (min: number, max: number, stride: number): number => {
  const n = Math.floor(max / stride) - Math.ceil(min / stride) + 1;
  return n > 0 ? n : 0;
};

/**
 * /grid points = candidate positions + the resolver.
 *
 * Density has ONE rule, and it looks only at geometry and counts — never at
 * what the data says:
 *   1. Each GRIB grid (distinct geometry) has a base stride, a power of two
 *      from the bbox size and the grid's cell size alone (baseStride). Lattice nodes are
 *      the grid's own (i, j) indices that are multiples of the stride, from
 *      index 0, so lattices at different strides NEST: a density change only
 *      adds or removes nodes, it never moves one.
 *   2. Station winners (in-view stations that win their own position, via
 *      claimAt) are found first; W = their number.
 *   3. Fill level k: every grid uses stride max(1, base / 2^k). The densest k
 *      with C(k) + W <= maxPoints is chosen, C(k) being the number of lattice
 *      CANDIDATES at that level (index arithmetic, no probing); k = 0 if none
 *      fits. That level's candidates are resolved once. Land and uncovered
 *      candidates count against the budget — deterministic, no trial passes.
 *   4. Each candidate p of grid G goes through resolveAt: a GRIB answer from
 *      G itself is emitted, a GRIB answer from another grid is dropped (that
 *      grid's own lattice shows it), a station answer is emitted as that
 *      station's vector (stationId), no answer is dropped.
 *   5. Winners whose position a lattice point already shows are skipped; the
 *      rest are thinned (thinByCellLadder) into what the lattice left.
 * The lattice never exceeds maxPoints (candidates are thinned first if k = 0
 * still overflows), so the total is <= maxPoints by construction.
 */
export function gridPoints(ctx: ResolveCtx, bbox: Bbox, time: number, maxPoints: number): GridPoint[] {
  // 1. Station winners (cheap: claim only, no sampling).
  interface Winner {
    lat: number;
    lon: number;
    claim: Claim;
  }
  const winners: Winner[] = [];
  const hasLayer = (type: 'utcef' | 'harmonic') => ctx.layers.some((l) => l.type === type);
  if (ctx.utcef && hasLayer('utcef')) {
    for (const s of utcefStationsInBbox(ctx.utcef, bbox)) {
      const claim = claimAt(ctx, s.latitude, s.longitude, time);
      if (claim && claim.source === 'utcef' && claim.station === s) winners.push({ lat: s.latitude, lon: s.longitude, claim });
    }
  }
  if (ctx.harmonics && hasLayer('harmonic')) {
    for (const { station, vectorCapable } of stationsInBbox(ctx.harmonics, bbox.west, bbox.south, bbox.east, bbox.north, Infinity)) {
      if (!vectorCapable) continue;
      const claim = claimAt(ctx, station.latitude, station.longitude, time);
      if (claim && claim.source === 'station' && claim.station === station) winners.push({ lat: station.latitude, lon: station.longitude, claim });
    }
  }

  // 2. Lattice plans: one per distinct grid geometry the GRIB layers answer from.
  const plans: LatticePlan[] = [];
  if (ctx.grib) {
    const geometries = new Set<GridSeries['grid']>();
    for (const l of ctx.layers) if (l.type === 'grib2') for (const s of l.series!) geometries.add(s.grid);
    const lonSpan = bbox.east - bbox.west;
    const latSpan = bbox.north - bbox.south;
    for (const series of ctx.grib.series) {
      const grid = series.grid;
      if (!geometries.has(grid)) continue;
      const win = gribLatticeWindow(grid, bbox);
      if (!win) continue;
      plans.push({ grid, win, base: baseStride(lonSpan / Math.abs(grid.di), latSpan / Math.abs(grid.dj), maxPoints) });
    }
  }
  const strideAt = (p: LatticePlan, k: number): number => Math.max(1, p.base / 2 ** k);
  const candidateCount = (k: number): number => {
    let n = 0;
    for (const p of plans) n += multiplesIn(p.win.iMin, p.win.iMax, strideAt(p, k)) * multiplesIn(p.win.jMin, p.win.jMax, strideAt(p, k));
    return n;
  };
  let level = 0;
  const maxLevel = plans.reduce((m, p) => Math.max(m, Math.log2(p.base)), 0);
  for (let k = maxLevel; k >= 1; k--) {
    if (candidateCount(k) + winners.length <= maxPoints) {
      level = k;
      break;
    }
  }

  // 3. The chosen level's candidates, resolved once.
  interface Cand {
    lat: number;
    lon: number;
    grid: GridSeries['grid'];
  }
  let cands: Cand[] = [];
  for (const p of plans) {
    const s = strideAt(p, level);
    const { grid, win } = p;
    for (let j = Math.ceil(win.jMin / s) * s; j <= win.jMax; j += s) {
      const lat = round4(grid.lat0 + j * grid.dj);
      for (let i = Math.ceil(win.iMin / s) * s; i <= win.iMax; i += s) {
        const lon = round4(((grid.lon0 + i * grid.di + 180) % 360 + 360) % 360 - 180);
        cands.push({ lat, lon, grid });
      }
    }
  }
  // Level 0 can still overflow (several overlapping grids, rounding at their
  // edges): thin the candidate POSITIONS (stable spatial ladder) so the
  // resolver is never asked about more than maxPoints positions.
  if (cands.length > maxPoints) cands = thinByCellLadder(cands, maxPoints);

  const points: GridPoint[] = [];
  const taken = new Set<number>();
  for (const c of cands) {
    const r = resolveAt(ctx, c.lat, c.lon, time, (claim) => claim.source !== 'grib' || claim.series.grid === c.grid);
    if (!r) continue;
    const key = posKey(c.lat, c.lon);
    if (taken.has(key)) continue; // a station answer already shown here by an overlapping lattice
    const pt = gridPointOf(r, c.lat, c.lon);
    if (!pt) continue;
    taken.add(key);
    points.push(pt);
  }

  // 4. Station winners the lattice does not already show, thinned into the rest of the budget.
  const free = taken.size === 0 ? winners : winners.filter((w) => !taken.has(posKey(w.lat, w.lon)));
  for (const w of thinByCellLadder(free, Math.max(0, maxPoints - points.length))) {
    const r = sampleClaimAt(ctx, w.claim, w.lat, w.lon, time);
    const pt = r ? gridPointOf(r, w.lat, w.lon) : null;
    if (pt) points.push(pt);
  }
  return points;
}
