// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Index parity: the cell-index lookups (UTCEF coverage index, legacy coverage
 * index) must pick exactly the station the straightforward linear algorithms
 * pick — across the antimeridian, near the poles, with large representative
 * areas, equal-distance ties and file filters.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCellIndex } from '../dist/geoindex.js';
import { loadHarmonicsDir } from '../dist/harmonics.js';
import { distanceKm, legacyCoverageIndexFor, lonInSpan, nearestCurrentStations, stationsInBbox } from '../dist/predict.js';
import { parseUtcef, utcefCoverageIndex, utcefSampleAt, utcefStationsInBbox, utcefVectorAt } from '../dist/utcef.js';
import { T0, rng, rect } from './grid-testutil.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const legacyData = loadHarmonicsDir(FIXTURES);

// ── utcefVectorAt: index path vs the old linear algorithm ──

function inRing(ring: number[][], lat: number, lon: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inArea = (area: number[][][], lat: number, lon: number) =>
  inRing(area[0], lat, lon) || inRing(area[0], lat, lon + 360) || inRing(area[0], lat, lon - 360);

function oldLinear(stations: any[], lat: number, lon: number, maxKm: number, files?: ReadonlySet<string>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const st = files ? stations.filter((s) => s.file !== undefined && files.has(s.file)) : stations;
  if (st.length === 0) return null;
  const c = st.find((s) => s.representativeArea && inArea(s.representativeArea, lat, lon));
  if (c) return { station: c, distanceKm: Math.round(distanceKm(lat, lon, c.latitude, c.longitude) * 100) / 100 };
  let near: { station: any; distanceKm: number } | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const s of st) {
    const d = Math.round(distanceKm(lat, lon, s.latitude, s.longitude) * 100) / 100;
    if (!near || d < near.distanceKm) near = { station: s, distanceKm: d };
  }
  if (!near || near.distanceKm > maxKm) return null;
  return near;
}

function syntheticStations(rand: () => number): any[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mk = (i: number, lat: number, lon: number, area?: number[][][]) =>
    out.push({ id: `S${i}`, name: `S${i}`, latitude: lat, longitude: lon, meanU: 0, meanV: 0, constituents: [], file: `f${i % 3}.utcef`, representativeArea: area });
  let i = 0;
  for (let k = 0; k < 150; k++) {
    // Cluster near 10E/45N, a band by the antimeridian, and some cell-edge stations.
    const kind = k % 3;
    const lat = kind === 0 ? 44 + rand() * 3 : kind === 1 ? -20 + rand() * 4 : Math.floor(rand() * 40) * 0.5 - 10;
    const lon = kind === 0 ? 9 + rand() * 3 : kind === 1 ? 178 + rand() * 4 : Math.floor(rand() * 40) * 0.5 + 5;
    const wrapped = lon > 180 ? lon - 360 : lon;
    let area: number[][][] | undefined;
    const r = rand();
    if (r < 0.25) {
      const w = rand() * 1.5 + 0.1;
      area = rect(lon - w, lat - w, lon + w, lat + w); // may run past 180
    } else if (r < 0.32) {
      area = rect(lon - 20, lat - 15, lon + 20, lat + 15); // large (> 64 cells)
    }
    mk(i++, lat, wrapped, area);
  }
  // Exact duplicates for the tie-break, and a pair straddling ±180.
  mk(i++, 45, 10, undefined);
  mk(i++, 45, 10, undefined);
  mk(i++, -20, 179.99, undefined);
  mk(i++, -20, -179.99, undefined);
  return out;
}

test('utcefVectorAt via the coverage index matches the linear algorithm', () => {
  const rand = rng(12345);
  const stations = syntheticStations(rand);
  const data: any = { dir: '', files: ['f0.utcef', 'f1.utcef', 'f2.utcef'], currentStations: stations }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fileSets: Array<ReadonlySet<string> | undefined> = [undefined, new Set(['f0.utcef']), new Set(['f1.utcef', 'f2.utcef'])];
  const maxKms = [0, 1, 5, 50, 200];
  let hits = 0;
  for (let n = 0; n < 6000; n++) {
    const pick = stations[Math.floor(rand() * stations.length)];
    const r = rand();
    // Probe near a station (some exactly on it / on a cell edge), in the antimeridian band, or anywhere.
    let lat = r < 0.4 ? pick.latitude + (rand() - 0.5) * 1.2 : r < 0.5 ? pick.latitude : r < 0.7 ? -20 + (rand() - 0.5) * 8 : rand() * 140 - 70;
    let lon = r < 0.4 ? pick.longitude + (rand() - 0.5) * 1.2 : r < 0.5 ? pick.longitude : r < 0.7 ? 180 + (rand() - 0.5) * 8 : rand() * 360 - 180;
    if (n % 7 === 0) { lat = Math.round(lat * 2) / 2; lon = Math.round(lon * 2) / 2; } // on cell edges
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    const maxKm = maxKms[n % maxKms.length];
    const files = fileSets[n % fileSets.length];
    const want = oldLinear(stations, lat, lon, maxKm, files);
    const got = utcefVectorAt(data, lat, lon, T0, maxKm, files);
    assert.equal(got?.station, want?.station, `probe ${n} (${lat},${lon}) maxKm=${maxKm}`);
    if (want) {
      hits++;
      assert.equal(got!.distanceKm, want.distanceKm);
      assert.deepEqual(got!.sample, utcefSampleAt(want.station, T0));
    }
  }
  assert.ok(hits > 1000, `only ${hits} non-null probes — test too weak`);
  // Infinity keeps the linear scan and agrees too.
  const inf = utcefVectorAt(data, 10, 100, T0, Infinity);
  assert.equal(inf?.station, oldLinear(stations, 10, 100, Infinity)?.station);
});

test('large representative_area polygons: array-order containment across big and small areas', () => {
  const mk = (id: string, lat: number, lon: number, area: number[][][], file = 'a.utcef') =>
    ({ id, name: id, latitude: lat, longitude: lon, meanU: 0, meanV: 0, constituents: [], file, representativeArea: area }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const big = rect(-30, 20, 30, 70); // 120 x 100 cells at 0.5°: well past the fan-out cap
  const small = rect(9, 44, 11, 46);
  const L = mk('L', 60, 0, big);
  const S = mk('S', 45, 10, small);
  const probe = (list: any[], lat: number, lon: number, files?: ReadonlySet<string>) => // eslint-disable-line @typescript-eslint/no-explicit-any
    utcefCoverageIndex(list).stationAt(lat, lon, 0, files)?.id ?? null;
  assert.equal(probe([L, S], 45, 10), 'L'); // both contain; L is earlier
  assert.equal(probe([S, L], 45, 10), 'S'); // small earlier now
  assert.equal(probe([S, L], 60, 5), 'L'); // only the big one contains
  assert.equal(probe([L, S], 10, 100), null);
  assert.equal(probe([L, S], 45, 10, new Set(['zzz'])), null);
  const S2 = mk('S2', 45, 10, small, 'b.utcef');
  assert.equal(probe([L, S2], 45, 10, new Set(['b.utcef'])), 'S2'); // files filter skips L
  // Big polygon written past the antimeridian, probed from the −180..180 side.
  const wrapBig = mk('W', 0, 180, rect(150, -30, 210, 30));
  assert.equal(probe([wrapBig], 0, -170), 'W');
  assert.equal(probe([wrapBig], 0, 170), 'W');
  assert.equal(probe([wrapBig], 0, 100), null);
  // Same through utcefVectorAt.
  const data: any = { dir: '', files: ['a.utcef'], currentStations: [S, L] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(utcefVectorAt(data, 45, 10, T0, 50)?.station.id, 'S');
  assert.equal(utcefVectorAt(data, 60, 5, T0, 50)?.station.id, 'L');
});


function polarStation(id: string, lat: number, lon: number) {
  return { id, name: id, latitude: lat, longitude: lon, meanU: 0, meanV: 0, constituents: [], file: 'a.utcef' } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

test('coverage index finds a station across the pole (north and south)', () => {
  for (const sign of [1, -1]) {
    const list = [polarStation('P', sign * 89.9, 150)];
    const idx = utcefCoverageIndex(list);
    const d = distanceKm(sign * 89.8, 0, sign * 89.9, 150);
    assert.ok(d < 50);
    assert.equal(idx.stationAt(sign * 89.8, 0, 50)?.id, 'P');
    assert.equal(idx.stationAt(sign * 89.8, 0, d - 1), null);
  }
});

test('coverage index with a large maxKm matches the linear scan', () => {
  const list: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let k = 0; k < 40; k++) list.push(polarStation('S' + k, 55 + ((k * 7) % 10), -20 + ((k * 13) % 60)));
  const idx = utcefCoverageIndex(list);
  const data = { currentStations: list } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [lat, lon] of [[60, 0], [58.3, 12.7], [64, -15], [10, 100]]) {
    for (const maxKm of [300, 2000, 5000]) {
      const lin = utcefVectorAt(data, lat, lon, T0, Infinity);
      const want = lin && lin.distanceKm <= maxKm ? lin.station.id : null;
      assert.equal(idx.stationAt(lat, lon, maxKm)?.id ?? null, want, `${lat},${lon} @${maxKm}`);
    }
  }
});


test('legacyCoverageIndexFor.stationAt matches stationVectorAt\'s selection (top-10 then capable)', () => {
  const rand = rng(12345);
  const ref = legacyData.stations.find((s) => s.isCurrent && !s.isSubordinate)!;
  const sub = legacyData.stations.find((s) => s.isCurrent && s.offsets && s.offsets.floodDir !== null)!;
  const mk = (i: number, lat: number, lon: number, capable: boolean) => ({
    ...(capable ? sub : ref), id: `S${i}`, latitude: lat, longitude: lon,
  });
  const stations: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  // dense cluster of non-capable stations around (53,5) hides capable ones; plus global scatter
  for (let i = 0; i < 40; i++) stations.push(mk(i, 53 + Math.round((rand() - 0.5) * 20) / 100, 5 + Math.round((rand() - 0.5) * 20) / 100, false));
  for (let i = 40; i < 80; i++) stations.push(mk(i, 53 + (rand() - 0.5) * 3, 5 + (rand() - 0.5) * 3, rand() < 0.5));
  for (let i = 80; i < 200; i++) stations.push(mk(i, (rand() - 0.5) * 180, (rand() - 0.5) * 360, rand() < 0.5));
  for (let i = 200; i < 230; i++) stations.push(mk(i, 89 + rand(), (rand() - 0.5) * 360, rand() < 0.5));
  for (let i = 230; i < 260; i++) stations.push(mk(i, (rand() - 0.5) * 20, 179.5 + rand() * 1 - (rand() < 0.5 ? 0 : 360) , rand() < 0.5));
  const data = { ...legacyData, stations };
  const idx = legacyCoverageIndexFor(data);
  assert.equal(legacyCoverageIndexFor(data), idx);
  let found = 0;
  for (let n = 0; n < 600; n++) {
    const k = n % 4;
    const lat = k === 0 ? 53 + (rand() - 0.5) * 2 : k === 1 ? 89 + rand() : k === 2 ? (rand() - 0.5) * 20 : (rand() - 0.5) * 170;
    const lon = k === 0 ? 5 + (rand() - 0.5) * 2 : k === 2 ? 179 + rand() * 2 : (rand() - 0.5) * 360;
    for (const maxKm of [5, 50, 300, 5000, Infinity]) {
      const expected = nearestCurrentStations(data, lat, lon, 10).filter((x) => x.vectorCapable && x.distanceKm <= maxKm)[0]?.station ?? null;
      const got = idx.stationAt(lat, lon, maxKm);
      assert.equal(got, expected, `probe ${lat},${lon} maxKm=${maxKm}`);
      if (got) found++;
    }
  }
  assert.ok(found > 100);
});


test('coverage index matches the linear scan close to the pole', () => {
  const rand = rng(7);
  const list: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let k = 0; k < 60; k++) list.push(polarStation('P' + k, 88.5 + rand() * 1.49, -180 + rand() * 360));
  const idx = utcefCoverageIndex(list);
  const data = { currentStations: list } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let n = 0; n < 40; n++) {
    const lat = 89.5 + rand() * 0.45;
    const lon = -180 + rand() * 360;
    for (const maxKm of [1, 5, 10, 20]) {
      const lin = utcefVectorAt(data, lat, lon, T0, Infinity);
      const want = lin && lin.distanceKm <= maxKm ? lin.station.id : null;
      assert.equal(idx.stationAt(lat, lon, maxKm)?.id ?? null, want, `${lat},${lon} @${maxKm}`);
    }
  }
});


test('inBbox gathers exactly the linear filter, in array order (antimeridian, wide and polar boxes)', () => {
  const rand = rng(31337);
  const list: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let k = 0; k < 400; k++) {
    list.push(polarStation('S' + k, k % 5 === 0 ? 85 + rand() * 5 : (rand() - 0.5) * 170, k % 3 === 0 ? 170 + rand() * 20 - (rand() < 0.5 ? 0 : 360) : (rand() - 0.5) * 360));
  }
  const data = { currentStations: list } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const boxes: Array<[number, number, number, number]> = [
    [170, -10, 190, 10], [-10, -10, 10, 10], [-180, -90, 180, 90], [-540, -20, 540, 20], [175, 80, 185, 90], [100, 30, 130, 60], [-200, -5, -160, 5],
  ];
  for (let n = 0; n < 40; n++) {
    const w = (rand() - 0.5) * 400;
    boxes.push([w, (rand() - 0.5) * 150, w + rand() * 60, 0]);
    boxes[boxes.length - 1][3] = boxes[boxes.length - 1][1] + rand() * 30;
  }
  let nonEmpty = 0;
  for (const [w, s, e, n] of boxes) {
    const want = list.filter((st) => st.latitude >= s && st.latitude <= n && lonInSpan(st.longitude, w, e));
    const got = utcefStationsInBbox(data, { west: w, south: s, east: e, north: n });
    assert.deepEqual(got.map((x: any) => x.id), want.map((x) => x.id), `box ${w},${s},${e},${n}`); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (want.length) nonEmpty++;
  }
  assert.ok(nonEmpty > 15);
  // Legacy: stationsInBbox equals the linear current+resolvable filter.
  const idx = legacyCoverageIndexFor(legacyData);
  const lin = legacyData.stations.filter((s) => s.isCurrent && idx.index.items.includes(s));
  const all = stationsInBbox(legacyData, -180, -90, 180, 90, 1000).map((x) => x.station);
  assert.deepEqual(all, lin);
  assert.deepEqual(stationsInBbox(legacyData, 5.15, 53.15, 5.25, 53.25, 10).map((x) => x.station.name), ['Test Sub, Courants']);
});

test('createCellIndex: nearestWithin breaks equal-distance ties by array rank and honours the accept filter', () => {
  const items = [
    { id: 'a', lat: 10.001, lon: 20 },
    { id: 'b', lat: 10.001, lon: 20 }, // exact duplicate of a
    { id: 'c', lat: 10.0005, lon: 20 },
    { id: 'far', lat: 40, lon: 100 },
  ];
  const idx = createCellIndex(items, (i) => i.lat, (i) => i.lon);
  assert.equal(idx.nearestWithin(10, 20, 5)?.id, 'c');
  assert.equal(idx.nearestWithin(10, 20, 5, (i) => i.id !== 'c')?.id, 'a'); // a before b on the tie
  assert.equal(idx.nearestWithin(10, 20, 0.01), null);
  assert.equal(idx.nearestWithin(10, 20, Infinity, (i) => i.id === 'far')?.id, 'far');
  const seen: string[] = [];
  idx.within(10, 20, 1, (i) => seen.push(i.id));
  assert.deepEqual(seen.sort(), ['a', 'b', 'c']);
});

test('a representative_area ring that encircles a pole is rejected with a warning (station kept, nearest lookup applies)', () => {
  const doc = (ring: number[][]) => JSON.stringify({
    metadata: { schema_version: '1.0.0' },
    dataset: { features: [{
      type: 'Feature', id: 'P', geometry: { type: 'Point', coordinates: [10, 88] },
      properties: {
        prediction_method: 'harmonic_constituents_currents',
        representative_area: { type: 'Polygon', coordinates: [ring] },
        harmonic_constituents: { M2: { u_amplitude: 1, u_phase_g: 0, v_amplitude: 1, v_phase_g: 0 } },
      },
    }] },
  });
  // Around the pole: longitudes sweep the full circle at lat 85.
  const polar = [[-180, 85], [-90, 85], [0, 85], [90, 85], [179.999, 85], [-180, 85]];
  const warnings: string[] = [];
  const parsed = parseUtcef(doc(polar), 'p.utcef', warnings);
  assert.equal(parsed.currentStations.length, 1);
  assert.equal(parsed.currentStations[0].representativeArea, undefined);
  assert.equal(parsed.currentStations[0].areaBounds, null);
  assert.ok(warnings.some((w) => /pole/.test(w)), warnings.join('|'));
  // An ordinary antimeridian-crossing ring is still accepted and unwrapped.
  const ok = parseUtcef(doc([[179, 10], [-179, 10], [-179, 12], [179, 12], [179, 10]]), 'p.utcef', []);
  const b = ok.currentStations[0].areaBounds!;
  assert.ok(b.east > 180 && b.west === 179);
});
