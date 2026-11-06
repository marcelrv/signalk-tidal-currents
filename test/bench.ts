// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm run bench` — NOT part of CI (the test glob only matches *.test.js).
 *
 * 200k UTCEF stations + a global 0.25° GRIB (with a land mask) + 20 orphan
 * GRIB datasets in the priority stack, at a Europe-sized zoomed-out bbox and
 * a harbour-sized zoomed-in bbox, sweeping the time over 48 steps. Prints
 * ms/request and the RSS delta across the sweep as a markdown table.
 *
 * Run with --expose-gc (the npm script does) so RSS is measured after a GC.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ApiState } from '../dist/api.js';
import { createGribSource } from '../dist/gribcurrents.js';
import { DatasetRankEntry } from '../dist/priority.js';
import { createUtcefSource } from '../dist/utcef.js';
import { encodeGrib2File, EncodeField } from './grib2-testutil.js';
import { ROOT, T0, HOUR, rng, makeApi, uvFields } from './grid-testutil.js';

const gc = (globalThis as { gc?: () => void }).gc;
const rssMb = (): number => {
  gc?.();
  return process.memoryUsage().rss / 1048576;
};
const heapMb = (): number => {
  gc?.();
  return process.memoryUsage().heapUsed / 1048576;
};
const ms = (t: number) => Math.round(t * 100) / 100;

// ── Data ──
const rand = rng(424242);
const t0 = performance.now();

// UTCEF: 190k stations over Europe + a 10k-station harbour cluster (Rotterdam-ish).
const features: unknown[] = [];
const mkFeature = (id: string, lat: number, lon: number) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5] },
  properties: {
    prediction_method: 'harmonic_constituents_currents',
    data_unit_speed: 'knots',
    harmonic_constituents: { M2: { u_amplitude: 1.2, u_phase_g: 30, v_amplitude: 0.6, v_phase_g: 80 } },
  },
});
for (let i = 0; i < 190_000; i++) features.push(mkFeature(`E${i}`, 35 + rand() * 30, -15 + rand() * 45));
for (let i = 0; i < 10_000; i++) features.push(mkFeature(`H${i}`, 51.8 + rand() * 0.3, 3.9 + rand() * 0.4));
const utcefDir = path.join(ROOT, 'bench-utcef');
fs.mkdirSync(utcefDir, { recursive: true });
fs.writeFileSync(
  path.join(utcefDir, 'europe.utcef'),
  JSON.stringify({ metadata: { schema_version: '1.0.0' }, dataset: { type: 'FeatureCollection', features } }),
);
features.length = 0;

// GRIB: global 0.25° with a smooth "continent" mask, two time steps; plus 20 small orphan regions.
const NI = 1440;
const NJ = 721;
const globalField = (param: number, h: number): EncodeField => {
  const values = new Array<number>(NI * NJ);
  for (let j = 0; j < NJ; j++) {
    const lat = -90 + j * 0.25;
    for (let i = 0; i < NI; i++) {
      const lon = i * 0.25;
      const land = Math.sin(lon / 23) * Math.cos(lat / 17) > 0.55;
      values[j * NI + i] = land ? NaN : param === 2 ? 0.6 * Math.sin(lat / 9 + h / 5) : 0.4 * Math.cos(lon / 11 + h / 7);
    }
  }
  return { param, refTime: T0, forecastHours: h, la1: -90, lo1: 0, dLat: 0.25, dLon: 0.25, ni: NI, nj: NJ, values, decScale: 2 };
};
const gribDir = path.join(ROOT, 'bench-grib');
fs.mkdirSync(gribDir, { recursive: true });
fs.writeFileSync(path.join(gribDir, 'global.grb2'), encodeGrib2File([2, 3].flatMap((p) => [0, 6, 12].map((h) => globalField(p, h)))));
const stack: DatasetRankEntry[] = [];
for (let k = 0; k < 20; k++) {
  fs.writeFileSync(path.join(gribDir, `orphan${k}.grb2`), encodeGrib2File(uvFields(-60 + k * 2, 100 + k * 3, 0.1, 7, { u: 0.5 })));
  stack.push({ id: `o${k}`, type: 'grib2', files: [`orphan${k}.grb2`] });
}
console.log(`fixtures built in ${ms((performance.now() - t0) / 1000)} s`);

const grib = createGribSource(gribDir, 0);
const utcef = createUtcefSource(utcefDir, 0);
const tLoad = performance.now();
const gd = grib.get();
const ud = utcef.get();
console.log(`loaded ${gd?.series.length} GRIB series, ${ud?.currentStations.length} UTCEF stations in ${ms((performance.now() - tLoad) / 1000)} s`);

const state: ApiState = { data: null, error: null, grib, utcef, preferGrib: true, datasetRank: () => stack };
const call = makeApi(state);

interface Case {
  name: string;
  route: string;
  query: (t: number) => Record<string, unknown>;
}
const europe = '-15,35,30,65';
const harbour = '3.9,51.8,4.3,52.1';
const cases: Case[] = [
  { name: '/grid Europe (zoomed out), maxPoints 500', route: '/grid', query: (t) => ({ bbox: europe, time: new Date(t).toISOString(), maxPoints: '500' }) },
  { name: '/grid harbour (zoomed in), maxPoints 2000', route: '/grid', query: (t) => ({ bbox: harbour, time: new Date(t).toISOString(), maxPoints: '2000' }) },
  { name: '/grid world, maxPoints 500', route: '/grid', query: (t) => ({ bbox: '-180,-85,180,85', time: new Date(t).toISOString(), maxPoints: '500' }) },
  { name: '/stations?bbox Europe, maxPoints 500', route: '/stations', query: () => ({ bbox: europe, maxPoints: '500' }) },
  { name: '/stations?bbox harbour, maxPoints 2000', route: '/stations', query: () => ({ bbox: harbour, maxPoints: '2000' }) },
];

const rows: string[] = [];
for (const c of cases) {
  call(c.route, c.query(T0)); // warm-up: index builds, JIT
  const base = rssMb();
  const heapBase = heapMb();
  let peak = base;
  let points = 0;
  const sweep = () => {
    const times: number[] = [];
    for (let step = 0; step < 48; step++) {
      const q = c.query(T0 + step * HOUR);
      const s = performance.now();
      const body = call(c.route, q);
      times.push(performance.now() - s);
      points = (body.points ?? body).length;
      peak = Math.max(peak, process.memoryUsage().rss / 1048576);
    }
    return times;
  };
  const times = sweep();
  const after1 = rssMb();
  sweep(); // a second sweep: RSS must plateau, not keep growing
  const after2 = rssMb();
  const heapAfter = heapMb();
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  rows.push(
    `| ${c.name} | ${points} | ${ms(mean)} | ${ms(times[Math.floor(times.length / 2)])} | ${ms(times[times.length - 1])} | ${ms(after1 - base)} | ${ms(after2 - after1)} | ${ms(heapAfter - heapBase)} | ${ms(peak - base)} |`,
  );
}

console.log('\n| request | points | mean ms | median ms | max ms | RSS delta after sweep 1 (MB) | RSS delta sweep 2 vs 1 (MB) | live-heap delta (MB) | peak RSS delta (MB) |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
console.log(`\nnode ${process.version} ${process.arch}, RSS baseline after load ${ms(rssMb())} MB`);
