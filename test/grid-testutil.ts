// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared synthetic fixtures for the resolver / /grid / index tests: GRIB dirs
 * (via the independent encoder), UTCEF dirs, a stub router and a seeded RNG.
 * Everything lives under one tmpdir root that is removed on exit.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerRoutes, ApiState } from '../dist/api.js';
import { encodeGrib2File, EncodeField } from './grib2-testutil.js';

export const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);
export const HOUR = 3600_000;
export const gridTime = new Date(T0).toISOString();

export const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-tc-shared-'));
process.on('exit', () => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** A uniform n×n square-grid field. */
export const fld = (
  param: number,
  value: number,
  la1: number,
  lo1: number,
  d: number,
  n: number,
  forecastHours = 0,
  refTime = T0,
): EncodeField => ({ param, refTime, forecastHours, la1, lo1, dLat: d, dLon: d, ni: n, nj: n, values: new Array(n * n).fill(value) });

/** u/v field pair; `u` may be a per-node array (NaN = land). */
export function uvFields(
  la1: number,
  lo1: number,
  d: number,
  n: number,
  opts: { u?: number | number[]; v?: number | number[]; forecastHours?: number; refTime?: number } = {},
): EncodeField[] {
  const mk = (param: number, val: number | number[]): EncodeField => ({
    ...fld(param, 0, la1, lo1, d, n, opts.forecastHours ?? 0, opts.refTime ?? T0),
    values: Array.isArray(val) ? val : new Array(n * n).fill(val),
  });
  return [mk(2, opts.u ?? 1), mk(3, opts.v ?? 0)];
}

export function gribDirOf(files: Record<string, EncodeField[]>): string {
  const dir = fs.mkdtempSync(path.join(ROOT, 'g-'));
  for (const [n, f] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), encodeGrib2File(f));
  return dir;
}

export type UtcefStationSpec = [id: string, lat: number, lon: number, area?: number[][][]];

export function writeUtcefDir(files: Record<string, UtcefStationSpec[]>): string {
  const dir = fs.mkdtempSync(path.join(ROOT, 'u-'));
  for (const [name, stations] of Object.entries(files)) {
    const doc = {
      metadata: { schema_version: '1.0.0' },
      dataset: {
        type: 'FeatureCollection',
        features: stations.map(([id, lat, lon, area]) => ({
          type: 'Feature',
          id,
          geometry: { type: 'Point', coordinates: [lon, lat] },
          properties: {
            ...(area ? { representative_area: { type: 'Polygon', coordinates: area } } : {}),
            prediction_method: 'harmonic_constituents_currents',
            data_unit_speed: 'knots',
            harmonic_constituents: { M2: { u_amplitude: 2, u_phase_g: 0, v_amplitude: 1, v_phase_g: 0 } },
          },
        })),
      },
    };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
  }
  return dir;
}

export function rect(w: number, s: number, e: number, n: number): number[][][] {
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
}

/** Call a registered route handler directly and return its JSON body. */
export function makeApi(state: ApiState) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes = new Map<string, (req: any, res: any) => void>();
  registerRoutes({ get: (p, h) => routes.set(p, h) }, state);
  return (routePath: string, query: Record<string, unknown> = {}) => {
    let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = { status: () => res, json: (b: unknown) => void (body = b) };
    routes.get(routePath)!({ query, params: {} }, res);
    return body;
  };
}

export type P = { latitude: number; longitude: number; source: string; stationId?: string; u: number; v: number; speedKn: number; direction: number };

/** Seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
