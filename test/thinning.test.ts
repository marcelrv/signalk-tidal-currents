// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { thinByCellLadder } from '../dist/api.js';

/** A dense grid of stations: `n`×`n` points on a 0.01° spacing from (lat0, lon0). */
function gridStations(n: number, lat0 = 50, lon0 = 0, step = 0.01) {
  const out: Array<{ lat: number; lon: number; id: string }> = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out.push({ lat: lat0 + j * step, lon: lon0 + i * step, id: `${j}-${i}` });
    }
  }
  return out;
}

test('thinByCellLadder returns the input untouched when it already fits the budget', () => {
  const items = gridStations(5); // 25 points
  const thinned = thinByCellLadder(items, 500);
  assert.equal(thinned, items); // same reference — zoomed-in "show everything" path
});

test('thinByCellLadder caps output at maxPoints', () => {
  const items = gridStations(100); // 10 000 points
  for (const max of [50, 200, 1000]) {
    const thinned = thinByCellLadder(items, max);
    assert.ok(thinned.length <= max, `expected <= ${max}, got ${thinned.length}`);
    assert.ok(thinned.length > 0);
  }
});

test('thinByCellLadder is stable: the chosen subset does not depend on input order', () => {
  const items = gridStations(60); // 3600 points
  const a = thinByCellLadder(items, 300).map((s) => s.id).sort();
  const shuffled = [...items].reverse();
  const b = thinByCellLadder(shuffled, 300).map((s) => s.id).sort();
  assert.deepEqual(a, b);
});

test('thinByCellLadder gives fewer points for a smaller budget', () => {
  const items = gridStations(80); // 6400 points
  const fine = thinByCellLadder(items, 1200).length;
  const coarse = thinByCellLadder(items, 100).length;
  assert.ok(coarse < fine);
  assert.ok(coarse <= 100 && fine <= 1200);
});

test('thinByCellLadder keeps points spread across the viewport, not clustered', () => {
  const items = gridStations(100, 50, 0, 0.01); // covers 50..50.99 lat, 0..0.99 lon
  const thinned = thinByCellLadder(items, 200);
  const lats = thinned.map((s) => s.lat);
  const lons = thinned.map((s) => s.lon);
  // Representatives reach into every corner region, not just the first cells.
  assert.ok(Math.min(...lats) < 50.1 && Math.max(...lats) > 50.8);
  assert.ok(Math.min(...lons) < 0.1 && Math.max(...lons) > 0.8);
});

test('thinByCellLadder falls back to a truncated coarsest set when maxPoints is tiny', () => {
  // Points spread across many 40° cells so even the coarsest level overflows a tiny budget.
  const items: Array<{ lat: number; lon: number; id: string }> = [];
  for (let lon = -160; lon <= 160; lon += 40) items.push({ lat: 0, lon, id: `p${lon}` });
  const thinned = thinByCellLadder(items, 3);
  assert.equal(thinned.length, 3);
});
