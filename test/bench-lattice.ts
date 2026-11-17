// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * NOT part of CI. Measures how much of the /grid budget the GRIB lattice uses
 * and what a request costs (time, transient allocation), for the lattice fill
 * variants. Run (after `tsc -p tsconfig.test.json`) with:
 *   node --expose-gc --max-semi-space-size=64 dist-test/bench-lattice.js [mode]
 * mode = baseline | ladder | ladder-guarded | quincunx (ignored on a build
 * without the prototype switch, which is the plain baseline).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as api from '../dist/api.js';
import { ApiState } from '../dist/api.js';
import { createGribSource } from '../dist/gribcurrents.js';
import { createUtcefSource } from '../dist/utcef.js';
import { encodeGrib2File, EncodeField } from './grib2-testutil.js';
import { ROOT, T0, HOUR, rng, makeApi } from './grid-testutil.js';

const mode = process.argv[2] ?? 'baseline';
const fillMode = (api as unknown as { gridFillMode?: { mode: string; lastCandidates: number; lastResolved: number; lastSaturated: boolean } }).gridFillMode;
if (fillMode) fillMode.mode = mode;
const gc = (globalThis as { gc?: () => void }).gc!;
const r2 = (x: number) => Math.round(x * 100) / 100;

// ── Fixture 1: the coastal case from the issue (150×150 @ 0.02°, ~40% land) ──
const land = (lat: number, lon: number) => Math.sin(lon * 2.1) + Math.cos(lat * 1.7) + 0.6 * Math.sin((lat + lon) * 5) > 0.75;
function field(param: number, la1: number, lo1: number, d: number, ni: number, nj: number, h: number): EncodeField {
  const values = new Array<number>(ni * nj);
  for (let j = 0; j < nj; j++)
    for (let i = 0; i < ni; i++) {
      const lat = la1 + j * d;
      const lon = lo1 + i * d;
      values[j * ni + i] = land(lat, lon) ? NaN : param === 2 ? 0.6 * Math.sin(lat * 3 + h / 5) : 0.4 * Math.cos(lon * 3 + h / 7);
    }
  return { param, refTime: T0, forecastHours: h, la1, lo1, dLat: d, dLon: d, ni, nj, values, decScale: 2 };
}
function gribDir(name: string, fields: EncodeField[]): string {
  const dir = path.join(ROOT, `bl-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.grb2`), encodeGrib2File(fields));
  return dir;
}
function utcefDir(name: string, pts: [number, number][]): string {
  const dir = path.join(ROOT, `bl-u-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const features = pts.map(([lat, lon], k) => ({
    type: 'Feature',
    id: `${name}${k}`,
    geometry: { type: 'Point', coordinates: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5] },
    properties: {
      prediction_method: 'harmonic_constituents_currents',
      data_unit_speed: 'knots',
      harmonic_constituents: { M2: { u_amplitude: 1.2, u_phase_g: 30, v_amplitude: 0.6, v_phase_g: 80 } },
    },
  }));
  fs.writeFileSync(path.join(dir, `${name}.utcef`), JSON.stringify({ metadata: { schema_version: '1.0.0' }, dataset: { type: 'FeatureCollection', features } }));
  return dir;
}

const coastGrib = createGribSource(gribDir('coast', [2, 3].flatMap((p) => [0, 6].map((h) => field(p, p === 2 ? 51 : 51, 2, 0.02, 150, 150, h)))), 0);
let landFrac = 0;
for (let j = 0; j < 150; j++) for (let i = 0; i < 150; i++) if (land(51 + j * 0.02, 2 + i * 0.02)) landFrac++;
landFrac /= 150 * 150;
// 100 UTCEF stations on land cells (they win there: GRIB has no value).
const rnd = rng(7);
const landPts: [number, number][] = [];
while (landPts.length < 100) {
  const lat = 51 + rnd() * 2.98;
  const lon = 2 + rnd() * 2.98;
  if (land(lat, lon)) landPts.push([lat, lon]);
}
const coastUtcef = createUtcefSource(utcefDir('coast', landPts), 0);

// ── Fixture 2: large — global 0.25° + regional 0.02° (8°×6°) + 200k UTCEF stations ──
const t0 = performance.now();
const NI = 1440, NJ = 721;
const globalField = (param: number, h: number): EncodeField => {
  const values = new Array<number>(NI * NJ);
  for (let j = 0; j < NJ; j++)
    for (let i = 0; i < NI; i++) {
      const lat = -90 + j * 0.25, lon = i * 0.25;
      values[j * NI + i] = Math.sin(lon / 23) * Math.cos(lat / 17) > 0.55 ? NaN : param === 2 ? 0.6 * Math.sin(lat / 9 + h / 5) : 0.4 * Math.cos(lon / 11 + h / 7);
    }
  return { param, refTime: T0, forecastHours: h, la1: -90, lo1: 0, dLat: 0.25, dLon: 0.25, ni: NI, nj: NJ, values, decScale: 2 };
};
const bigDir = path.join(ROOT, 'bl-big');
fs.mkdirSync(bigDir, { recursive: true });
fs.writeFileSync(path.join(bigDir, 'global.grb2'), encodeGrib2File([2, 3].flatMap((p) => [0, 6, 12].map((h) => globalField(p, h)))));
fs.writeFileSync(path.join(bigDir, 'region.grb2'), encodeGrib2File([2, 3].flatMap((p) => [0, 6, 12].map((h) => field(p, 50, -2, 0.02, 400, 300, h)))));
const big: [number, number][] = [];
const rb = rng(424242);
for (let i = 0; i < 190_000; i++) big.push([35 + rb() * 30, -15 + rb() * 45]);
for (let i = 0; i < 10_000; i++) big.push([51.8 + rb() * 0.3, 3.9 + rb() * 0.4]);
const bigGrib = createGribSource(bigDir, 0);
const bigUtcef = createUtcefSource(utcefDir('big', big), 0);
bigGrib.get();
bigUtcef.get();
console.error(`fixtures ${r2((performance.now() - t0) / 1000)} s`);

const iso = (t: number) => new Date(t).toISOString();
type Pt = { latitude: number; longitude: number; source: string };
const gridCall = (state: ApiState) => {
  const call = makeApi(state);
  return (bbox: string, maxPoints: number, t = T0): Pt[] => call('/grid', { bbox, time: iso(t), maxPoints: String(maxPoints) }).points;
};

const out: Record<string, unknown> = { mode, node: process.version, arch: process.arch, landFrac: r2(landFrac) };

// 1. The issue's case.
{
  const g0 = gridCall({ data: null, error: null, grib: coastGrib, utcef: null, preferGrib: true });
  const g1 = gridCall({ data: null, error: null, grib: coastGrib, utcef: coastUtcef, preferGrib: true });
  const v = '2,51,4.98,53.98';
  const a = g0(v, 400);
  const b = g1(v, 400);
  out.coast = {
    noStations: { grib: a.filter((p) => p.source === 'grib').length, total: a.length },
    with100Stations: { grib: b.filter((p) => p.source === 'grib').length, utcef: b.filter((p) => p.source === 'utcef').length, total: b.length },
  };
}

// 2. Budget utilisation over a zoom/pan sweep on the coastal grid (GRIB only and with stations).
function sweep(g: (bbox: string, mp: number) => Pt[], maxPoints: number) {
  const rs = rng(99);
  let used = 0, n = 0, minU = 1, resolved = 0, cands = 0, lim = 0, limUse = 0, limCand = 0;
  for (let w = 0.25; w <= 4; w *= 1.07) {
    for (let r = 0; r < 4; r++) {
      const west = 2 + rs() * Math.max(0.01, 2.98 - w * 0.5);
      const south = 51 + rs() * Math.max(0.01, 2.98 - w * 0.5);
      const pts = g(`${west},${south},${west + w},${south + w * 0.7}`, maxPoints);
      const u = pts.length / maxPoints;
      used += u;
      minU = Math.min(minU, u);
      n++;
      if (fillMode && !fillMode.lastSaturated && pts.length > 0) {
        lim++;
        limUse += u;
        limCand += Math.min(fillMode.lastResolved, maxPoints) / maxPoints;
      }
      if (fillMode) {
        resolved += fillMode.lastResolved;
        cands += fillMode.lastCandidates;
      }
    }
  }
  return { budgetLimited: lim, budgetLimitedUse: lim ? r2(limUse / lim) : null, budgetLimitedResolvedShare: lim ? r2(limCand / lim) : null, meanUse: r2(used / n), minUse: r2(minU), requests: n, meanResolved: fillMode ? Math.round(resolved / n) : null, meanCandidates: fillMode ? Math.round(cands / n) : null };
}
{
  const g0 = gridCall({ data: null, error: null, grib: coastGrib, utcef: null, preferGrib: true });
  const g1 = gridCall({ data: null, error: null, grib: coastGrib, utcef: coastUtcef, preferGrib: true });
  out.sweep = { grib400: sweep(g0, 400), grib2000: sweep(g0, 2000), stations400: sweep(g1, 400) };
}

// 3. Pan stability: same-size view shifted by 1/4 width; share of lattice points in the overlap kept.
{
  const g0 = gridCall({ data: null, error: null, grib: coastGrib, utcef: null, preferGrib: true });
  const rs = rng(5);
  let kept = 0, inOverlap = 0;
  for (let k = 0; k < 40; k++) {
    const w = 0.5 + rs() * 1.5;
    const west = 2.1 + rs() * 0.8, south = 51.1 + rs() * 0.8;
    const A = g0(`${west},${south},${west + w},${south + w}`, 400);
    const sh = w / 4;
    const B = new Set(g0(`${west + sh},${south},${west + w + sh},${south + w}`, 400).map((p) => `${p.latitude},${p.longitude}`));
    for (const p of A) {
      if (p.longitude < west + sh + 0.05 || p.longitude > west + w - 0.05) continue;
      inOverlap++;
      if (B.has(`${p.latitude},${p.longitude}`)) kept++;
    }
  }
  out.panStability = r2(kept / inOverlap);
}

// 4. Cost on the large fixture.
{
  const g = gridCall({ data: null, error: null, grib: bigGrib, utcef: bigUtcef, preferGrib: true });
  const cases: [string, string, number][] = [
    ['Europe', '-15,35,30,65', 500],
    ['Europe', '-15,35,30,65', 5000],
    ['North Sea', '-2,50,6,56', 2000],
    ['North Sea', '-2,50,6,56', 5000],
    ['Channel', '0,50.2,2.5,51.6', 5000],
    ['harbour', '3.9,51.8,4.3,52.1', 2000],
  ];
  const rows: unknown[] = [];
  for (const [name, bbox, mp] of cases) {
    g(bbox, mp); // warm-up
    const times: number[] = [];
    let alloc = 0, ab = 0, pts = 0, gribPts = 0;
    for (let s = 0; s < 24; s++) {
      gc();
      const m0 = process.memoryUsage();
      const st = performance.now();
      const p = g(bbox, mp, T0 + s * HOUR / 2);
      times.push(performance.now() - st);
      const m1 = process.memoryUsage();
      alloc = Math.max(alloc, m1.heapUsed - m0.heapUsed);
      ab = Math.max(ab, m1.arrayBuffers - m0.arrayBuffers);
      pts = p.length;
      gribPts = p.filter((x) => x.source === 'grib').length;
    }
    times.sort((a, b) => a - b);
    rows.push({
      case: `${name} mp=${mp}`,
      points: pts,
      grib: gribPts,
      resolved: fillMode?.lastResolved ?? null,
      candidates: fillMode?.lastCandidates ?? null,
      medianMs: r2(times[12]),
      maxMs: r2(times[23]),
      peakHeapAllocMB: r2(alloc / 1048576),
      peakArrayBufMB: r2(ab / 1048576),
    });
  }
  out.big = rows;
  gc();
  out.rssAfterMB = r2(process.memoryUsage().rss / 1048576);
}
console.log(JSON.stringify(out, null, 1));
