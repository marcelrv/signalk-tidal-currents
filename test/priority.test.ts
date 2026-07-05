// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_PRIORITY,
  isValidDatasetStack,
  isValidPriorityOrder,
  loadPriorityOverride,
  resolveDatasetStack,
  savePriorityOverrideAtomic,
} from '../dist/priority.js';
import { ApiState, resolveVector } from '../dist/api.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-priority-'));
}

/** A minimal GRIB field covering (52,4) with a uniform 1 m/s eastward current. */
function fakeGribState() {
  const slot = {
    time: Date.UTC(2026, 6, 4, 12, 0, 0),
    grid: { ni: 2, nj: 2, lat0: 51, lon0: 3, di: 2, dj: 2, globalLon: false },
    u: Float64Array.from([1, 1, 1, 1]),
    v: Float64Array.from([0, 0, 0, 0]),
    depth: 0,
    file: 'test.grb2',
  };
  const data = { dir: 'test', files: ['test.grb2'], slots: [slot], slotsByFile: { 'test.grb2': [slot] }, warnings: [] };
  return { get: () => data, error: null };
}

/** A minimal UTCEF station whose representative_area covers (52,4) with a constant vector. */
function fakeUtcefState() {
  const station = {
    id: 'FAKE', name: 'Fake station', latitude: 52, longitude: 4,
    meanU: 0, meanV: 2, constituents: [],
    representativeArea: [[[3, 51], [5, 51], [5, 53], [3, 53], [3, 51]]],
    file: 't.utcef',
  };
  const data = { dir: 'test', files: ['t.utcef'], currentStations: [station], heightStationCount: 0, unsupportedFeatureCount: 0, warnings: [] };
  return { get: () => data, error: null };
}

test('resolveVector follows a custom sourcePriority over grib/utcef when both cover the position', () => {
  const time = Date.UTC(2026, 6, 4, 12, 0, 0);
  const state: ApiState = { data: null, error: null, grib: fakeGribState() as any, utcef: fakeUtcefState() as any, sourcePriority: ['grib2', 'utcef', 'harmonic'] };
  const gribFirst = resolveVector(state, 52, 4, time);
  assert.equal(gribFirst?.source, 'grib');

  state.sourcePriority = ['utcef', 'grib2', 'harmonic'];
  const utcefFirst = resolveVector(state, 52, 4, time);
  assert.equal(utcefFirst?.source, 'utcef');
});

test('DEFAULT_PRIORITY is grib2, utcef, harmonic', () => {
  assert.deepEqual(DEFAULT_PRIORITY, ['grib2', 'utcef', 'harmonic']);
});

test('isValidPriorityOrder accepts any permutation of the 3 types', () => {
  assert.ok(isValidPriorityOrder(['grib2', 'utcef', 'harmonic']));
  assert.ok(isValidPriorityOrder(['harmonic', 'grib2', 'utcef']));
});

test('isValidPriorityOrder rejects non-permutations', () => {
  assert.equal(isValidPriorityOrder(['grib2', 'utcef']), false); // too short
  assert.equal(isValidPriorityOrder(['grib2', 'grib2', 'harmonic']), false); // duplicate
  assert.equal(isValidPriorityOrder(['grib2', 'utcef', 'nonsense']), false); // unknown value
  assert.equal(isValidPriorityOrder(null), false);
  assert.equal(isValidPriorityOrder('grib2,utcef,harmonic'), false);
});

test('loadPriorityOverride returns empty defaults when absent/corrupt', () => {
  const dir = tmpDir();
  assert.deepEqual(loadPriorityOverride(dir), { order: null, datasets: [] });
  fs.writeFileSync(path.join(dir, 'priority.json'), '{not valid json');
  assert.deepEqual(loadPriorityOverride(dir), { order: null, datasets: [] });
});

test('savePriorityOverrideAtomic round-trips order and dataset stack', () => {
  const dir = tmpDir();
  savePriorityOverrideAtomic(dir, ['utcef', 'harmonic', 'grib2']);
  assert.deepEqual(loadPriorityOverride(dir), { order: ['utcef', 'harmonic', 'grib2'], datasets: [] });
  savePriorityOverrideAtomic(dir, ['utcef', 'harmonic', 'grib2'], ['coastal-nl', 'global-rtofs']);
  assert.deepEqual(loadPriorityOverride(dir), { order: ['utcef', 'harmonic', 'grib2'], datasets: ['coastal-nl', 'global-rtofs'] });
});

test('isValidDatasetStack accepts unique string lists, rejects everything else', () => {
  assert.ok(isValidDatasetStack([]));
  assert.ok(isValidDatasetStack(['a', 'b']));
  assert.equal(isValidDatasetStack(['a', 'a']), false); // duplicate
  assert.equal(isValidDatasetStack(['a', '']), false); // empty id
  assert.equal(isValidDatasetStack(['a', 42]), false);
  assert.equal(isValidDatasetStack('a,b'), false);
  assert.equal(isValidDatasetStack(null), false);
});

test('resolveDatasetStack: persisted first (stale ids dropped), rest appended in type order', () => {
  const installs = [
    { id: 'h1', type: 'harmonic' as const, files: ['HARMONIC'] },
    { id: 'u1', type: 'utcef' as const, files: ['nl.utcef'] },
    { id: 'g1', type: 'grib2' as const, files: ['a.grb2', 'b.grb2'] },
  ];
  const stack = resolveDatasetStack(['u1', 'gone'], ['grib2', 'utcef', 'harmonic'], installs);
  assert.deepEqual(stack.map((e) => e.id), ['u1', 'g1', 'h1']);
  assert.deepEqual(stack[1].files, ['a.grb2', 'b.grb2']);
});

test('resolveVector: a dataset stack entry wins across types, and only probes its own files', () => {
  const time = Date.UTC(2026, 6, 4, 12, 0, 0);
  const state: ApiState = {
    data: null, error: null,
    grib: fakeGribState() as any,
    utcef: fakeUtcefState() as any,
    sourcePriority: ['grib2', 'utcef', 'harmonic'],
    // UTCEF dataset ranked on top — beats GRIB despite the type order.
    datasetRank: () => [{ id: 'nl', type: 'utcef', files: ['t.utcef'] }],
  };
  assert.equal(resolveVector(state, 52, 4, time)?.source, 'utcef');

  // A stack whose only dataset owns a DIFFERENT file finds nothing there,
  // so resolution falls through to the type-rank pass (grib first).
  state.datasetRank = () => [{ id: 'other', type: 'utcef', files: ['other.utcef'] }];
  assert.equal(resolveVector(state, 52, 4, time)?.source, 'grib');
});

test('a stacked UTCEF dataset far away does not hijack via its nearest-station fallback', () => {
  const time = Date.UTC(2026, 6, 4, 12, 0, 0);
  const near = {
    id: 'NEAR', name: 'Near station', latitude: 52, longitude: 4,
    meanU: 0, meanV: 1, constituents: [],
    representativeArea: [[[3, 51], [5, 51], [5, 53], [3, 53], [3, 51]]],
    file: 'near.utcef',
  };
  const far = { id: 'FAR', name: 'Far station', latitude: 27, longitude: -75, meanU: 1, meanV: 0, constituents: [], file: 'far.utcef' };
  const data = { dir: 't', files: ['far.utcef', 'near.utcef'], currentStations: [far, near], heightStationCount: 0, unsupportedFeatureCount: 0, warnings: [] };
  const state: ApiState = {
    data: null, error: null,
    utcef: { get: () => data, error: null } as any,
    sourcePriority: ['grib2', 'utcef', 'harmonic'],
    // The far dataset is ranked ABOVE the near one — without the clamped
    // per-dataset fallback radius it would claim the North Sea query from
    // 7000 km away purely by being first in the stack.
    datasetRank: () => [
      { id: 'far', type: 'utcef', files: ['far.utcef'] },
      { id: 'near', type: 'utcef', files: ['near.utcef'] },
    ],
  };
  const r = resolveVector(state, 52, 4, time);
  assert.equal(r?.source, 'utcef');
  assert.equal(r?.utcefStation?.id, 'NEAR');
});

test('gribVectorAt honors a file filter against slotsByFile', () => {
  const time = Date.UTC(2026, 6, 4, 12, 0, 0);
  const g = (fakeGribState() as any).get();
  const state: ApiState = {
    data: null, error: null,
    grib: { get: () => g, error: null } as any,
    sourcePriority: ['grib2', 'utcef', 'harmonic'],
    datasetRank: () => [{ id: 'g', type: 'grib2', files: ['missing.grb2'] }],
  };
  // The stack's grib dataset owns no loaded file → falls through to the
  // unfiltered type-rank probe, which still finds the merged grib data.
  assert.equal(resolveVector(state, 52, 4, time)?.source, 'grib');
});
