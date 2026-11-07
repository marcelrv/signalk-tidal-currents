// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * /grid invariants. Instead of pinning individual edge cases, these tests pin
 * the RULES the implementation is built on (see AGENTS.md):
 *   1. one resolver: every /grid point equals /vector at its coordinates;
 *   2. per-grid GRIB series: no cycle mixing, no cross-grid shadowing;
 *   3. geometry-only density: nested power-of-two lattices, fill by candidate
 *      count, total <= maxPoints by construction;
 *   4. counted work: the cost of a request is bounded by its output.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerRoutes, resolveVector, gridPoints, REST_FALLBACK_MAX_KM, ApiState } from '../dist/api.js';
import { createGribSource, gribBuildCounts } from '../dist/gribcurrents.js';
import { loadHarmonicsDir } from '../dist/harmonics.js';
import { claimAt, createResolveCtx, orderedLayers, ownWinCacheSize, ownWinFor, resolveAt, resolveBuildCounts, OWN_TIME_DEPENDENT, OWN_WIN_CACHE_CAP } from '../dist/resolve.js';
import { createUtcefSource, utcefStationsInBbox } from '../dist/utcef.js';
import { encodeGrib2File, EncodeField } from './grib2-testutil.js';
import { T0, HOUR, gridTime, uvFields, gribDirOf, writeUtcefDir, rect, makeApi, rng, P, UtcefStationSpec } from './grid-testutil.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const legacyData = loadHarmonicsDir(FIXTURES);

const isoAt = (ms: number) => new Date(ms).toISOString();

/** Assert every point equals the resolver's answer at its own coordinates. */
function assertParity(state: ApiState, pts: P[], timeMs: number, label = '') {
  for (const p of pts) {
    const rv = resolveVector(state, p.latitude, p.longitude, timeMs, REST_FALLBACK_MAX_KM);
    const where = `${label} ${p.latitude},${p.longitude} (${p.source}/${p.stationId})`;
    assert.ok(rv, `/vector has no answer at ${where}`);
    assert.equal(rv.source, p.source, where);
    const id = rv.utcefStation?.id ?? rv.station?.id;
    assert.equal(p.stationId, id, where);
    assert.equal(p.u, rv.sample.u, where);
    assert.equal(p.v, rv.sample.v, where);
    assert.equal(p.direction, rv.sample.direction, where);
    assert.equal(p.speedKn, rv.source === 'station' ? Math.abs(rv.sample.speedKn) : rv.sample.speedKn, where);
  }
}

const key = (p: { latitude: number; longitude: number }) => `${p.latitude},${p.longitude}`;

type Box = { west: number; south: number; east: number; north: number };
/** In-view stations (UTCEF and legacy) whose own-position winner depends on the time. */
function timeDependentInView(ctx: ReturnType<typeof createResolveCtx>, view: Box, t: number): number {
  let n = 0;
  const count = (kind: 'utcef' | 'station', ranks: Uint32Array) => {
    const own = ownWinFor(ctx, kind, t);
    for (const r of ranks) if (own[r] === OWN_TIME_DEPENDENT) n++;
  };
  if (ctx.utcef && ctx.utcefIndex && ctx.layers.some((l) => l.type === 'utcef')) count('utcef', ctx.utcefIndex.points.inBboxRanks(view.west, view.south, view.east, view.north));
  if (ctx.harmonics && ctx.legacyIndex && ctx.layers.some((l) => l.type === 'harmonic')) count('station', ctx.legacyIndex.index.inBboxRanks(view.west, view.south, view.east, view.north));
  return n;
}

// ── 1. Parity: /grid == /vector over randomized synthetic setups ──

test('parity: every /grid point equals /vector at its coordinates (randomized setups)', () => {
  const rand = rng(20260110);
  // Pre-encoded GRIB pool. Per-node values vary in space and time; some nodes are NaN (land).
  const ramp = (n: number, base: number, land = false) =>
    Array.from({ length: n * n }, (_, k) => (land && k % 7 === 3 ? NaN : base + (k % n) * 0.15 - Math.floor(k / n) * 0.05));
  const pool: Record<string, EncodeField[]> = {
    'a.grb2': [0, 6].flatMap((h) => uvFields(52.9, 4.9, 0.1, 7, { u: ramp(7, 0.3 + h * 0.05, true), v: ramp(7, -0.2), forecastHours: h })),
    // Newer cycle of the SAME grid as a.grb2.
    'a2.grb2': [0, 6].flatMap((h) => uvFields(52.9, 4.9, 0.1, 7, { u: ramp(7, 2), v: ramp(7, 1), forecastHours: h, refTime: T0 + 3 * HOUR })),
    // At +6h some nodes are missing: cells that are defined in only SOME slots (coastline, time-dependent coverage).
    'b.grb2': [0, 6, 12].flatMap((h) => uvFields(52.9, 4.9, 0.05, 13, { u: ramp(13, 0.1 * h).map((x, k) => (h === 6 && k % 11 < 4 ? NaN : x)), v: 0.4, forecastHours: h })),
    'c.grb2': uvFields(53.3, 5.3, 0.1, 7, { u: 3, v: -1 }),
    'd.grb2': uvFields(40, -10, 0.1, 7, { u: 0.5, v: 0.5 }),
  };
  const gribBytes = Object.fromEntries(Object.entries(pool).map(([n, f]) => [n, encodeGrib2File(f)]));
  const gribNames = Object.keys(pool);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const shuffle = <T>(arr: T[]) => arr.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);

  let withPoints = 0;
  let sources = new Set<string>();
  for (let n = 0; n < 60; n++) {
    // GRIB: random non-empty subset.
    const gribFiles = gribNames.filter(() => rand() < 0.5);
    if (gribFiles.length === 0) gribFiles.push(pick(gribNames));
    const gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-par-g-'));
    for (const f of gribFiles) fs.writeFileSync(path.join(gdir, f), gribBytes[f]);
    // UTCEF: 0, 1 or 2 files, some stations with areas.
    const utcefFiles: Record<string, UtcefStationSpec[]> = {};
    for (const f of ['u1.utcef', 'u2.utcef'].filter(() => rand() < 0.5)) {
      utcefFiles[f] = Array.from({ length: 2 + Math.floor(rand() * 6) }, (_, k): UtcefStationSpec => {
        const lat = 52.7 + rand() * 1.0;
        const lon = 4.7 + rand() * 1.1;
        const w = 0.05 + rand() * 0.25;
        return [`${f[1]}-${k}`, lat, lon, rand() < 0.3 ? rect(lon - w, lat - w, lon + w, lat + w) : undefined];
      });
    }
    const haveUtcef = Object.keys(utcefFiles).length > 0;
    const udir = haveUtcef ? writeUtcefDir(utcefFiles) : null;
    const haveLegacy = rand() < 0.5;

    const state: ApiState = {
      data: haveLegacy ? legacyData : null,
      error: null,
      grib: createGribSource(gdir, 0),
      utcef: udir ? createUtcefSource(udir, 0) : null,
      preferGrib: rand() < 0.6,
    };
    if (rand() < 0.3) state.sourcePriority = shuffle(['grib2', 'utcef', 'harmonic'] as const).slice() as ApiState['sourcePriority'];
    if (rand() < 0.5) {
      const entries = [
        ...gribFiles.filter(() => rand() < 0.6).map((f) => ({ id: `g-${f}`, type: 'grib2' as const, files: [f] })),
        ...Object.keys(utcefFiles).filter(() => rand() < 0.6).map((f) => ({ id: `u-${f}`, type: 'utcef' as const, files: [f] })),
        ...(haveLegacy && rand() < 0.5 ? [{ id: 'h', type: 'harmonic' as const, files: [] as string[] }] : []),
      ];
      const stack = shuffle(entries);
      state.datasetRank = () => stack;
    }

    const west = 4.6 + rand() * 0.8;
    const south = 52.6 + rand() * 0.8;
    const bbox = [west, south, west + 0.15 + rand() * 1.05, south + 0.15 + rand() * 1.05].map((x) => Math.round(x * 1e4) / 1e4);
    const tMs = T0 + Math.floor(rand() * 57) * HOUR;
    const maxPoints = pick([3, 10, 40, 150, 400]);
    const q: Record<string, unknown> = { bbox: bbox.join(','), time: isoAt(tMs), maxPoints: String(maxPoints) };
    if (haveLegacy) q.stations = '1';
    const body = makeApi(state)('/grid', q);
    if (!body.points) continue; // 503: nothing loaded in this draw (cannot happen with GRIB, kept for safety)
    const pts = body.points as P[];
    assert.ok(pts.length <= maxPoints, `setup ${n}: ${pts.length} > ${maxPoints}`);
    assert.equal(new Set(pts.map(key)).size, pts.length, `setup ${n}: duplicate positions`);
    assertParity(state, pts, tMs, `setup ${n}`);
    if (pts.length > 0) withPoints++;
    for (const p of pts) sources.add(p.source);
    fs.rmSync(gdir, { recursive: true, force: true });
  }
  assert.ok(withPoints >= 20, `only ${withPoints}/60 setups produced points — test too weak`);
  assert.ok(sources.has('grib') && sources.has('utcef') && sources.has('station'), `sources seen: ${[...sources]}`);
});

// ── 2. No cycle mixing ──

test('no cycle mixing: a valid time is answered from the newest cycle only, never blended with an older one', () => {
  // Two cycles of ONE grid; both cover the +0h and +6h valid times with different values.
  const cycles = (oldName: string, newName: string) =>
    createGribSource(gribDirOf({
      [oldName]: [0, 6].flatMap((h) => uvFields(52.9, 4.9, 0.1, 7, { u: 1, v: 0, forecastHours: h + 6, refTime: T0 - 6 * HOUR })),
      [newName]: [0, 6].flatMap((h) => uvFields(52.9, 4.9, 0.1, 7, { u: 5, v: 0, forecastHours: h, refTime: T0 })),
    }), 0);
  // Holds whichever file name sorts first: the cycle decides, not the name.
  for (const [oldName, newName] of [['a-old.grb2', 'z-new.grb2'], ['z-old.grb2', 'a-new.grb2']]) {
    const state: ApiState = { data: null, error: null, grib: cycles(oldName, newName), utcef: null, preferGrib: true };
    for (const h of [0, 1, 3, 5.5, 6]) {
      assert.equal(resolveVector(state, 53.2, 5.2, T0 + h * HOUR)!.sample.u, 5, `${oldName}/${newName} +${h}h`);
    }
  }
});

// ── 3. No shadowing ──

test('no shadowing: regions with identical valid times each answer inside their own area, in one probe', () => {
  const grib = createGribSource(gribDirOf({
    'east.grb2': uvFields(52.9, 4.9, 0.1, 7, { u: 1 }),
    'west.grb2': uvFields(40, 290, 0.1, 7, { u: 2 }),
  }), 0);
  const state: ApiState = { data: null, error: null, grib, utcef: null, preferGrib: true };
  assert.equal(resolveVector(state, 53.2, 5.2, T0)!.sample.u, 1);
  assert.equal(resolveVector(state, 40.3, -69.8, T0)!.sample.u, 2);
  // Answered by ONE layer probe each: there is no merged-list miss + fallback pass.
  const ctx = createResolveCtx(state);
  assert.equal(ctx.layers.length, 1);
  for (const [lat, lon] of [[53.2, 5.2], [40.3, -69.8]]) {
    const before = ctx.counters.layerProbes;
    assert.ok(resolveAt(ctx, lat, lon, T0));
    assert.equal(ctx.counters.layerProbes - before, 1);
  }
  const pts = makeApi(state)('/grid', { bbox: '-70,40,-69.4,40.6', time: gridTime, maxPoints: '50' }).points as P[];
  assert.ok(pts.length > 0 && pts.every((p) => p.source === 'grib' && p.u === 2));
  const east = makeApi(state)('/grid', { bbox: '4.9,52.9,5.5,53.5', time: gridTime, maxPoints: '50' }).points as P[];
  assert.ok(east.length > 0 && east.every((p) => p.source === 'grib' && p.u === 1));
});

// ── Shared scene for the density tests ──

// 64×64 nodes at 0.05°: lat 50..53.15, lon 2..5.15.
const BIG_N = 64;
const bigDir = gribDirOf({ 'big.grb2': uvFields(50, 2, 0.05, BIG_N, { u: 1, v: 0 }) });
const bigState = (extra: Partial<ApiState> = {}): ApiState => ({ data: null, error: null, grib: createGribSource(bigDir, 0), utcef: null, preferGrib: true, ...extra });
const bigBbox = '2,50,5.2,53.2';
const gridOf = (state: ApiState, bbox: string, maxPoints: number, extra: Record<string, unknown> = {}, tMs = T0) =>
  makeApi(state)('/grid', { bbox, time: isoAt(tMs), maxPoints: String(maxPoints), ...extra }).points as P[];

// ── 4. Pan stability ──

test('pan stability: same-size views shifted by a fraction of a cell share identical lattice points', () => {
  const state = bigState();
  const cell = 0.05;
  for (const maxPoints of [30, 120, 5000]) {
    const base = [2.2, 50.2, 4.2, 52.2];
    const a = gridOf(state, base.join(','), maxPoints);
    assert.ok(a.length > 0);
    for (const shift of [0.31 * cell, 0.5 * cell, 0.77 * cell, 3.2 * cell]) {
      const b = gridOf(state, base.map((x) => x + shift).join(','), maxPoints);
      // The overlap interior (clear of both views' edges).
      const inBoth = (p: P) => p.longitude > 2.2 + shift + cell && p.longitude < 4.2 - cell && p.latitude > 50.2 + shift + cell && p.latitude < 52.2 - cell;
      const ka = new Map(a.filter(inBoth).map((p) => [key(p), p]));
      const kb = new Map(b.filter(inBoth).map((p) => [key(p), p]));
      assert.ok(ka.size > 0 && kb.size > 0, `maxPoints ${maxPoints} shift ${shift}`);
      // The two views may sit on different fill levels (their windows hold different candidate
      // counts), but lattices nest: the sparser view's points are a subset of the denser one's,
      // and a shared point is identical in both. Nothing is ever MOVED by panning.
      const [sparse, dense] = ka.size <= kb.size ? [ka, kb] : [kb, ka];
      for (const [k, p] of sparse) assert.deepEqual(dense.get(k), p, `maxPoints ${maxPoints} shift ${shift}: ${k}`);
      if (maxPoints === 5000) assert.deepEqual([...ka.keys()].sort(), [...kb.keys()].sort());
    }
  }
});

// ── 5. No flicker ──

test('no flicker: a station that wins in view does not change any lattice point', () => {
  const bbox = '2,50,5.2,53.2';
  const baseDir = writeUtcefDir({ 'far.utcef': [['FAR', 10, -60]] });
  // GRIB ranks first, so the extra stations never win on the lattice; one lies OUTSIDE the grid (wins there).
  const extraDir = writeUtcefDir({ 'far.utcef': [['FAR', 10, -60], ['OUT', 53.19, 5.19], ['IN', 51, 3]] });
  const mk = (dir: string) => bigState({ utcef: createUtcefSource(dir, 0) });
  const lattice = (pts: P[]) => pts.filter((p) => p.source === 'grib');
  for (const maxPoints of [200, 5000]) {
    const without = gridOf(mk(baseDir), bbox, maxPoints);
    const withSt = gridOf(mk(extraDir), bbox, maxPoints);
    assert.deepEqual(lattice(withSt), lattice(without), `maxPoints ${maxPoints}`);
    assert.ok(withSt.length <= maxPoints);
  }
});

// ── 6. Budget ──

test('budget: points.length <= maxPoints for every combination, including overlapping grids and many stations', () => {
  const grib = createGribSource(gribDirOf({
    'fine.grb2': uvFields(51, 3, 0.02, 80, { u: 1 }),
    'coarse.grb2': uvFields(50, 2, 0.5, 8, { u: 2 }),
  }), 0);
  const stations: UtcefStationSpec[] = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) stations.push([`S${i}-${j}`, 50 + i * 0.3, 2 + j * 0.3]);
  const utcef = createUtcefSource(writeUtcefDir({ 'many.utcef': stations }), 0);
  for (const preferGrib of [true, false]) {
    for (const withStations of [false, true]) {
      const state: ApiState = { data: legacyData, error: null, grib, utcef: withStations ? utcef : null, preferGrib };
      for (const bbox of ['2,50,5.5,53.5', '3.1,51.1,3.5,51.5', '-179,-80,179,80']) {
        for (const mp of [1, 2, 3, 5, 8, 13, 30, 60, 200, 1000]) {
          const pts = gridOf(state, bbox, mp, { stations: '1' });
          assert.ok(pts.length <= mp, `${pts.length} > ${mp} (preferGrib=${preferGrib} stations=${withStations} bbox=${bbox})`);
        }
      }
    }
  }
});

// ── 7. Nesting ──

test('nesting: a sparser lattice is a subset of a denser one (stable under budget changes)', () => {
  const state = bigState();
  const budgets = [4000, 1100, 400, 100, 25, 6];
  let prev = new Set(gridOf(state, bigBbox, budgets[0]).map(key));
  assert.ok(prev.size > 1000);
  for (const mp of budgets.slice(1)) {
    const cur = gridOf(state, bigBbox, mp).map(key);
    assert.ok(cur.length > 0 && cur.length <= mp);
    for (const k of cur) assert.ok(prev.has(k), `${k} appears at maxPoints=${mp} but not at the denser level`);
    prev = new Set(cur);
  }
});

// ── 8. Fill ──

test('fill: a small region in an otherwise empty view uses the budget, denser than the geometry-only level', () => {
  // 20×20 nodes at 0.05° (1° square) inside a 4° view: ~6% of it.
  const grib = createGribSource(gribDirOf({ 'small.grb2': uvFields(51, 3, 0.05, 20, { u: 1 }) }), 0);
  const state: ApiState = { data: null, error: null, grib, utcef: null, preferGrib: true };
  const view = '1.5,49.5,5.5,53.5';
  const maxPoints = 400;
  // Level 0 (geometry only): an 80×80-cell view at budget 400 → base stride 8 → just 3×3 nodes of this grid.
  const filled = gridOf(state, view, maxPoints);
  assert.ok(filled.length <= maxPoints);
  assert.equal(filled.length, 400, 'densest power-of-two level that fits: stride 1 → 20×20');
  assert.ok(filled.length > 4 * 9);
  // A tight budget settles at a coarser level and is nested in the denser one.
  const sparse = gridOf(state, view, 30);
  assert.ok(sparse.length > 0 && sparse.length <= 30);
  const dense = new Set(filled.map(key));
  for (const p of sparse) assert.ok(dense.has(key(p)));
});

// ── 9. Stations first ──

test('stations first: adding a winning station never removes it; the lattice drops at most one level', () => {
  const grib = createGribSource(gribDirOf({ 'small.grb2': uvFields(51, 3, 0.05, 20, { u: 1 }) }), 0);
  const view = '1.5,49.5,5.5,53.5';
  const maxPoints = 400;
  const mk = (stations: UtcefStationSpec[]): ApiState => ({
    data: null,
    error: null,
    grib,
    utcef: stations.length ? createUtcefSource(writeUtcefDir({ 's.utcef': stations }), 0) : null,
    preferGrib: true,
  });
  const none = gridOf(mk([]), view, maxPoints);
  assert.equal(none.length, 400);
  // A station outside the GRIB footprint wins there. Its arrival costs the lattice ONE level (400 → 100).
  const one = gridOf(mk([['S1', 49.8, 5.3]]), view, maxPoints);
  assert.ok(one.some((p) => p.stationId === 'S1'));
  const latOne = one.filter((p) => p.source === 'grib');
  assert.equal(latOne.length, 100);
  const noneKeys = new Set(none.map(key));
  for (const p of latOne) assert.ok(noneKeys.has(key(p)), 'remaining arrows did not move');
  // More stations do not make it worse than one more level, and none of them is dropped while they fit.
  const sts: UtcefStationSpec[] = Array.from({ length: 20 }, (_, i) => [`T${i}`, 49.6 + (i % 5) * 0.1, 4.6 + Math.floor(i / 5) * 0.15]);
  const many = gridOf(mk(sts), view, maxPoints);
  assert.equal(many.filter((p) => p.source === 'utcef').length, 20);
  assert.equal(many.filter((p) => p.source === 'grib').length, 100);
  assert.ok(many.length <= maxPoints);
});

// ── 10. Station-won lattice points ──

test('a lattice node won by a station shows that station\'s vector; a station on a node is not emitted twice', () => {
  const utcef = createUtcefSource(writeUtcefDir({ 'g.utcef': [['G', 53.2, 5.2]] }), 0);
  const grib = createGribSource(gribDirOf({ 'g.grb2': uvFields(52.9, 4.9, 0.1, 7, { u: 1 }) }), 0);
  // UTCEF first: G wins the whole GRIB box.
  const state: ApiState = { data: null, error: null, grib, utcef, preferGrib: false };
  const pts = gridOf(state, '5.0,53.0,5.4,53.4', 400);
  const own = pts.find((p) => p.latitude === 53.2 && p.longitude === 5.2 && p.stationId === 'G')!;
  assert.ok(own);
  assert.ok(pts.length > 1);
  for (const p of pts) {
    assert.equal(p.source, 'utcef');
    assert.equal(p.stationId, 'G');
    assert.equal(p.u, own.u);
  }
  assert.equal(new Set(pts.map(key)).size, pts.length);
  assertParity(state, pts, T0);
});

// ── 11. Legacy stations (stations=1) ──

test('stations=1 adds legacy stations through the same resolver; without it no station points appear', () => {
  const grib = createGribSource(gribDirOf({ 'big.grb2': uvFields(52.9, 4.9, 0.02, 31, { u: 1 }) }), 0);
  const utcef = createUtcefSource(writeUtcefDir({ 'far.utcef': [['FAR', 10, -60]] }), 0);
  const bbox = '4.9,52.9,5.5,53.5';
  for (const preferGrib of [true, false]) {
    const state: ApiState = { data: legacyData, error: null, grib, utcef, preferGrib };
    const off = gridOf(state, bbox, 400);
    assert.deepEqual(off, gridOf(state, bbox, 400, { stations: '0' }));
    assert.ok(!off.some((p) => p.source === 'station'));
    const on = gridOf(state, bbox, 400, { stations: '1' });
    assertParity(state, on, T0, `preferGrib=${preferGrib}`);
    assert.equal(on.some((p) => p.source === 'station'), !preferGrib, 'stations only where the rank says they win');
  }
  // Only harmonics loaded: needs the opt-in, otherwise a 503 body.
  const only: ApiState = { data: legacyData, error: null, grib: null, utcef: null, preferGrib: false };
  const body = makeApi(only)('/grid', { bbox, time: gridTime, stations: '1' });
  assert.ok(body.points.some((p: P) => p.source === 'station'));
  assert.ok(makeApi(only)('/grid', { bbox, time: gridTime }).error);
});

test('a legacy station without a sample at `time` falls through exactly like /vector', () => {
  const { firstYear, numYears } = legacyData.constituents;
  const tOut = Date.UTC(firstYear + numYears + 2, 5, 1);
  const grib = createGribSource(gribDirOf({ 'late.grb2': uvFields(52.9, 4.9, 0.02, 31, { u: 1, refTime: tOut }) }), 0);
  const state: ApiState = { data: legacyData, error: null, grib, utcef: null, preferGrib: false };
  const pts = gridOf(state, '4.9,52.9,5.5,53.5', 400, { stations: '1' }, tOut);
  assert.ok(pts.length > 10);
  assertParity(state, pts, tOut);
});

// ── 12. Counted work ──

test('counted work: a request costs O(output + in-view stations), layers out of view cost nothing, nothing accumulates', () => {
  // A dense UTCEF cluster in view, a GRIB region, and 20 orphan UTCEF files elsewhere on the globe.
  const view = { west: 4.5, south: 52.5, east: 5.7, north: 53.7 };
  const bbox = `${view.west},${view.south},${view.east},${view.north}`;
  const cluster: UtcefStationSpec[] = [];
  for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) cluster.push([`C${i}-${j}`, 52.6 + i * 0.07, 4.6 + j * 0.07]);
  const files: Record<string, UtcefStationSpec[]> = { 'near.utcef': cluster };
  for (let k = 0; k < 20; k++) files[`orphan${k}.utcef`] = [[`O${k}`, -40 + k, 100 + k]];
  const utcef = createUtcefSource(writeUtcefDir(files), 0);
  const grib = createGribSource(gribDirOf({
    'near.grb2': uvFields(52.9, 4.9, 0.02, 31, { u: 1 }),
    ...Object.fromEntries(Array.from({ length: 5 }, (_, k) => [`far${k}.grb2`, uvFields(-30 + k, 150, 0.1, 7, { u: 1 })])),
  }), 0);
  const stack = [
    ...Array.from({ length: 20 }, (_, k) => ({ id: `o${k}`, type: 'utcef' as const, files: [`orphan${k}.utcef`] })),
    ...Array.from({ length: 5 }, (_, k) => ({ id: `f${k}`, type: 'grib2' as const, files: [`far${k}.grb2`] })),
  ];
  for (const preferGrib of [true, false]) {
    const state: ApiState = { data: legacyData, error: null, grib, utcef, preferGrib, datasetRank: () => stack };
    const inView = utcefStationsInBbox(utcef.get()!, view).length + 1; // + the one legacy station in view
    for (const maxPoints of [20, 150, 600]) {
      const run = () => {
        const ctx = createResolveCtx(state, REST_FALLBACK_MAX_KM, { bbox: view, legacy: true });
        const pts = gridPoints(ctx, view, T0, maxPoints);
        return { ctx, pts };
      };
      const { ctx, pts } = run();
      const c = ctx.counters;
      const label = `preferGrib=${preferGrib} maxPoints=${maxPoints}`;
      assert.ok(pts.length <= maxPoints, label);
      assert.ok(c.resolves <= maxPoints, `${label}: resolves ${c.resolves}`);
      // claimAt runs only for the time-dependent in-view stations and for the thinned survivors.
      const stationPts = pts.filter((p) => p.source !== 'grib').length;
      const tdInView = timeDependentInView(ctx, view, T0);
      assert.ok(c.claims <= tdInView + stationPts, `${label}: claims ${c.claims} > time-dependent ${tdInView} + station points ${stationPts}`);
      assert.ok(c.claims <= inView, `${label}: claims ${c.claims} > in-view stations ${inView}`);
      assert.ok(c.samples <= pts.length, `${label}: samples ${c.samples} > points ${pts.length}`);
      // The 25 out-of-view datasets never became layers; probes are bounded by output × layers actually kept.
      assert.ok(ctx.layers.every((l) => !l.stack), `${label}: out-of-view stack layers were probed`);
      assert.ok(c.layerProbes <= (c.resolves + c.claims) * ctx.layers.length, label);
      // A second identical request does the same work.
      const again = run();
      assert.deepEqual(again.ctx.counters, c, label);
      assert.deepEqual(again.pts, pts, label);
      console.log(`  counters ${label}: points=${pts.length} resolves=${c.resolves} claims=${c.claims} (in-view ${inView}, time-dependent ${tdInView}, station points ${stationPts}) samples=${c.samples} layerProbes=${c.layerProbes} layers=${ctx.layers.length}`);
    }
  }
});

// ── 13. No cache growth ──

test('no cache growth: 1000 /grid requests over varying bboxes and times build every cache entry once', () => {
  const grib = createGribSource(gribDirOf({ 'g.grb2': uvFields(52.9, 4.9, 0.1, 7, { u: 1 }, ) }), 0);
  const utcef = createUtcefSource(writeUtcefDir({ 'u.utcef': [['U', 53.2, 5.2]], 'x.utcef': [['X', 52.5, 5.5]] }), 0);
  // One stable stack snapshot (what the plugin's memoised datasetRank hands out).
  const stack = [
    { id: 'g', type: 'grib2' as const, files: ['g.grb2'] },
    { id: 'u', type: 'utcef' as const, files: ['u.utcef'] },
    { id: 'x', type: 'utcef' as const, files: ['x.utcef'] },
  ];
  const state: ApiState = { data: legacyData, error: null, grib, utcef, preferGrib: true, datasetRank: () => stack };
  const rand = rng(7);
  const call = makeApi(state);
  const req = () => {
    const w = 4 + rand() * 2;
    const s = 52 + rand() * 1.5;
    return call('/grid', { bbox: `${w},${s},${w + 0.1 + rand()},${s + 0.1 + rand()}`, time: isoAt(T0 + Math.floor(rand() * 200) * HOUR), maxPoints: String(10 + Math.floor(rand() * 400)), stations: '1' }).points as P[];
  };
  let total = req().length;
  const warm = { ...resolveBuildCounts };
  for (let n = 0; n < 1000; n++) total += req().length;
  assert.ok(total > 0);
  // Per-layer series and extents were built by the first requests and never again.
  assert.equal(resolveBuildCounts.gribLayerSeries, warm.gribLayerSeries);
  assert.equal(resolveBuildCounts.layerExtents, warm.layerExtents);
  assert.equal(resolveBuildCounts.fileExtentPasses, warm.fileExtentPasses);
  // The station-winner arrays: one per (range state, source), however many requests and times.
  assert.ok(resolveBuildCounts.ownWin - warm.ownWin <= 4, `ownWin builds ${resolveBuildCounts.ownWin - warm.ownWin}`);
  assert.ok(ownWinCacheSize(createResolveCtx(state, REST_FALLBACK_MAX_KM)) <= OWN_WIN_CACHE_CAP);
});

// ── 13b. Per-snapshot layer caches: no thrash with many stack layers ──

/** Every cache counter the layer caches expose, as one comparable object. */
const buildCounts = () => ({ gribSeries: gribBuildCounts.series, ...resolveBuildCounts });

test('layer caches: 40 single-file GRIB and 40 single-file UTCEF stack layers build each layer\'s series / extent once', () => {
  const N = 40;
  // GRIB: 20 regions × 2 cycles, one file each. A layer holds ONE file, which is a strict subset of its
  // region's series (two cycles), so every layer needs its own built series — the case a capped cache thrashes on.
  const gfiles: Record<string, EncodeField[]> = {};
  for (let r = 0; r < N / 2; r++) {
    for (const [tag, cycleH] of [['a', 0], ['b', 3]] as const) {
      gfiles[`r${r}${tag}.grb2`] = uvFields(-60 + r * 5, 10 + r * 7, 0.1, 4, { u: 1 + r * 0.1 + cycleH / 10, forecastHours: 0, refTime: T0 + cycleH * HOUR });
    }
  }
  const ufiles: Record<string, UtcefStationSpec[]> = {};
  for (let k = 0; k < N; k++) ufiles[`s${k}.utcef`] = [[`S${k}`, -60 + k * 3, -170 + k * 8]];
  const grib = createGribSource(gribDirOf(gfiles), 0);
  const utcef = createUtcefSource(writeUtcefDir(ufiles), 0);
  const stack = Object.keys(gfiles).flatMap((g, k) => [
    { id: `g${k}`, type: 'grib2' as const, files: [g] },
    { id: `u${k}`, type: 'utcef' as const, files: [`s${k}.utcef`] },
  ]);
  assert.equal(stack.length, 2 * N);
  const state: ApiState = { data: null, error: null, grib, utcef, preferGrib: true, datasetRank: () => stack };
  const call = makeApi(state);
  grib.get();
  utcef.get();

  // Repeated /vector and /grid requests, at several places and (in-range) times.
  const round = () => {
    const out: unknown[] = [];
    for (let r = 0; r < N / 2; r += 3) {
      for (const h of [0, 2]) out.push(resolveVector(state, -60 + r * 5 + 0.15, 10 + r * 7 + 0.15, T0 + h * HOUR));
    }
    for (const bbox of ['9,-61,40,-30', '-171,-61,-100,-20', '-180,-85,180,85']) {
      for (const h of [0, 1]) out.push(call('/grid', { bbox, time: isoAt(T0 + h * HOUR), maxPoints: '300' }));
    }
    return out;
  };
  const before = buildCounts();
  const first = round();
  const afterFirst = buildCounts();
  assert.equal(afterFirst.gribLayerSeries - before.gribLayerSeries, N, 'each GRIB layer\'s series built once');
  assert.equal(afterFirst.gribSeries - before.gribSeries, N, 'one series (dedup + cell mask) per layer, no duplicates');
  assert.equal(afterFirst.fileExtentPasses - before.fileExtentPasses, 1, 'one pass over the stations for all per-file extents');
  const utcefLayers = orderedLayers(state, REST_FALLBACK_MAX_KM).filter((l) => l.type === 'utcef').length;
  assert.equal(afterFirst.layerExtents - before.layerExtents, utcefLayers, 'each UTCEF layer\'s extent assembled once');
  assert.equal(utcefLayers, N + 1);
  // Many more rounds: nothing is rebuilt, results are unchanged.
  for (let n = 0; n < 5; n++) assert.deepEqual(round(), first);
  assert.deepEqual(buildCounts(), afterFirst, 'no cache entry was built twice');
  const delta = (k: keyof ReturnType<typeof buildCounts>) => afterFirst[k] - before[k];
  console.log(`  layer caches: ${N}+${N} stack layers; builds in round 1 = series ${delta('gribSeries')}, layer series ${delta('gribLayerSeries')}, extent passes ${delta('fileExtentPasses')}, layer extents ${delta('layerExtents')}, ownWin ${delta('ownWin')}; builds in rounds 2-6 = 0`);
});

test('layer caches: a layer whose files are a region\'s whole file set reuses the canonical series (no build, no second cell mask)', () => {
  const N = 40;
  const gfiles: Record<string, EncodeField[]> = {};
  for (let k = 0; k < N; k++) gfiles[`g${k}.grb2`] = uvFields(-60 + k * 2, -170 + k * 8, 0.1, 4, { u: 1 + k * 0.01 });
  const grib = createGribSource(gribDirOf(gfiles), 0);
  const data = grib.get()!;
  const stack = Object.keys(gfiles).map((g, k) => ({ id: `g${k}`, type: 'grib2' as const, files: [g] }));
  const state: ApiState = { data: null, error: null, grib, utcef: null, preferGrib: true, datasetRank: () => stack };
  const before = buildCounts();
  const ctx = createResolveCtx(state);
  const layers = ctx.layers.filter((l) => l.stack);
  assert.equal(layers.length, N);
  for (const l of layers) assert.equal(l.series![0], data.series.find((s) => s.files[0] === [...l.files!][0]), `${[...l.files!]}`);
  createResolveCtx(state);
  assert.equal(gribBuildCounts.series, before.gribSeries, 'no series built');
  assert.equal(makeApi(state)('/grid', { bbox: '-171,-61,-100,20', time: gridTime, maxPoints: '200' }).points.length > 0, true);
  assert.equal(gribBuildCounts.series, before.gribSeries);
});

// ── 13c. Station winners: static ownWin array, time-dependent only on coastline cells ──

test('station winners: coastline (partial-cell) stations are re-decided per time; a sweep across a GRIB horizon edge stays equal to /vector', () => {
  // 8×8 nodes at 0.1°, lat 52.9..53.6, lon 4.9..5.6. Two slots (T0, T0+6h).
  const n = 8;
  const hole = (i0: number, j0: number) => (k: number) => { const i = k % n, j = Math.floor(k / n); return i >= i0 && i <= i0 + 1 && j >= j0 && j <= j0 + 1; };
  const atT0 = Array.from({ length: n * n }, (_, k) => (hole(5, 5)(k) ? NaN : 0.5));
  const at6 = Array.from({ length: n * n }, (_, k) => (hole(5, 5)(k) || hole(2, 2)(k) ? NaN : 0.5));
  const grib = createGribSource(gribDirOf({
    'coast.grb2': [
      ...uvFields(52.9, 4.9, 0.1, n, { u: atT0, v: 0.2, forecastHours: 0 }),
      ...uvFields(52.9, 4.9, 0.1, n, { u: at6, v: 0.2, forecastHours: 6 }),
    ],
  }), 0);
  const specs: UtcefStationSpec[] = [
    ['A-partial', 53.137, 5.141], // cell (2,2): defined at +0h, missing at +6h → covered or not depending on the time
    ['B-land', 53.451, 5.453], // cell (5,5): never defined → always the station
    ['C-sea', 53.027, 4.963], // fully defined → GRIB while the series is in range, else the station
    ['D-outside', 54.5, 5.5], // outside the grid → always the station
  ];
  const utcef = createUtcefSource(writeUtcefDir({ 'u.utcef': specs }), 0);
  const state: ApiState = { data: null, error: null, grib, utcef, preferGrib: true };
  const view = { west: 4.8, south: 52.8, east: 5.8, north: 54.6 };
  const stations = utcef.get()!.currentStations;
  const sweep = () => {
    const seen = new Map<string, number[]>();
    for (let h = -6; h <= 12; h++) {
      const t = T0 + h * HOUR;
      const ctx = createResolveCtx(state, REST_FALLBACK_MAX_KM, { bbox: view });
      const pts = gridPoints(ctx, view, t, 5000) as P[];
      assertParity(state, pts, t, `h=${h}`);
      // Oracle: brute-force claimAt for every in-view station.
      const oracle = createResolveCtx(state, REST_FALLBACK_MAX_KM);
      const expected = stations.filter((s) => { const c = claimAt(oracle, s.latitude, s.longitude, t); return c?.source === 'utcef' && c.station === s; }).map((s) => s.id).sort();
      const got = stations.filter((s) => pts.some((p) => p.stationId === s.id && p.latitude === s.latitude && p.longitude === s.longitude)).map((s) => s.id).sort();
      assert.deepEqual(got, expected, `h=${h}`);
      for (const id of got) seen.set(id, [...(seen.get(id) ?? []), h]);
      // claimAt ran for the time-dependent stations and the survivors only (nothing is thinned at 5000).
      assert.equal(ctx.counters.claims, timeDependentInView(ctx, view, t) + got.length, `h=${h}: claims`);
      assert.equal(timeDependentInView(ctx, view, t), h >= 0 && h <= 6 ? 1 : 0, `h=${h}: only the coastline station is time-dependent, and only while the series is in range (slots 0/+6h, ±30 min slack)`);
    }
    return seen;
  };
  const b0 = buildCounts();
  const seen = sweep();
  const hours = (id: string) => seen.get(id) ?? [];
  assert.deepEqual(hours('B-land'), Array.from({ length: 19 }, (_, i) => i - 6));
  assert.deepEqual(hours('D-outside'), Array.from({ length: 19 }, (_, i) => i - 6));
  assert.deepEqual(hours('C-sea'), [-6, -5, -4, -3, -2, -1, 7, 8, 9, 10, 11, 12], 'GRIB covers C while the series is in range');
  assert.deepEqual(hours('A-partial'), [-6, -5, -4, -3, -2, -1, 6, 7, 8, 9, 10, 11, 12], 'A is covered by GRIB only while the +0h slot brackets it');
  // 19 time steps, two range states (in / out of range) → the array was filled twice, then served from the LRU.
  assert.equal(resolveBuildCounts.ownWin - b0.ownWin, 2);
  sweep();
  assert.equal(resolveBuildCounts.ownWin - b0.ownWin, 2, 'a second sweep builds nothing');
  assert.ok(ownWinCacheSize(createResolveCtx(state, REST_FALLBACK_MAX_KM)) <= OWN_WIN_CACHE_CAP);
});

test('station winners: one build per key — a request at another time in the same range builds nothing', () => {
  const grib = createGribSource(gribDirOf({ 'g.grb2': [0, 6, 12].flatMap((h) => uvFields(52.9, 4.9, 0.1, 7, { u: 1, forecastHours: h })) }), 0);
  const stations: UtcefStationSpec[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) stations.push([`S${i}-${j}`, 52.5 + i * 0.12, 4.5 + j * 0.12]);
  const utcef = createUtcefSource(writeUtcefDir({ 's.utcef': stations }), 0);
  const state: ApiState = { data: null, error: null, grib, utcef, preferGrib: true };
  const call = makeApi(state);
  const grid = (h: number, bbox = '4.5,52.5,5.8,53.7') => call('/grid', { bbox, time: isoAt(T0 + h * HOUR), maxPoints: '400' }).points as P[];
  const b0 = resolveBuildCounts.ownWin;
  grid(0);
  assert.equal(resolveBuildCounts.ownWin - b0, 1);
  for (const h of [1, 2.5, 5, 9, 12, 12.25]) grid(h);
  assert.equal(resolveBuildCounts.ownWin - b0, 1, 'times inside the range (± slack) reuse the array');
  grid(0, '4.9,52.9,5.2,53.2'); // another viewport: same array
  assert.equal(resolveBuildCounts.ownWin - b0, 1);
  grid(40); // past the horizon: GRIB out of range → a second array
  assert.equal(resolveBuildCounts.ownWin - b0, 2);
  grid(1);
  grid(41);
  assert.equal(resolveBuildCounts.ownWin - b0, 2, 'both range states stay cached (LRU)');
  // The array is one byte per station.
  const ctx = createResolveCtx(state);
  assert.equal(ownWinFor(ctx, 'utcef', T0).byteLength, stations.length);
});

test('station winners: replacing another source\'s data object (same snapshot, same rangeKey) recomputes them', () => {
  // Two GRIB files with the same series count and time range: one covers the UTCEF station, the other is elsewhere.
  const over = createGribSource(gribDirOf({ 'g.grb2': [0, 6].flatMap((h) => uvFields(52.9, 4.9, 0.1, 7, { u: 1, forecastHours: h })) }), 0).get()!;
  const away = createGribSource(gribDirOf({ 'g.grb2': [0, 6].flatMap((h) => uvFields(40, -10, 0.1, 7, { u: 1, forecastHours: h })) }), 0).get()!;
  let cur = over;
  const grib = { get: () => cur, error: null, invalidate: () => {} };
  const utcef = createUtcefSource(writeUtcefDir({ 's.utcef': [['S', 53.1, 5.1]] }), 0);
  const state: ApiState = { data: null, error: null, grib, utcef, preferGrib: true };
  const call = makeApi(state);
  const t = T0 + 3 * HOUR;
  const grid = () => call('/grid', { bbox: '4.8,52.8,5.6,53.6', time: isoAt(t), maxPoints: '400' }).points as P[];
  const snapshot = orderedLayers(state, REST_FALLBACK_MAX_KM);
  const b0 = resolveBuildCounts.ownWin;
  let pts = grid();
  assert.equal(resolveBuildCounts.ownWin - b0, 1);
  assert.ok(!pts.some((p) => p.stationId === 'S'), 'GRIB covers the station: it loses its own position');
  assert.ok(pts.some((p) => p.source === 'grib'));
  grid();
  assert.equal(resolveBuildCounts.ownWin - b0, 1, 'same data: served from the cache');
  cur = away; // a new GRIB data object, same snapshot, same rangeKey
  assert.equal(orderedLayers(state, REST_FALLBACK_MAX_KM), snapshot);
  pts = grid();
  assert.equal(resolveBuildCounts.ownWin - b0, 2, 'the winners were recomputed for the new GRIB data');
  assert.ok(pts.some((p) => p.stationId === 'S' && p.source === 'utcef'), 'the station now wins and is shown');
  assertParity(state, pts, t);
  cur = over; // back to the first object: its own cached array, still correct
  pts = grid();
  assert.equal(resolveBuildCounts.ownWin - b0, 2);
  assert.ok(!pts.some((p) => p.stationId === 'S'));
});

// ── 14. Thin API surface ──

test('registerRoutes still exposes /grid, /vector and /timeline on a stub router', () => {
  const routes: string[] = [];
  registerRoutes({ get: (p) => routes.push(p) }, { data: null, error: null });
  for (const r of ['/grid', '/vector', '/timeline']) assert.ok(routes.includes(r), r);
});

test('a land lattice node never borrows a nearby station vector', () => {
  // Grid columns >= 8 are land (NaN). A UTCEF station sits at sea within reach of the land nodes:
  // the resolver falls through to it there, but /grid must not draw it on the lattice over land.
  const n = 20;
  const d = 0.1;
  const land = (k: number) => k % n >= 8;
  const u = Array.from({ length: n * n }, (_, k) => (land(k) ? NaN : 1));
  const v = Array.from({ length: n * n }, (_, k) => (land(k) ? NaN : 0.5));
  const gdir = gribDirOf({ 'a.grb2': uvFields(52, 3, d, n, { u, v }) });
  // S2 sits on a land cell: it must still show at its own position, whatever the priority.
  const udir = writeUtcefDir({ 'u.utcef': [['S1', 52.5, 3.6], ['S2', 53.5, 4.5]] });
  const landLon = 3 + 8 * d;
  const atOwn = (p: P, id: string, lat: number, lon: number) => p.stationId === id && p.latitude === lat && p.longitude === lon;
  for (const preferGrib of [true, false]) {
    const state: ApiState = { data: null, error: null, grib: createGribSource(gdir, 0), utcef: createUtcefSource(udir, 0), preferGrib };
    const pts = makeApi(state)('/grid', { bbox: '3,52,5,54', time: gridTime, maxPoints: '5000' }).points as P[];
    assert.ok(pts.length > 0);
    const onLand = pts.filter((p) => p.longitude >= landLon - 1e-9 && !atOwn(p, 'S2', 53.5, 4.5));
    assert.deepEqual(onLand, [], `preferGrib=${preferGrib}: arrows over land`);
    assert.ok(pts.some((p) => atOwn(p, 'S2', 53.5, 4.5)), `preferGrib=${preferGrib}: land station at its own position`);
    assertParity(state, pts, T0, `preferGrib=${preferGrib}`);
  }
});

test('a station outranking a stack GRIB subset keeps its vector where only the subset has data', () => {
  // Same grid, same valid time: the newer cycle (new.grb2) is land-masked at columns >= 8 and wins
  // the all-files series there; the older cycle (old.grb2) has data everywhere. Stack: the UTCEF
  // station above the old-cycle subset → the station outranks GRIB data that does exist at those
  // nodes, so its vector must be drawn there (only the all-files series has no value).
  const n = 20;
  const d = 0.1;
  const land = (k: number) => k % n >= 8;
  const gdir = gribDirOf({
    'old.grb2': uvFields(52, 3, d, n, { refTime: T0 - 6 * HOUR, forecastHours: 6 }),
    'new.grb2': uvFields(52, 3, d, n, {
      u: Array.from({ length: n * n }, (_, k) => (land(k) ? NaN : 1)),
      v: Array.from({ length: n * n }, (_, k) => (land(k) ? NaN : 0)),
    }),
  });
  const udir = writeUtcefDir({ 'u.utcef': [['S1', 52.5, 3.9]] });
  const state: ApiState = {
    data: null, error: null, grib: createGribSource(gdir, 0), utcef: createUtcefSource(udir, 0), preferGrib: true,
    datasetRank: () => [
      { id: 'st', type: 'utcef', files: ['u.utcef'] },
      { id: 'old', type: 'grib2', files: ['old.grb2'] },
    ],
  };
  const pts = makeApi(state)('/grid', { bbox: '3,52,5,54', time: gridTime, maxPoints: '5000' }).points as P[];
  // Masked nodes within the station's reach (the stack clamps it to 50 km; 0.25° keeps well inside).
  const near = pts.filter((p) => p.longitude >= 3 + 8 * d - 1e-9 && Math.abs(p.latitude - 52.5) <= 0.25 && Math.abs(p.longitude - 3.9) <= 0.25);
  assert.ok(near.length > 1, 'station vector drawn on subset-covered nodes');
  assert.deepEqual(near.filter((p) => p.stationId !== 'S1'), [], 'the outranking station answers there');
  assertParity(state, pts, T0, 'stack subset');
});

test('past the GRIB time slack the resolver falls through to UTCEF instead of holding a stale field', () => {
  // GRIB covers T0..T0+2h; a UTCEF station sits inside the grid. One hour past the last slot
  // the stale GRIB field must no longer answer (tides turn in ~6 h): UTCEF takes over.
  const gdir = gribDirOf({
    'a.grb2': uvFields(52, 3, 0.1, 20),
    'b.grb2': uvFields(52, 3, 0.1, 20, { forecastHours: 2 }),
  });
  const udir = writeUtcefDir({ 'u.utcef': [['S1', 52.5, 3.5]] });
  const state: ApiState = { data: null, error: null, grib: createGribSource(gdir, 0), utcef: createUtcefSource(udir, 0), preferGrib: true };
  const at = (t: number) => resolveVector(state, 52.5, 3.5, t, REST_FALLBACK_MAX_KM)?.source;
  assert.equal(at(T0 + HOUR), 'grib');
  assert.equal(at(T0 + 2 * HOUR + 15 * 60_000), 'grib', 'inside the short clamp slack');
  assert.equal(at(T0 + 2 * HOUR + 35 * 60_000), 'utcef', 'just past the 30 min slack');
  assert.equal(at(T0 - 35 * 60_000), 'utcef', 'just before the 30 min slack');
  assert.equal(at(T0 + 3 * HOUR), 'utcef', 'an hour past the last slot');
  assert.equal(at(T0 - HOUR), 'utcef', 'an hour before the first slot');
});
