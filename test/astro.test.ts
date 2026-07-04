// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  CONSTITUENTS,
  astronomicalArgs,
  canonical,
  constituentSpeed,
  equilibriumArg,
  isKnownConstituent,
  nodeFactors,
} from '../dist/astro.js';

const HOUR_MS = 3600_000;

// The single strongest correctness check available without an external
// reference prediction: the time-derivative of the Greenwich equilibrium
// argument V₀ must equal the constituent's catalog angular speed. This
// validates both the Doodson combination and the mean-longitude rates.
test('V0 time-derivative matches each catalog speed', () => {
  const t0 = Date.UTC(2026, 5, 1, 0, 0, 0);
  const dtH = 0.02;
  for (const name of Object.keys(CONSTITUENTS)) {
    const a0 = astronomicalArgs(t0);
    const a1 = astronomicalArgs(t0 + dtH * HOUR_MS);
    const v0 = equilibriumArg(a0, name)!;
    const v1 = equilibriumArg(a1, name)!;
    // Unwrap the mod-360 difference to the nearest branch.
    let d = v1 - v0;
    d -= 360 * Math.round(d / 360);
    const rate = d / dtH;
    assert.ok(
      Math.abs(rate - constituentSpeed(name)!) < 1e-3,
      `${name}: dV0/dt ${rate.toFixed(6)} vs speed ${constituentSpeed(name)}`,
    );
  }
});

test('fundamental arguments equal the standard J2000.0 mean longitudes', () => {
  // 2000-01-01 12:00 UTC ≈ J2000.0; the polynomials' constant terms should show.
  const a = astronomicalArgs(Date.UTC(2000, 0, 1, 12, 0, 0));
  assert.ok(Math.abs(a.s - 218.3164477) < 1e-4);
  assert.ok(Math.abs(a.h - 280.4664567) < 1e-4);
  assert.ok(Math.abs(a.p - 83.3532465) < 1e-4);
  assert.ok(Math.abs(a.N - 125.0445479) < 1e-4);
  assert.ok(Math.abs(a.T15 - 180) < 1e-6); // 12 UT hours × 15°
});

test('solar constituents have no nodal modulation', () => {
  const a = astronomicalArgs(Date.UTC(2026, 0, 1));
  for (const name of ['S2', 'P1', 'T2', 'S1', 'SSA']) {
    const nf = nodeFactors(a, name)!;
    assert.equal(nf.f, 1, `${name} f`);
    assert.equal(nf.u, 0, `${name} u`);
  }
});

test('node factors stay within physically plausible bounds over a nodal cycle', () => {
  // Sample across the full 18.6-year node cycle.
  const ranges: Record<string, [number, number]> = {
    M2: [0.96, 1.04],
    K1: [0.88, 1.13],
    O1: [0.8, 1.2],
    K2: [0.73, 1.32],
    MF: [0.6, 1.46],
  };
  for (let yr = 2000; yr <= 2020; yr++) {
    const a = astronomicalArgs(Date.UTC(yr, 0, 1));
    for (const [name, [lo, hi]] of Object.entries(ranges)) {
      const f = nodeFactors(a, name)!.f;
      assert.ok(f >= lo && f <= hi, `${name} f=${f.toFixed(4)} out of [${lo},${hi}] at ${yr}`);
    }
  }
});

test('M4 is the M2² shallow-water compound', () => {
  const a = astronomicalArgs(Date.UTC(2026, 3, 15));
  const fM2 = nodeFactors(a, 'M2')!.f;
  const nf4 = nodeFactors(a, 'M4')!;
  assert.ok(Math.abs(nf4.f - fM2 * fM2) < 1e-9);
  assert.ok(Math.abs(nf4.u - 2 * nodeFactors(a, 'M2')!.u) < 1e-9);
});

test('constituent name lookup is case/space-insensitive', () => {
  assert.equal(canonical(' m2 '), 'M2');
  assert.ok(isKnownConstituent('k1'));
  assert.ok(!isKnownConstituent('ZZ9'));
  assert.equal(equilibriumArg(astronomicalArgs(0), 'ZZ9'), null);
  assert.equal(nodeFactors(astronomicalArgs(0), 'ZZ9'), null);
});
