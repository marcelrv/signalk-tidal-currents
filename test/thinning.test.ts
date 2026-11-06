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

// ── Reference implementation: the original object/Map-based algorithm ──

const LADDER = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 40];
function refPick<T extends { lat: number; lon: number }>(items: T[], size: number, limit: number): T[] | null {
  const slotOf = new Map<number, number>();
  const reps: T[] = [];
  const d2s: number[] = [];
  for (const it of items) {
    const ci = Math.floor(it.lon / size);
    const cj = Math.floor(it.lat / size);
    const d2 = (it.lon - (ci + 0.5) * size) ** 2 + (it.lat - (cj + 0.5) * size) ** 2;
    const key = cj * 1048576 + ci;
    const slot = slotOf.get(key);
    if (slot === undefined) {
      if (reps.length >= limit) return null;
      slotOf.set(key, reps.length);
      reps.push(it);
      d2s.push(d2);
    } else {
      const cur = reps[slot];
      if (d2 < d2s[slot] || (d2 === d2s[slot] && (it.lat < cur.lat || (it.lat === cur.lat && it.lon < cur.lon)))) {
        reps[slot] = it;
        d2s[slot] = d2;
      }
    }
  }
  return reps;
}
function refThin<T extends { lat: number; lon: number }>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  let chosen: T[] | null = null;
  for (let i = LADDER.length - 1; i >= 0; i--) {
    const reps = refPick(items, LADDER[i], max);
    if (reps) chosen = reps;
    else break;
  }
  return chosen ?? refPick(items, LADDER[LADDER.length - 1], Infinity)!.slice(0, max);
}

test('thinByCellLadder (typed-array cells) picks exactly what the original Map-based algorithm picked, in the same order', () => {
  let a = 12345;
  const rand = () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
  const scenes: Array<Array<{ lat: number; lon: number; id: number }>> = [
    // Random, with duplicated coordinates and negative / antimeridian-side values.
    Array.from({ length: 6000 }, (_, id) => ({ lat: -80 + rand() * 160, lon: -180 + rand() * 360, id })),
    // A regular lattice: many exact distance ties (resolved by lat, lon).
    gridStations(70, 50, 0, 0.01).map((s, id) => ({ lat: s.lat, lon: s.lon, id })),
    // A dense cluster plus far outliers.
    Array.from({ length: 4000 }, (_, id) => ({ lat: id % 50 === 0 ? 10 + rand() * 60 : 51.9 + rand() * 0.2, lon: id % 50 === 0 ? -40 + rand() * 80 : 3.9 + rand() * 0.4, id })),
  ];
  for (const [n, items] of scenes.entries()) {
    for (const max of [0, 1, 2, 3, 7, 25, 100, 500, 3000]) {
      const got = thinByCellLadder(items, max).map((s) => s.id);
      const want = refThin(items, max).map((s) => s.id);
      assert.deepEqual(got, want, `scene ${n} max ${max}`);
    }
  }
});
