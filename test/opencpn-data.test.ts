// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests against real-world data: the HARMONICS_NO_US pair
 * shipped with OpenCPN (https://github.com/OpenCPN/OpenCPN, data/tcdata).
 *
 * The files are NOT bundled with this project — their license is not
 * explicit (derived from XTide harmonic data whose non-US portions were
 * withdrawn over licensing; OpenCPN distributes them under its own GPL
 * umbrella), so vendoring them into this Apache-2.0 repo is not safely
 * possible. Instead the test downloads them into a gitignored cache on
 * first run and SKIPS (does not fail) when offline.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHarmonicsDir } from '../dist/harmonics.js';
import { currentSampleAt, currentSpeedAt, nearestCurrentStations, predictReference } from '../dist/predict.js';

const DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'test', 'data-opencpn',
);
const BASE_URL = 'https://raw.githubusercontent.com/OpenCPN/OpenCPN/master/data/tcdata';
const FILES = ['HARMONICS_NO_US', 'HARMONICS_NO_US.IDX'];

async function ensureData(): Promise<boolean> {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(DATA_DIR, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000) continue;
    try {
      const resp = await fetch(`${BASE_URL}/${name}`);
      if (!resp.ok) return false;
      fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
    } catch {
      return false;
    }
  }
  return true;
}

const available = await ensureData();

test('OpenCPN HARMONICS_NO_US real-data integration', { skip: !available && 'data unavailable (offline?)' }, async (t) => {
  const data = loadHarmonicsDir(DATA_DIR);

  await t.test('parses the full file without desync', () => {
    assert.ok(data.constituents.names.length >= 100, `constituents: ${data.constituents.names.length}`);
    assert.ok(data.records.size >= 500, `records: ${data.records.size}`);
    assert.ok(data.stations.length >= 2000, `stations: ${data.stations.length}`);
  });

  await t.test('contains current stations (Canada/Caribbean)', () => {
    const currents = data.stations.filter((s) => s.isCurrent);
    assert.ok(currents.length >= 50, `current stations: ${currents.length}`);
    const vectorCapable = currents.filter(
      (s) => s.offsets && s.offsets.floodDir !== null && s.offsets.ebbDir !== null,
    );
    assert.ok(vectorCapable.length >= 20, `vector-capable: ${vectorCapable.length}`);
  });

  await t.test('height reference predictions are plausible', () => {
    // Any tide reference station: 25h of predictions must oscillate within
    // a plausible tidal range around its datum.
    const ref = data.stations.find(
      (s) => s.type === 'T' && !s.isSubordinate && currentSpeedAt(data, s, Date.now()) !== null,
    );
    assert.ok(ref, 'no resolvable reference station found');
    const rec = data.records.get(ref!.name) ?? [...data.records.values()].find((r) => !r.isCurrent);
    let min = Infinity, max = -Infinity;
    const t0 = Date.now();
    for (let m = 0; m <= 25 * 60; m += 15) {
      const h = predictReference(rec!, data.constituents, t0 + m * 60_000);
      assert.ok(Number.isFinite(h), 'prediction not finite');
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
    assert.ok(max - min > 0.1, `no tidal oscillation (range ${(max - min).toFixed(3)})`);
    assert.ok(max - min < 20, `implausible range ${(max - min).toFixed(1)}`);
  });

  await t.test('current stations produce signed flood/ebb with directions', () => {
    // British Columbia has dense subordinate current coverage.
    const near = nearestCurrentStations(data, 48.8, -123.2, 10).filter((n) => n.vectorCapable);
    assert.ok(near.length > 0, 'no vector-capable current stations near BC');
    const st = near[0].station;
    let sawFlood = false, sawEbb = false;
    const t0 = Date.now();
    for (let m = 0; m <= 14 * 60; m += 20) {
      const s = currentSampleAt(data, st, t0 + m * 60_000)!;
      assert.ok(Number.isFinite(s.speedKn));
      assert.ok(Math.abs(s.speedKn) < 15, `implausible current ${s.speedKn} kn`);
      if (s.speedKn > 0.3) {
        sawFlood = true;
        assert.equal(s.direction, st.offsets!.floodDir);
      }
      if (s.speedKn < -0.3) {
        sawEbb = true;
        assert.equal(s.direction, st.offsets!.ebbDir);
        assert.ok(s.u !== null && s.v !== null);
      }
    }
    assert.ok(sawFlood && sawEbb, `no full cycle at ${st.name} (flood=${sawFlood} ebb=${sawEbb})`);
  });
});
