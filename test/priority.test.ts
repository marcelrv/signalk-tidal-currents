// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_PRIORITY, isValidPriorityOrder, loadPriorityOverride, savePriorityOverrideAtomic } from '../dist/priority.js';
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
  const data = { dir: 'test', files: ['test.grb2'], slots: [slot], warnings: [] };
  return { get: () => data, error: null };
}

/** A minimal UTCEF station whose representative_area covers (52,4) with a constant vector. */
function fakeUtcefState() {
  const station = {
    id: 'FAKE', name: 'Fake station', latitude: 52, longitude: 4,
    meanU: 0, meanV: 2, constituents: [],
    representativeArea: [[[3, 51], [5, 51], [5, 53], [3, 53], [3, 51]]],
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

test('loadPriorityOverride returns null when absent/corrupt', () => {
  const dir = tmpDir();
  assert.equal(loadPriorityOverride(dir), null);
  fs.writeFileSync(path.join(dir, 'priority.json'), '{not valid json');
  assert.equal(loadPriorityOverride(dir), null);
});

test('savePriorityOverrideAtomic round-trips', () => {
  const dir = tmpDir();
  savePriorityOverrideAtomic(dir, ['utcef', 'harmonic', 'grib2']);
  assert.deepEqual(loadPriorityOverride(dir), ['utcef', 'harmonic', 'grib2']);
});
