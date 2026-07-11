// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Dependency-free astronomical engine for tidal harmonic prediction.
 *
 * The legacy OpenCPN/XTide HARMONIC files ship the three astronomical terms a
 * harmonic sum needs — angular speed ω, equilibrium argument V₀ and node
 * factor f — precomputed in per-year tables (see harmonics.ts / predict.ts).
 * The UTCEF format deliberately does NOT: it carries only per-constituent
 * amplitude and Greenwich phase lag and expects the engine to derive ω, V₀,
 * f and u itself "from standard celestial mechanics" (UTCEF spec §5.0). This
 * module is that derivation.
 *
 * Conventions (UTCEF spec §5.0, all normative):
 *   - time base is UTC;
 *   - phase lags g are GREENWICH phase lags;
 *   - constituent speeds and nodal corrections follow the IHO / Schureman
 *     catalog.
 * So V₀ here is the *Greenwich* equilibrium argument and the caller subtracts
 * the Greenwich phase lag g directly.
 *
 * V₀ is evaluated fully at the prediction instant (V₀(t) already contains the
 * fast ω·t variation, since the mean longitudes are essentially linear in
 * time); the spec's "V₀(i) + ωᵢ·t" split is the same quantity. The slow
 * (18.6-year) nodal factor f and phase u are evaluated at the same instant.
 *
 * Node-factor series are the standard Schureman/Foreman cosine expansions in
 * the lunar node N, accurate to ~0.1% — the same ones production tide
 * predictors use.
 */

const DEG2RAD = Math.PI / 180;
const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** J2000.0 = 2000-01-01 12:00 TT, expressed as a UTC epoch (ms). The ~64 s
 *  TT−UTC offset is negligible for tidal argument accuracy. */
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** Day boundary used for the Earth-rotation (mean solar) term. */
const EPOCH_MS = Date.UTC(2000, 0, 1, 0, 0, 0);

export interface AstroArgs {
  /** Earth-rotation term: 15° × total UT hours since a day boundary. */
  T15: number;
  s: number;  // mean longitude of the Moon
  h: number;  // mean longitude of the Sun
  p: number;  // mean longitude of lunar perigee
  N: number;  // longitude of the Moon's ascending node
  p1: number; // mean longitude of solar perigee (perihelion)
}

// Single-entry memo: map/grid renders evaluate thousands of stations at the
// SAME instant, and timeline loops step through repeated instants per station.
// The polynomials are cheap individually but dominate when called 10^5×/request.
let lastArgsTimeMs = NaN;
let lastArgs: AstroArgs | null = null;

/** The five fundamental mean longitudes (deg) plus the rotation term at a UTC time. */
export function astronomicalArgs(timeMs: number): AstroArgs {
  if (timeMs === lastArgsTimeMs && lastArgs) return lastArgs;
  const T = (timeMs - J2000_MS) / 86400000 / 36525; // Julian centuries TT from J2000
  const utHours = (timeMs - EPOCH_MS) / 3600000;

  const s = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + (T * T * T) / 538841;
  const h = 280.4664567 + 36000.76982779 * T + 0.0003032028 * T * T;
  const p = 83.3532465 + 4069.0137287 * T - 0.0103200 * T * T;
  const N = 125.0445479 - 1934.1362891 * T + 0.0020754 * T * T;
  const p1 = 282.9373 + 1.7195366 * T + 0.0004597 * T * T;

  lastArgsTimeMs = timeMs;
  lastArgs = { T15: 15 * utHours, s, h, p, N, p1 };
  return lastArgs;
}

/** Doodson-style linear combination of the fundamental arguments for one constituent. */
interface Combo {
  T15: number;
  s: number;
  h: number;
  p: number;
  p1: number;
  const: number; // additive phase offset (deg), always a multiple of 90
}

/** Which nodal-correction family a constituent belongs to. */
type NodalFamily =
  | 'none' // solar / no nodal modulation (f=1, u=0)
  | 'Mm'
  | 'Mf'
  | 'O1'
  | 'K1'
  | 'J1'
  | 'M2'
  | 'K2'
  | 'M2^n' // Mⁿ overtide of M2 (M3, M4, MN4, M6, M8): f = f(M2)^(T15/2), u = (T15/2)·u(M2)
  | 'M2·K1' // MK3 compound: f = f(M2)·f(K1), u = u(M2) + u(K1)
  | 'M2²·K1' // 2MK3 compound: f = f(M2)²·f(K1), u = 2·u(M2) − u(K1)
  | 'M2⁻¹'; // S2−M2 style compounds (2SM2, MSF): f = f(M2), u = −u(M2)

interface ConstituentDef {
  speed: number; // catalog angular speed, °/hr (for reporting + validation)
  combo: Combo;
  nodal: NodalFamily;
}

const C = (
  speed: number,
  T15: number,
  s: number,
  h: number,
  p: number,
  p1: number,
  konst: number,
  nodal: NodalFamily,
): ConstituentDef => ({ speed, combo: { T15, s, h, p, p1, const: konst }, nodal });

/**
 * Standard IHO/Schureman constituents. Speeds are the canonical catalog
 * values; the V₀ combination is verified against them in the tests (the
 * numeric time-derivative of V₀ must equal `speed`).
 *
 *                        speed        T15  s   h   p  p1  const  nodal
 */
export const CONSTITUENTS: Record<string, ConstituentDef> = {
  // Semidiurnal
  M2:  C(28.9841042, 2, -2,  2,  0,  0,    0, 'M2'),
  S2:  C(30.0000000, 2,  0,  0,  0,  0,    0, 'none'),
  N2:  C(28.4397295, 2, -3,  2,  1,  0,    0, 'M2'),
  K2:  C(30.0821373, 2,  0,  2,  0,  0,    0, 'K2'),
  NU2: C(28.5125831, 2, -3,  4, -1,  0,    0, 'M2'),
  MU2: C(27.9682084, 2, -4,  4,  0,  0,    0, 'M2'),
  '2N2': C(27.8953548, 2, -4,  2,  2,  0,   0, 'M2'),
  L2:  C(29.5284789, 2, -1,  2, -1,  0,  180, 'M2'),
  T2:  C(29.9589333, 2,  0, -1,  0,  1,    0, 'none'),
  R2:  C(30.0410667, 2,  0,  1,  0, -1,  180, 'none'),
  LAMBDA2: C(29.4556253, 2, -1,  0,  1,  0, 180, 'M2'),
  '2SM2': C(31.0158958, 2,  2, -2,  0,  0,   0, 'M2⁻¹'),
  // Diurnal
  K1:  C(15.0410686, 1,  0,  1,  0,  0,   90, 'K1'),
  O1:  C(13.9430356, 1, -2,  1,  0,  0,  -90, 'O1'),
  P1:  C(14.9589314, 1,  0, -1,  0,  0,  -90, 'none'),
  Q1:  C(13.3986609, 1, -3,  1,  1,  0,  -90, 'O1'),
  S1:  C(15.0000000, 1,  0,  0,  0,  0,    0, 'none'),
  J1:  C(15.5854433, 1,  1,  1, -1,  0,   90, 'J1'),
  '2Q1': C(12.8542862, 1, -4,  1,  2,  0, -90, 'O1'),
  RHO1:  C(13.4715145, 1, -3,  3, -1,  0, -90, 'O1'),
  // Long period
  MM:  C(0.5443747, 0,  1,  0, -1,  0,    0, 'Mm'),
  MF:  C(1.0980331, 0,  2,  0,  0,  0,    0, 'Mf'),
  SSA: C(0.0821373, 0,  0,  2,  0,  0,    0, 'none'),
  SA:  C(0.0410686, 0,  0,  1,  0,  0,    0, 'none'),
  MSF: C(1.0158958, 0,  2, -2,  0,  0,    0, 'M2⁻¹'), // S2−M2 compound
  // Shallow-water / overtides
  M3:  C(43.4761563, 3, -3,  3,  0,  0,    0, 'M2^n'),
  MK3: C(44.0251729, 3, -2,  3,  0,  0,   90, 'M2·K1'),
  '2MK3': C(42.9271398, 3, -4,  3,  0,  0, -90, 'M2²·K1'),
  M4:  C(57.9682084, 4, -4,  4,  0,  0,    0, 'M2^n'),
  MS4: C(58.9841042, 4, -2,  2,  0,  0,    0, 'M2'),
  MN4: C(57.4238337, 4, -5,  4,  1,  0,    0, 'M2^n'),
  S4:  C(60.0000000, 4,  0,  0,  0,  0,    0, 'none'),
  M6:  C(86.9523127, 6, -6,  6,  0,  0,    0, 'M2^n'),
  S6:  C(90.0000000, 6,  0,  0,  0,  0,    0, 'none'),
  M8:  C(115.9364166, 8, -8,  8,  0,  0,   0, 'M2^n'),
  // Deliberately absent: M1 and OO1 (the NOS standard set's remaining pair).
  // Their nodal corrections need Schureman's full I/ξ/ν obliquity theory (no
  // reliable short cosine-in-N series), and their amplitudes at NOAA current
  // stations are ~1-3 cm/s — below the error already accepted elsewhere.
};

/** Greenwich equilibrium argument V₀ (deg, 0–360) for a constituent at a UTC time. */
export function equilibriumArg(a: AstroArgs, name: string): number | null {
  const def = CONSTITUENTS[canonical(name)];
  if (!def) return null;
  const c = def.combo;
  return norm360(c.T15 * a.T15 + c.s * a.s + c.h * a.h + c.p * a.p + c.p1 * a.p1 + c.const);
}

// nodeFactors depends only on (constituent, N), and N moves 0.053°/day — so a
// 0.001°-quantized cache stays accurate to ~half a minute of N-motion while a
// 24 h animation over thousands of stations touches only a couple of buckets.
const nodeFactorCache = new Map<string, { f: number; u: number }>();
const NODE_CACHE_MAX = 8192;

/** Node factor f (amplitude scale) and u (phase correction, deg) for a constituent. */
export function nodeFactors(a: AstroArgs, name: string): { f: number; u: number } | null {
  const canon = canonical(name);
  const def = CONSTITUENTS[canon];
  if (!def) return null;
  const key = `${canon}:${Math.round(a.N * 1000)}`;
  const hit = nodeFactorCache.get(key);
  if (hit) return hit;
  const result = computeNodeFactors(def, a);
  if (nodeFactorCache.size >= NODE_CACHE_MAX) nodeFactorCache.clear();
  nodeFactorCache.set(key, result);
  return result;
}

function computeNodeFactors(def: ConstituentDef, a: AstroArgs): { f: number; u: number } {
  const N = a.N * DEG2RAD;
  const cN = Math.cos(N), c2N = Math.cos(2 * N), c3N = Math.cos(3 * N);
  const sN = Math.sin(N), s2N = Math.sin(2 * N), s3N = Math.sin(3 * N);

  switch (def.nodal) {
    case 'none':
      return { f: 1, u: 0 };
    case 'Mm':
      return { f: 1.0 - 0.1300 * cN + 0.0013 * c2N, u: 0 };
    case 'Mf':
      return { f: 1.0429 + 0.4135 * cN - 0.0040 * c2N, u: -23.74 * sN + 2.68 * s2N - 0.38 * s3N };
    case 'O1':
      return {
        f: 1.0089 + 0.1871 * cN - 0.0147 * c2N + 0.0014 * c3N,
        u: 10.80 * sN - 1.34 * s2N + 0.19 * s3N,
      };
    case 'K1':
      return {
        f: 1.0060 + 0.1150 * cN - 0.0088 * c2N + 0.0006 * c3N,
        u: -8.86 * sN + 0.68 * s2N - 0.07 * s3N,
      };
    case 'J1':
      return {
        f: 1.0129 + 0.1676 * cN - 0.0170 * c2N + 0.0016 * c3N,
        u: -12.94 * sN + 1.34 * s2N - 0.19 * s3N,
      };
    case 'M2': {
      return { f: 1.0004 - 0.0373 * cN + 0.0002 * c2N, u: -2.14 * sN };
    }
    case 'K2':
      return {
        f: 1.0241 + 0.2863 * cN + 0.0083 * c2N - 0.0015 * c3N,
        u: -17.74 * sN + 0.68 * s2N - 0.04 * s3N,
      };
    case 'M2^n': {
      const fM2 = 1.0004 - 0.0373 * cN + 0.0002 * c2N;
      const uM2 = -2.14 * sN;
      // M3/M4/MN4/M6/M8 = M2^(T15/2) — power follows the harmonic order
      // (Schureman: f(Mⁿ) = f(M2)^(n/2), u(Mⁿ) = (n/2)·u(M2)).
      const order = def.combo.T15 / 2;
      return { f: Math.pow(fM2, order), u: order * uM2 };
    }
    case 'M2·K1': {
      const fM2 = 1.0004 - 0.0373 * cN + 0.0002 * c2N;
      const uM2 = -2.14 * sN;
      const fK1 = 1.0060 + 0.1150 * cN - 0.0088 * c2N + 0.0006 * c3N;
      const uK1 = -8.86 * sN + 0.68 * s2N - 0.07 * s3N;
      return { f: fM2 * fK1, u: uM2 + uK1 };
    }
    case 'M2²·K1': {
      const fM2 = 1.0004 - 0.0373 * cN + 0.0002 * c2N;
      const uM2 = -2.14 * sN;
      const fK1 = 1.0060 + 0.1150 * cN - 0.0088 * c2N + 0.0006 * c3N;
      const uK1 = -8.86 * sN + 0.68 * s2N - 0.07 * s3N;
      return { f: fM2 * fM2 * fK1, u: 2 * uM2 - uK1 };
    }
    case 'M2⁻¹': {
      // 2SM2 = 2S2−M2, MSF = S2−M2: the M2 term enters negatively.
      return { f: 1.0004 - 0.0373 * cN + 0.0002 * c2N, u: 2.14 * sN };
    }
  }
}

/** Constituent-name normalization: uppercase, strip spaces (e.g. "m2" → "M2"). */
export function canonical(name: string): string {
  return name.toUpperCase().replace(/\s+/g, '');
}

/** Whether the engine knows a constituent (so callers can warn on unknowns). */
export function isKnownConstituent(name: string): boolean {
  return canonical(name) in CONSTITUENTS;
}

/** Catalog angular speed (°/hr) for a constituent, or null if unknown. */
export function constituentSpeed(name: string): number | null {
  const def = CONSTITUENTS[canonical(name)];
  return def ? def.speed : null;
}
