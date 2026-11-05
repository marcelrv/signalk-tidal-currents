// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerRoutes, resolveVector, ApiState } from '../dist/api.js';
import {
  createGribSource,
  gribVectorAt,
  gribGridSamples,
  gribSummary,
  loadGribDir,
  GRIB_TIME_SLACK_MS,
} from '../dist/gribcurrents.js';
import { loadHarmonicsDir } from '../dist/harmonics.js';
import { createUtcefSource, lonInSpan, utcefCoverageIndex } from '../dist/utcef.js';
import { encodeGrib2File, EncodeField } from './grib2-testutil.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);
const HOUR = 3600_000;

// 7x7 grid covering the harmonics fixture stations (52.9-53.5N, 4.9-5.5E).
function gridField(param: number, forecastHours: number, value: number): EncodeField {
  return {
    param,
    refTime: T0,
    forecastHours,
    la1: 52.9,
    lo1: 4.9,
    dLat: 0.1,
    dLon: 0.1,
    ni: 7,
    nj: 7,
    values: new Array(49).fill(value),
  };
}

function writeGribDir(name: string, fields: EncodeField[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sk-tc-${name}-`));
  fs.writeFileSync(path.join(dir, 'currents.grb2'), encodeGrib2File(fields));
  return dir;
}

// u=1 m/s (east) at T0, u=2 m/s at T0+2h; v=0 throughout.
const uvDir = writeGribDir('uv', [
  gridField(2, 0, 1.0),
  gridField(3, 0, 0.0),
  gridField(2, 2, 2.0),
  gridField(3, 2, 0.0),
]);

test('loadGribDir pairs u/v fields into time slots', () => {
  const data = loadGribDir(uvDir)!;
  assert.ok(data);
  assert.deepEqual(data.files, ['currents.grb2']);
  assert.equal(data.slots.length, 2);
  assert.equal(data.slots[0].time, T0);
  assert.equal(data.slots[1].time, T0 + 2 * HOUR);
  assert.deepEqual(data.warnings, []);
});

test('gribVectorAt: spatial sample and linear time interpolation', () => {
  const data = loadGribDir(uvDir)!;
  const at0 = gribVectorAt(data, 53.2, 5.2, T0)!;
  assert.ok(Math.abs(at0.u! - 1.0) < 1e-6);
  assert.ok(Math.abs(at0.v!) < 1e-6);
  assert.equal(at0.direction, 90); // flowing east
  assert.ok(Math.abs(at0.speedKn - 1 / 0.514444) < 0.01);

  const mid = gribVectorAt(data, 53.2, 5.2, T0 + HOUR)!; // halfway → u=1.5
  assert.ok(Math.abs(mid.u! - 1.5) < 1e-6);

  // Clamps to the edge field within the slack window…
  const late = gribVectorAt(data, 53.2, 5.2, T0 + 2 * HOUR + GRIB_TIME_SLACK_MS - 1)!;
  assert.ok(Math.abs(late.u! - 2.0) < 1e-6);
  // …but not beyond it.
  assert.equal(gribVectorAt(data, 53.2, 5.2, T0 + 2 * HOUR + GRIB_TIME_SLACK_MS + 1), null);
  assert.equal(gribVectorAt(data, 53.2, 5.2, T0 - GRIB_TIME_SLACK_MS - 1), null);
});

test('gribVectorAt: outside the grid → null', () => {
  const data = loadGribDir(uvDir)!;
  assert.equal(gribVectorAt(data, 53.2, 6.5, T0), null);
  assert.equal(gribVectorAt(data, 51.0, 5.2, T0), null);
});

test('direction/speed fields (params 0/1) are converted to u/v', () => {
  // 1 m/s flowing toward 045° true.
  const dir = writeGribDir('dirspd', [gridField(0, 0, 45.0), gridField(1, 0, 1.0)]);
  const data = loadGribDir(dir)!;
  const s = gribVectorAt(data, 53.2, 5.2, T0)!;
  assert.equal(s.direction, 45);
  assert.ok(Math.abs(s.u! - Math.SQRT1_2) < 1e-3);
  assert.ok(Math.abs(s.v! - Math.SQRT1_2) < 1e-3);
});

test('loadGribDir returns null for a missing/empty directory', () => {
  assert.equal(loadGribDir('/nonexistent/nowhere'), null);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-empty-'));
  assert.equal(loadGribDir(empty), null);
});

test('createGribSource picks up newly dropped files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-reload-'));
  const src = createGribSource(dir, 0); // re-check on every get() for the test
  assert.equal(src.get(), null);
  fs.writeFileSync(path.join(dir, 'new.grb2'), encodeGrib2File([gridField(2, 0, 1), gridField(3, 0, 0)]));
  const data = src.get();
  assert.ok(data && data.slots.length === 1);
});

test('invalidate() forces an immediate reload, bypassing checkIntervalMs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-invalidate-'));
  // Long interval — without invalidate(), a get() right after dropping a new
  // file in would still return the stale (null) result for up to a minute.
  const src = createGribSource(dir, 60_000);
  assert.equal(src.get(), null);
  fs.writeFileSync(path.join(dir, 'new.grb2'), encodeGrib2File([gridField(2, 0, 1), gridField(3, 0, 0)]));
  assert.equal(src.get(), null, 'still within checkIntervalMs — should not have reloaded yet');
  src.invalidate();
  const data = src.get();
  assert.ok(data && data.slots.length === 1, 'invalidate() should force the very next get() to reload');
});

// ── API integration (stub router, harmonics fixture + synthetic GRIB) ──

interface Captured {
  code: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeApi(state: ApiState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = new Map<string, (req: any, res: any) => void>();
  registerRoutes({ get: (p, h) => routes.set(p, h) }, state);
  return (routePath: string, query: Record<string, unknown> = {}, params: Record<string, string> = {}): Captured => {
    let captured: Captured | undefined;
    let code = 200;
    const res = {
      status(c: number) {
        code = c;
        return res;
      },
      json(body: unknown) {
        captured = { code, body };
      },
    };
    routes.get(routePath)!({ query, params }, res);
    return captured!;
  };
}

const harmonics = loadHarmonicsDir(FIXTURES);

function apiState(preferGrib = true): ApiState {
  return {
    data: harmonics,
    error: null,
    grib: createGribSource(uvDir, 0),
    preferGrib,
  };
}

test('resolveVector prefers GRIB inside coverage, station outside', () => {
  const state = apiState();
  const inGrib = resolveVector(state, 53.2, 5.2, T0)!;
  assert.equal(inGrib.source, 'grib');
  // Outside the grid (which ends at 5.5E) but within REST_FALLBACK_MAX_KM of
  // the fixture station at (53.2, 5.2) → station fallback.
  const outside = resolveVector(state, 53.2, 5.6, T0)!;
  assert.equal(outside.source, 'station');
  assert.equal(outside.station!.id, 'test-sub-courants');
  // preferGrib=false flips the order.
  const stationFirst = resolveVector(apiState(false), 53.2, 5.2, T0)!;
  assert.equal(stationFirst.source, 'station');
  // Station path respects an explicit tighter distance limit; GRIB does not.
  assert.equal(resolveVector(state, 53.2, 5.6, T0, 5), null);
  // ~87 km from the fixture station and outside GRIB coverage → beyond the
  // default REST_FALLBACK_MAX_KM cap, so no source covers it at all.
  assert.equal(resolveVector(state, 53.2, 6.5, T0), null);
});

test('GET / reports both sources', () => {
  const call = makeApi(apiState());
  const r = call('/');
  assert.equal(r.code, 200);
  assert.ok(r.body.harmonics.currentStations > 0);
  assert.equal(r.body.grib.fields, 2);
  assert.equal(r.body.preferredSource, 'grib');
  assert.ok(r.body.grib.boundingBox.latMin < 53 && r.body.grib.boundingBox.latMax > 53.4);
});

test('GET /vector selects source and reports it', () => {
  const call = makeApi(apiState());
  const grib = call('/vector', { latitude: 53.2, longitude: 5.2, time: new Date(T0).toISOString() });
  assert.equal(grib.code, 200);
  assert.equal(grib.body.source, 'grib');
  assert.equal(grib.body.station, null);
  assert.ok(Math.abs(grib.body.sample.u - 1.0) < 1e-6);

  const station = call('/vector', { latitude: 53.2, longitude: 5.6, time: new Date(T0).toISOString() });
  assert.equal(station.body.source, 'station');
  assert.equal(station.body.station.id, 'test-sub-courants');

  // Beyond GRIB time slack → station takes over even inside the grid.
  const late = call('/vector', {
    latitude: 53.2,
    longitude: 5.2,
    time: new Date(T0 + 24 * HOUR).toISOString(),
  });
  assert.equal(late.body.source, 'station');
});

test('GET /timeline mixes sources across the GRIB horizon', () => {
  const call = makeApi(apiState());
  const r = call('/timeline', {
    latitude: 53.2,
    longitude: 5.2,
    start: new Date(T0).toISOString(),
    end: new Date(T0 + 12 * HOUR).toISOString(),
    step: '60',
  });
  assert.equal(r.code, 200);
  const sources = r.body.timeline.map((s: { source: string }) => s.source);
  assert.equal(sources[0], 'grib');
  assert.equal(sources[sources.length - 1], 'station');
  assert.ok(r.body.station, 'fallback station reported when station samples are used');
  // Within GRIB coverage samples interpolate the grid.
  assert.ok(Math.abs(r.body.timeline[1].u - 1.5) < 1e-6); // T0+1h
});

test('GET /timeline works GRIB-only (no harmonics loaded)', () => {
  const state: ApiState = { data: null, error: 'nope', grib: createGribSource(uvDir, 0), preferGrib: true };
  const call = makeApi(state);
  const r = call('/timeline', {
    latitude: 53.2,
    longitude: 5.2,
    start: new Date(T0).toISOString(),
    end: new Date(T0 + 2 * HOUR).toISOString(),
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.station, null);
  assert.ok(r.body.timeline.every((s: { source: string }) => s.source === 'grib'));
  // …and station endpoints still 503 cleanly.
  assert.equal(call('/stations', { latitude: 53, longitude: 5 }).code, 503);
});

test('GET /stations?bbox= returns every station in the viewport', () => {
  const call = makeApi(apiState());
  // Covers all three fixture current stations (5.1-5.3E, 53.1-53.3N).
  const r = call('/stations', { bbox: '5.05,53.05,5.35,53.35' });
  assert.equal(r.code, 200);
  assert.equal(r.body.length, 3);
  const sub = r.body.find((s: { name: string }) => s.name === 'Test Sub, Courants');
  assert.equal(sub.vectorCapable, true);
  assert.equal(sub.distanceKm, undefined); // no reference point in bbox mode

  // A narrower box only sees the subordinate station.
  const narrow = call('/stations', { bbox: '5.15,53.15,5.25,53.25' });
  assert.equal(narrow.body.length, 1);
  assert.equal(narrow.body[0].name, 'Test Sub, Courants');

  // Malformed bbox → 400.
  assert.equal(call('/stations', { bbox: '5,53,not-a-number,54' }).code, 400);
  assert.equal(call('/stations', { bbox: '10,53,5,54' }).code, 400); // west >= east
});

test('GET /grid samples the GRIB vector field over a bbox', () => {
  const call = makeApi(apiState());
  const r = call('/grid', {
    bbox: '5.0,53.0,5.4,53.4',
    time: new Date(T0).toISOString(),
    maxPoints: '25',
  });
  assert.equal(r.code, 200);
  assert.ok(r.body.points.length > 0);
  assert.ok(r.body.points.length <= 25);
  for (const p of r.body.points) {
    assert.ok(p.latitude >= 53.0 && p.latitude <= 53.4);
    assert.ok(p.longitude >= 5.0 && p.longitude <= 5.4);
    assert.ok(Math.abs(p.u - 1.0) < 1e-6); // uniform field at T0
  }

  // Missing bbox → 400.
  assert.equal(call('/grid', { time: new Date(T0).toISOString() }).code, 400);

  // No GRIB loaded → 503.
  const noGrib = makeApi({ data: harmonics, error: null, grib: null, preferGrib: true });
  assert.equal(noGrib('/grid', { bbox: '5.0,53.0,5.4,53.4' }).code, 503);
});

function utcefFeature(id: string, lat: number, lon: number, area?: number[][][]) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      ...(area ? { representative_area: { type: 'Polygon', coordinates: area } } : {}),
      prediction_method: 'harmonic_constituents_currents',
      data_unit_speed: 'knots',
      harmonic_constituents: { M2: { u_amplitude: 2, u_phase_g: 0, v_amplitude: 1, v_phase_g: 0 } },
    },
  };
}

/** UTCEF dir with one file per entry of `files` (name → [id, lat, lon][]). */
function writeUtcefDir(files: Record<string, Array<[string, number, number, number[][][]?]>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-gridfb-'));
  for (const [name, stations] of Object.entries(files)) {
    const doc = {
      metadata: { schema_version: '1.0.0' },
      dataset: { type: 'FeatureCollection', features: stations.map(([id, lat, lon, area]) => utcefFeature(id, lat, lon, area)) },
    };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
  }
  return dir;
}

// K: Dutch coast, outside the synthetic GRIB box (52.9-53.5N, 4.9-5.5E).
// G: in the middle of the GRIB box.
const gridTime = new Date(T0).toISOString();

test('GET /grid uses UTCEF stations where GRIB has no coverage', (t) => {
  const dir = writeUtcefDir({ 'k.utcef': [['K', 51.96, 3.66]] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const utcef = createUtcefSource(dir, 0);
  const bbox = '3.5,51.9,3.85,52.0';

  // GRIB loaded but not covering the viewport → UTCEF arrows.
  const withGrib = makeApi({ data: null, error: null, grib: createGribSource(uvDir, 0), utcef, preferGrib: true });
  const r = withGrib('/grid', { bbox, time: gridTime });
  assert.equal(r.code, 200);
  assert.equal(r.body.points.length, 1);
  assert.equal(r.body.points[0].source, 'utcef');
  assert.equal(r.body.points[0].stationId, 'K');
  assert.equal(r.body.points[0].latitude, 51.96);
  assert.ok(r.body.points[0].speedKn > 0);
  assert.ok(Number.isFinite(r.body.points[0].direction));

  // No GRIB at all, UTCEF only → still 200.
  const utcefOnly = makeApi({ data: null, error: null, grib: null, utcef, preferGrib: true });
  assert.equal(utcefOnly('/grid', { bbox, time: gridTime }).body.points.length, 1);

  // Neither → 503.
  const none = makeApi({ data: harmonics, error: null, grib: null, utcef: null, preferGrib: true });
  assert.equal(none('/grid', { bbox, time: gridTime }).code, 503);
});

test('GET /grid merges GRIB and UTCEF per point by source priority', (t) => {
  const dir = writeUtcefDir({ 'k.utcef': [['K', 51.96, 3.66]], 'g.utcef': [['G', 53.2, 5.2]] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const utcef = createUtcefSource(dir, 0);
  const grib = createGribSource(uvDir, 0);
  const bbox = '3.5,51.9,5.5,53.5'; // GRIB box + K: only partly GRIB-covered

  // GRIB first: GRIB lattice in its box, K outside it; G (inside GRIB) dropped.
  const gribFirst = makeApi({ data: null, error: null, grib, utcef, preferGrib: true });
  const a = gribFirst('/grid', { bbox, time: gridTime, maxPoints: '200' }).body.points;
  assert.ok(a.some((p: any) => p.source === 'grib')); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(a.filter((p: any) => p.source === 'utcef').map((p: any) => p.stationId), ['K']); // eslint-disable-line @typescript-eslint/no-explicit-any

  // UTCEF first: G wins its 50 km neighbourhood (the whole small GRIB box), so
  // no GRIB arrows remain there; both stations are shown.
  const utcefFirst = makeApi({ data: null, error: null, grib, utcef, preferGrib: false });
  const b = utcefFirst('/grid', { bbox, time: gridTime, maxPoints: '200' }).body.points;
  assert.deepEqual(b.filter((p: any) => p.source === 'utcef').map((p: any) => p.stationId).sort(), ['G', 'K']); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(b.filter((p: any) => p.source === 'grib').length, 0); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Dataset stack outranks the type rank: g.utcef stacked on top wins inside
  // the GRIB box even though preferGrib is true.
  const stacked = makeApi({
    data: null,
    error: null,
    grib,
    utcef,
    preferGrib: true,
    datasetRank: () => [{ id: 'g', type: 'utcef', files: ['g.utcef'] }],
  });
  const c = stacked('/grid', { bbox, time: gridTime, maxPoints: '200' }).body.points;
  assert.ok(c.some((p: any) => p.stationId === 'G')); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(c.filter((p: any) => p.source === 'grib').length, 0); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Same answer as /vector at G.
  assert.equal(stacked('/vector', { latitude: '53.2', longitude: '5.2', time: gridTime }).body.source, 'utcef');
  assert.equal(gribFirst('/vector', { latitude: '53.2', longitude: '5.2', time: gridTime }).body.source, 'grib');
});

test('GET /grid honours a distant station whose representative_area covers the viewport', (t) => {
  // Station ~110 km south of the GRIB box, its area polygon covering the box.
  const area = [[[4.8, 52.0], [5.6, 52.0], [5.6, 53.6], [4.8, 53.6], [4.8, 52.0]]];
  const dir = writeUtcefDir({ 'far.utcef': [['F', 52.2, 5.2, area]] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = makeApi({
    data: null,
    error: null,
    grib: createGribSource(uvDir, 0),
    utcef: createUtcefSource(dir, 0),
    preferGrib: false,
  });
  assert.equal(call('/vector', { latitude: '53.2', longitude: '5.2', time: gridTime }).body.source, 'utcef');
  const pts = call('/grid', { bbox: '5.0,53.0,5.4,53.4', time: gridTime }).body.points;
  assert.equal(pts.filter((p: any) => p.source === 'grib').length, 0); // eslint-disable-line @typescript-eslint/no-explicit-any
});

test('GET /grid splits the budget between sources instead of collapsing density', (t) => {
  // 100 UTCEF stations south of the GRIB box, plus the 49-point GRIB lattice.
  const stations: Array<[string, number, number]> = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) stations.push([`S${i}-${j}`, 51 + i * 0.1, 3.5 + j * 0.1]);
  const dir = writeUtcefDir({ 'many.utcef': stations });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = makeApi({ data: null, error: null, grib: createGribSource(uvDir, 0), utcef: createUtcefSource(dir, 0), preferGrib: true });
  const pts = call('/grid', { bbox: '3.4,50.9,5.5,53.5', time: gridTime, maxPoints: '60' }).body.points;
  assert.ok(pts.length <= 60, `${pts.length} > budget`);
  assert.ok(pts.length >= 30, `density collapsed to ${pts.length}`);
  assert.ok(pts.some((p: any) => p.source === 'grib')); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.ok(pts.some((p: any) => p.source === 'utcef')); // eslint-disable-line @typescript-eslint/no-explicit-any
});

test('GET /grid and /stations?bbox find UTCEF stations in viewports past ±180', (t) => {
  // Fiji-ish station east of the antimeridian (stored as −179.5) and a NZ one west of it.
  const dir = writeUtcefDir({ 'pac.utcef': [['E', -17, -179.5], ['W', -36, 174.8]] });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const utcef = createUtcefSource(dir, 0);
  const call = makeApi({ data: null, error: null, grib: null, utcef, preferGrib: true });
  const ids = (r: Captured) => r.body.points.map((p: any) => p.stationId).sort(); // eslint-disable-line @typescript-eslint/no-explicit-any

  // Viewport written east-positive across the antimeridian (Freeboard style).
  assert.deepEqual(ids(call('/grid', { bbox: '170,-40,190,-10', time: gridTime })), ['E', 'W']);
  // Same area written west-negative.
  assert.deepEqual(ids(call('/grid', { bbox: '-190,-40,-170,-10', time: gridTime })), ['E', 'W']);
  // Returned longitudes stay normalised to −180…180, like GRIB samples.
  const e = call('/grid', { bbox: '170,-40,190,-10', time: gridTime }).body.points.find((p: any) => p.stationId === 'E'); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(e.longitude, -179.5);
  // A plain viewport still excludes the far side.
  assert.deepEqual(ids(call('/grid', { bbox: '170,-40,179,-10', time: gridTime })), ['W']);

  const st = call('/stations', { bbox: '170,-40,190,-10' });
  assert.deepEqual(st.body.map((s: any) => s.id).sort(), ['E', 'W']); // eslint-disable-line @typescript-eslint/no-explicit-any
});

test('lonInSpan / utcefCoverageIndex wrap across the antimeridian', () => {
  assert.ok(lonInSpan(-175, 170, 190));
  assert.ok(lonInSpan(185, -180, -170));
  assert.ok(!lonInSpan(-175, 170, 179));
  assert.ok(lonInSpan(10, -1000, 1000)); // wider than the globe
  const station = { id: 'A', name: 'A', latitude: -17, longitude: 179.95, meanU: 0, meanV: 0, constituents: [] };
  const index = utcefCoverageIndex([station]);
  assert.ok(index.covers(-17, -179.95, 50)); // ~11 km away, across ±180
  assert.ok(!index.covers(-17, -175, 50));
});

test('GET /grid thins UTCEF points to maxPoints', (t) => {
  const stations: Array<[string, number, number]> = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) stations.push([`S${i}-${j}`, 51 + i * 0.1, 3 + j * 0.1]);
  const dir = writeUtcefDir({ 'many.utcef': stations });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call = makeApi({ data: null, error: null, grib: null, utcef: createUtcefSource(dir, 0), preferGrib: true });
  const r = call('/grid', { bbox: '2.9,50.9,4.1,52.1', time: gridTime, maxPoints: '7' });
  assert.equal(r.code, 200);
  assert.ok(r.body.points.length > 0 && r.body.points.length <= 7);
  assert.ok(r.body.points.every((p: any) => p.source === 'utcef')); // eslint-disable-line @typescript-eslint/no-explicit-any
  // Stable: same request → same set.
  assert.deepEqual(call('/grid', { bbox: '2.9,50.9,4.1,52.1', time: gridTime, maxPoints: '7' }).body.points, r.body.points);
});

test('GET /grid tags GRIB lattice points with source', () => {
  const call = makeApi(apiState());
  const r = call('/grid', { bbox: '5.0,53.0,5.4,53.4', time: gridTime, maxPoints: '25' });
  assert.ok(r.body.points.length > 0);
  assert.ok(r.body.points.every((p: any) => p.source === 'grib' && p.stationId === undefined)); // eslint-disable-line @typescript-eslint/no-explicit-any
});

test('GET /grid anchors samples to a fixed lattice — panning does not shift them', () => {
  // Two overlapping viewports at the same zoom (same maxPoints/area ratio),
  // as if the user panned the map slightly. A point present in both
  // viewports must land at the *exact* same lat/lon in both responses —
  // otherwise every pan would re-phase the sampling grid and the arrows
  // would appear to jump around instead of staying put.
  const call = makeApi(apiState());
  const time = new Date(T0).toISOString();
  const a = call('/grid', { bbox: '4.9,52.9,5.3,53.3', time, maxPoints: '16' });
  const b = call('/grid', { bbox: '5.0,53.0,5.4,53.4', time, maxPoints: '16' });
  assert.ok(a.body.points.length > 0 && b.body.points.length > 0);

  const key = (p: { latitude: number; longitude: number }) => `${p.latitude},${p.longitude}`;
  const aPoints = new Set(a.body.points.map(key));
  const bPoints = new Set(b.body.points.map(key));
  const shared = [...aPoints].filter((k) => bPoints.has(k));
  assert.ok(shared.length > 0, 'overlapping viewports should share at least one identical sample point');
});

test('GET /timeline 404s when nothing covers the window', () => {
  const state: ApiState = { data: null, error: 'nope', grib: createGribSource(uvDir, 0), preferGrib: true };
  const call = makeApi(state);
  const r = call('/timeline', {
    latitude: 20.0,
    longitude: -30.0,
    start: new Date(T0).toISOString(),
    end: new Date(T0 + 2 * HOUR).toISOString(),
  });
  assert.equal(r.code, 404);
});

test('loadGribDir per-file cache: unchanged files reuse decoded slots, changed files re-decode, deleted evicted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-cache-'));
  fs.writeFileSync(path.join(dir, 'a.grb2'), encodeGrib2File([gridField(2, 0, 1.0), gridField(3, 0, 0.0)]));
  fs.writeFileSync(path.join(dir, 'b.grb2'), encodeGrib2File([gridField(2, 2, 2.0), gridField(3, 2, 0.0)]));

  const cache = new Map();
  const first = loadGribDir(dir, cache)!;
  assert.equal(first.slots.length, 2);
  const aSlotsFirst = first.slotsByFile['a.grb2'];

  // Nothing changed: the decoded slot ARRAYS must be reused, not rebuilt.
  const second = loadGribDir(dir, cache)!;
  assert.equal(second.slotsByFile['a.grb2'], aSlotsFirst);

  // Touch b into the future: only b re-decodes; a's arrays survive.
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(path.join(dir, 'b.grb2'), future, future);
  const bSlotsBefore = second.slotsByFile['b.grb2'];
  const third = loadGribDir(dir, cache)!;
  assert.equal(third.slotsByFile['a.grb2'], aSlotsFirst);
  assert.notEqual(third.slotsByFile['b.grb2'], bSlotsBefore);

  // Delete b: cache entry evicted, merged data shrinks.
  fs.unlinkSync(path.join(dir, 'b.grb2'));
  const fourth = loadGribDir(dir, cache)!;
  assert.equal(fourth.slots.length, 1);
  assert.equal(cache.has('b.grb2'), false);
  assert.equal(cache.has('a.grb2'), true);
});

// A grid in a different part of the world (mirrors having downloaded, say,
// both a US-East-Coast region and a Pacific region — separate GRIB grids).
function remoteGridField(param: number, forecastHours: number, value: number): EncodeField {
  return {
    param,
    refTime: T0,
    forecastHours,
    la1: 30.0,
    lo1: -75.0, // US East Coast, far from the 4.9-5.5E fixture grid
    dLat: 0.1,
    dLon: 0.1,
    ni: 7,
    nj: 7,
    values: new Array(49).fill(value),
  };
}

test('gribGridSamples: samples every region, not just slots[0] grid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-multiregion-'));
  // File a sorts first, so its grid is slots[0].grid. The bug sampled only
  // that grid, so a viewport over file b's region returned no arrows.
  fs.writeFileSync(path.join(dir, 'a.grb2'), encodeGrib2File([gridField(2, 0, 1.0), gridField(3, 0, 0.0)]));
  // SAME valid time (T0) as region A — reproduces the real NOAA RTOFS case
  // where every region shares one cycle's forecast times, so loadGribDir's
  // same-time dedup collapses the merged `slots` down to just one region
  // (here b.grb2 sorts last and wins). The fix must still find region A via
  // slotsByFile rather than the collapsed `slots`.
  fs.writeFileSync(
    path.join(dir, 'b.grb2'),
    encodeGrib2File([remoteGridField(2, 0, 1.0), remoteGridField(3, 0, 0.0)]),
  );
  const data = loadGribDir(dir)!;
  // Precondition: the merged list really did collapse to a single region.
  assert.equal(data.slots.length, 1);

  // Viewport over region B (US East Coast) must yield arrows.
  const east = gribGridSamples(data, { west: -74.8, south: 30.1, east: -74.2, north: 30.5 }, T0, 50);
  assert.ok(east.length > 0, 'expected samples in the second region');
  assert.ok(east.every((p) => p.longitude < 0 && p.latitude >= 30 && p.latitude <= 30.6));

  // Viewport over region A (North Sea) still works.
  const west = gribGridSamples(data, { west: 5.0, south: 53.0, east: 5.4, north: 53.4 }, T0, 50);
  assert.ok(west.length > 0, 'expected samples in the first region');
  assert.ok(west.every((p) => p.longitude > 4 && p.longitude < 6));

  // A viewport much wider than region B's own small span (-75.0 to -74.4),
  // extending well past its western edge — the "zoomed out" map case. The
  // region is still fully contained in the bbox and must still yield
  // samples (this used to come back empty: the old lonIndex modulo folded
  // the far-west bbox edge to a huge positive index with no upper clamp).
  const zoomedOut = gribGridSamples(data, { west: -90, south: 20, east: -70, north: 40 }, T0, 50);
  assert.ok(zoomedOut.length > 0, 'expected samples in region B from a wide zoomed-out viewport');

  // Summary reports both regions and a union envelope spanning them.
  const summary = gribSummary(data) as {
    regions: { lonWest: number; lonEast: number }[];
    boundingBox: { lonWest: number; lonEast: number; latMin: number; latMax: number };
  };
  assert.equal(summary.regions.length, 2);
  assert.ok(summary.boundingBox.lonWest <= -75 && summary.boundingBox.lonEast >= 5);
});
