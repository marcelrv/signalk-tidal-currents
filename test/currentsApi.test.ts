// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * The in-process `currentsApi` handle (PropertyValues, src/currentsApi.ts):
 * its results must equal the HTTP routes' JSON exactly, errors must carry the
 * route's status/body, and a stopped plugin must reject instead of serving
 * stale data. The plugin-level test pins "emitted once, valid across a
 * stop/start".
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerRoutes, ApiState } from '../dist/api.js';
import { CURRENTS_API_PROPERTY, CurrentsApiError, CurrentsApiV1, createCurrentsApi, invoke } from '../dist/currentsApi.js';
import { loadHarmonicsDir } from '../dist/harmonics.js';
import { pluginConstructor } from '../dist/index.js';
import { createUtcefSource } from '../dist/utcef.js';
import { ROOT, writeUtcefDir } from './grid-testutil.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Captured {
  code: number;
  body: any;
}

/** The HTTP routes, called the way express calls them (query values are strings). */
function httpApi(state: ApiState) {
  const routes = new Map<string, (req: any, res: any) => void>();
  registerRoutes({ get: (p, h) => routes.set(p, h) }, state);
  return (routePath: string, query: Record<string, string> = {}, params: Record<string, string> = {}): Captured => {
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

/** Harmonics fixture (52.9–53.5N, 4.9–5.5E) plus two UTCEF stations in the same area. */
function loadedState(): ApiState {
  const utcefDir = writeUtcefDir({ 'a.utcef': [['UT-1', 53.21, 5.21], ['UT-2', 53.35, 5.05]] });
  return {
    data: loadHarmonicsDir(FIXTURES),
    error: null,
    utcef: createUtcefSource(utcefDir),
  };
}

async function rejection(p: Promise<unknown>): Promise<CurrentsApiError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof CurrentsApiError, `expected CurrentsApiError, got ${e}`);
    return e;
  }
  assert.fail('expected a rejection');
}

test('currentsApi: handle shape is the version 1 contract', () => {
  const api = createCurrentsApi(loadedState(), () => true);
  assert.equal(api.version, 1);
  assert.equal(api.providerId, 'signalk-tidal-currents');
  assert.equal(typeof api.findStations, 'function');
  assert.equal(typeof api.getTimeline, 'function');
  assert.ok(Object.isFrozen(api));
});

test('currentsApi.findStations: equals GET /stations?latitude=&longitude=&limit=, incl. vectorCapable', async () => {
  const state = loadedState();
  const http = httpApi(state);
  const api = createCurrentsApi(state, () => true);

  const got = await api.findStations(53.2, 5.2, 5);
  const want = http('/stations', { latitude: '53.2', longitude: '5.2', limit: '5' });
  assert.equal(want.code, 200);
  assert.deepEqual(got, want.body);
  assert.ok(got.length > 0);
  assert.ok(got.some((s) => s.source === 'utcef') && got.some((s) => s.source === undefined), 'both UTCEF and legacy stations');
  for (const s of got) assert.equal(typeof s.vectorCapable, 'boolean', `${s.id} vectorCapable`);

  // Default limit = the route's default when `limit` is omitted.
  assert.deepEqual(await api.findStations(53.2, 5.2), http('/stations', { latitude: '53.2', longitude: '5.2' }).body);
});

test('currentsApi.getTimeline: equals GET /stations/:id/timeline for a legacy and a UTCEF station', async () => {
  const state = loadedState();
  const http = httpApi(state);
  const api = createCurrentsApi(state, () => true);
  const stations = await api.findStations(53.2, 5.2, 10);
  const legacy = stations.find((s) => s.source === undefined)!;
  const utcef = stations.find((s) => s.source === 'utcef')!;

  const start = '2026-01-10T00:00:00.000Z';
  const end = '2026-01-10T06:00:00.000Z';
  for (const id of [legacy.id, utcef.id]) {
    const got = await api.getTimeline(id, start, end, 30);
    const want = http('/stations/:id/timeline', { start, end, step: '30' }, { id });
    assert.equal(want.code, 200);
    assert.deepEqual(got, want.body, id);
    assert.equal(got.timeline.length, 13);
    // Default step (omitted) matches the route's default too.
    assert.deepEqual(await api.getTimeline(id, start, end), http('/stations/:id/timeline', { start, end }, { id }).body);
  }
});

test('currentsApi: route errors reject with the same status and body', async () => {
  const state = loadedState();
  const http = httpApi(state);
  const api = createCurrentsApi(state, () => true);

  const notFound = await rejection(api.getTimeline('no-such-station', '2026-01-10T00:00:00Z', '2026-01-10T01:00:00Z'));
  const want404 = http('/stations/:id/timeline', { start: '2026-01-10T00:00:00Z', end: '2026-01-10T01:00:00Z' }, { id: 'no-such-station' });
  assert.equal(notFound.status, 404);
  assert.deepEqual(notFound.body, want404.body);
  assert.equal(notFound.message, want404.body.error);

  const badWindow = await rejection(api.getTimeline('x', '2026-01-10T01:00:00Z', '2026-01-10T00:00:00Z'));
  assert.equal(badWindow.status, 400);

  const badPos = await rejection(api.findStations(NaN, 5));
  assert.equal(badPos.status, 400);
  assert.deepEqual(badPos.body, http('/stations', { latitude: 'NaN', longitude: '5' }).body);

  const empty = await rejection(createCurrentsApi({ data: null, error: 'nothing here' }, () => true).findStations(53, 5));
  assert.equal(empty.status, 503);
});

test('limit / maxPoints: missing → default, 0 → the maximum, negative → 400 (never slices from the end)', async () => {
  // 60 UTCEF stations: more than the nearest-mode cap (50) and the default (10).
  const many: Array<[string, number, number]> = [];
  for (let i = 0; i < 60; i++) many.push([`M-${i}`, 53 + (i % 10) * 0.05, 5 + Math.floor(i / 10) * 0.05]);
  const state: ApiState = { data: null, error: null, utcef: createUtcefSource(writeUtcefDir({ 'many.utcef': many })) };
  const http = httpApi(state);
  const api = createCurrentsApi(state, () => true);
  const near = { latitude: '53.2', longitude: '5.2' };

  assert.equal((await api.findStations(53.2, 5.2)).length, 10, 'missing → default 10');
  assert.equal(http('/stations', { ...near, limit: 'abc' }).body.length, 10, 'unparseable → default 10');
  assert.equal((await api.findStations(53.2, 5.2, 1)).length, 1);
  assert.equal((await api.findStations(53.2, 5.2, 0)).length, 50, '0 → the cap, 50');
  assert.equal((await api.findStations(53.2, 5.2, 500)).length, 50, 'capped at 50');
  // -1 used to reach slice(0, -1) and return every station but one.
  const neg = await rejection(api.findStations(53.2, 5.2, -1));
  assert.equal(neg.status, 400);
  assert.deepEqual(neg.body, http('/stations', { ...near, limit: '-1' }).body);

  const bbox = '4.9,52.9,5.4,53.6';
  assert.equal(http('/stations', { bbox, maxPoints: '0' }).body.length, 60, 'bbox: 0 → the cap (5000), all 60');
  assert.equal(http('/stations', { bbox, limit: '0' }).body.length, 60, 'bbox: legacy limit alias too');
  assert.equal(http('/stations', { bbox, maxPoints: '-5' }).code, 400);
  assert.match(http('/stations', { bbox, limit: '-5' }).body.error, /^limit must be >= 0/);

  const time = '2026-01-10T00:00:00Z';
  assert.equal(http('/grid', { bbox, time, maxPoints: '0' }).code, 200, '/grid: 0 → the cap');
  assert.equal(http('/grid', { bbox, time, maxPoints: '0' }).body.points.length, 60);
  const gneg = http('/grid', { bbox, time, maxPoints: '-1' });
  assert.equal(gneg.code, 400);
  assert.match(gneg.body.error, /^maxPoints must be >= 0/);
});

test('currentsApi: a handler that returns without a response rejects instead of hanging', async () => {
  const err = await rejection(invoke(() => {}, { data: null, error: null }, {}, {}));
  assert.equal(err.status, 500);
});

test('currentsApi: running but without station data, every call rejects 503 like the routes', async () => {
  const empty: ApiState = { data: null, error: 'no harmonics pair' };
  const http = httpApi(empty);
  const api = createCurrentsApi(empty, () => true);
  const start = '2026-01-10T00:00:00Z';
  const end = '2026-01-10T01:00:00Z';

  const tl = await rejection(api.getTimeline('UT-1', start, end));
  assert.equal(tl.status, 503, 'not 404: the id is not the problem');
  assert.deepEqual(tl.body, http('/stations/:id/timeline', { start, end }, { id: 'UT-1' }).body);
  assert.equal((await rejection(api.findStations(53.2, 5.2))).status, 503);
  assert.equal(http('/stations/:id', {}, { id: 'UT-1' }).code, 503);
});

test('currentsApi: a stopped plugin rejects even while data is still in memory', async () => {
  const state = loadedState();
  let running = true;
  const api = createCurrentsApi(state, () => running);
  assert.ok((await api.findStations(53.2, 5.2)).length > 0);
  running = false;
  assert.equal((await rejection(api.findStations(53.2, 5.2))).status, 503);
  assert.equal((await rejection(api.getTimeline('UT-1', '2026-01-10T00:00:00Z', '2026-01-10T01:00:00Z'))).status, 503);
});

test('plugin: emits currentsApi once; the handle follows stop/start', async () => {
  const dataDir = fs.mkdtempSync(path.join(ROOT, 'plugin-'));
  for (const f of ['HARMONIC', 'HARMONIC.IDX']) fs.copyFileSync(path.join(FIXTURES, f), path.join(dataDir, f));

  const emitted: Array<{ name: string; value: unknown }> = [];
  const app = {
    emitPropertyValue: (name: string, value: unknown) => emitted.push({ name, value }),
    setPluginStatus: () => {},
    setPluginError: () => {},
    handleMessage: () => {},
  };
  const plugin = pluginConstructor(app);
  // Unroutable catalog URL: the fire-and-forget refresh fails fast and offline.
  const options = { dataDir, publishDelta: false, catalogUrl: 'http://127.0.0.1:9/catalog.json' };

  plugin.start(options);
  try {
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].name, CURRENTS_API_PROPERTY);
    const api = emitted[0].value as CurrentsApiV1;
    assert.ok((await api.findStations(53.2, 5.2)).length > 0);

    plugin.stop();
    assert.equal((await rejection(api.findStations(53.2, 5.2))).status, 503);

    plugin.start(options); // config save = stop + start
    assert.equal(emitted.length, 1, 'never re-emitted: the server caps PropertyValues per name');
    assert.ok((await api.findStations(53.2, 5.2)).length > 0, 'same handle works again after restart');
  } finally {
    plugin.stop();
  }
});

test('plugin: starts fine on a server without PropertyValues', () => {
  const dataDir = fs.mkdtempSync(path.join(ROOT, 'plugin-'));
  const plugin = pluginConstructor({ setPluginStatus: () => {}, setPluginError: () => {}, handleMessage: () => {} });
  plugin.start({ dataDir, publishDelta: false, catalogUrl: 'http://127.0.0.1:9/catalog.json' });
  plugin.stop();
});
