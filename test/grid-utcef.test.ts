// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerRoutes, resolveVector, orderedLayers, ApiState } from '../dist/api.js';
import { createGribSource, gribVectorAt } from '../dist/gribcurrents.js';
import { loadHarmonicsDir } from '../dist/harmonics.js';
import { distanceKm } from '../dist/predict.js';
import { createUtcefSource, utcefCoverageIndex, utcefVectorAt, utcefSampleAt } from '../dist/utcef.js';
import { encodeGrib2File, EncodeField } from './grib2-testutil.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);
const gridTime = new Date(T0).toISOString();

// 7x7 GRIB grid, 52.9-53.5N / 4.9-5.5E, u=1 m/s.
function gridField(param: number, value: number): EncodeField {
  return { param, refTime: T0, forecastHours: 0, la1: 52.9, lo1: 4.9, dLat: 0.1, dLon: 0.1, ni: 7, nj: 7, values: new Array(49).fill(value) };
}
const uvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-gu-'));
fs.writeFileSync(path.join(uvDir, 'currents.grb2'), encodeGrib2File([gridField(2, 1), gridField(3, 0)]));

function writeUtcefDir(files: Record<string, Array<[string, number, number, number[][][]?]>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-gu-u-'));
  for (const [name, stations] of Object.entries(files)) {
    const doc = {
      metadata: { schema_version: '1.0.0' },
      dataset: {
        type: 'FeatureCollection',
        features: stations.map(([id, lat, lon, area]) => ({
          type: 'Feature',
          id,
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            ...(area ? { representative_area: { type: 'Polygon', coordinates: area } } : {}),
            prediction_method: 'harmonic_constituents_currents',
            data_unit_speed: 'knots',
            harmonic_constituents: { M2: { u_amplitude: 2, u_phase_g: 0, v_amplitude: 1, v_phase_g: 0 } },
          },
        })),
      },
    };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
  }
  return dir;
}

function makeApi(state: ApiState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = new Map<string, (req: any, res: any) => void>();
  registerRoutes({ get: (p, h) => routes.set(p, h) }, state);
  return (routePath: string, query: Record<string, unknown> = {}) => {
    let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = { status: () => res, json: (b: unknown) => void (body = b) };
    routes.get(routePath)!({ query, params: {} }, res);
    return body;
  };
}
type P = { latitude: number; longitude: number; source: string; stationId?: string; u: number; v: number };

test('GET /grid fills lattice samples won by a drawn UTCEF station with that station\'s vector', (t) => {
  const dir = writeUtcefDir({ 'g.utcef': [['G', 53.2, 5.2]] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // UTCEF first: G wins the whole GRIB box.
  const call = makeApi({ data: null, error: null, grib: createGribSource(uvDir, 0), utcef: createUtcefSource(dir, 0), preferGrib: false });
  const pts: P[] = call('/grid', { bbox: '5.0,53.0,5.4,53.4', time: gridTime, maxPoints: '20' }).points;
  const own = pts.find((p) => p.latitude === 53.2 && p.longitude === 5.2 && p.stationId === 'G')!;
  assert.ok(own, 'G is drawn at its own position');
  const filled = pts.filter((p) => !(p.latitude === 53.2 && p.longitude === 5.2));
  assert.ok(filled.length > 0, 'lattice samples exist');
  for (const p of filled) {
    assert.equal(p.source, 'utcef');
    assert.equal(p.stationId, 'G');
    assert.equal(p.u, own.u);
    assert.equal(p.v, own.v);
  }
  assert.ok(pts.length <= 20);
});

test('GET /grid lattice positions do not depend on UTCEF stations in view (pan stability)', (t) => {
  // Station X sits inside view A only; the far station keeps UTCEF "loaded"
  // in both states. GRIB wins everywhere it covers.
  const withX = writeUtcefDir({ 'x.utcef': [['X', 53.0, 4.95], ['FAR', 40, 0]] });
  const withoutX = writeUtcefDir({ 'x.utcef': [['FAR', 40, 0]] });
  t.after(() => { fs.rmSync(withX, { recursive: true, force: true }); fs.rmSync(withoutX, { recursive: true, force: true }); });
  const mk = (dir: string) =>
    makeApi({ data: null, error: null, grib: createGribSource(uvDir, 0), utcef: createUtcefSource(dir, 0), preferGrib: true });
  const key = (p: P) => `${p.latitude},${p.longitude}`;
  const lattice = (pts: P[]) => pts.filter((p) => p.source === 'grib').map(key).sort();
  const A = { bbox: '4.9,52.9,5.3,53.3', time: gridTime, maxPoints: '16' };
  const B = { bbox: '5.0,53.0,5.4,53.4', time: gridTime, maxPoints: '16' };
  assert.deepEqual(lattice(mk(withX)('/grid', A).points), lattice(mk(withoutX)('/grid', A).points));
  assert.deepEqual(lattice(mk(withX)('/grid', B).points), lattice(mk(withoutX)('/grid', B).points));
  // Overlap of A and B: identical lattice positions from both views.
  const inB = (p: P) => p.latitude >= 53.0 && p.latitude < 53.25 && p.longitude >= 5.0 && p.longitude < 5.25; // clear of the float-fuzzy bbox edges
  const a = mk(withX)('/grid', A).points.filter((p: P) => p.source === 'grib' && inB(p)).map(key).sort();
  const b = mk(withX)('/grid', B).points.filter((p: P) => p.source === 'grib' && inB(p)).map(key).sort();
  assert.ok(a.length > 0);
  assert.deepEqual(a, b);
});

test('GET /grid never returns more than maxPoints', (t) => {
  const stations: Array<[string, number, number]> = [];
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) stations.push([`S${i}-${j}`, 51 + i * 0.2, 3.5 + j * 0.2]);
  const dir = writeUtcefDir({ 'many.utcef': stations });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const preferGrib of [true, false]) {
    const call = makeApi({ data: null, error: null, grib: createGribSource(uvDir, 0), utcef: createUtcefSource(dir, 0), preferGrib });
    for (const mp of [1, 2, 3, 5, 8, 13, 30, 60, 200]) {
      const pts = call('/grid', { bbox: '3.4,50.9,5.9,53.5', time: gridTime, maxPoints: String(mp) }).points;
      assert.ok(pts.length <= mp, `${pts.length} > ${mp} (preferGrib=${preferGrib})`);
    }
  }
});

// ── utcefVectorAt: index path vs the old linear algorithm ──

function inRing(ring: number[][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inArea = (area: number[][][], lat: number, lon: number) =>
  inRing(area[0], lat, lon) || inRing(area[0], lat, lon + 360) || inRing(area[0], lat, lon - 360);

function oldLinear(stations: any[], lat: number, lon: number, maxKm: number, files?: ReadonlySet<string>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const st = files ? stations.filter((s) => s.file !== undefined && files.has(s.file)) : stations;
  if (st.length === 0) return null;
  const c = st.find((s) => s.representativeArea && inArea(s.representativeArea, lat, lon));
  if (c) return { station: c, distanceKm: Math.round(distanceKm(lat, lon, c.latitude, c.longitude) * 100) / 100 };
  let near: { station: any; distanceKm: number } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const s of st) {
    const d = Math.round(distanceKm(lat, lon, s.latitude, s.longitude) * 100) / 100;
    if (!near || d < near.distanceKm) near = { station: s, distanceKm: d };
  }
  if (!near || near.distanceKm > maxKm) return null;
  return near;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rect(w: number, s: number, e: number, n: number): number[][][] {
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
}

function syntheticStations(rand: () => number): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mk = (i: number, lat: number, lon: number, area?: number[][][]) =>
    out.push({ id: `S${i}`, name: `S${i}`, latitude: lat, longitude: lon, meanU: 0, meanV: 0, constituents: [], file: `f${i % 3}.utcef`, representativeArea: area });
  let i = 0;
  for (let k = 0; k < 150; k++) {
    // Cluster near 10E/45N, a band by the antimeridian, and some cell-edge stations.
    const kind = k % 3;
    const lat = kind === 0 ? 44 + rand() * 3 : kind === 1 ? -20 + rand() * 4 : Math.floor(rand() * 40) * 0.5 - 10;
    const lon = kind === 0 ? 9 + rand() * 3 : kind === 1 ? 178 + rand() * 4 : Math.floor(rand() * 40) * 0.5 + 5;
    const wrapped = lon > 180 ? lon - 360 : lon;
    let area: number[][][] | undefined;
    const r = rand();
    if (r < 0.25) {
      const w = rand() * 1.5 + 0.1;
      area = rect(lon - w, lat - w, lon + w, lat + w); // may run past 180
    } else if (r < 0.32) {
      area = rect(lon - 20, lat - 15, lon + 20, lat + 15); // large (> 64 cells)
    }
    mk(i++, lat, wrapped, area);
  }
  // Exact duplicates for the tie-break, and a pair straddling ±180.
  mk(i++, 45, 10, undefined);
  mk(i++, 45, 10, undefined);
  mk(i++, -20, 179.99, undefined);
  mk(i++, -20, -179.99, undefined);
  return out;
}

test('utcefVectorAt via the coverage index matches the linear algorithm', () => {
  const rand = rng(12345);
  const stations = syntheticStations(rand);
  const data: any = { dir: '', files: ['f0.utcef', 'f1.utcef', 'f2.utcef'], currentStations: stations }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fileSets: Array<ReadonlySet<string> | undefined> = [undefined, new Set(['f0.utcef']), new Set(['f1.utcef', 'f2.utcef'])];
  const maxKms = [0, 1, 5, 50, 200];
  let hits = 0;
  for (let n = 0; n < 6000; n++) {
    const pick = stations[Math.floor(rand() * stations.length)];
    const r = rand();
    // Probe near a station (some exactly on it / on a cell edge), in the antimeridian band, or anywhere.
    let lat = r < 0.4 ? pick.latitude + (rand() - 0.5) * 1.2 : r < 0.5 ? pick.latitude : r < 0.7 ? -20 + (rand() - 0.5) * 8 : rand() * 140 - 70;
    let lon = r < 0.4 ? pick.longitude + (rand() - 0.5) * 1.2 : r < 0.5 ? pick.longitude : r < 0.7 ? 180 + (rand() - 0.5) * 8 : rand() * 360 - 180;
    if (n % 7 === 0) { lat = Math.round(lat * 2) / 2; lon = Math.round(lon * 2) / 2; } // on cell edges
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    const maxKm = maxKms[n % maxKms.length];
    const files = fileSets[n % fileSets.length];
    const want = oldLinear(stations, lat, lon, maxKm, files);
    const got = utcefVectorAt(data, lat, lon, T0, maxKm, files);
    assert.equal(got?.station, want?.station, `probe ${n} (${lat},${lon}) maxKm=${maxKm}`);
    if (want) {
      hits++;
      assert.equal(got!.distanceKm, want.distanceKm);
      assert.deepEqual(got!.sample, utcefSampleAt(want.station, T0));
    }
  }
  assert.ok(hits > 1000, `only ${hits} non-null probes — test too weak`);
  // Infinity keeps the linear scan and agrees too.
  const inf = utcefVectorAt(data, 10, 100, T0, Infinity);
  assert.equal(inf?.station, oldLinear(stations, 10, 100, Infinity)?.station);
});

test('large representative_area polygons: array-order containment across big and small areas', () => {
  const mk = (id: string, lat: number, lon: number, area: number[][][], file = 'a.utcef') =>
    ({ id, name: id, latitude: lat, longitude: lon, meanU: 0, meanV: 0, constituents: [], file, representativeArea: area }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const big = rect(-30, 20, 30, 70); // 120 x 100 cells at 0.5°: well past the fan-out cap
  const small = rect(9, 44, 11, 46);
  const L = mk('L', 60, 0, big);
  const S = mk('S', 45, 10, small);
  const probe = (list: any[], lat: number, lon: number, files?: ReadonlySet<string>) => // eslint-disable-line @typescript-eslint/no-explicit-any
    utcefCoverageIndex(list).stationAt(lat, lon, 0, files)?.id ?? null;
  assert.equal(probe([L, S], 45, 10), 'L'); // both contain; L is earlier
  assert.equal(probe([S, L], 45, 10), 'S'); // small earlier now
  assert.equal(probe([S, L], 60, 5), 'L'); // only the big one contains
  assert.equal(probe([L, S], 10, 100), null);
  assert.equal(probe([L, S], 45, 10, new Set(['zzz'])), null);
  const S2 = mk('S2', 45, 10, small, 'b.utcef');
  assert.equal(probe([L, S2], 45, 10, new Set(['b.utcef'])), 'S2'); // files filter skips L
  // Big polygon written past the antimeridian, probed from the −180..180 side.
  const wrapBig = mk('W', 0, 180, rect(150, -30, 210, 30));
  assert.equal(probe([wrapBig], 0, -170), 'W');
  assert.equal(probe([wrapBig], 0, 170), 'W');
  assert.equal(probe([wrapBig], 0, 100), null);
  // Same through utcefVectorAt.
  const data: any = { dir: '', files: ['a.utcef'], currentStations: [S, L] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(utcefVectorAt(data, 45, 10, T0, 50)?.station.id, 'S');
  assert.equal(utcefVectorAt(data, 60, 5, T0, 50)?.station.id, 'L');
});

// ── resolveVector: shared ordered layers ──

test('resolveVector honours a dataset stack mixing grib2, utcef and harmonic entries', (t) => {
  const dir = writeUtcefDir({ 'g.utcef': [['G', 53.2, 5.2]] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const data = loadHarmonicsDir(FIXTURES);
  const base = { data, error: null, grib: createGribSource(uvDir, 0), utcef: createUtcefSource(dir, 0), preferGrib: true };
  const at = (stack: any[] | undefined) => resolveVector({ ...base, datasetRank: stack ? () => stack : undefined }, 53.2, 5.2, T0); // eslint-disable-line @typescript-eslint/no-explicit-any
  const G = { id: 'g', type: 'grib2', files: ['currents.grb2'] };
  const U = { id: 'u', type: 'utcef', files: ['g.utcef'] };
  const H = { id: 'h', type: 'harmonic', files: [] };
  assert.equal(at([G, U, H])?.source, 'grib');
  assert.equal(at([U, G, H])?.source, 'utcef');
  const stationFirst = at([H, G, U]);
  const stationOnly = resolveVector({ data, error: null, preferGrib: true }, 53.2, 5.2, T0);
  assert.equal(stationFirst?.source, stationOnly ? 'station' : 'grib');
  // A stack entry with a non-matching file list falls through to the type rank.
  assert.equal(at([{ id: 'x', type: 'utcef', files: ['nope.utcef'] }])?.source, 'grib');
  assert.equal(at(undefined)?.source, 'grib');
});

test('orderedLayers is cached per stack snapshot: same list and same file Sets across calls', () => {
  const stack = [{ id: 'g', type: 'grib2' as const, files: ['a.grb2'] }, { id: 'u', type: 'utcef' as const, files: ['b.utcef'] }];
  const state: ApiState = { data: null, error: null, preferGrib: true, datasetRank: () => stack };
  const l1 = orderedLayers(state, 50);
  const l2 = orderedLayers(state, 50);
  assert.equal(l1, l2);
  assert.equal(l1[0].files, l2[0].files);
  assert.deepEqual(l1.map((l) => [l.type, l.stack, l.utcefMaxKm]), [
    ['grib2', true, 50], ['utcef', true, 50], ['grib2', false, 50], ['utcef', false, 50], ['harmonic', false, 50],
  ]);
  // The stack clamp applies only to stack layers.
  assert.deepEqual(orderedLayers(state, 500).filter((l) => l.type === 'utcef').map((l) => l.utcefMaxKm), [50, 500]);
  // No datasetRank at all is cached too.
  const bare: ApiState = { data: null, error: null, preferGrib: false };
  assert.equal(orderedLayers(bare, 50), orderedLayers(bare, 50));
  assert.deepEqual(orderedLayers(bare, 50).map((l) => l.type), ['utcef', 'harmonic', 'grib2']);
});

test('/timeline UTCEF fallback honours representative_area like /vector', (t) => {
  const area = [[[4.95, 52.95], [5.1, 52.95], [5.1, 53.1], [4.95, 53.1], [4.95, 52.95]]];
  const dir = writeUtcefDir({ 'a.utcef': [['A', 53.0, 5.0], ['B', 53.3, 5.3, area]] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = makeApi({ data: null, error: null, grib: null, utcef: createUtcefSource(dir, 0), preferGrib: true });
  const q = { latitude: '53.02', longitude: '5.02', time: gridTime, hours: '2', step: '60' };
  const vec = call('/vector', q);
  const tl = call('/timeline', q);
  const vBody = vec.body ?? vec;
  const tBody = tl.body ?? tl;
  assert.equal(vBody.station.id, 'B');
  assert.equal(tBody.utcefStation.id, 'B');
});

function polarStation(id: string, lat: number, lon: number) {
  return { id, name: id, latitude: lat, longitude: lon, meanU: 0, meanV: 0, constituents: [], file: 'a.utcef' } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test('coverage index finds a station across the pole (north and south)', () => {
  for (const sign of [1, -1]) {
    const list = [polarStation('P', sign * 89.9, 150)];
    const idx = utcefCoverageIndex(list);
    const d = distanceKm(sign * 89.8, 0, sign * 89.9, 150);
    assert.ok(d < 50);
    assert.equal(idx.stationAt(sign * 89.8, 0, 50)?.id, 'P');
    assert.equal(idx.stationAt(sign * 89.8, 0, d - 1), null);
  }
});

test('coverage index with a large maxKm matches the linear scan', () => {
  const list: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let k = 0; k < 40; k++) list.push(polarStation('S' + k, 55 + ((k * 7) % 10), -20 + ((k * 13) % 60)));
  const idx = utcefCoverageIndex(list);
  const data = { currentStations: list } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [lat, lon] of [[60, 0], [58.3, 12.7], [64, -15], [10, 100]]) {
    for (const maxKm of [300, 2000, 5000]) {
      const lin = utcefVectorAt(data, lat, lon, T0, Infinity);
      const want = lin && lin.distanceKm <= maxKm ? lin.station.id : null;
      assert.equal(idx.stationAt(lat, lon, maxKm)?.id ?? null, want, `${lat},${lon} @${maxKm}`);
    }
  }
});

// ---- review follow-ups: shadowed regions, layer-specific winner, memo ----
const fld = (param: number, value: number, la1: number, lo1: number, d: number, n: number, forecastHours = 0): EncodeField =>
  ({ param, refTime: T0, forecastHours, la1, lo1, dLat: d, dLon: d, ni: n, nj: n, values: new Array(n * n).fill(value) });
function gribDirOf(files: Record<string, EncodeField[]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-gu-g-'));
  for (const [n, f] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), encodeGrib2File(f));
  return dir;
}

test('shadowed regional GRIB grid: no-files lookup, /grid and resolveVector all see it', () => {
  const dir = gribDirOf({
    'a.grb2': [fld(2, 1, 52.9, 4.9, 0.1, 7), fld(3, 0, 52.9, 4.9, 0.1, 7)],
    'b.grb2': [fld(2, 1, 40, 290, 0.1, 7), fld(3, 0, 40, 290, 0.1, 7)],
  });
  const grib = createGribSource(dir, 0);
  const utcef = createUtcefSource(writeUtcefDir({ 'x.utcef': [['K', 53.2, 5.2]] }), 0);
  assert.ok(gribVectorAt(grib.get()!, 53.2, 5.2, T0));
  const state = { data: null, error: null, grib, utcef, preferGrib: true } as unknown as ApiState;
  const pts = makeApi(state)('/grid', { bbox: '4.9,52.9,5.5,53.5', time: gridTime, maxPoints: '50' }).points as P[];
  assert.ok(pts.length > 0);
  assert.ok(pts.every((p) => p.source === 'grib'));
  assert.equal(resolveVector(state, 53.2, 5.2, T0)?.source, 'grib');
});

test('/grid: lower-ranked overlapping GRIB lattice dropped; points match resolveVector (with and without UTCEF)', () => {
  const grib = createGribSource(gribDirOf({
    'coast.grb2': [fld(2, 2, 52.9, 4.9, 0.05, 13), fld(3, 0, 52.9, 4.9, 0.05, 13)],
    'global.grb2': [fld(2, 1, 50, 2, 0.5, 15), fld(3, 0, 50, 2, 0.5, 15)],
  }), 0);
  const rank = [
    { id: 'coast', type: 'grib2' as const, files: ['coast.grb2'] },
    { id: 'global', type: 'grib2' as const, files: ['global.grb2'] },
  ];
  const farUtcef = createUtcefSource(writeUtcefDir({ 'x.utcef': [['FAR', 10, -60]] }), 0);
  for (const utcef of [farUtcef, null]) {
    const state = { data: null, error: null, grib, utcef, preferGrib: true, datasetRank: () => rank } as unknown as ApiState;
    const pts = makeApi(state)('/grid', { bbox: '5.0,53.0,5.4,53.4', time: gridTime, maxPoints: '400' }).points as P[];
    const inCoast = pts.filter((p) => p.latitude >= 52.9 && p.latitude <= 53.5 && p.longitude >= 4.9 && p.longitude <= 5.5);
    assert.ok(inCoast.length > 0);
    assert.ok(inCoast.every((p) => p.u === 2), 'no global (u=1) point inside the coastal box');
    for (const p of pts.filter((x) => x.source === 'grib')) {
      const r = resolveVector(state, p.latitude, p.longitude, T0)!;
      assert.equal(p.u, r.sample.u);
      assert.equal(p.v, r.sample.v);
    }
  }
});

test('/grid UTCEF-station GRIB-coverage memo stays correct within and across slot pairs', () => {
  const grib = createGribSource(gribDirOf({
    'a.grb2': [
      fld(2, 1, 52.9, 4.9, 0.1, 7, 0), fld(3, 0, 52.9, 4.9, 0.1, 7, 0),
      fld(2, 1, 52.9, 4.9, 0.1, 7, 6), fld(3, 0, 52.9, 4.9, 0.1, 7, 6),
    ],
  }), 0);
  const utcef = createUtcefSource(writeUtcefDir({ 'x.utcef': [['K', 53.2, 5.2]] }), 0);
  const call = makeApi({ data: null, error: null, grib, utcef, preferGrib: true } as unknown as ApiState);
  const at = (h: number) =>
    (call('/grid', { bbox: '5.15,53.15,5.25,53.25', time: new Date(T0 + h * 3600_000).toISOString(), maxPoints: '1000' }).points as P[]);
  const drawn = (pts: P[]) => pts.some((p) => p.source === 'utcef' && p.stationId === 'K' && p.latitude === 53.2 && p.longitude === 5.2);
  assert.equal(drawn(at(1)), false);
  assert.equal(drawn(at(2)), false); // same slot pair, memo hit
  assert.equal(drawn(at(30)), true); // outside the GRIB range (+3 h slack)
  assert.equal(drawn(at(3)), false); // back inside
});

// ---- /grid budget: far-away UTCEF must not thin GRIB; area-bounded stride ----
const bigGrib = () => createGribSource(gribDirOf({ 'big.grb2': [fld(2, 1, 52.9, 4.9, 0.02, 31), fld(3, 0, 52.9, 4.9, 0.02, 31)] }), 0);
const nlBbox = '4.9,52.9,5.5,53.5';
const gridCall = (utcefDir: string | null, preferGrib: boolean, bbox: string, maxPoints: number) =>
  makeApi({ data: null, error: null, grib: bigGrib(), utcef: utcefDir ? createUtcefSource(utcefDir, 0) : null, preferGrib })(
    '/grid', { bbox, time: gridTime, maxPoints: String(maxPoints) }).points as P[];

test('/grid: a far-away UTCEF station does not reduce GRIB density', (t) => {
  const far = writeUtcefDir({ 'f.utcef': [['FAR', 10, -60]] });
  t.after(() => fs.rmSync(far, { recursive: true, force: true }));
  const without = gridCall(null, true, nlBbox, 400);
  const withFar = gridCall(far, true, nlBbox, 400);
  console.log(`far-UTCEF test: without=${without.length} with=${withFar.length}`);
  assert.ok(without.length > 121);
  assert.equal(withFar.length, without.length);
});

test('/grid: grid covering a quarter of the bbox shares the budget with UTCEF', (t) => {
  const st: Array<[string, number, number]> = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) st.push([`Q${i}-${j}`, 52.9 + i * 0.12, 5.6 + j * 0.06]);
  const dir = writeUtcefDir({ 'q.utcef': st });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pts = gridCall(dir, true, '4.9,52.9,6.1,54.1', 400);
  const grib = pts.filter((p) => p.source === 'grib').length;
  const utcef = pts.filter((p) => p.source === 'utcef').length;
  console.log(`quarter-grid test: grib=${grib} utcef=${utcef} total=${pts.length}`);
  assert.ok(grib > 0 && utcef > 0);
  assert.ok(grib <= 0.5 * 400 * 1.5, `grib ${grib} too dense`);
  assert.ok(pts.length <= 400);
});

test('/grid: lattice is pan-stable with UTCEF loaded', (t) => {
  const far = writeUtcefDir({ 'f.utcef': [['FAR', 10, -60]] });
  t.after(() => fs.rmSync(far, { recursive: true, force: true }));
  const key = (p: P) => `${p.latitude},${p.longitude}`;
  const A = gridCall(far, true, '4.9,52.9,5.4,53.4', 100).filter((p) => p.source === 'grib');
  const B = gridCall(far, true, '5.013,53.017,5.513,53.517', 100).filter((p) => p.source === 'grib');
  const inOv = (p: P) => p.latitude > 53.03 && p.latitude < 53.39 && p.longitude > 5.03 && p.longitude < 5.39;
  const a = A.filter(inOv).map(key).sort();
  const b = B.filter(inOv).map(key).sort();
  assert.ok(a.length > 0);
  assert.deepEqual(a, b);
});

test('/grid: UTCEF ranked above GRIB still halves the lattice request', (t) => {
  const st: Array<[string, number, number]> = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) st.push([`R${i}-${j}`, 52.9 + i * 0.06, 4.9 + j * 0.06]);
  const dir = writeUtcefDir({ 'r.utcef': st });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pts = gridCall(dir, false, nlBbox, 400);
  assert.ok(pts.length <= 400);
  assert.ok(pts.some((p) => p.source === 'utcef' && p.stationId?.startsWith('R')));
  const latticeOnly = gridCall(null, true, nlBbox, 200).length;
  assert.ok(latticeOnly <= 200);
});
