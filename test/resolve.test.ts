// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * The single resolver (src/resolve.ts): claimAt / resolveAt share one layer
 * loop; /vector, /timeline and the published deltas all go through it.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveVector, ApiState } from '../dist/api.js';
import { createGribSource } from '../dist/gribcurrents.js';
import { loadHarmonicsDir } from '../dist/harmonics.js';
import { Layer, claimAt, createResolveCtx, orderedLayers, resolveAt } from '../dist/resolve.js';
import { createUtcefSource } from '../dist/utcef.js';
import { T0, HOUR, gridTime, gribDirOf, makeApi, rng, uvFields, writeUtcefDir, rect } from './grid-testutil.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const legacyData = loadHarmonicsDir(FIXTURES);

const uvDir = gribDirOf({ 'currents.grb2': uvFields(52.9, 4.9, 0.1, 7, { u: 1, v: 0 }) });

test('resolveVector honours a dataset stack mixing grib2, utcef and harmonic entries', () => {
  const dir = writeUtcefDir({ 'g.utcef': [['G', 53.2, 5.2]] });
  const base = { data: legacyData, error: null, grib: createGribSource(uvDir, 0), utcef: createUtcefSource(dir, 0), preferGrib: true };
  const at = (stack: any[] | undefined) => resolveVector({ ...base, datasetRank: stack ? () => stack : undefined }, 53.2, 5.2, T0); // eslint-disable-line @typescript-eslint/no-explicit-any
  const G = { id: 'g', type: 'grib2', files: ['currents.grb2'] };
  const U = { id: 'u', type: 'utcef', files: ['g.utcef'] };
  const H = { id: 'h', type: 'harmonic', files: [] };
  assert.equal(at([G, U, H])?.source, 'grib');
  assert.equal(at([U, G, H])?.source, 'utcef');
  assert.equal(at([H, G, U])?.source, 'station');
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
  assert.deepEqual(l1.map((l: Layer) => [l.type, l.stack, l.utcefMaxKm]), [
    ['grib2', true, 50], ['utcef', true, 50], ['grib2', false, 50], ['utcef', false, 50], ['harmonic', false, 50],
  ]);
  // The stack clamp applies only to stack layers.
  assert.deepEqual(orderedLayers(state, 500).filter((l: Layer) => l.type === 'utcef').map((l: Layer) => l.utcefMaxKm), [50, 500]);
  // No datasetRank at all is cached too.
  const bare: ApiState = { data: null, error: null, preferGrib: false };
  assert.equal(orderedLayers(bare, 50), orderedLayers(bare, 50));
  assert.deepEqual(orderedLayers(bare, 50).map((l: Layer) => l.type), ['utcef', 'harmonic', 'grib2']);
});

test('claimAt and resolveAt share one loop: same winner everywhere, claimAt samples nothing', () => {
  const rand = rng(99);
  const grib = createGribSource(gribDirOf({
    'a.grb2': uvFields(52.9, 4.9, 0.1, 7, { u: Array.from({ length: 49 }, (_, k) => (k % 5 === 2 ? NaN : 1)) }),
    'b.grb2': uvFields(53.3, 5.3, 0.05, 9, { u: 2 }),
  }), 0);
  const utcef = createUtcefSource(writeUtcefDir({ 'u.utcef': [['A', 53.0, 5.0, rect(4.9, 52.9, 5.15, 53.1)], ['B', 53.4, 5.6]] }), 0);
  for (const preferGrib of [true, false]) {
    const state: ApiState = { data: legacyData, error: null, grib, utcef, preferGrib };
    const ctx = createResolveCtx(state);
    let claimed = 0;
    for (let n = 0; n < 400; n++) {
      const lat = 52.7 + rand() * 1.0;
      const lon = 4.7 + rand() * 1.1;
      const t = T0 + Math.floor(rand() * 20) * HOUR - 4 * HOUR;
      const claim = claimAt(ctx, lat, lon, t);
      const r = resolveAt(ctx, lat, lon, t);
      assert.equal(!!claim, !!r, `${lat},${lon}`);
      if (!claim || !r) continue;
      claimed++;
      assert.equal(claim.source, r.source);
      if (claim.source === 'utcef') assert.equal(claim.station, r.utcefStation);
      if (claim.source === 'station') assert.equal(claim.station, r.station);
      if (claim.source === 'grib') assert.equal(claim.series, r.series);
      assert.deepEqual(resolveVector(state, lat, lon, t, ctx.maxStationKm)?.sample, r.sample);
    }
    assert.ok(claimed > 100);
    assert.equal(ctx.counters.claims, 400);
    assert.equal(ctx.counters.resolves, 400);
    assert.equal(ctx.counters.samples, claimed, 'only resolveAt samples');
  }
});

test('/timeline equals /vector at every step, across the GRIB horizon and source changes', () => {
  const grib = createGribSource(gribDirOf({ 'g.grb2': [0, 6].flatMap((h) => uvFields(52.9, 4.9, 0.1, 7, { u: 1 + h / 6, forecastHours: h })) }), 0);
  const utcef = createUtcefSource(writeUtcefDir({ 'u.utcef': [['U', 53.2, 5.2]] }), 0);
  for (const [lat, lon] of [[53.2, 5.2], [53.2, 5.6], [53.4, 5.5]]) {
    const state: ApiState = { data: legacyData, error: null, grib, utcef, preferGrib: true };
    const call = makeApi(state);
    const tl = call('/timeline', { latitude: String(lat), longitude: String(lon), start: gridTime, end: new Date(T0 + 24 * HOUR).toISOString(), step: '60' });
    assert.ok(tl.timeline.length > 0);
    const seen = new Set<string>();
    for (const s of tl.timeline) {
      const rv = resolveVector(state, lat, lon, Date.parse(s.time))!;
      assert.equal(s.source, rv.source);
      assert.equal(s.u, rv.sample.u);
      assert.equal(s.v, rv.sample.v);
      seen.add(s.source);
    }
    if (lat === 53.2 && lon === 5.2) assert.ok(seen.has('grib') && seen.has('utcef'), `degrades past the horizon: ${[...seen]}`);
  }
});

test('/timeline UTCEF fallback honours representative_area like /vector', () => {
  const area = [[[4.95, 52.95], [5.1, 52.95], [5.1, 53.1], [4.95, 53.1], [4.95, 52.95]]];
  const dir = writeUtcefDir({ 'a.utcef': [['A', 53.0, 5.0], ['B', 53.3, 5.3, area]] });
  const call = makeApi({ data: null, error: null, grib: null, utcef: createUtcefSource(dir, 0), preferGrib: true });
  const q = { latitude: '53.02', longitude: '5.02', time: gridTime, hours: '2', step: '60' };
  assert.equal(call('/vector', q).station.id, 'B');
  assert.equal(call('/timeline', q).utcefStation.id, 'B');
});

test('a context built with a bbox drops layers that cannot reach it; legacy:false drops harmonic layers', () => {
  const utcef = createUtcefSource(writeUtcefDir({ 'near.utcef': [['N', 53.2, 5.2]], 'far.utcef': [['F', -40, 150]] }), 0);
  const grib = createGribSource(gribDirOf({ 'near.grb2': uvFields(52.9, 4.9, 0.1, 7), 'far.grb2': uvFields(-41, 149, 0.1, 7) }), 0);
  const stack = [
    { id: 'fg', type: 'grib2' as const, files: ['far.grb2'] },
    { id: 'fu', type: 'utcef' as const, files: ['far.utcef'] },
    { id: 'ng', type: 'grib2' as const, files: ['near.grb2'] },
  ];
  const state: ApiState = { data: legacyData, error: null, grib, utcef, preferGrib: true, datasetRank: () => stack };
  const all = createResolveCtx(state);
  const view = { west: 4.5, south: 52.5, east: 5.8, north: 53.8 };
  const near = createResolveCtx(state, 50, { bbox: view });
  assert.ok(all.layers.length > near.layers.length);
  assert.deepEqual(near.layers.filter((l) => l.stack).map((l) => [...l.files!]), [['near.grb2']]);
  // Type-rank layers reach the view (they hold the near data too).
  assert.deepEqual(near.layers.filter((l) => !l.stack).map((l) => l.type), ['grib2', 'utcef', 'harmonic']);
  // Resolution inside the view is unchanged by the pre-filter.
  for (const [lat, lon] of [[53.2, 5.2], [53.0, 5.0], [53.5, 5.6]]) {
    assert.deepEqual(resolveAt(near, lat, lon, T0)?.sample, resolveAt(all, lat, lon, T0)?.sample);
  }
  // Probes: a hit in the first near layer costs one probe; far layers are never touched.
  const before = near.counters.layerProbes;
  resolveAt(near, 53.2, 5.2, T0);
  assert.equal(near.counters.layerProbes - before, 1);
  const noLegacy = createResolveCtx(state, 50, { legacy: false });
  assert.ok(!noLegacy.layers.some((l) => l.type === 'harmonic'));
  assert.ok(all.layers.some((l) => l.type === 'harmonic'));
});
