// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Harmonic prediction of tidal currents (and heights) from parsed
 * HARMONIC/HARMONIC.IDX data.
 *
 * Reference stations:
 *   v(t) = datum + Σ_i f_i(year) · A_i · cos( ω_i·t + V₀_i(year) − φ_i )
 * with t in hours since the start of the year at the station's meridian,
 * f = node factor, V₀ = equilibrium argument, φ = station epoch.
 * For current stations the result is the SIGNED speed along the channel
 * axis in knots (+ = flood, − = ebb).
 *
 * Subordinate current stations apply the classic flood/ebb time offsets and
 * multipliers to their reference station and carry their own flood/ebb
 * directions, which is what turns the signed speed into a set/drift vector.
 */

import {
  ConstituentTable,
  findRecord,
  HarmonicsData,
  HarmonicStation,
  IdxStation,
} from './harmonics.js';

export const KNOTS_TO_MS = 0.514444;
const DEG2RAD = Math.PI / 180;

export interface CurrentSample {
  time: string;        // ISO
  speedKn: number;     // signed along-axis speed; + = flood
  direction: number | null; // degrees true (flood/ebb axis), null if unknown
  u: number | null;    // m/s east component, null if direction unknown
  v: number | null;    // m/s north component
}

/** Signed harmonic sum for a reference record at a UTC time. */
export function predictReference(
  station: HarmonicStation,
  tbl: ConstituentTable,
  timeMs: number,
): number {
  // Phases are referenced to the station meridian: evaluate the argument in
  // meridian-local time, relative to the start of that (local) year.
  const local = new Date(timeMs + station.meridianSeconds * 1000);
  const year = local.getUTCFullYear();
  let yearIdx = year - tbl.firstYear;
  if (yearIdx < 0) yearIdx = 0;
  if (yearIdx >= tbl.numYears) yearIdx = tbl.numYears - 1;

  const yearStartMs = Date.UTC(year, 0, 1);
  const hours = (local.getTime() - yearStartMs) / 3600_000;

  let sum = station.datum;
  for (let i = 0; i < tbl.speeds.length; i++) {
    const amp = station.amplitude[i];
    if (amp === 0) continue;
    const arg =
      tbl.speeds[i] * hours + tbl.equilibrium[i][yearIdx] - station.epoch[i];
    sum += tbl.nodeFactor[i][yearIdx] * amp * Math.cos(arg * DEG2RAD);
  }
  return sum;
}

/**
 * Signed current speed (knots) at a station (reference or subordinate).
 * Returns null when the station cannot be resolved to harmonic data.
 */
export function currentSpeedAt(
  data: HarmonicsData,
  station: IdxStation,
  timeMs: number,
): number | null {
  if (!station.isSubordinate) {
    const rec = findRecord(data.records, station.name);
    if (!rec) return null;
    return predictReference(rec, data.constituents, timeMs);
  }
  const off = station.offsets;
  if (!off) return null;
  const rec = findRecord(data.records, off.referenceName);
  if (!rec) return null;

  // Classic subordinate-current approximation: evaluate the reference at the
  // flood- and ebb-shifted times and pick the phase-consistent branch. Near
  // slack both branches disagree; take the one with the smaller magnitude so
  // the transition stays continuous-ish.
  const flood =
    predictReference(rec, data.constituents, timeMs - off.floodOffsetMinutes * 60_000) *
      off.floodMultiplier + off.floodAdd;
  const ebb =
    predictReference(rec, data.constituents, timeMs - off.ebbOffsetMinutes * 60_000) *
      off.ebbMultiplier + off.ebbAdd;
  if (flood > 0 && ebb >= 0) return flood;
  if (ebb < 0 && flood <= 0) return ebb;
  // Disagreement (slack window): choose the weaker signal.
  return Math.abs(flood) < Math.abs(ebb) ? flood : ebb;
}

/** Full set/drift sample; direction requires flood/ebb axes (subordinates). */
export function currentSampleAt(
  data: HarmonicsData,
  station: IdxStation,
  timeMs: number,
): CurrentSample | null {
  const speedKn = currentSpeedAt(data, station, timeMs);
  if (speedKn === null) return null;

  let direction: number | null = null;
  const off = station.offsets;
  if (off && off.floodDir !== null && off.ebbDir !== null) {
    direction = speedKn >= 0 ? off.floodDir : off.ebbDir;
  }
  const drift = Math.abs(speedKn) * KNOTS_TO_MS;
  return {
    time: new Date(timeMs).toISOString(),
    speedKn: Math.round(speedKn * 100) / 100,
    direction,
    u: direction === null ? null : Math.round(drift * Math.sin(direction * DEG2RAD) * 1000) / 1000,
    v: direction === null ? null : Math.round(drift * Math.cos(direction * DEG2RAD) * 1000) / 1000,
  };
}

export function timeline(
  data: HarmonicsData,
  station: IdxStation,
  startMs: number,
  endMs: number,
  stepMs: number,
): CurrentSample[] {
  const out: CurrentSample[] = [];
  for (let t = startMs; t <= endMs; t += stepMs) {
    const s = currentSampleAt(data, station, t);
    if (s) out.push(s);
  }
  return out;
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Nearest current stations to a position, closest first. Only stations that
 * resolve to harmonic data are returned; `vectorCapable` marks those with
 * known flood/ebb directions (usable as set/drift vectors).
 */
export function nearestCurrentStations(
  data: HarmonicsData,
  lat: number,
  lon: number,
  limit: number = 10,
): Array<{ station: IdxStation; distanceKm: number; vectorCapable: boolean }> {
  return data.stations
    .filter((s) => s.isCurrent && currentSpeedAt(data, s, Date.now()) !== null)
    .map((s) => ({
      station: s,
      distanceKm: Math.round(distanceKm(lat, lon, s.latitude, s.longitude) * 100) / 100,
      vectorCapable: !!(s.offsets && s.offsets.floodDir !== null && s.offsets.ebbDir !== null),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
