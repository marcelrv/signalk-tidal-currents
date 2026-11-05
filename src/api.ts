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

import { GribCurrentsData, GribSource, GridSample, gribGridSamples, gribSummary, gribVectorAt } from './gribcurrents.js';
import { HarmonicsData, IdxStation } from './harmonics.js';
import { DatasetRankEntry, SourceType } from './priority.js';
import {
  CurrentSample,
  currentSampleAt,
  nearestCurrentStations,
  stationsInBbox,
  timeline,
} from './predict.js';
import {
  UtcefCurrentStation,
  UtcefData,
  UtcefSource,
  nearestUtcefStations,
  utcefCoverageIndexFor,
  utcefSampleAt,
  utcefStationsInBbox,
  utcefSummary,
  utcefVectorAt,
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
   * the provider is expected to memoize — resolveVector runs per timeline
   * sample. Datasets probe only their own files; anything not covered by the
   * stack (orphan files, the legacy harmonic pair) is still found by the
   * type-rank fallback pass.
   */
  datasetRank?: () => DatasetRankEntry[];
}

export interface ResolvedVector {
  source: 'grib' | 'utcef' | 'station';
  sample: CurrentSample;
  /** Legacy-station path only: */
  station?: IdxStation;
  /** UTCEF-station path only: */
  utcefStation?: UtcefCurrentStation;
  distanceKm?: number;
}

/** Nearest-station fallback radius for a SINGLE dataset's probe in the priority stack (see fromUtcefDataset in resolveVector). */
export const UTCEF_DATASET_FALLBACK_MAX_KM = 50;

/**
 * Default nearest-station fallback radius for the merged type-rank pass
 * (REST /vector and /timeline, which don't pass an explicit maxStationKm).
 * Without a cap, a position with no GRIB/UTCEF coverage nearby would still
 * match whatever station happens to be nearest on the *entire* station list
 * — which, for a query far from any installed dataset (e.g. a boat outside
 * all configured regions), can be a station thousands of km away on another
 * continent. That's a "best guess", not useful data, so bound it the same
 * way the per-dataset probe already is — currents are driven by local
 * channel/bathymetry, not something a distant station approximates well
 * even within "the same region", so there's no case for going wider here
 * than the per-dataset radius.
 */
export const REST_FALLBACK_MAX_KM = UTCEF_DATASET_FALLBACK_MAX_KM;

/** Human-readable name of whichever station backed a resolved vector. */
export function resolvedStationName(r: ResolvedVector): string | null {
  if (r.source === 'station') return r.station?.name ?? null;
  if (r.source === 'utcef') return r.utcefStation?.name ?? null;
  return null;
}

/**
 * Vector at a position/time from the best available source. GRIB (a forecast
 * grid) wins when it covers the position/time unless preferGrib is false;
 * among station-type sources the modern UTCEF vector data is tried before the
 * legacy OpenCPN harmonics. `maxStationKm` bounds the station searches
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
  const fromGrib = (files?: ReadonlySet<string>): ResolvedVector | null => {
    const g = state.grib?.get();
    if (!g) return null;
    const sample = gribVectorAt(g, lat, lon, timeMs, files);
    return sample ? { source: 'grib', sample } : null;
  };
  const fromUtcef = (files?: ReadonlySet<string>, maxKm = maxStationKm): ResolvedVector | null => {
    const u = state.utcef?.get();
    if (!u) return null;
    const hit = utcefVectorAt(u, lat, lon, timeMs, maxKm, files);
    return hit
      ? { source: 'utcef', sample: hit.sample, utcefStation: hit.station, distanceKm: hit.distanceKm }
      : null;
  };
  // A SINGLE dataset's probe must not use the unlimited nearest-station
  // fallback the merged pass enjoys: "nearest station within this one file"
  // matches ANY position on earth, so a stacked Caribbean dataset would
  // claim a query in the North Sea just by being ranked and non-empty.
  // Containment (representative_area) still applies at any range; only the
  // nearest-fallback radius is clamped.
  const fromUtcefDataset = (files: ReadonlySet<string>): ResolvedVector | null =>
    fromUtcef(files, Math.min(maxStationKm, UTCEF_DATASET_FALLBACK_MAX_KM));
  const fromStation = (): ResolvedVector | null => {
    if (!state.data) return null;
    const near = nearestCurrentStations(state.data, lat, lon, 10).filter(
      (n) => n.vectorCapable && n.distanceKm <= maxStationKm,
    );
    if (near.length === 0) return null;
    const sample = currentSampleAt(state.data, near[0].station, timeMs);
    if (!sample) return null;
    return { source: 'station', sample, station: near[0].station, distanceKm: near[0].distanceKm };
  };

  // Per-dataset stack first (PRD §5.3 Phase 3): probe each installed dataset
  // in stack order, restricted to its own files, so a small high-res coastal
  // model ranked above a global one actually wins where they overlap — even
  // across source types, which the type rank below cannot express. The
  // legacy harmonic pair has no per-file provenance; a harmonic dataset
  // probes the whole legacy station source.
  for (const entry of state.datasetRank?.() ?? []) {
    const files = new Set(entry.files);
    const r =
      entry.type === 'grib2'
        ? fromGrib(files)
        : entry.type === 'utcef'
          ? fromUtcefDataset(files)
          : fromStation();
    if (r) return r;
  }

  // Type-rank fallback: catches everything without a stack entry — orphan
  // (manually dropped) files, the legacy pair, or no manifest at all.
  const fns: Record<SourceType, () => ResolvedVector | null> = { grib2: fromGrib, utcef: fromUtcef, harmonic: fromStation };
  for (const key of sourceRank(state)) {
    const r = fns[key]();
    if (r) return r;
  }
  return null;
}

/**
 * Source-type rank to try in order: an explicit `sourcePriority` (PRD §5.3
 * Phase 1) wins when set; otherwise falls back to the legacy `preferGrib`
 * boolean so existing saved configs keep behaving the same way.
 */
function sourceRank(state: ApiState): SourceType[] {
  return state.sourcePriority ?? (state.preferGrib === false ? ['utcef', 'harmonic', 'grib2'] : ['grib2', 'utcef', 'harmonic']);
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
 * re-grids like a tile pyramid, exactly as gribGridSamples does for the grid
 * lattice. Same philosophy, applied to irregularly-placed stations.
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
function pickCellReps<T extends GeoItem>(items: T[], sizeDeg: number): T[] {
  const best = new Map<string, { item: T; d2: number }>();
  for (const it of items) {
    const ci = Math.floor(it.lon / sizeDeg);
    const cj = Math.floor(it.lat / sizeDeg);
    const key = `${cj}:${ci}`;
    const centerLon = (ci + 0.5) * sizeDeg;
    const centerLat = (cj + 0.5) * sizeDeg;
    const d2 = (it.lon - centerLon) ** 2 + (it.lat - centerLat) ** 2;
    const cur = best.get(key);
    if (
      !cur ||
      d2 < cur.d2 ||
      (d2 === cur.d2 && (it.lat < cur.item.lat || (it.lat === cur.item.lat && it.lon < cur.item.lon)))
    ) {
      best.set(key, { item: it, d2 });
    }
  }
  return [...best.values()].map((v) => v.item);
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
    const reps = pickCellReps(items, CELL_LADDER_DEG[i]);
    if (reps.length <= maxPoints) chosen = reps;
    else break;
  }
  // Even the coarsest level overflows (maxPoints smaller than the number of
  // occupied 40° cells): fall back to that coarsest set, truncated.
  return chosen ?? pickCellReps(items, CELL_LADDER_DEG[CELL_LADDER_DEG.length - 1]).slice(0, maxPoints);
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
            vectorCapable: currents.filter(
              (s) => s.offsets && s.offsets.floodDir !== null && s.offsets.ebbDir !== null,
            ).length,
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
  // data (no station in the request). Each sample is taken from the
  // preferred source that covers the position at that instant, so a window
  // extending past the GRIB forecast horizon degrades to station data
  // per-sample rather than failing.
  router.get('/timeline', (req, res) => {
    if (notReady(res)) return;
    const pos = parsePosition(req, res);
    if (!pos) return;
    const win = parseWindow(req, res);
    if (!win) return;

    // Resolve the fallback stations once, not per sample. Bounded the same
    // way resolveVector's merged pass is (REST_FALLBACK_MAX_KM) — otherwise a
    // position outside all coverage would still pick up whatever station is
    // nearest on the entire station list, however far away that is.
    const near = state.data
      ? nearestCurrentStations(state.data, pos.lat, pos.lon, 10).filter(
          (n) => n.vectorCapable && n.distanceKm <= REST_FALLBACK_MAX_KM,
        )
      : [];
    const station = near.length > 0 ? near[0] : null;
    const u = utcefData();
    const utcefNearRaw = u ? nearestUtcefStations(u, pos.lat, pos.lon, 1)[0] ?? null : null;
    const utcefNear = utcefNearRaw && utcefNearRaw.distanceKm <= REST_FALLBACK_MAX_KM ? utcefNearRaw : null;
    const g = gribData();

    // Per-sample source candidates in preference order (same policy as
    // resolveVector: per-dataset stack first, then the type rank).
    let utcefUsed: { station: UtcefCurrentStation; distanceKm: number } | null = null;
    const fromGrib = (t: number) => (g ? gribVectorAt(g, pos.lat, pos.lon, t) : null);
    const fromUtcef = (t: number) => {
      if (!utcefNear) return null;
      const s = utcefSampleAt(utcefNear.station, t);
      if (s) utcefUsed ??= utcefNear;
      return s;
    };
    const fromStation = (t: number) =>
      station && state.data ? currentSampleAt(state.data, station.station, t) : null;
    const fns: Record<SourceType, (t: number) => CurrentSample | null> = { grib2: fromGrib, utcef: fromUtcef, harmonic: fromStation };
    const sourceLabel: Record<SourceType, 'grib' | 'utcef' | 'station'> = { grib2: 'grib', utcef: 'utcef', harmonic: 'station' };
    // A stack dataset's UTCEF station is resolved ONCE (containment/nearest
    // doesn't depend on time), then sampled per-t like the fallback path.
    const stackCandidates = (state.datasetRank?.() ?? []).map((entry) => {
      const files = new Set(entry.files);
      if (entry.type === 'grib2') {
        return { source: 'grib' as const, fn: (t: number) => (g ? gribVectorAt(g, pos.lat, pos.lon, t, files) : null) };
      }
      if (entry.type === 'utcef') {
        // Same clamped nearest-fallback radius as resolveVector's per-dataset probe.
        const hit = u ? utcefVectorAt(u, pos.lat, pos.lon, win.start, UTCEF_DATASET_FALLBACK_MAX_KM, files) : null;
        return {
          source: 'utcef' as const,
          fn: (t: number) => {
            if (!hit) return null;
            const s = utcefSampleAt(hit.station, t);
            if (s) utcefUsed ??= hit;
            return s;
          },
        };
      }
      return { source: 'station' as const, fn: fromStation };
    });
    const candidates: Array<{ source: 'grib' | 'utcef' | 'station'; fn: (t: number) => CurrentSample | null }> = [
      ...stackCandidates,
      ...sourceRank(state).map((key) => ({ source: sourceLabel[key], fn: fns[key] })),
    ];

    const samples: Array<CurrentSample & { source: 'grib' | 'utcef' | 'station' }> = [];
    const usedSources = new Set<string>();
    for (let t = win.start; t <= win.end; t += win.stepMs) {
      for (const cand of candidates) {
        const s = cand.fn(t);
        if (s) {
          usedSources.add(cand.source);
          samples.push({ ...s, source: cand.source });
          break;
        }
      }
    }
    if (samples.length === 0) {
      res.status(404).json({ error: 'no current data source covers this position/window' });
      return;
    }
    res.json({
      position: { latitude: pos.lat, longitude: pos.lon },
      station: usedSources.has('station') && station
        ? stationInfo(station.station, { distanceKm: station.distanceKm })
        : null,
      utcefStation: usedSources.has('utcef') && (utcefUsed ?? utcefNear)
        ? utcefStationInfo((utcefUsed ?? utcefNear)!.station, { distanceKm: (utcefUsed ?? utcefNear)!.distanceKm })
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
  // equivalent of /stations?bbox=…. Candidates are the GRIB lattice samples
  // (gribGridSamples) and the UTCEF 2D-vector stations in the bbox; each
  // candidate is kept only where its own source is the one resolveVector
  // would pick there (same dataset stack / sourcePriority / preferGrib), so
  // the map agrees with /vector and the published deltas wherever GRIB or
  // UTCEF is the winning source, and a viewport only partly covered by GRIB
  // still shows UTCEF arrows in the rest of it. The point budget is split
  // between the two sources. Legacy harmonic stations are not included (not
  // an overlay source here) and do not claim positions: where /vector would
  // resolve to a legacy station, /grid still shows the best GRIB/UTCEF point.
  router.get('/grid', (req, res) => {
    const g = gribData();
    const u = utcefData();
    const haveUtcef = !!(u && u.currentStations.length > 0);
    if (!g && !haveUtcef) {
      res.status(503).json({ error: 'no GRIB or UTCEF current data loaded' });
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
    const points = gridPoints(state, g, haveUtcef ? u : null, bbox, time, maxPoints);
    res.json({
      time: new Date(time).toISOString(),
      units: { speedKn: 'knots (magnitude)', u: 'm/s east', v: 'm/s north' },
      points,
    });
  });
}

/** One /grid point: a GRIB lattice sample or a UTCEF station, tagged with its source. */
export type GridPoint = GridSample & { source: 'grib' | 'utcef'; stationId?: string };

type Bbox = { west: number; south: number; east: number; north: number };

/**
 * /grid candidates merged by source priority. A "layer" is one probe of the
 * resolveVector order: per-dataset stack entries first (restricted to their
 * files), then the type rank (harmonic layers are skipped — see the route
 * comment). A candidate survives only if the first layer that claims its
 * position is of the candidate's own source type. Every candidate is claimed
 * by its own type layer at least (a GRIB sample has GRIB data there; a UTCEF
 * station is at distance 0 from itself), so a candidate is dropped only where
 * a higher-ranked source of the other type covers it.
 */
function gridPoints(
  state: ApiState,
  g: GribCurrentsData | null,
  u: UtcefData | null,
  bbox: Bbox,
  time: number,
  maxPoints: number,
): GridPoint[] {
  // Every station that can claim a point here is in the cached all-stations
  // coverage index (built once per loaded dataset, not per request), so only
  // the in-view stations need gathering.
  const inView = u ? utcefStationsInBbox(u, bbox) : [];

  // Priority arbitration (null = no UTCEF, nothing to arbitrate). Runs even
  // without GRIB: overlapping UTCEF datasets must still resolve to the
  // station /vector would return. winner() mirrors resolveVector: the first
  // layer that claims a position wins, and a UTCEF layer names its station.
  let winner: ((lat: number, lon: number) => { type: GridPoint['source']; station?: UtcefCurrentStation } | undefined) | null = null;
  let winnerAtStation: ((s: UtcefCurrentStation) => { type: GridPoint['source']; station?: UtcefCurrentStation } | undefined) | null = null;
  if (u) {
    const index = utcefCoverageIndexFor(u);
    type Win = { type: GridPoint['source']; station?: UtcefCurrentStation };
    // Each layer answers at an arbitrary point (GRIB lattice samples) and at a
    // station's own position (in-view stations — memoised for UTCEF layers).
    type Layer = { at(lat: number, lon: number): Win | undefined; atStation(s: UtcefCurrentStation): Win | undefined };
    const layers: Layer[] = [];
    const gribLayer = (grib: GribCurrentsData, files?: ReadonlySet<string>): Layer => {
      const at = (la: number, lo: number): Win | undefined =>
        gribVectorAt(grib, la, lo, time, files) !== null ? { type: 'grib' } : undefined;
      return { at, atStation: (s) => at(s.latitude, s.longitude) };
    };
    const utcefLayer = (maxKm: number, files?: ReadonlySet<string>): Layer => {
      const filesKey = files ? [...files].sort().join('\n') : '';
      const win = (station: UtcefCurrentStation | null): Win | undefined => (station ? { type: 'utcef', station } : undefined);
      return {
        at: (la, lo) => win(index.stationAt(la, lo, maxKm, files)),
        atStation: (s) => win(index.stationAtStation(s, maxKm, files, filesKey)),
      };
    };
    for (const entry of state.datasetRank?.() ?? []) {
      const files = new Set(entry.files);
      if (entry.type === 'grib2' && g) layers.push(gribLayer(g, files));
      else if (entry.type === 'utcef') layers.push(utcefLayer(UTCEF_DATASET_FALLBACK_MAX_KM, files));
    }
    for (const key of sourceRank(state)) {
      if (key === 'grib2' && g) layers.push(gribLayer(g));
      else if (key === 'utcef') layers.push(utcefLayer(REST_FALLBACK_MAX_KM));
    }
    winner = (lat, lon) => {
      for (const l of layers) {
        const w = l.at(lat, lon);
        if (w) return w;
      }
      return undefined;
    };
    winnerAtStation = (st) => {
      for (const l of layers) {
        const w = l.atStation(st);
        if (w) return w;
      }
      return undefined;
    };
  }

  // A UTCEF station is kept only if it is the very station the winning layer
  // returns at its position (not merely "some UTCEF wins here"), so
  // overlapping datasets agree with /vector on which file's station shows.
  // Filtering happens BEFORE thinning, so the budget goes to stations that
  // actually win their position. (Pre-thinning first would let a cell's
  // representative be a station GRIB outranks, hiding the eligible ones.)
  const utcefWinners = (winnerAtStation ? inView.filter((s) => winnerAtStation!(s)?.station === s) : inView).map((s) => ({
    lat: s.latitude,
    lon: s.longitude,
    s,
  }));

  const utcefPoint = (s: UtcefCurrentStation, lat: number, lon: number): GridPoint => {
    const sample = utcefSampleAt(s, time);
    return { latitude: lat, longitude: lon, speedKn: sample.speedKn, direction: sample.direction, u: sample.u, v: sample.v, source: 'utcef', stationId: s.id };
  };

  // GRIB lattice samples where GRIB wins stay GRIB. Where a UTCEF station
  // that is NOT drawn wins (its representative_area reaches in from afar, or
  // thinning dropped it), the sample position gets that station's vector, as
  // /vector would return there — else the area would be blank.
  const gribPoints = (samples: GridSample[], shown: ReadonlySet<UtcefCurrentStation>): GridPoint[] => {
    const out: GridPoint[] = [];
    for (const p of samples) {
      const w = winner?.(p.latitude, p.longitude);
      if (!w || w.type === 'grib') out.push({ ...p, source: 'grib' });
      else if (w.station && !shown.has(w.station)) out.push(utcefPoint(w.station, p.latitude, p.longitude));
    }
    return out;
  };

  // Split the budget: each source thinned on its own (GRIB by its lattice
  // stride, UTCEF by the cell ladder). The GRIB request depends only on
  // maxPoints and whether any UTCEF station is in play — never on how many —
  // so the lattice stride (and every GRIB arrow's position) stays put while
  // panning at a fixed zoom.
  const gribRequest = utcefWinners.length > 0 ? Math.max(1, Math.ceil(maxPoints / 2)) : maxPoints;
  const rawGrib = g ? gribGridSamples(g, bbox, time, gribRequest) : [];
  const gribEstimate = gribPoints(rawGrib, new Set(utcefWinners.map((w) => w.s))).length;
  const utcefThin = thinByCellLadder(utcefWinners, Math.max(0, maxPoints - gribEstimate));
  // Re-resolve against the stations actually drawn: lattice points whose
  // winner was thinned away get that station's vector instead of vanishing.
  const grib = gribPoints(rawGrib, new Set(utcefThin.map((w) => w.s))).slice(0, Math.max(0, maxPoints - utcefThin.length));

  const utcef: GridPoint[] = utcefThin.map(({ s }) => utcefPoint(s, s.latitude, s.longitude));
  return [...grib, ...utcef];
}
