// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { parseGrib2, sampleGrid, Grib2Grid } from '../dist/grib2.js';
import {
  BitWriter,
  encodeGrib2File,
  encodeGrib2Message,
  makeSection1,
  makeSection3,
  makeSection4,
  section,
  wrapMessage,
} from './grib2-testutil.js';

const T0 = Date.UTC(2026, 0, 10, 0, 0, 0);

test('simple packing round trip: metadata, grid and values', () => {
  // 3x2 grid, scan 0x40 (west→east, south→north) — already normalized order.
  const values = [0.1, 0.2, 0.3, 0.4, 0.5, -0.6];
  const msg = encodeGrib2Message({
    param: 2,
    refTime: T0,
    forecastHours: 6,
    la1: 53.0,
    lo1: 5.0,
    dLat: 0.5,
    dLon: 0.25,
    ni: 3,
    nj: 2,
    values,
  });
  const { fields, skipped } = parseGrib2(msg);
  assert.deepEqual(skipped, []);
  assert.equal(fields.length, 1);
  const f = fields[0];
  assert.equal(f.discipline, 10);
  assert.equal(f.paramCategory, 1);
  assert.equal(f.paramNumber, 2);
  assert.equal(f.refTime, T0);
  assert.equal(f.validTime, T0 + 6 * 3600_000);
  assert.equal(f.surfaceType, 1);
  assert.equal(f.grid.ni, 3);
  assert.equal(f.grid.nj, 2);
  assert.ok(Math.abs(f.grid.lat0 - 53.0) < 1e-9);
  assert.ok(Math.abs(f.grid.lon0 - 5.0) < 1e-9);
  assert.ok(Math.abs(f.grid.di - 0.25) < 1e-9);
  assert.ok(Math.abs(f.grid.dj - 0.5) < 1e-9);
  for (let i = 0; i < values.length; i++) {
    assert.ok(Math.abs(f.values[i] - values[i]) < 1e-3, `value[${i}]`);
  }
});

test('scan mode 0x00 (north→south) is normalized to south→north order', () => {
  // Same logical field encoded twice with different scan modes.
  const south = [1, 2, 3, 4]; // 2x2 normalized: row j=0 = southern
  const msgNorm = encodeGrib2Message({
    param: 3, refTime: T0, forecastHours: 0,
    la1: 53.0, lo1: 5.0, dLat: 0.1, dLon: 0.1, ni: 2, nj: 2,
    scan: 0x40, values: south,
  });
  const msgNS = encodeGrib2Message({
    param: 3, refTime: T0, forecastHours: 0,
    la1: 53.1, lo1: 5.0, dLat: 0.1, dLon: 0.1, ni: 2, nj: 2,
    scan: 0x00, values: [3, 4, 1, 2], // northern row first
  });
  const a = parseGrib2(msgNorm).fields[0];
  const b = parseGrib2(msgNS).fields[0];
  assert.ok(Math.abs(b.grid.lat0 - 53.0) < 1e-9); // southernmost row
  assert.deepEqual(Array.from(a.values), Array.from(b.values));
});

test('bitmap: NaN input points decode as NaN', () => {
  const values = [1.5, NaN, 2.5, NaN];
  const msg = encodeGrib2Message({
    param: 2, refTime: T0, forecastHours: 0,
    la1: 53.0, lo1: 5.0, dLat: 0.1, dLon: 0.1, ni: 2, nj: 2,
    values,
  });
  const f = parseGrib2(msg).fields[0];
  assert.ok(Math.abs(f.values[0] - 1.5) < 1e-3);
  assert.ok(Number.isNaN(f.values[1]));
  assert.ok(Math.abs(f.values[2] - 2.5) < 1e-3);
  assert.ok(Number.isNaN(f.values[3]));
});

test('multi-message files parse every message', () => {
  const file = encodeGrib2File([
    { param: 2, refTime: T0, forecastHours: 0, la1: 53, lo1: 5, dLat: 0.1, dLon: 0.1, ni: 2, nj: 2, values: [1, 1, 1, 1] },
    { param: 3, refTime: T0, forecastHours: 0, la1: 53, lo1: 5, dLat: 0.1, dLon: 0.1, ni: 2, nj: 2, values: [2, 2, 2, 2] },
  ]);
  const { fields } = parseGrib2(file);
  assert.equal(fields.length, 2);
  assert.equal(fields[0].paramNumber, 2);
  assert.equal(fields[1].paramNumber, 3);
});

test('template 5.40 is accepted and invalid JPEG2000 data is skipped', () => {
  const msg = wrapMessage([
    makeSection1(T0),
    makeSection3(2, 2, 53, 5, 0.1, 0.1),
    makeSection4(1, 2, 0),
    section(5, (w) => {
      w.u32(4).u16(40); // template 5.40 JPEG2000
      w.raw(new Uint8Array(12));
    }),
    section(6, (w) => w.u8(255)),
    section(7, (w) => w.raw(new Uint8Array(4))),
  ]);
  const { fields, skipped } = parseGrib2(msg);
  assert.equal(fields.length, 0);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].includes('JPX') || skipped[0].includes('JPEG'), skipped[0]);
});

// ── complex packing (templates 5.2 / 5.3) ──────────────────────────────

/** Section 5 for complex packing with R=0, E=0, D=0. */
function sect5Complex(opts: {
  template: 2 | 3;
  numDataPoints: number;
  nbits: number;
  missingMgmt?: number;
  numGroups: number;
  refGroupWidths?: number;
  bitsGroupWidths?: number;
  refGroupLengths?: number;
  lengthIncrement?: number;
  lastGroupLength: number;
  bitsScaledLengths?: number;
  sdOrder?: number;
  sdExtraOctets?: number;
}): Uint8Array {
  return section(5, (w) => {
    w.u32(opts.numDataPoints).u16(opts.template);
    w.f32(0).s16sm(0).s16sm(0).u8(opts.nbits).u8(0); // R, E, D, nbits, field type
    w.u8(1); // group splitting method: general
    w.u8(opts.missingMgmt ?? 0);
    w.u32(0).u32(0); // primary/secondary missing value substitutes
    w.u32(opts.numGroups);
    w.u8(opts.refGroupWidths ?? 0);
    w.u8(opts.bitsGroupWidths ?? 8);
    w.u32(opts.refGroupLengths ?? 0);
    w.u8(opts.lengthIncrement ?? 1);
    w.u32(opts.lastGroupLength);
    w.u8(opts.bitsScaledLengths ?? 8);
    if (opts.template === 3) {
      w.u8(opts.sdOrder ?? 2).u8(opts.sdExtraOctets ?? 1);
    }
  });
}

function complexMessage(ni: number, nj: number, s5: Uint8Array, s7data: Uint8Array): Uint8Array {
  return wrapMessage([
    makeSection1(T0),
    makeSection3(ni, nj, 53, 5, 0.1, 0.1),
    makeSection4(1, 2, 0),
    s5,
    section(6, (w) => w.u8(255)),
    section(7, (w) => w.raw(s7data)),
  ]);
}

test('complex packing (5.2): two groups incl. constant group', () => {
  // Groups: [ref=1, width=2, len=2] over raw [0,3] → X=[1,4];
  //         [ref=10, width=0, len=2]              → X=[10,10]
  const bw = new BitWriter();
  bw.write(1, 4).write(10, 4).align(); // group references (nbits=4)
  bw.write(2, 8).write(0, 8).align(); // group widths
  bw.write(0, 8).write(0, 8).align(); // scaled group lengths (last overridden)
  bw.write(0, 2).write(3, 2); // group 1 packed values
  const msg = complexMessage(
    2, 2,
    sect5Complex({ template: 2, numDataPoints: 4, nbits: 4, numGroups: 2, refGroupLengths: 2, lastGroupLength: 2 }),
    bw.toUint8Array(),
  );
  const { fields, skipped } = parseGrib2(msg);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Array.from(fields[0].values), [1, 4, 10, 10]);
});

test('complex packing (5.2): primary missing value management', () => {
  // One group: ref=5, width=2, len=4, raw [0,3,1,2]; 3 (all ones) = missing.
  const bw = new BitWriter();
  bw.write(5, 4).align(); // reference
  bw.write(2, 8).align(); // width
  bw.write(0, 8).align(); // scaled length (last group → 4)
  bw.write(0, 2).write(3, 2).write(1, 2).write(2, 2);
  const msg = complexMessage(
    2, 2,
    sect5Complex({ template: 2, numDataPoints: 4, nbits: 4, missingMgmt: 1, numGroups: 1, lastGroupLength: 4 }),
    bw.toUint8Array(),
  );
  const vals = parseGrib2(msg).fields[0].values;
  assert.equal(vals[0], 5);
  assert.ok(Number.isNaN(vals[1]));
  assert.equal(vals[2], 6);
  assert.equal(vals[3], 7);
});

test('complex packing with spatial differencing (5.3, order 1)', () => {
  // Target X = [3,5,8]: diffs [2,3], minsd=2, stored diffs−min = [_,0,1].
  const bw = new BitWriter();
  bw.write(0x03, 8); // first value (sign-magnitude, 1 octet)
  bw.write(0x02, 8); // overall minimum of differences
  // nbits=0 → no group references
  bw.align();
  bw.write(1, 8).align(); // group width = 1
  bw.write(0, 8).align(); // scaled length (last group → 3)
  bw.write(0, 1).write(0, 1).write(1, 1);
  const msg = complexMessage(
    3, 1,
    sect5Complex({ template: 3, numDataPoints: 3, nbits: 0, numGroups: 1, lastGroupLength: 3, sdOrder: 1 }),
    bw.toUint8Array(),
  );
  const { fields, skipped } = parseGrib2(msg);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Array.from(fields[0].values), [3, 5, 8]);
});

test('complex packing with spatial differencing (5.3, order 2)', () => {
  // Target X = [5,7,10,14]: 2nd diffs [1,1], minsd=1, stored = all 0
  // (single constant group, width 0, ref 0).
  const bw = new BitWriter();
  bw.write(0x05, 8).write(0x07, 8); // first two values
  bw.write(0x01, 8); // minsd
  bw.align();
  bw.write(0, 8).align(); // group width = 0
  bw.write(0, 8).align(); // scaled length (last group → 4)
  const msg = complexMessage(
    4, 1,
    sect5Complex({ template: 3, numDataPoints: 4, nbits: 0, numGroups: 1, lastGroupLength: 4, sdOrder: 2 }),
    bw.toUint8Array(),
  );
  const { fields, skipped } = parseGrib2(msg);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Array.from(fields[0].values), [5, 7, 10, 14]);
});

// ── grid sampling ──────────────────────────────────────────────────────

const grid: Grib2Grid = { ni: 3, nj: 3, lat0: 53, lon0: 5, di: 0.1, dj: 0.1, globalLon: false };
const gridValues = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]); // j*3+i

test('sampleGrid: exact points and bilinear midpoints', () => {
  assert.equal(sampleGrid(grid, gridValues, 53.0, 5.0), 0);
  assert.ok(Math.abs(sampleGrid(grid, gridValues, 53.2, 5.2)! - 8) < 1e-9);
  const mid = sampleGrid(grid, gridValues, 53.05, 5.05);
  assert.ok(Math.abs(mid! - 2) < 1e-9); // avg of 0,1,3,4
});

test('sampleGrid: outside the grid → null', () => {
  assert.equal(sampleGrid(grid, gridValues, 52.5, 5.0), null);
  assert.equal(sampleGrid(grid, gridValues, 53.0, 4.5), null);
  assert.equal(sampleGrid(grid, gridValues, 53.5, 5.0), null);
});

test('sampleGrid: NaN corners are dropped and weights renormalized', () => {
  const vals = Float64Array.from(gridValues);
  vals[0] = NaN; // SW corner of the first cell
  const v = sampleGrid(grid, vals, 53.05, 5.05);
  assert.ok(Math.abs(v! - (1 + 3 + 4) / 3) < 1e-9);
  // all four corners missing → null
  vals[1] = vals[3] = vals[4] = NaN;
  assert.equal(sampleGrid(grid, vals, 53.05, 5.05), null);
});

// ── JPEG2000 / template 5.40 integration with a real BSH file ──────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const BSH_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bsh_nowcast.grb2',
);

test('real BSH GRIB2 file with JPEG2000 (template 5.40) decodes to sensible values', { skip: !fs.existsSync(BSH_FIXTURE) ? 'fixture file not present — download from BSH FTP' : false }, () => {
  const buf = fs.readFileSync(BSH_FIXTURE);
  const { fields, skipped } = parseGrib2(buf);
  assert.deepEqual(skipped, []);
  assert.ok(fields.length > 0);
  // Should have u/v component pairs at multiple forecast hours.
  const uFields = fields.filter((f) => f.paramNumber === 2);
  const vFields = fields.filter((f) => f.paramNumber === 3);
  assert.ok(uFields.length > 0);
  assert.equal(uFields.length, vFields.length);
  // Verify grid metadata.
  const f = fields[0];
  assert.equal(f.paramCategory, 1);
  assert.ok(f.grid.ni > 10 && f.grid.nj > 10);
  // Verify decoded values are in a plausible range (m/s).
  const nonNaN = f.values.filter((v) => !Number.isNaN(v));
  assert.ok(nonNaN.length > 0);
  for (const v of nonNaN) {
    assert.ok(v > -10 && v < 10, `velocity ${v} out of plausible range`);
  }
});
