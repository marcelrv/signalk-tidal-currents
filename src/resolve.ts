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
 *
 * Long-lived caches (per-layer GRIB series, UTCEF extents, the station-winner
 * arrays) hang off a (loaded data object, layer snapshot) pair, where the
 * snapshot is the array orderedLayers() returns: they are built lazily, once
 * per layer, never evicted by a count cap, and freed when the data reloads or
 * the dataset stack changes.
 */

import type { ApiState } from './api.js';
import {
  GribCurrentsData,
  GridSeries,
  TimeDependence,
  gribClaimSeries,
  gribSeriesInRange,
  gribSeriesSample,
  gribSubsetSeries,
} from './gribcurrents.js';
import { HarmonicsData, IdxStation } from './harmonics.js';
import { DatasetRankEntry, SourceType } from './priority.js';
import {
  CurrentSample,
  currentSampleAt,
  distanceKm,
  isVectorCapable,
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
      utcefMaxKm: stackKm,
      stack: true,
    });
  }
  for (const type of rank) layers.push({ type, utcefMaxKm: maxStationKm, stack: false });
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

  /** Union with another extent (the 10° bucket sets are tiny: <= 648 keys). */
  addAll(other: Extent): void {
    for (const k of other.keys) this.keys.add(k);
  }

  intersects(b: Bbox): boolean {
    return this.forEach(b.west, b.south, b.east, b.north, (k) => this.keys.has(k));
  }
}

/**
 * Everything cached for one (loaded data object, layer snapshot) pair. The
 * snapshot is the layer array orderedLayers() hands out, so entries are keyed
 * by LAYER OBJECT (never by file-set identity or a name string) and their
 * number is bounded by the number of layers. The two-level WeakMap frees them
 * when the data reloads or the stack changes.
 */
class SnapshotCache {
  /** GRIB: the series a stack layer answers from. */
  gribSeries = new Map<Layer, readonly GridSeries[]>();
  /** UTCEF: radius → file → that file's extent (one pass over the stations builds all files of one radius). */
  fileExtents = new Map<number, Map<string, Extent>>();
  /** UTCEF: a layer's extent, the union of its files' extents. */
  layerExtents = new Map<Layer, Extent>();
  /** Legacy: the extent of the vector-capable stations at this snapshot's radius. */
  legacyExtent: Extent | null = null;
  /** Station-winner arrays, LRU (see ownWinFor). */
  ownWin = new Map<string, Uint8Array>();
}
const snapshotCaches = new WeakMap<object, WeakMap<readonly Layer[], SnapshotCache>>();
function cacheFor(data: object, snapshot: readonly Layer[]): SnapshotCache {
  let perData = snapshotCaches.get(data);
  if (!perData) snapshotCaches.set(data, (perData = new WeakMap()));
  let c = perData.get(snapshot);
  if (!c) perData.set(snapshot, (c = new SnapshotCache()));
  return c;
}

/** Build counters for tests: each expensive cache entry must be built once, however many requests follow. */
export const resolveBuildCounts = {
  /** GRIB: series built for a stack layer — see gribBuildCounts.series for the series themselves. */
  gribLayerSeries: 0,
  /** UTCEF: passes over a data object's stations that produced the per-file extents. */
  fileExtentPasses: 0,
  /** Layer extents assembled (unions of per-file extents). */
  layerExtents: 0,
  /** Station-winner arrays filled. */
  ownWin: 0,
};

/** The series a layer answers from: the data's own for a type-rank layer, else the file-subset series (built once per layer). */
function layerSeries(grib: GribCurrentsData, snapshot: readonly Layer[], l: Layer): readonly GridSeries[] {
  if (!l.files) return grib.series;
  const cache = cacheFor(grib, snapshot);
  let series = cache.gribSeries.get(l);
  if (!series) {
    resolveBuildCounts.gribLayerSeries++;
    cache.gribSeries.set(l, (series = gribSubsetSeries(grib, l.files)));
  }
  return series;
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

/** Key of the per-file extent of stations that carry no `file` (hand-built data). */
const NO_FILE = '';

/** One pass over the stations → one Extent per file (padded by `radiusKm`). */
function fileExtentsFor(cache: SnapshotCache, u: UtcefData, radiusKm: number): Map<string, Extent> {
  let perFile = cache.fileExtents.get(radiusKm);
  if (!perFile) {
    resolveBuildCounts.fileExtentPasses++;
    perFile = new Map();
    let lastFile: string | undefined;
    let e!: Extent;
    for (const s of u.currentStations) {
      const f = s.file ?? NO_FILE;
      if (f !== lastFile) {
        lastFile = f;
        e = perFile.get(f) ?? perFile.set(f, new Extent()).get(f)!;
      }
      e.addPoint(s.latitude, s.longitude, radiusKm);
      const b = utcefAreaBounds(s);
      if (b) e.addBox(b.west, b.south, b.east, b.north);
    }
    cache.fileExtents.set(radiusKm, perFile);
  }
  return perFile;
}

/** A UTCEF layer's extent: the union of its files' extents (every file's, for a type-rank layer). */
function utcefExtent(u: UtcefData, snapshot: readonly Layer[], l: Layer): Extent {
  const cache = cacheFor(u, snapshot);
  let e = cache.layerExtents.get(l);
  if (!e) {
    resolveBuildCounts.layerExtents++;
    e = new Extent();
    const perFile = fileExtentsFor(cache, u, l.utcefMaxKm);
    if (l.files) for (const f of l.files) { const fe = perFile.get(f); if (fe) e.addAll(fe); }
    else for (const fe of perFile.values()) e.addAll(fe);
    cache.layerExtents.set(l, e);
  }
  return e;
}

function legacyExtent(d: HarmonicsData, snapshot: readonly Layer[], capable: readonly IdxStation[], radiusKm: number): Extent {
  const cache = cacheFor(d, snapshot);
  if (!cache.legacyExtent) {
    const e = new Extent();
    for (const s of capable) e.addPoint(s.latitude, s.longitude, radiusKm);
    cache.legacyExtent = e;
  }
  return cache.legacyExtent;
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
  /** The same without the bbox pre-filter (identical to `layers` when no bbox was given): what a position-independent decision must be made against. */
  fullLayers: CtxLayer[];
  /** The layer snapshot (orderedLayers) the layers came from — the key of the per-snapshot caches. */
  snapshot: readonly Layer[];
  grib: GribCurrentsData | null;
  utcef: UtcefData | null;
  harmonics: HarmonicsData | null;
  /** Cell indexes of the loaded UTCEF / legacy data (null when that source cannot answer). */
  utcefIndex: ReturnType<typeof utcefCoverageIndexFor> | null;
  legacyIndex: ReturnType<typeof legacyCoverageIndexFor> | null;
  maxStationKm: number;
  /** Legacy harmonic layers participate. */
  legacy: boolean;
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
 * cached per (data, layer snapshot)); nothing in it survives the request.
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
  const legacy = opts.legacy !== false;
  const legacyIdx = legacy && harmonics ? legacyCoverageIndexFor(harmonics) : null;
  const legacyOk = !!legacyIdx && legacyIdx.hasVectorCapable;
  const bbox = opts.bbox;

  const snapshot = orderedLayers(state, maxStationKm);
  const full: CtxLayer[] = [];
  const reach: CtxLayer[] = [];
  let legacyAdded = false;
  for (const l of snapshot) {
    if (l.type === 'grib2') {
      if (!grib) continue;
      const series = layerSeries(grib, snapshot, l);
      if (series.length === 0) continue;
      const cl: CtxLayer = { ...l, series };
      full.push(cl);
      // With a viewport, only the series that reach it take part in the loop: a
      // hundred regions installed elsewhere cost nothing per point.
      if (!bbox) continue;
      const near = series.filter((s) => gribExtent([s]).intersects(bbox));
      if (near.length === series.length) reach.push(cl);
      else if (near.length > 0) reach.push({ ...l, series: near });
    } else if (l.type === 'utcef') {
      if (!utcef) continue;
      full.push(l);
      if (bbox && utcefExtent(utcef, snapshot, l).intersects(bbox)) reach.push(l);
    } else {
      // Every harmonic layer probes the whole legacy source (it has no
      // per-file provenance), so only the first can ever answer.
      if (!legacyOk || legacyAdded) continue;
      full.push(l);
      if (bbox && legacyExtent(harmonics!, snapshot, legacyIdx!.capable, maxStationKm).intersects(bbox)) reach.push(l);
      legacyAdded = true;
    }
  }
  return {
    layers: bbox ? reach : full,
    fullLayers: full,
    snapshot,
    grib,
    utcef,
    harmonics: legacyOk ? harmonics : null,
    utcefIndex: utcef ? utcefCoverageIndexFor(utcef) : null,
    legacyIndex: legacyOk ? legacyIdx : null,
    maxStationKm,
    legacy,
    counters: { claims: 0, resolves: 0, layerProbes: 0, samples: 0 },
  };
}

// ── Claim / resolve ──

/** Who answers at a position/time (no sample taken yet). */
export type Claim =
  | { source: 'grib'; layer: CtxLayer; series: GridSeries }
  | { source: 'utcef'; layer: CtxLayer; station: UtcefCurrentStation }
  | { source: 'station'; layer: CtxLayer; station: IdxStation };

/**
 * THE layer loop. The first layer whose probe claims the position wins.
 * `td` (optional out-flag) is raised when a probe before the winner depended
 * on the time beyond the coarse series-in-range test (a GRIB cell defined in
 * only some slots): the decision may then differ at another time.
 */
function claimLoop(
  ctx: ResolveCtx,
  layers: readonly CtxLayer[],
  lat: number,
  lon: number,
  timeMs: number,
  td?: TimeDependence,
): Claim | null {
  for (const layer of layers) {
    ctx.counters.layerProbes++;
    if (layer.type === 'grib2') {
      const series = gribClaimSeries(layer.series!, lat, lon, timeMs, td);
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
  return claimLoop(ctx, ctx.layers, lat, lon, timeMs);
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
  const claim = claimLoop(ctx, ctx.layers, lat, lon, timeMs);
  if (!claim || (accept && !accept(claim))) return null;
  return sampleClaimAt(ctx, claim, lat, lon, timeMs);
}

// ── Station winners (static, one byte per station) ──

/** `ownWin` values: the station loses / wins its own position, or the answer depends on the time (re-decide with claimAt). */
export const OWN_LOSES = 0;
export const OWN_WINS = 1;
export const OWN_TIME_DEPENDENT = 2;

/** Max `ownWin` arrays kept per (data, snapshot): a handful of forecast-horizon states, least recently used out first. */
export const OWN_WIN_CACHE_CAP = 4;

/**
 * Compact key of which GRIB series of the (unpruned) GRIB layers are in their
 * time range at `timeMs`, one bit per layer series, hex-packed. Crossing a
 * forecast-horizon edge changes it.
 */
function rangeKey(ctx: ResolveCtx, timeMs: number): string {
  let key = '';
  let bits = 0;
  let n = 0;
  for (const l of ctx.fullLayers) {
    if (l.type !== 'grib2') continue;
    for (const s of l.series!) {
      bits = (bits << 1) | (gribSeriesInRange(s, timeMs) ? 1 : 0);
      if (++n === 4) { key += bits.toString(16); bits = 0; n = 0; }
    }
  }
  return n > 0 ? key + bits.toString(16) + n : key;
}

/**
 * For every station of one source (UTCEF: `data.currentStations`, legacy: the
 * legacy index's station list; indexed by array position) whether it wins its
 * OWN position: OWN_WINS / OWN_LOSES, or OWN_TIME_DEPENDENT when the decision
 * touched a partially-defined GRIB cell (coastline) and so can differ per time.
 *
 * Who wins a station's own position is almost static: it changes with the layer
 * configuration (snapshot, maxStationKm, legacy on/off — all part of the key),
 * with which GRIB series are in their time range (`rangeKey`; only at
 * forecast-horizon edges) and, for the flagged stations, with the time. So the
 * array is filled ONCE per key by the same claim loop every other probe uses
 * (against the UNPRUNED layers: it covers stations outside the current view),
 * and a /grid request only re-decides the flagged stations.
 *
 * Memory: one byte per station per kept key (a Uint8Array, not a per-station
 * memo map), at most OWN_WIN_CACHE_CAP keys per (data, snapshot), least recently
 * used first out; freed with the data object or the layer snapshot.
 */
export function ownWinFor(ctx: ResolveCtx, kind: 'utcef' | 'station', timeMs: number): Uint8Array {
  const data = kind === 'utcef' ? ctx.utcef! : ctx.harmonics!;
  const cache = cacheFor(data, ctx.snapshot);
  const key = `${kind}|${ctx.legacy ? 1 : 0}|${ctx.maxStationKm}|${rangeKey(ctx, timeMs)}`;
  const hit = cache.ownWin.get(key);
  if (hit) {
    cache.ownWin.delete(key); // refresh recency
    cache.ownWin.set(key, hit);
    return hit;
  }
  resolveBuildCounts.ownWin++;
  const fill: ResolveCtx = { ...ctx, counters: { claims: 0, resolves: 0, layerProbes: 0, samples: 0 } };
  const td: TimeDependence = { timeDependent: false };
  const stations: ReadonlyArray<UtcefCurrentStation | IdxStation> = kind === 'utcef' ? ctx.utcef!.currentStations : ctx.legacyIndex!.index.items;
  const out = new Uint8Array(stations.length);
  for (let k = 0; k < stations.length; k++) {
    const s = stations[k];
    if (kind === 'station' && !isVectorCapable(s as IdxStation)) continue; // never claimed
    td.timeDependent = false;
    const claim = claimLoop(fill, ctx.fullLayers, s.latitude, s.longitude, timeMs, td);
    out[k] = td.timeDependent ? OWN_TIME_DEPENDENT : claim && claim.source === kind && (claim as { station?: unknown }).station === s ? OWN_WINS : OWN_LOSES;
  }
  cache.ownWin.set(key, out);
  if (cache.ownWin.size > OWN_WIN_CACHE_CAP) cache.ownWin.delete(cache.ownWin.keys().next().value!);
  return out;
}

/** Number of kept station-winner arrays for `data` under `snapshot` (bounded by OWN_WIN_CACHE_CAP; for tests). */
export function ownWinCacheSize(data: object, snapshot: readonly Layer[]): number {
  return snapshotCaches.get(data)?.get(snapshot)?.ownWin.size ?? 0;
}
