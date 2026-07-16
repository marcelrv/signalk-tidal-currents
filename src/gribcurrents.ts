// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Gridded tidal/ocean current source from GRIB2 files.
 *
 * Unlike the harmonic-station source, GRIB2 currents are FIELDS: u/v
 * velocity components on a lat/lon grid, one grid per forecast time. There
 * is no station concept — lookups are purely positional, with bilinear
 * interpolation in space and linear interpolation in time between the two
 * bracketing forecast fields.
 *
 * Accepted fields (GRIB2 discipline 10 "oceanographic", category 1
 * "currents"):
 *   param 2/3 — u/v components (m/s), the common encoding
 *   param 0/1 — direction (°, direction TOWARD) / speed (m/s), converted
 *               to u/v at load time
 * When a file carries several depth levels, the shallowest is used.
 */

import * as fs from 'fs';
import * as path from 'path';

import { Grib2Field, Grib2Grid, parseGrib2, sampleGrid } from './grib2.js';
import { CurrentSample, KNOTS_TO_MS } from './predict.js';
import { listDataFilesRecursive } from './utcef.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** How far outside the covered time range a lookup may clamp to the edge field. */
export const GRIB_TIME_SLACK_MS = 3 * 3_600_000;

/** One forecast time with matched u and v grids. */
export interface TimeSlot {
  time: number; // ms epoch
  grid: Grib2Grid;
  u: Float64Array; // m/s east
  v: Float64Array; // m/s north
  depth: number; // m below surface (0 = surface), for reporting
  file: string;
}

export interface GribCurrentsData {
  dir: string;
  files: string[];
  slots: TimeSlot[]; // sorted by time
  /**
   * The same slots keyed by source file, WITHOUT the cross-file same-time
   * dedup applied to `slots` — per-dataset priority (PRD §5.3 Phase 3) needs
   * to probe one file's full coverage even when another file shadowed some
   * of its valid times in the merged list. Same TimeSlot objects, no copies.
   */
  slotsByFile: Record<string, TimeSlot[]>;
  /** Reasons for anything skipped during parsing (surfaced in the summary). */
  warnings: string[];
}

export const GRIB_EXT_RE = /\.(grb2?|grib2?)$/i;

function isCurrentField(f: Grib2Field): boolean {
  return f.discipline === 10 && f.paramCategory === 1 && f.paramNumber >= 0 && f.paramNumber <= 3;
}

/** Surface types acceptable as "the surface current": water surface or a depth below it. */
function fieldDepth(f: Grib2Field): number | null {
  if (f.surfaceType === null || f.surfaceType === 1) return 0;
  if (f.surfaceType === 160) return f.surfaceValue ?? 0; // depth below sea level, m
  return null;
}

function sameGrid(a: Grib2Grid, b: Grib2Grid): boolean {
  return (
    a.ni === b.ni &&
    a.nj === b.nj &&
    Math.abs(a.lat0 - b.lat0) < 1e-9 &&
    Math.abs(a.lon0 - b.lon0) < 1e-9 &&
    Math.abs(a.di - b.di) < 1e-9 &&
    Math.abs(a.dj - b.dj) < 1e-9
  );
}

/** Pair u/v (or dir/speed) fields into time slots. */
function buildSlots(fields: Grib2Field[], file: string, warnings: string[]): TimeSlot[] {
  interface Bucket {
    time: number;
    depth: number;
    grid: Grib2Grid;
    byParam: Map<number, Grib2Field>;
  }
  const buckets: Bucket[] = [];
  for (const f of fields) {
    if (!isCurrentField(f)) continue;
    const depth = fieldDepth(f);
    if (depth === null) continue;
    let b = buckets.find(
      (x) => x.time === f.validTime && Math.abs(x.depth - depth) < 1e-6 && sameGrid(x.grid, f.grid),
    );
    if (!b) {
      b = { time: f.validTime, depth, grid: f.grid, byParam: new Map() };
      buckets.push(b);
    }
    b.byParam.set(f.paramNumber, f);
  }

  const slots: TimeSlot[] = [];
  const byTime = new Map<number, Bucket[]>();
  for (const b of buckets) {
    const list = byTime.get(b.time) ?? [];
    list.push(b);
    byTime.set(b.time, list);
  }
  for (const [time, list] of byTime) {
    // Prefer the shallowest level that yields a complete vector.
    list.sort((a, b) => a.depth - b.depth);
    let made = false;
    for (const b of list) {
      const u = b.byParam.get(2);
      const v = b.byParam.get(3);
      if (u && v) {
        slots.push({ time, grid: b.grid, u: u.values, v: v.values, depth: b.depth, file });
        made = true;
        break;
      }
      const dir = b.byParam.get(0);
      const spd = b.byParam.get(1);
      if (dir && spd) {
        const n = spd.values.length;
        const uu = new Float64Array(n);
        const vv = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const s = spd.values[i];
          const d = dir.values[i] * DEG2RAD; // direction TOWARD (oceanographic)
          uu[i] = s * Math.sin(d);
          vv[i] = s * Math.cos(d);
        }
        slots.push({ time, grid: b.grid, u: uu, v: vv, depth: b.depth, file });
        made = true;
        break;
      }
    }
    if (!made) {
      warnings.push(
        `${path.basename(file)}: current field(s) at ${new Date(time).toISOString()} lack a matching u/v or dir/speed pair`,
      );
    }
  }
  return slots;
}

/**
 * Per-file parse cache, keyed by relative path. A GRIB decode is the most
 * expensive thing this plugin does (bit-level complex-packing inflation into
 * Float64Arrays), and a reload is triggered by ANY change to the directory —
 * including every single completed catalog download. Without this, a boat
 * that has downloaded many regions re-decodes ALL of them each time one new
 * cycle file lands, which freezes a Cerbo GX / Pi for seconds and doubles
 * peak RAM (old + new arrays live simultaneously during the rebuild).
 * `sig` is size+mtime — the same change signal createGribSource already
 * trusts for the directory as a whole. Failed parses are cached too, so a
 * corrupt file is reported once per change, not re-parsed once per minute.
 */
export interface GribFileCacheEntry {
  sig: string;
  slots: TimeSlot[];
  warnings: string[];
}
export type GribFileCache = Map<string, GribFileCacheEntry>;

/** Parse every GRIB2 file in a directory (recursively — catalog filenames may carry subdir paths) into a time-sorted current dataset. Pass a `cache` (owned by a long-lived source) to re-parse only files whose size/mtime changed. */
export function loadGribDir(dir: string, cache?: GribFileCache): GribCurrentsData | null {
  if (!fs.existsSync(dir)) return null; // directory absent — GRIB source simply not configured
  const entries = listDataFilesRecursive(dir, GRIB_EXT_RE);
  if (entries.length === 0) {
    cache?.clear();
    return null;
  }

  const warnings: string[] = [];
  const slots: TimeSlot[] = [];
  const slotsByFile: Record<string, TimeSlot[]> = {};
  const files: string[] = [];
  const present = new Set<string>();
  for (const name of entries) {
    const full = path.join(dir, name);
    present.add(name);
    let sig = '';
    try {
      const st = fs.statSync(full);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      continue; // vanished between listing and stat
    }

    const cached = cache?.get(name);
    let fileSlots: TimeSlot[];
    let fileWarnings: string[];
    if (cached && cached.sig === sig) {
      ({ slots: fileSlots, warnings: fileWarnings } = cached);
    } else {
      fileWarnings = [];
      fileSlots = [];
      try {
        const { fields, skipped } = parseGrib2(fs.readFileSync(full));
        for (const s of skipped) fileWarnings.push(`${name}: ${s}`);
        fileSlots = buildSlots(fields, name, fileWarnings);
        fileSlots.sort((a, b) => a.time - b.time);
        if (fileSlots.length === 0 && fields.length > 0) {
          fileWarnings.push(`${name}: no ocean-current fields (discipline 10, category 1) found`);
        }
      } catch (e) {
        fileWarnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      cache?.set(name, { sig, slots: fileSlots, warnings: fileWarnings });
    }

    warnings.push(...fileWarnings);
    if (fileSlots.length > 0) {
      slots.push(...fileSlots);
      slotsByFile[name] = fileSlots;
      files.push(name);
    }
  }
  // Deleted files must not pin their decoded arrays in memory forever.
  if (cache) {
    for (const key of [...cache.keys()]) if (!present.has(key)) cache.delete(key);
  }
  if (slots.length === 0) {
    return { dir, files, slots: [], slotsByFile, warnings };
  }
  slots.sort((a, b) => a.time - b.time);
  // Duplicate valid times across files: keep the one from the later file
  // (sorted scan above), assuming newer downloads supersede older ones.
  const dedup: TimeSlot[] = [];
  for (const s of slots) {
    const last = dedup[dedup.length - 1];
    if (last && last.time === s.time && Math.abs(last.depth - s.depth) < 1e-6) dedup[dedup.length - 1] = s;
    else dedup.push(s);
  }
  return { dir, files, slots: dedup, slotsByFile, warnings };
}

function sampleSlot(slot: TimeSlot, lat: number, lon: number): { u: number; v: number } | null {
  const u = sampleGrid(slot.grid, slot.u, lat, lon);
  const v = sampleGrid(slot.grid, slot.v, lat, lon);
  if (u === null || v === null) return null;
  return { u, v };
}

/**
 * Interpolated current vector at a position/time, or null when the position
 * is outside every grid (or on land) or the time is outside the covered
 * range by more than GRIB_TIME_SLACK_MS.
 *
 * Unlike station samples, `speedKn` is a magnitude (there is no flood/ebb
 * axis in gridded data — the sign convention does not apply).
 *
 * `files` restricts the lookup to slots parsed from those files (union,
 * merged by time) — how per-dataset priority (PRD §5.3 Phase 3) probes one
 * installed dataset instead of the whole merged directory.
 */
export function gribVectorAt(
  data: GribCurrentsData,
  lat: number,
  lon: number,
  timeMs: number,
  files?: ReadonlySet<string>,
): CurrentSample | null {
  let slots = data.slots;
  if (files) {
    const lists = Object.entries(data.slotsByFile)
      .filter(([name]) => files.has(name))
      .map(([, list]) => list);
    if (lists.length === 0) return null;
    slots = lists.length === 1 ? lists[0] : lists.flat().sort((a, b) => a.time - b.time);
  }
  if (slots.length === 0) return null;
  if (timeMs < slots[0].time - GRIB_TIME_SLACK_MS) return null;
  if (timeMs > slots[slots.length - 1].time + GRIB_TIME_SLACK_MS) return null;

  // Bracketing slots (binary search).
  let lo = 0;
  let hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (slots[mid].time <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  const s0 = slots[lo];
  const s1 = slots[Math.min(lo + 1, slots.length - 1)];

  const a = sampleSlot(s0, lat, lon);
  const b = s1 === s0 ? a : sampleSlot(s1, lat, lon);
  let u: number;
  let v: number;
  if (a && b && s1.time > s0.time && timeMs >= s0.time) {
    const w = Math.min(1, (timeMs - s0.time) / (s1.time - s0.time));
    u = a.u * (1 - w) + b.u * w;
    v = a.v * (1 - w) + b.v * w;
  } else if (a ?? b) {
    ({ u, v } = (a ?? b)!);
  } else {
    return null;
  }

  const speedMs = Math.hypot(u, v);
  const direction = speedMs > 1e-6 ? ((Math.atan2(u, v) * RAD2DEG) % 360 + 360) % 360 : 0;
  return {
    time: new Date(timeMs).toISOString(),
    speedKn: Math.round((speedMs / KNOTS_TO_MS) * 100) / 100,
    direction: Math.round(direction * 10) / 10,
    u: Math.round(u * 1000) / 1000,
    v: Math.round(v * 1000) / 1000,
  };
}

export interface GridSample {
  latitude: number;
  longitude: number;
  speedKn: number;
  direction: number;
  u: number;
  v: number;
}

/**
 * Current vectors within a bounding box, for a map's flow-field overlay
 * (there is no station concept in gridded data, so this is the only way to
 * show GRIB coverage beyond a single point).
 *
 * Samples are chosen from the source grid's own fixed (i, j) lattice —
 * never at bbox-relative offsets — specifically so a given physical point
 * always lands at the same lat/lon. Otherwise, since the bbox is the map
 * viewport, every pan/zoom would shift the sampling phase and the arrows
 * would appear to jump to unrelated positions instead of the same current
 * field just being panned/zoomed with the map. `stride` (spacing between
 * sampled grid indices) is chosen to target roughly `maxPoints` samples
 * over the box and is snapped to multiples of itself, so panning at a
 * fixed stride reveals/hides points from one stable lattice, and only
 * zooming across a stride change re-grids (coarser/finer), like a tile
 * pyramid. Points with no coverage (land, outside the grid, outside the
 * time slack) are omitted, so the result can be smaller than `maxPoints`.
 */
/**
 * The distinct grid geometries loaded — one per downloaded region — each with
 * the set of files on that grid. Different regions (e.g. US East Coast vs. US
 * West Coast) are separate GRIB grids with their own origin/extent, so anything
 * that walks a lattice must cover each of them.
 *
 * Derived from `slotsByFile`, NOT the merged `slots`: every NOAA RTOFS region
 * from one cycle carries the SAME forecast valid-times, so the same-time dedup
 * in loadGribDir collapses `slots` down to whichever region's file sorts last,
 * erasing every other region's grid from the merged list. The `files` set lets
 * callers restrict `gribVectorAt` to a region's own (un-deduped) slots, exactly
 * as resolveVector's per-dataset probe does.
 */
function gridGroups(data: GribCurrentsData): { grid: Grib2Grid; files: Set<string> }[] {
  const groups: { grid: Grib2Grid; files: Set<string> }[] = [];
  for (const [file, slots] of Object.entries(data.slotsByFile)) {
    if (slots.length === 0) continue;
    const grid = slots[0].grid;
    let g = groups.find((x) => sameGrid(x.grid, grid));
    if (!g) {
      g = { grid, files: new Set() };
      groups.push(g);
    }
    g.files.add(file);
  }
  return groups;
}

/** Integer (i, j) index window of a grid's own lattice covering `bbox`, or null when the grid and the bbox are disjoint. */
function gridBboxWindow(
  grid: Grib2Grid,
  bbox: { west: number; south: number; east: number; north: number },
): { iMin: number; iMax: number; jMin: number; jMax: number } | null {
  // lonIndex must return the index CLOSEST to the grid's own span, not the
  // [0, 360/di) principal value: a plain "% 360" modulo always folds a
  // faraway west edge to a huge positive index instead of a small negative
  // one. That's invisible while a regional grid is small relative to the
  // viewport's distance from lon0, but the moment a caller's bbox is wider
  // than the grid (e.g. a map viewport zoomed out past the grid's own
  // extent), bbox.west lands past grid.lon0's "far side" and the raw modulo
  // index overshoots grid.ni with no upper clamp — iMin then exceeds the
  // (correctly clamped) iMax and the grid is wrongly reported as not
  // overlapping the bbox at all, even though it's fully contained in it.
  const lonIndex = (lon: number): number =>
    (((((lon - grid.lon0 + 180) % 360) + 360) % 360) - 180) / grid.di;
  let iMinF = lonIndex(bbox.west);
  let iMaxF = lonIndex(bbox.east);
  if (iMaxF < iMinF) iMaxF += 360 / grid.di; // bbox straddles the grid's lon0 wrap point
  // A bbox at least as wide as the grid itself trivially contains the whole
  // grid regardless of where its edges happen to normalize to — covers the
  // fully-zoomed-out case without relying on delicate modulo arithmetic.
  if (iMaxF - iMinF >= grid.ni - 1) {
    iMinF = 0;
    iMaxF = grid.ni - 1;
  }
  const iMin = Math.max(0, Math.floor(iMinF));
  const iMax = Math.min(grid.ni - 1, Math.ceil(iMaxF));
  const jMin = Math.max(0, Math.floor((bbox.south - grid.lat0) / grid.dj));
  const jMax = Math.min(grid.nj - 1, Math.ceil((bbox.north - grid.lat0) / grid.dj));
  if (iMax < iMin || jMax < jMin) return null;
  return { iMin, iMax, jMin, jMax };
}

export function gribGridSamples(
  data: GribCurrentsData,
  bbox: { west: number; south: number; east: number; north: number },
  timeMs: number,
  maxPoints = 400,
): GridSample[] {
  // Each downloaded region is its own grid geometry. Sample every region
  // whose lattice overlaps the viewport — not just the merged grid — or a
  // viewport over any region the same-time dedup dropped from `slots` (e.g.
  // the US East Coast, shadowed by the Pacific region) returns no arrows
  // even though per-point lookups there succeed.
  const windows = gridGroups(data)
    .map((g) => ({ ...g, win: gridBboxWindow(g.grid, bbox) }))
    .filter((w): w is typeof w & { win: NonNullable<typeof w.win> } => w.win !== null);
  if (windows.length === 0) return [];

  // Split the point budget across overlapping regions so the total stays
  // near maxPoints (regions are mostly disjoint, so usually there is one).
  const perGrid = Math.max(1, Math.floor(maxPoints / windows.length));

  const points: GridSample[] = [];
  for (const { grid, files, win } of windows) {
    const { iMin, iMax, jMin, jMax } = win;
    const iCount = iMax - iMin + 1;
    const jCount = jMax - jMin + 1;
    const stride = Math.max(1, Math.ceil(Math.sqrt((iCount * jCount) / perGrid)));
    // Snap the start to a multiple of stride so the chosen indices are the
    // same regardless of where iMin/jMin happen to fall for this viewport.
    const iStart = Math.ceil(iMin / stride) * stride;
    const jStart = Math.ceil(jMin / stride) * stride;

    for (let j = jStart; j <= jMax; j += stride) {
      const lat = grid.lat0 + j * grid.dj;
      for (let i = iStart; i <= iMax; i += stride) {
        const lonRaw = grid.lon0 + i * grid.di;
        const lon = ((lonRaw + 180) % 360 + 360) % 360 - 180;
        // Restrict to this region's own files so the dedup that dropped it
        // from the merged `slots` doesn't also blank it here.
        const sample = gribVectorAt(data, lat, lon, timeMs, files);
        if (sample && sample.u !== null && sample.v !== null) {
          points.push({
            latitude: Math.round(lat * 1e4) / 1e4,
            longitude: Math.round(lon * 1e4) / 1e4,
            speedKn: sample.speedKn,
            direction: sample.direction ?? 0,
            u: sample.u,
            v: sample.v,
          });
          if (points.length >= maxPoints) return points;
        }
      }
    }
  }
  return points;
}

/** Coverage summary for the dataset endpoint / plugin status. */
export function gribSummary(data: GribCurrentsData): Record<string, unknown> {
  if (data.slots.length === 0) {
    return { dir: data.dir, files: data.files, fields: 0, warnings: data.warnings };
  }
  // One entry per downloaded region (each is its own grid). The old summary
  // reported only slots[0]'s grid, so a boat with several regions saw the
  // coverage of just one of them (e.g. the Pacific box while the US East
  // Coast was loaded but invisible).
  const regions = gridGroups(data).map(({ grid: g }) => {
    const lonWest = ((g.lon0 + 180) % 360 + 360) % 360 - 180;
    const lonEastRaw = g.lon0 + (g.ni - 1) * g.di;
    const lonEast = ((lonEastRaw + 180) % 360 + 360) % 360 - 180;
    return {
      latMin: Math.round(Math.min(g.lat0, g.lat0 + (g.nj - 1) * g.dj) * 1e4) / 1e4,
      latMax: Math.round(Math.max(g.lat0, g.lat0 + (g.nj - 1) * g.dj) * 1e4) / 1e4,
      lonWest: Math.round(lonWest * 1e4) / 1e4,
      lonEast: Math.round(lonEast * 1e4) / 1e4,
      resolutionDeg: Math.round(g.di * 1e4) / 1e4,
    };
  });
  return {
    dir: data.dir,
    files: data.files,
    fields: data.slots.length,
    timeRange: {
      start: new Date(data.slots[0].time).toISOString(),
      end: new Date(data.slots[data.slots.length - 1].time).toISOString(),
    },
    // Union envelope across all regions (informational — a caller needing
    // exact per-region coverage, or handling antimeridian-straddling grids,
    // should use `regions`). Longitude union is a plain min/max in [-180, 180].
    boundingBox: {
      latMin: Math.min(...regions.map((r) => r.latMin)),
      latMax: Math.max(...regions.map((r) => r.latMax)),
      lonWest: Math.min(...regions.map((r) => r.lonWest)),
      lonEast: Math.max(...regions.map((r) => r.lonEast)),
    },
    regions,
    resolutionDeg: Math.min(...regions.map((r) => r.resolutionDeg)),
    warnings: data.warnings,
  };
}

/**
 * Lazily(re)loading GRIB source: re-stats the directory at most every
 * `checkIntervalMs` and reloads when the file set (name/size/mtime) changed,
 * so dropping a fresh forecast file in requires no plugin restart.
 */
export interface GribSource {
  get(): GribCurrentsData | null;
  /** Set when the last load attempt failed outright. */
  readonly error: string | null;
  /** Forces the next get() call to re-stat the directory and reload immediately, bypassing checkIntervalMs — used right after a catalog-driven download finishes so a newly-downloaded file is served without waiting up to a minute. */
  invalidate(): void;
}

export function createGribSource(dir: string, checkIntervalMs = 60_000): GribSource {
  let data: GribCurrentsData | null = null;
  let signature = '';
  let lastCheck = -Infinity;
  let error: string | null = null;
  // Survives across reloads: only files whose size/mtime changed get re-decoded.
  const fileCache: GribFileCache = new Map();

  const currentSignature = (): string => {
    try {
      return listDataFilesRecursive(dir, GRIB_EXT_RE)
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return `${f}:${st.size}:${st.mtimeMs}`;
        })
        .join('|');
    } catch {
      return '';
    }
  };

  return {
    get(): GribCurrentsData | null {
      const now = Date.now();
      if (now - lastCheck >= checkIntervalMs) {
        lastCheck = now;
        const sig = currentSignature();
        if (sig !== signature) {
          signature = sig;
          try {
            data = loadGribDir(dir, fileCache);
            error = null;
          } catch (e) {
            data = null;
            error = e instanceof Error ? e.message : String(e);
          }
        }
      }
      return data;
    },
    get error(): string | null {
      return error;
    },
    invalidate(): void {
      lastCheck = -Infinity;
    },
  };
}
