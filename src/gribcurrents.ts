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

import { Grib2Field, Grib2Grid, GridCell, locateGridCell, parseGrib2, sampleGrid } from './grib2.js';
import { CurrentSample, KNOTS_TO_MS } from './predict.js';
import { listDataFilesRecursive } from './utcef.js';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * How far outside the covered time range a lookup may clamp to the edge field.
 * Kept short on purpose: a tidal current turns in ~6 h, so holding the last
 * field for hours shows a stale vector that can point the opposite way — and,
 * GRIB usually ranking first, it hides the UTCEF/harmonic answer meanwhile.
 * Past the slack the series is out of range and the resolver falls through to
 * the next source. Times between slots are interpolated and never affected.
 * A series with a single valid time (an analysis/nowcast file) has no range to
 * interpolate in, so it gets GRIB_SINGLE_SLOT_SLACK_MS instead.
 */
export const GRIB_TIME_SLACK_MS = 30 * 60_000;

/** Clamp slack of a series with ONE valid time: still well short of a tidal half-cycle. */
export const GRIB_SINGLE_SLOT_SLACK_MS = 2 * 3_600_000;

/** The clamp slack that applies to a series' slot list. */
export const gribTimeSlackMs = (slots: readonly TimeSlot[]): number =>
  slots.length === 1 ? GRIB_SINGLE_SLOT_SLACK_MS : GRIB_TIME_SLACK_MS;

/** One forecast time with matched u and v grids. */
export interface TimeSlot {
  time: number; // ms epoch (valid time)
  grid: Grib2Grid;
  u: Float64Array; // m/s east
  v: Float64Array; // m/s north
  depth: number; // m below surface (0 = surface), for reporting
  file: string;
  /** Model cycle (analysis/reference time) the field belongs to, ms epoch. */
  refTime: number;
}

/**
 * All the slots of ONE grid geometry. The unit GRIB lookups work on: a grid
 * never shadows another grid, and a lookup brackets in time only among the
 * slots of its own series (deduped per valid time — shallowest depth, then
 * newest refTime, then later file name — so one forecast cycle answers a
 * given valid time).
 */
export interface GridSeries {
  /** One shared object per distinct geometry within a data object (compare by identity). */
  grid: Grib2Grid;
  /** Files contributing slots to this grid, sorted. */
  files: string[];
  /** Deduped per valid time, sorted by time. */
  slots: TimeSlot[];
  /** Every candidate slot before the per-time dedup (what gribSubsetSeries subsets are built from). */
  raw: TimeSlot[];
  /**
   * Per-cell coverage bits (index j0*ni + i0 of locateGridCell): bit 0 = the
   * cell is bilinear-defined in at least one slot (necessary condition),
   * bit 1 = defined in EVERY slot (sufficient). Time-independent.
   */
  cellMask: Uint8Array;
}

export interface GribCurrentsData {
  dir: string;
  files: string[];
  /** One entry per distinct grid geometry, finest resolution first (ties by file name). */
  series: GridSeries[];
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
    refTime: number;
    byParam: Map<number, Grib2Field>;
  }
  const buckets: Bucket[] = [];
  for (const f of fields) {
    if (!isCurrentField(f)) continue;
    const depth = fieldDepth(f);
    if (depth === null) continue;
    let b = buckets.find(
      (x) => x.time === f.validTime && x.refTime === f.refTime && Math.abs(x.depth - depth) < 1e-6 && sameGrid(x.grid, f.grid),
    );
    if (!b) {
      b = { time: f.validTime, depth, grid: f.grid, refTime: f.refTime, byParam: new Map() };
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
    list.sort((a, b) => a.depth - b.depth || b.refTime - a.refTime);
    let made = false;
    for (const b of list) {
      const u = b.byParam.get(2);
      const v = b.byParam.get(3);
      if (u && v) {
        slots.push({ time, grid: b.grid, u: u.values, v: v.values, depth: b.depth, file, refTime: b.refTime });
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
        slots.push({ time, grid: b.grid, u: uu, v: vv, depth: b.depth, file, refTime: b.refTime });
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

// ── Series model ──

/** Finest grid first (|di·dj| ascending), ties by first file name. */
function seriesOrder(a: GridSeries, b: GridSeries): number {
  const ra = Math.abs(a.grid.di * a.grid.dj);
  const rb = Math.abs(b.grid.di * b.grid.dj);
  if (ra !== rb) return ra - rb;
  return a.files[0] < b.files[0] ? -1 : a.files[0] > b.files[0] ? 1 : 0;
}

/**
 * Per-cell coverage bits for a series (see GridSeries.cellMask). Built from
 * per-NODE accumulators over all slots (one pass over the decoded arrays), then
 * folded into cells with the same corner indices locateGridCell produces.
 */
function buildCellMask(grid: Grib2Grid, slots: TimeSlot[]): Uint8Array {
  const { ni, nj } = grid;
  const n = ni * nj;
  const allOk = new Uint8Array(n).fill(1);
  const anyU = new Uint8Array(n);
  const anyV = new Uint8Array(n);
  for (const slot of slots) {
    const u = slot.u;
    const v = slot.v;
    for (let k = 0; k < n; k++) {
      const nu = !Number.isNaN(u[k]);
      const nv = !Number.isNaN(v[k]);
      if (nu) anyU[k] = 1;
      if (nv) anyV[k] = 1;
      if (!(nu && nv)) allOk[k] = 0;
    }
  }
  const mask = new Uint8Array(n);
  for (let j0 = 0; j0 < nj; j0++) {
    const j1 = Math.min(nj - 1, j0 + 1);
    for (let i0 = 0; i0 < ni; i0++) {
      const i1 = grid.globalLon ? (i0 + 1) % ni : Math.min(ni - 1, i0 + 1);
      const k0 = j0 * ni + i0;
      const k1 = j0 * ni + i1;
      const k2 = j1 * ni + i0;
      const k3 = j1 * ni + i1;
      const all = allOk[k0] & allOk[k1] & allOk[k2] & allOk[k3];
      const any = (anyU[k0] | anyU[k1] | anyU[k2] | anyU[k3]) & (anyV[k0] | anyV[k1] | anyV[k2] | anyV[k3]);
      mask[k0] = any | (all << 1);
    }
  }
  return mask;
}

/** Work counter for tests: how many series (dedup + cell mask) were built. A subset series is built once per (data, layer snapshot) — see gribSubsetSeries. */
export const gribBuildCounts = { series: 0 };

/** One series from the candidate slots `raw` of ONE grid: dedup per valid time (shallowest depth, then newest refTime, then later file) and the cell mask. */
function makeSeries(grid: Grib2Grid, raw: TimeSlot[]): GridSeries {
  gribBuildCounts.series++;
  const ranked = raw
    .slice()
    .sort(
      (a, b) =>
        a.time - b.time ||
        a.depth - b.depth ||
        b.refTime - a.refTime ||
        (a.file < b.file ? 1 : a.file > b.file ? -1 : 0),
    );
  const slots: TimeSlot[] = [];
  for (const s of ranked) if (slots.length === 0 || slots[slots.length - 1].time !== s.time) slots.push(s);
  const files = [...new Set(raw.map((s) => s.file))].sort();
  return { grid, files, slots, raw, cellMask: buildCellMask(grid, slots) };
}

/**
 * Group slots by grid geometry into series. Within a grid, one slot per valid
 * time: shallowest depth, then newest refTime, then later file name. Ordered
 * finest-resolution first, then by file name.
 */
export function buildGridSeries(all: TimeSlot[]): GridSeries[] {
  const groups: Array<{ grid: Grib2Grid; raw: TimeSlot[] }> = [];
  for (const s of all) {
    let g = groups.find((x) => sameGrid(x.grid, s.grid));
    if (!g) groups.push((g = { grid: s.grid, raw: [] }));
    g.raw.push(s);
  }
  return groups.map(({ grid, raw }) => makeSeries(grid, raw)).sort(seriesOrder);
}

/** Parse every GRIB2 file in a directory (recursively — catalog filenames may carry subdir paths) into per-grid series. Pass a `cache` (owned by a long-lived source) to re-parse only files whose size/mtime changed. */
export function loadGribDir(dir: string, cache?: GribFileCache): GribCurrentsData | null {
  if (!fs.existsSync(dir)) return null; // directory absent — GRIB source simply not configured
  const entries = listDataFilesRecursive(dir, GRIB_EXT_RE);
  if (entries.length === 0) {
    cache?.clear();
    return null;
  }

  const warnings: string[] = [];
  const slots: TimeSlot[] = [];
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
      files.push(name);
    }
  }
  // Deleted files must not pin their decoded arrays in memory forever.
  if (cache) {
    for (const key of [...cache.keys()]) if (!present.has(key)) cache.delete(key);
  }
  return { dir, files, series: buildGridSeries(slots), warnings };
}

/**
 * The series a lookup restricted to `files` works on, built from the files'
 * own slots (same dedup/order rules as the unrestricted series). NOT cached
 * here: the resolver keeps one result per (data, layer snapshot) so it is built
 * once per stack layer and freed with the data or the stack (resolve.ts).
 *
 * Per geometry, a file subset that equals the canonical series' full file set
 * (the common case — a dataset's files ARE a region's files) reuses the
 * canonical `GridSeries` object itself: no second dedup pass, no second cell
 * mask, and `grid` identity with the unrestricted series comes for free. Only a
 * strict subset (e.g. one cycle of a region that also has another) is built,
 * on the data's canonical grid object.
 */
export function gribSubsetSeries(data: GribCurrentsData, files: ReadonlySet<string>): GridSeries[] {
  const out: GridSeries[] = [];
  for (const canon of data.series) {
    const raw = canon.raw.filter((slot) => files.has(slot.file));
    if (raw.length === 0) continue;
    out.push(raw.length === canon.raw.length ? canon : makeSeries(canon.grid, raw));
  }
  return out.sort(seriesOrder);
}

/** `data.series` for every file (`files` undefined), else the file-subset series (uncached — see gribSubsetSeries). */
export function gribSeriesFor(data: GribCurrentsData, files?: ReadonlySet<string>): readonly GridSeries[] {
  return files ? gribSubsetSeries(data, files) : data.series;
}

function sampleSlot(slot: TimeSlot, lat: number, lon: number): { u: number; v: number } | null {
  const u = sampleGrid(slot.grid, slot.u, lat, lon);
  const v = sampleGrid(slot.grid, slot.v, lat, lon);
  if (u === null || v === null) return null;
  return { u, v };
}

/** Index of the slot at/just before `timeMs` in a sorted list, or -1 when out of range (beyond the clamp slack). */
function bracketIndex(slots: TimeSlot[], timeMs: number): number {
  if (slots.length === 0) return -1;
  const slack = gribTimeSlackMs(slots);
  if (timeMs < slots[0].time - slack) return -1;
  if (timeMs > slots[slots.length - 1].time + slack) return -1;
  // Bracketing slots (binary search).
  let lo = 0;
  let hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (slots[mid].time <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const scratchCell: GridCell = { i0: 0, i1: 0, j0: 0, j1: 0, wx: 0, wy: 0 };

/** Is `timeMs` inside the series' slots (± the clamp slack)? The only time dependence of a coverage probe besides partially-defined cells. */
export function gribSeriesInRange(series: GridSeries, timeMs: number): boolean {
  return bracketIndex(series.slots, timeMs) >= 0;
}

/**
 * Is the series defined at (lat, lon) in ANY of its slots — i.e. is this sea
 * rather than land for this grid? Time-independent (no range check): the same
 * non-null condition as gribSeriesSample at some slot. The cell mask settles
 * fully-defined and fully-undefined cells with one lookup; only a partially
 * defined (coastline) cell samples its slots until one answers.
 */
export function gribSeriesDefinedAt(series: GridSeries, lat: number, lon: number): boolean {
  const cell = locateGridCell(series.grid, lat, lon, scratchCell);
  if (!cell) return false;
  const m = series.cellMask[cell.j0 * series.grid.ni + cell.i0];
  if (m & 2) return series.slots.length > 0;
  if (!(m & 1)) return false;
  for (const slot of series.slots) if (sampleSlot(slot, lat, lon) !== null) return true;
  return false;
}

/** Out-flag of a coverage probe: set when the answer depended on the time beyond the series' range check. */
export interface TimeDependence {
  timeDependent: boolean;
}

/**
 * Does `series` answer at (lat, lon, timeMs)? EXACTLY the non-null condition
 * of gribSeriesSample, without building a sample: the cell mask settles the
 * common cases (defined in every slot / in none) with one lookup, and only a
 * partially-defined cell (coastline) falls back to sampling the two
 * bracketing slots. The mask is time-independent, so scrolling time never
 * rebuilds it.
 *
 * `td` (optional) is raised when the probe had to sample the bracketing slots:
 * only then can the answer change with `timeMs` while the series stays in
 * range. The out-of-range outcome is a function of the time too, but of a
 * coarse one the caller keys on separately (gribSeriesInRange).
 */
export function gribSeriesCovers(series: GridSeries, lat: number, lon: number, timeMs: number, td?: TimeDependence): boolean {
  const lo = bracketIndex(series.slots, timeMs);
  if (lo < 0) return false;
  const cell = locateGridCell(series.grid, lat, lon, scratchCell);
  if (!cell) return false;
  const m = series.cellMask[cell.j0 * series.grid.ni + cell.i0];
  if (m & 2) return true;
  if (!(m & 1)) return false;
  if (td) td.timeDependent = true;
  const s0 = series.slots[lo];
  const s1 = series.slots[Math.min(lo + 1, series.slots.length - 1)];
  return sampleSlot(s0, lat, lon) !== null || (s1 !== s0 && sampleSlot(s1, lat, lon) !== null);
}

/** The first series (in the given order) that answers at the point, or null. `td` is raised if any probe consulted was time-dependent. */
export function gribClaimSeries(
  list: readonly GridSeries[],
  lat: number,
  lon: number,
  timeMs: number,
  td?: TimeDependence,
): GridSeries | null {
  for (const s of list) if (gribSeriesCovers(s, lat, lon, timeMs, td)) return s;
  return null;
}

/**
 * Bilinear-in-space, linear-in-time current at a point from one series; null
 * when the time is outside the slots (beyond the clamp slack) or the point is
 * uncovered.
 *
 * Unlike station samples, `speedKn` is a magnitude (there is no flood/ebb
 * axis in gridded data — the sign convention does not apply).
 */
export function gribSeriesSample(
  series: GridSeries,
  lat: number,
  lon: number,
  timeMs: number,
): CurrentSample | null {
  const lo = bracketIndex(series.slots, timeMs);
  if (lo < 0) return null;
  const s0 = series.slots[lo];
  const s1 = series.slots[Math.min(lo + 1, series.slots.length - 1)];

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

/**
 * Interpolated current vector at a position/time: the first series (finest
 * grid first) with a value there — no merged slot list, no fallback pass.
 * `files` restricts the lookup to those files' own series (per-dataset
 * priority, PRD §5.3 Phase 3) — built per call, so a hot path (the resolver)
 * holds on to the series instead (resolve.ts).
 */
export function gribVectorAt(
  data: GribCurrentsData,
  lat: number,
  lon: number,
  timeMs: number,
  files?: ReadonlySet<string>,
): { sample: CurrentSample; series: GridSeries } | null {
  for (const series of gribSeriesFor(data, files)) {
    const sample = gribSeriesSample(series, lat, lon, timeMs);
    if (sample) return { sample, series };
  }
  return null;
}

/** Integer (i, j) index window of a grid's own lattice covering `bbox`, or null when the grid and the bbox are disjoint. */
export function gribLatticeWindow(
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

/** Total forecast slots across all series (status line / summary). */
export function gribSlotCount(data: GribCurrentsData): number {
  let n = 0;
  for (const s of data.series) n += s.slots.length;
  return n;
}

/** Coverage summary for the dataset endpoint / plugin status. */
export function gribSummary(data: GribCurrentsData): Record<string, unknown> {
  if (data.series.length === 0) {
    return { dir: data.dir, files: data.files, fields: 0, warnings: data.warnings };
  }
  // One entry per distinct grid (each downloaded region is its own grid).
  const regions = data.series.map(({ grid: g }) => {
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
  let start = Infinity;
  let end = -Infinity;
  for (const s of data.series) {
    start = Math.min(start, s.slots[0].time);
    end = Math.max(end, s.slots[s.slots.length - 1].time);
  }
  return {
    dir: data.dir,
    files: data.files,
    fields: gribSlotCount(data),
    timeRange: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
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
