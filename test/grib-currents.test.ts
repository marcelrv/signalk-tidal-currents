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
  loadGribDir,
  GRIB_TIME_SLACK_MS,
} from '../dist/gribcurrents.js';
import { loadHarmonicsDir } from '../dist/harmonics.js';
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
  // Outside the grid but near the fixture stations' area → station fallback.
  const outside = resolveVector(state, 53.2, 6.5, T0)!;
  assert.equal(outside.source, 'station');
  assert.equal(outside.station!.id, 'test-sub-courants');
  // preferGrib=false flips the order.
  const stationFirst = resolveVector(apiState(false), 53.2, 5.2, T0)!;
  assert.equal(stationFirst.source, 'station');
  // Station path respects the distance limit; GRIB does not.
  assert.equal(resolveVector(state, 53.2, 6.5, T0, 5), null);
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

  const station = call('/vector', { latitude: 53.2, longitude: 6.5, time: new Date(T0).toISOString() });
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
