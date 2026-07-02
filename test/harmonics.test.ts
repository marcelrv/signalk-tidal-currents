// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHarmonicsDir, meridianToSeconds, slugify } from '../dist/harmonics.js';
import {
  currentSampleAt,
  currentSpeedAt,
  nearestCurrentStations,
  predictReference,
} from '../dist/predict.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const data = loadHarmonicsDir(FIXTURES);

const M2_SPEED = 28.9841042; // deg/hr
const DEG2RAD = Math.PI / 180;

test('parses constituents and year tables', () => {
  assert.equal(data.constituents.names.length, 2);
  assert.equal(data.constituents.speeds[0], M2_SPEED);
  assert.equal(data.constituents.firstYear, 2025);
  assert.equal(data.constituents.numYears, 2);
  assert.deepEqual(data.constituents.equilibrium[1], [90, 0]);
});

test('parses station records with x placeholders and units', () => {
  assert.equal(data.records.size, 3);
  const ref = data.records.get('Test Ref, Courants')!;
  assert.equal(ref.isCurrent, true);
  assert.equal(ref.amplitude[0], 1.0);
  assert.equal(ref.amplitude[1], 0); // "x 0 0" placeholder
  const height = data.records.get('Test Height, Fixture')!;
  assert.equal(height.isCurrent, false);
  assert.equal(height.datum, 2.0);
});

test('parses IDX station types and subordinate offsets', () => {
  assert.equal(data.stations.length, 5);
  const sub = data.stations.find((s) => s.name === 'Test Sub, Courants')!;
  assert.equal(sub.isCurrent, true);
  assert.equal(sub.isSubordinate, true);
  assert.equal(sub.offsets!.floodOffsetMinutes, 60);
  assert.equal(sub.offsets!.floodMultiplier, 2.0);
  assert.equal(sub.offsets!.ebbMultiplier, 1.5);
  assert.equal(sub.offsets!.floodDir, 90);
  assert.equal(sub.offsets!.ebbDir, 270);
  assert.equal(sub.offsets!.referenceName, 'Test Ref, Courants');

  const tsub = data.stations.find((s) => s.name === 'Test Sub Height, Fixture')!;
  assert.equal(tsub.isCurrent, false);
  assert.equal(tsub.offsets!.referenceName, 'Test Height, Fixture');
});

test('reference prediction matches the harmonic formula', () => {
  const ref = data.records.get('Test Ref, Courants')!;
  // 2026, equilibrium M2 = 0, node = 1, amp 1, phase 0, meridian 0:
  // v(t) = cos(speed · hoursSinceYearStart)
  const t0 = Date.UTC(2026, 0, 1);
  assert.ok(Math.abs(predictReference(ref, data.constituents, t0) - 1.0) < 1e-6);
  const quarter = (90 / M2_SPEED) * 3600_000; // arg = 90°
  assert.ok(Math.abs(predictReference(ref, data.constituents, t0 + quarter)) < 1e-6);
  const half = (180 / M2_SPEED) * 3600_000;
  assert.ok(Math.abs(predictReference(ref, data.constituents, t0 + half) + 1.0) < 1e-6);
});

test('meridian shifts the phase reference', () => {
  const mer = data.records.get('Test Meridian, Courants')!;
  // Same constituents but meridian +01:00 — the peak occurs 1h earlier in UTC.
  const t0 = Date.UTC(2026, 0, 1);
  const vAtMinus1h = predictReference(mer, data.constituents, t0 - 3600_000);
  assert.ok(Math.abs(vAtMinus1h - 1.0) < 1e-6);
});

test('subordinate applies offsets, multipliers and directions', () => {
  const sub = data.stations.find((s) => s.name === 'Test Sub, Courants')!;
  const t0 = Date.UTC(2026, 0, 1);
  // At t0 + 60min the flood-shifted reference is at its +1.0 peak → 2.0 kn flood.
  const atPeak = currentSpeedAt(data, sub, t0 + 60 * 60_000)!;
  assert.ok(Math.abs(atPeak - 2.0) < 0.05, `flood peak ${atPeak}`);
  const sample = currentSampleAt(data, sub, t0 + 60 * 60_000)!;
  assert.equal(sample.direction, 90);
  assert.ok(sample.u! > 0.9); // ~2 kn east
  assert.ok(Math.abs(sample.v!) < 1e-6);

  // Half a cycle later the ebb branch applies: direction 270, negative speed.
  const half = (180 / M2_SPEED) * 3600_000;
  const ebbSample = currentSampleAt(data, sub, t0 + 30 * 60_000 + half)!;
  assert.ok(ebbSample.speedKn < -1.0, `ebb ${ebbSample.speedKn}`);
  assert.equal(ebbSample.direction, 270);
});

test('nearest station search filters and sorts', () => {
  const near = nearestCurrentStations(data, 53.2, 5.2, 10);
  assert.equal(near.length, 3); // 2 refs + 1 sub, height stations excluded
  assert.equal(near[0].station.name, 'Test Sub, Courants');
  assert.equal(near[0].vectorCapable, true);
  const ref = near.find((n) => n.station.name === 'Test Ref, Courants')!;
  assert.equal(ref.vectorCapable, false); // reference has no flood/ebb axis
});

test('utility functions', () => {
  assert.equal(meridianToSeconds('01:00'), 3600);
  assert.equal(meridianToSeconds('-3:30'), -12600);
  assert.equal(meridianToSeconds('+1:00'), 3600);
  assert.equal(slugify('Doove Balg, Courants (heure Fr)'), 'doove-balg-courants-heure-fr');
});
