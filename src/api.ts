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

import { GribCurrentsData, GribSource, GridSample, gribBracketPairs, gribGridSamplesWithFiles, gribPairsCover, gribSummary, gribVectorAt, TimeSlot } from './gribcurrents.js';
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
 * One probe of the resolution order: a source type, optionally restricted to
 * one dataset's files, with the nearest-station radius that probe uses for
 * UTCEF. Stack layers (per-dataset priority, PRD §5.3 Phase 3) come first,
 * then one layer per source type in sourcePriority order.
 */
export interface Layer {
  type: SourceType;
  /** Stack layers only: the dataset's own files (one stable Set per rank snapshot, so per-file caches keyed by Set identity hit). */
  files?: ReadonlySet<string>;
  /** Sorted file names joined by '\n' ('' for type-rank layers) — identifies `files` for memoisation. */
  filesKey: string;
  /** Nearest-station radius for a UTCEF probe: a stack layer is clamped to UTCEF_DATASET_FALLBACK_MAX_KM, a type-rank layer uses maxStationKm. */
  utcefMaxKm: number;
  /** True for a per-dataset stack layer, false for a type-rank (fallback) layer. */
  stack: boolean;
}

const NO_STACK: DatasetRankEntry[] = [];
const RANK_GRIB_FIRST: SourceType[] = ['grib2', 'utcef', 'harmonic'];
const RANK_STATIONS_FIRST: SourceType[] = ['utcef', 'harmonic', 'grib2'];

/**
 * Source-type rank to try in order: an explicit `sourcePriority` (PRD §5.3
 * Phase 1) wins when set; otherwise falls back to the legacy `preferGrib`
 * boolean so existing saved configs keep behaving the same way.
 */
function sourceRank(state: ApiState): SourceType[] {
  return state.sourcePriority ?? (state.preferGrib === false ? RANK_STATIONS_FIRST : RANK_GRIB_FIRST);
}

interface LayerCacheEntry {
  rank: SourceType[];
  maxStationKm: number;
  layers: Layer[];
}
// Keyed by the identity of the array datasetRank() returns (the provider
// memoises it until the stack changes), so the layer list — including one
// Set per stack entry — is built once per stack snapshot, not per probe.
const layerCache = new WeakMap<DatasetRankEntry[], LayerCacheEntry[]>();

/**
 * THE resolution order shared by resolveVector and /grid: per-dataset stack
 * layers first (restricted to their files), then the type-rank fallback
 * layers. Cached per (stack array identity, rank, maxStationKm); a missing
 * datasetRank maps to a shared empty-stack sentinel so it is cached too.
 */
export function orderedLayers(state: ApiState, maxStationKm: number): readonly Layer[] {
  const stack = state.datasetRank?.() ?? NO_STACK;
  const rank = sourceRank(state);
  let entries = layerCache.get(stack);
  if (!entries) layerCache.set(stack, (entries = []));
  for (const e of entries) {
    if (e.maxStationKm !== maxStationKm || e.rank.length !== rank.length) continue;
    let same = true;
    for (let i = 0; i < rank.length; i++) if (e.rank[i] !== rank[i]) { same = false; break; }
    if (same) return e.layers;
  }
  const stackKm = Math.min(maxStationKm, UTCEF_DATASET_FALLBACK_MAX_KM);
  const layers: Layer[] = [];
  for (const entry of stack) {
    layers.push({
      type: entry.type,
      files: new Set(entry.files),
      filesKey: [...entry.files].sort().join('\n'),
      utcefMaxKm: stackKm,
      stack: true,
    });
  }
  for (const type of rank) layers.push({ type, filesKey: '', utcefMaxKm: maxStationKm, stack: false });
  entries.push({ rank: rank.slice(), maxStationKm, layers });
  if (entries.length > 8) entries.shift();
  return layers;
}

/**
 * Legacy-harmonics fallback: nearest vector-capable station within maxStationKm
 * sampled at timeMs, or null when none qualifies or the sample is unavailable.
 */
function stationVectorAt(
  state: ApiState,
  lat: number,
  lon: number,
  timeMs: number,
  maxStationKm: number,
): ResolvedVector | null {
  if (!state.data) return null;
  const near = nearestCurrentStations(state.data, lat, lon, 10).filter(
    (n) => n.vectorCapable && n.distanceKm <= maxStationKm,
  );
  if (near.length === 0) return null;
  const sample = currentSampleAt(state.data, near[0].station, timeMs);
  if (!sample) return null;
  return { source: 'station', sample, station: near[0].station, distanceKm: near[0].distanceKm };
}

/**
 * Vector at a position/time from the best available source. GRIB (a forecast
 * grid) wins when it covers the position/time unless preferGrib is false;
 * among station-type sources the modern UTCEF vector data is tried before the
 * legacy OpenCPN harmonics. `maxStationKm` bounds the station searches
 * (REST_FALLBACK_MAX_KM for the REST API, the configured limit for delta
 * publishing — never truly unbounded, so a query far from any coverage
 * returns "no data" instead of a station on the other side of the planet).
 *
 * Probes orderedLayers(): the per-dataset stack first (each dataset only its
 * own files, so a small high-res coastal model ranked above a global one wins
 * where they overlap — even across source types), then the type rank, which
 * catches everything without a stack entry (orphan files, the legacy pair,
 * no manifest). A single dataset's UTCEF probe must not use the unlimited
 * nearest-station fallback of the merged pass ("nearest station within this
 * one file" matches ANY position on earth), so its radius is clamped to
 * UTCEF_DATASET_FALLBACK_MAX_KM; containment (representative_area) still
 * applies at any range. A harmonic layer probes the whole legacy source (it
 * has no per-file provenance).
 */
export function resolveVector(
  state: ApiState,
  lat: number,
  lon: number,
  timeMs: number,
  maxStationKm = REST_FALLBACK_MAX_KM,
): ResolvedVector | null {
  const layers = orderedLayers(state, maxStationKm);
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    if (l.type === 'grib2') {
      const g = state.grib?.get();
      if (!g) continue;
      const sample = gribVectorAt(g, lat, lon, timeMs, l.files);
      if (sample) return { source: 'grib', sample };
    } else if (l.type === 'utcef') {
      const u = state.utcef?.get();
      if (!u) continue;
      const hit = utcefVectorAt(u, lat, lon, timeMs, l.utcefMaxKm, l.files);
      if (hit) return { source: 'utcef', sample: hit.sample, utcefStation: hit.station, distanceKm: hit.distanceKm };
    } else {
      const r = stationVectorAt(state, lat, lon, timeMs, maxStationKm);
      if (r) return r;
    }
  }
  return null;
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
    // Same station resolution as /vector (representative_area containment
    // first, else nearest); resolution is time-independent.
    const utcefHit = u ? utcefVectorAt(u, pos.lat, pos.lon, win.start, REST_FALLBACK_MAX_KM) : null;
    const utcefNear = utcefHit ? { station: utcefHit.station, distanceKm: utcefHit.distanceKm } : null;
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
    // Stack layers (and their stable file Sets) come from the shared
    // orderedLayers() list, so slot caches keyed by Set identity keep hitting.
    const stackCandidates = orderedLayers(state, REST_FALLBACK_MAX_KM)
      .filter((l) => l.stack)
      .map((l) => {
        const files = l.files!;
        if (l.type === 'grib2') {
          return { source: 'grib' as const, fn: (t: number) => (g ? gribVectorAt(g, pos.lat, pos.lon, t, files) : null) };
        }
        if (l.type === 'utcef') {
          // Same clamped nearest-fallback radius as resolveVector's per-dataset probe.
          const hit = u ? utcefVectorAt(u, pos.lat, pos.lon, win.start, l.utcefMaxKm, files) : null;
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
  // (gribGridSamples) and the UTCEF 2D-vector stations in the bbox, arbitrated
  // with resolveVector's own layer order (dataset stack / sourcePriority /
  // preferGrib), so the map agrees with /vector and the published deltas
  // wherever GRIB or UTCEF wins. Lattice samples won by a UTCEF station are
  // always filled with that station's vector; stations are drawn only where
  // they win. The GRIB request is half the budget whenever UTCEF station data
  // is loaded (else all of it), independent of the view. Legacy harmonic
  // stations are not an overlay source and claim no positions. See gridPoints.
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

// Per-station GRIB coverage memo (see gridPoints): keyed by layer filesKey,
// valid while the bracketing slot pairs are the same objects.
// Keyed by the GRIB data object first so a reload drops the whole memo (the pairs hold decoded grids).
const stationGribCoverage = new WeakMap<GribCurrentsData, WeakMap<UtcefCurrentStation, Map<string, { pairs: { s0: TimeSlot; s1: TimeSlot }[]; covered: boolean }>>>();

/** One /grid point: a GRIB lattice sample or a UTCEF station, tagged with its source. */
export type GridPoint = GridSample & { source: 'grib' | 'utcef'; stationId?: string };

type Bbox = { west: number; south: number; east: number; north: number };

/**
 * /grid points merged by source priority. Uses the SAME ordered layer list as
 * resolveVector (orderedLayers) except that harmonic layers are skipped
 * (legacy stations are not an overlay source and claim no positions). The
 * first remaining layer that claims a position wins; a UTCEF layer names its
 * station.
 *
 * - GRIB lattice samples (gribGridSamples) where GRIB wins stay GRIB. The
 *   GRIB winner is layer-specific: a sample whose grid is not covered by the
 *   winning stack layer's files is dropped (that dataset's own lattice covers
 *   the area). A
 *   sample won by a UTCEF station S ALWAYS becomes S's vector at the sample
 *   position (source 'utcef', stationId S.id), whether or not S itself is
 *   drawn — so the overlay never depends on which stations are in view or
 *   thinned.
 * - In-view UTCEF stations are drawn at their own position only when they win
 *   it (the winning layer returns that very station), thinned with the cell
 *   ladder into whatever budget the lattice leaves.
 * - Budget: GRIB requests maxPoints lattice samples (ceil(maxPoints/2) when
 *   UTCEF data is loaded and ranks above GRIB, so in-view stations get room);
 *   depends on rank only, not the view. With UTCEF loaded the lattice stride
 *   is also bounded by the grid's share of the bbox area (strideFromBbox,
 *   GRID_GRIB_DENSITY_BOOST), still a fixed index lattice so panning is
 *   stable. UTCEF gets maxPoints minus the lattice output; total <= maxPoints.
 *   Each lattice sample's winner is evaluated once.
 */
function gridPoints(
  state: ApiState,
  g: GribCurrentsData | null,
  u: UtcefData | null,
  bbox: Bbox,
  time: number,
  maxPoints: number,
): GridPoint[] {
  const layers = orderedLayers(state, REST_FALLBACK_MAX_KM);
  const index = u ? utcefCoverageIndexFor(u) : null;
  // Arbitration is needed when UTCEF data is loaded or a per-dataset stack can
  // make a GRIB layer win; with neither, the lattice is emitted as sampled.
  const arbitrate = !!u || layers.some((l) => l.stack);

  type Win = UtcefCurrentStation | { grib: Layer } | null;
  // THE arbitration loop (harmonic layers skipped): the first layer whose
  // probe claims the position wins. Probes differ by position kind (lattice
  // sample vs. station position).
  const arbitrateLayers = (
    utcefProbe: (l: Layer) => UtcefCurrentStation | null,
    gribProbe: (l: Layer) => boolean,
  ): Win => {
    for (const l of layers) {
      if (l.type === 'grib2') {
        if (g && gribProbe(l)) return { grib: l };
      } else if (l.type === 'utcef') {
        if (!index) continue;
        const st = utcefProbe(l);
        if (st) return st;
      }
    }
    return null;
  };
  const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
    for (const f of a) if (b.has(f)) return true;
    return false;
  };
  // Lattice sample: the sample itself proves GRIB coverage for its own grid's
  // files, so a layer over those files (or an unrestricted one) needs no
  // second interpolation; only layers over OTHER files are probed.
  const winnerAtSample = (lat: number, lon: number, sampleFiles: ReadonlySet<string>): Win =>
    arbitrateLayers(
      (l) => index!.stationAt(lat, lon, l.utcefMaxKm, l.files),
      (l) => !l.files || intersects(l.files, sampleFiles) || gribVectorAt(g!, lat, lon, time, l.files) !== null,
    );
  // Station position: GRIB coverage memoised per (station, layer files) on the
  // bracketing slot pairs, so frames within the same pair skip the sampling.
  const pairs: Map<string, { s0: TimeSlot; s1: TimeSlot }[]> = new Map();
  const pairsFor = (l: Layer) => {
    let p = pairs.get(l.filesKey);
    if (!p) pairs.set(l.filesKey, (p = gribBracketPairs(g!, time, l.files)));
    return p;
  };
  const gribCoversStation = (s: UtcefCurrentStation, l: Layer): boolean => {
    const cur = pairsFor(l);
    let perData = stationGribCoverage.get(g!);
    if (!perData) stationGribCoverage.set(g!, (perData = new WeakMap()));
    let perStation = perData.get(s);
    if (!perStation) perData.set(s, (perStation = new Map()));
    const hit = perStation.get(l.filesKey);
    if (hit && hit.pairs.length === cur.length && hit.pairs.every((p, i) => p.s0 === cur[i].s0 && p.s1 === cur[i].s1)) {
      return hit.covered;
    }
    const covered = gribPairsCover(cur, s.latitude, s.longitude);
    perStation.set(l.filesKey, { pairs: cur, covered });
    return covered;
  };
  const winnerAtStation = (s: UtcefCurrentStation): Win =>
    arbitrateLayers(
      (l) => index!.stationAtStation(s, l.utcefMaxKm, l.files, l.filesKey),
      (l) => gribCoversStation(s, l),
    );

  const samples = new Map<UtcefCurrentStation, ReturnType<typeof utcefSampleAt>>();
  const utcefPoint = (s: UtcefCurrentStation, lat: number, lon: number): GridPoint => {
    let sample = samples.get(s);
    if (!sample) samples.set(s, (sample = utcefSampleAt(s, time)));
    return { latitude: lat, longitude: lon, speedKn: sample.speedKn, direction: sample.direction, u: sample.u, v: sample.v, source: 'utcef', stationId: s.id };
  };

  // Lattice first (its request depends only on maxPoints and on whether UTCEF
  // data is loaded at all), single pass.
  // GRIB keeps the full budget unless UTCEF data is loaded AND ranks above it
  // (then in-view stations need room). Rank only, never the view.
  const firstNonHarmonic = layers.find((l) => l.type !== 'harmonic');
  const gribRanksAboveUtcef = firstNonHarmonic?.type === 'grib2';
  const gribRequest = !u ? maxPoints : gribRanksAboveUtcef ? maxPoints : Math.max(1, Math.ceil(maxPoints / 2));
  const lattice: GridPoint[] = [];
  if (g) {
    for (const { sample: p, files } of gribGridSamplesWithFiles(g, bbox, time, gribRequest, { strideFromBbox: !!u })) {
      const w = arbitrate ? winnerAtSample(p.latitude, p.longitude, files) : null;
      if (w === null) lattice.push({ ...p, source: 'grib' });
      else if ('grib' in w) {
        // A winning stack layer over other files: its own lattice covers here.
        if (!w.grib.files || intersects(w.grib.files, files)) lattice.push({ ...p, source: 'grib' });
      } else lattice.push(utcefPoint(w, p.latitude, p.longitude));
    }
  }
  if (!u) return lattice;

  // In-view stations that win their own position, filtered BEFORE thinning so
  // the budget goes to stations that actually show.
  const winners: Array<{ lat: number; lon: number; s: UtcefCurrentStation }> = [];
  for (const s of utcefStationsInBbox(u, bbox)) {
    if (winnerAtStation(s) === s) winners.push({ lat: s.latitude, lon: s.longitude, s });
  }
  const utcefThin = thinByCellLadder(winners, Math.max(0, maxPoints - lattice.length));
  for (const { s } of utcefThin) lattice.push(utcefPoint(s, s.latitude, s.longitude));
  return lattice;
}
