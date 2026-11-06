// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * THE resolver: the only place that decides which source answers at
 * (lat, lon, t).
 *
 * `claimAt` walks the ordered layers (per-dataset stack first, then the
 * source-type rank) and returns WHO answers — a GRIB series, a UTCEF station
 * or a legacy harmonic station — without sampling anything. `resolveAt` is
 * `claimAt` + sampling the winner. Both go through one private layer loop, so
 * they cannot drift apart. /vector, /timeline, the published deltas and
 * every /grid point (lattice nodes and station winners alike) use it; no
 * other module probes a source to decide ownership of a position.
 *
 * Probes are O(1) per layer: GRIB cell masks, UTCEF / legacy cell indexes. A
 * context built with a `bbox` drops layers that cannot reach it, so datasets
 * installed elsewhere cost nothing per point.
 */

import type { ApiState } from './api.js';
import {
  GribCurrentsData,
  GridSeries,
  gribClaimSeries,
  gribSeriesFor,
  gribSeriesSample,
} from './gribcurrents.js';
import { HarmonicsData, IdxStation } from './harmonics.js';
import { DatasetRankEntry, SourceType } from './priority.js';
import {
  CurrentSample,
  currentSampleAt,
  distanceKm,
  legacyCoverageIndexFor,
  lonHalfWidthDeg,
} from './predict.js';
import {
  UtcefCurrentStation,
  UtcefData,
  utcefAreaBounds,
  utcefCoverageIndexFor,
  utcefSampleAt,
} from './utcef.js';

export interface ResolvedVector {
  source: 'grib' | 'utcef' | 'station';
  sample: CurrentSample;
  /** GRIB path only: the series (grid geometry) that answered. */
  series?: GridSeries;
  /** Legacy-station path only: */
  station?: IdxStation;
  /** UTCEF-station path only: */
  utcefStation?: UtcefCurrentStation;
  distanceKm?: number;
}

/** Nearest-station fallback radius for a SINGLE dataset's probe in the priority stack. */
export const UTCEF_DATASET_FALLBACK_MAX_KM = 50;

/**
 * Default nearest-station fallback radius for the merged type-rank pass
 * (REST /vector and /timeline, which don't pass an explicit maxStationKm).
 * Without a cap, a position with no GRIB/UTCEF coverage nearby would still
 * match whatever station happens to be nearest on the *entire* station list
 * — which, for a query far from any installed dataset, can be a station
 * thousands of km away on another continent. Currents are driven by local
 * channel/bathymetry, so there is no case for going wider than the
 * per-dataset radius.
 */
export const REST_FALLBACK_MAX_KM = UTCEF_DATASET_FALLBACK_MAX_KM;

/** Human-readable name of whichever station backed a resolved vector. */
export function resolvedStationName(r: ResolvedVector): string | null {
  if (r.source === 'station') return r.station?.name ?? null;
  if (r.source === 'utcef') return r.utcefStation?.name ?? null;
  return null;
}

// ── Layers ──

/**
 * One probe of the resolution order: a source type, optionally restricted to
 * one dataset's files, with the nearest-station radius that probe uses for
 * UTCEF. Stack layers (per-dataset priority, PRD §5.3 Phase 3) come first,
 * then one layer per source type in sourcePriority order.
 */
export interface Layer {
  type: SourceType;
  /** Stack layers only: the dataset's own files. */
  files?: ReadonlySet<string>;
  /**
   * Identifies `files` for memoisation: `f:` + sorted file names joined by
   * '\n' for stack layers (an EMPTY file list gives 'f:', never colliding),
   * '*' for type-rank (unrestricted) layers.
   */
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
/** Max cached (rank, maxStationKm) layer lists per stack snapshot. */
export const LAYER_CACHE_CAP = 8;
// Keyed by the identity of the array datasetRank() returns (the provider
// memoises it until the stack changes), so the layer list is built once per
// stack snapshot, not per probe.
const layerCache = new WeakMap<DatasetRankEntry[], LayerCacheEntry[]>();

/**
 * The resolution order: per-dataset stack layers first (restricted to their
 * files), then the type-rank fallback layers. Cached per (stack array
 * identity, rank, maxStationKm); a missing datasetRank maps to a shared
 * empty-stack sentinel so it is cached too.
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
      filesKey: 'f:' + [...entry.files].sort().join('\n'),
      utcefMaxKm: stackKm,
      stack: true,
    });
  }
  for (const type of rank) layers.push({ type, filesKey: '*', utcefMaxKm: maxStationKm, stack: false });
  entries.push({ rank: rank.slice(), maxStationKm, layers });
  if (entries.length > LAYER_CACHE_CAP) entries.shift();
  return layers;
}

// ── Layer extents (request pre-filter) ──

type Bbox = { west: number; south: number; east: number; north: number };

const BUCKET_DEG = 10;
const BUCKETS_LON = 360 / BUCKET_DEG;
const BUCKETS_LAT = 180 / BUCKET_DEG;
const latBucket = (lat: number): number => Math.min(BUCKETS_LAT - 1, Math.max(0, Math.floor((lat + 90) / BUCKET_DEG)));

/**
 * Coarse occupancy of the globe in 10° buckets: which buckets a layer's data
 * (padded by its probe radius) can reach. Answers "can this layer touch that
 * bbox?" in at most ~650 set lookups, however many stations the layer holds.
 */
class Extent {
  private keys = new Set<number>();
  private last = '';

  private forEach(west: number, south: number, east: number, north: number, fn: (key: number) => boolean | void): boolean {
    const j0 = latBucket(south);
    const j1 = latBucket(north);
    const all = !(east - west < 360);
    const i0 = all ? 0 : Math.floor(west / BUCKET_DEG);
    const i1 = all ? BUCKETS_LON - 1 : Math.floor(east / BUCKET_DEG);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const ib = ((i % BUCKETS_LON) + BUCKETS_LON) % BUCKETS_LON;
        if (fn(j * BUCKETS_LON + ib) === true) return true;
      }
    }
    return false;
  }

  addBox(west: number, south: number, east: number, north: number): void {
    const sig = `${latBucket(south)}:${latBucket(north)}:${Math.floor(west / BUCKET_DEG)}:${Math.floor(east / BUCKET_DEG)}:${east - west >= 360}`;
    if (sig === this.last) return; // consecutive stations in one bucket (the common case)
    this.last = sig;
    this.forEach(west, south, east, north, (k) => void this.keys.add(k));
  }

  /** A point reachable within `radiusKm` (Infinity = anywhere). */
  addPoint(lat: number, lon: number, radiusKm: number): void {
    if (!Number.isFinite(radiusKm)) return this.addBox(-180, -90, 180, 90);
    const dLat = radiusKm / 110;
    const dLon = lonHalfWidthDeg(lat, dLat);
    this.addBox(lon - dLon, lat - dLat, lon + dLon, lat + dLat);
  }

  intersects(b: Bbox): boolean {
    return this.forEach(b.west, b.south, b.east, b.north, (k) => this.keys.has(k));
  }
}

/** Max cached extents per data object (one per distinct layer file set / radius). */
export const EXTENT_CACHE_CAP = 32;
const extentCache = new WeakMap<object, Map<string, Extent>>();
function cachedExtent(data: object, key: string, build: () => Extent): Extent {
  let m = extentCache.get(data);
  if (!m) extentCache.set(data, (m = new Map()));
  let e = m.get(key);
  if (!e) {
    e = build();
    m.set(key, e);
    if (m.size > EXTENT_CACHE_CAP) m.delete(m.keys().next().value!);
  }
  return e;
}

/** Number of cached extents for `data` (bounded by EXTENT_CACHE_CAP; for tests). */
export function extentCacheSize(data: object): number {
  return extentCache.get(data)?.size ?? 0;
}

function gribExtent(series: readonly GridSeries[]): Extent {
  const e = new Extent();
  for (const { grid: g } of series) {
    const south = g.lat0 - g.dj;
    const north = g.lat0 + g.nj * g.dj;
    if (g.globalLon) e.addBox(-180, south, 180, north);
    else e.addBox(g.lon0 - g.di, south, g.lon0 + g.ni * g.di, north);
  }
  return e;
}

function utcefExtent(u: UtcefData, files: ReadonlySet<string> | undefined, filesKey: string, radiusKm: number): Extent {
  return cachedExtent(u, `${filesKey}|${radiusKm}`, () => {
    const e = new Extent();
    for (const s of u.currentStations) {
      if (files && !(s.file !== undefined && files.has(s.file))) continue;
      e.addPoint(s.latitude, s.longitude, radiusKm);
      const b = utcefAreaBounds(s);
      if (b) e.addBox(b.west, b.south, b.east, b.north);
    }
    return e;
  });
}

function legacyExtent(d: HarmonicsData, capable: readonly IdxStation[], radiusKm: number): Extent {
  return cachedExtent(d, `legacy|${radiusKm}`, () => {
    const e = new Extent();
    for (const s of capable) e.addPoint(s.latitude, s.longitude, radiusKm);
    return e;
  });
}

// ── Context ──

/** Work counters of one context — what the tests assert the cost bounds on. */
export interface ResolveCounters {
  /** Direct claimAt calls (not those made inside resolveAt). */
  claims: number;
  /** resolveAt calls. */
  resolves: number;
  /** Layer probes performed by the shared loop (claims + resolves). */
  layerProbes: number;
  /** Winners sampled (inside resolveAt, or via sampleClaimAt). */
  samples: number;
}

export interface CtxLayer extends Layer {
  /** GRIB layers: the series this layer answers from (finest first). */
  series?: readonly GridSeries[];
}

export interface ResolveCtx {
  /** Layers that can answer (data present; and, with a bbox, able to reach it), in resolution order. */
  layers: CtxLayer[];
  grib: GribCurrentsData | null;
  utcef: UtcefData | null;
  harmonics: HarmonicsData | null;
  /** Cell indexes of the loaded UTCEF / legacy data (null when that source cannot answer). */
  utcefIndex: ReturnType<typeof utcefCoverageIndexFor> | null;
  legacyIndex: ReturnType<typeof legacyCoverageIndexFor> | null;
  maxStationKm: number;
  counters: ResolveCounters;
}

export interface CtxOptions {
  /** Drop layers that cannot reach this viewport (for /grid). */
  bbox?: Bbox;
  /** Legacy harmonic layers participate (default true; /grid enables them with `stations=1`). */
  legacy?: boolean;
}

/**
 * Build the per-request / per-delta-tick context: the ordered layers that can
 * answer, with their data resolved once. Cheap (everything long-lived is
 * cached on the data objects); nothing in it survives the request.
 */
export function createResolveCtx(
  state: ApiState,
  maxStationKm = REST_FALLBACK_MAX_KM,
  opts: CtxOptions = {},
): ResolveCtx {
  const grib = state.grib?.get() ?? null;
  const utcefRaw = state.utcef?.get() ?? null;
  const utcef = utcefRaw && utcefRaw.currentStations.length > 0 ? utcefRaw : null;
  const harmonics = state.data;
  const legacyIdx = opts.legacy !== false && harmonics ? legacyCoverageIndexFor(harmonics) : null;
  const legacyOk = !!legacyIdx && legacyIdx.hasVectorCapable;
  const bbox = opts.bbox;

  const layers: CtxLayer[] = [];
  let legacyAdded = false;
  for (const l of orderedLayers(state, maxStationKm)) {
    if (l.type === 'grib2') {
      if (!grib) continue;
      let series = gribSeriesFor(grib, l.files, l.filesKey);
      // With a viewport, only the series that reach it take part in the loop: a
      // hundred regions installed elsewhere cost nothing per point.
      if (bbox) series = series.filter((s) => gribExtent([s]).intersects(bbox));
      if (series.length === 0) continue;
      layers.push({ ...l, series });
    } else if (l.type === 'utcef') {
      if (!utcef) continue;
      if (bbox && !utcefExtent(utcef, l.files, l.filesKey, l.utcefMaxKm).intersects(bbox)) continue;
      layers.push(l);
    } else {
      // Every harmonic layer probes the whole legacy source (it has no
      // per-file provenance), so only the first can ever answer.
      if (!legacyOk || legacyAdded) continue;
      if (bbox && !legacyExtent(harmonics!, legacyIdx!.capable, maxStationKm).intersects(bbox)) continue;
      layers.push(l);
      legacyAdded = true;
    }
  }
  return {
    layers,
    grib,
    utcef,
    harmonics: legacyOk ? harmonics : null,
    utcefIndex: utcef ? utcefCoverageIndexFor(utcef) : null,
    legacyIndex: legacyOk ? legacyIdx : null,
    maxStationKm,
    counters: { claims: 0, resolves: 0, layerProbes: 0, samples: 0 },
  };
}

// ── Claim / resolve ──

/** Who answers at a position/time (no sample taken yet). */
export type Claim =
  | { source: 'grib'; layer: CtxLayer; series: GridSeries }
  | { source: 'utcef'; layer: CtxLayer; station: UtcefCurrentStation }
  | { source: 'station'; layer: CtxLayer; station: IdxStation };

/** THE layer loop. The first layer whose probe claims the position wins. */
function claimLoop(ctx: ResolveCtx, lat: number, lon: number, timeMs: number): Claim | null {
  for (const layer of ctx.layers) {
    ctx.counters.layerProbes++;
    if (layer.type === 'grib2') {
      const series = gribClaimSeries(layer.series!, lat, lon, timeMs);
      if (series) return { source: 'grib', layer, series };
    } else if (layer.type === 'utcef') {
      const station = ctx.utcefIndex!.stationAt(lat, lon, layer.utcefMaxKm, layer.files);
      if (station) return { source: 'utcef', layer, station };
    } else {
      // A vector-capable, resolvable station always has a sample, so a claim
      // needs no prediction.
      const station = ctx.legacyIndex!.stationAt(lat, lon, ctx.maxStationKm);
      if (station) return { source: 'station', layer, station };
    }
  }
  return null;
}

/** Which source answers at (lat, lon, t), without sampling it. */
export function claimAt(ctx: ResolveCtx, lat: number, lon: number, timeMs: number): Claim | null {
  ctx.counters.claims++;
  return claimLoop(ctx, lat, lon, timeMs);
}

/**
 * Sample a claim's winner at (lat, lon, t) — resolveAt's second half, also used
 * directly by callers that already hold a winner (/grid's station winners).
 * Null only if the winner cannot produce a sample.
 */
export function sampleClaimAt(ctx: ResolveCtx, claim: Claim, lat: number, lon: number, timeMs: number): ResolvedVector | null {
  ctx.counters.samples++;
  if (claim.source === 'grib') {
    const sample = gribSeriesSample(claim.series, lat, lon, timeMs);
    return sample ? { source: 'grib', sample, series: claim.series } : null;
  }
  const round2 = (x: number) => Math.round(x * 100) / 100;
  if (claim.source === 'utcef') {
    const s = claim.station;
    return {
      source: 'utcef',
      sample: utcefSampleAt(s, timeMs),
      utcefStation: s,
      distanceKm: round2(distanceKm(lat, lon, s.latitude, s.longitude)),
    };
  }
  const s = claim.station;
  const sample = currentSampleAt(ctx.harmonics!, s, timeMs);
  return sample
    ? { source: 'station', sample, station: s, distanceKm: round2(distanceKm(lat, lon, s.latitude, s.longitude)) }
    : null;
}

/**
 * The vector at (lat, lon, t) from the first layer that claims it: claimAt +
 * sampling the winner. `accept` lets a caller (the /grid lattice) veto a claim
 * BEFORE the sample is taken — the result is then null and nothing is sampled.
 */
export function resolveAt(
  ctx: ResolveCtx,
  lat: number,
  lon: number,
  timeMs: number,
  accept?: (claim: Claim) => boolean,
): ResolvedVector | null {
  ctx.counters.resolves++;
  const claim = claimLoop(ctx, lat, lon, timeMs);
  if (!claim || (accept && !accept(claim))) return null;
  return sampleClaimAt(ctx, claim, lat, lon, timeMs);
}
