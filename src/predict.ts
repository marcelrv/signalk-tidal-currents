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
  findStationHarmonics,
  HarmonicsData,
  HarmonicStation,
  IdxStation,
} from './harmonics.js';

export const KNOTS_TO_MS = 0.514444;
const DEG2RAD = Math.PI / 180;

// Warn at most once per out-of-range year so a busy timeline/publish loop
// doesn't spam the log.
const warnedOutOfRangeYears = new Set<number>();

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
  if (yearIdx < 0 || yearIdx >= tbl.numYears) {
    if (!warnedOutOfRangeYears.has(year)) {
      warnedOutOfRangeYears.add(year);
      console.warn(
        `[signalk-tidal-currents] ${year} is outside the harmonics data range ` +
          `(${tbl.firstYear}-${tbl.firstYear + tbl.numYears - 1}); predictions will use the nearest available year's constants.`,
      );
    }
    yearIdx = yearIdx < 0 ? 0 : tbl.numYears - 1;
  }

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
    const rec = findStationHarmonics(data.records, station.name);
    if (!rec) return null;
    return predictReference(rec, data.constituents, timeMs);
  }
  const off = station.offsets;
  if (!off) return null;
  const rec = findStationHarmonics(data.records, off.referenceName);
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
  return 2 * R * Math.asin(Math.sqrt(Math.min(1, a)));
}

// Resolvability memo: whether a station's (or its reference's) harmonic
// record exists is a pure function of the loaded dataset, so cache it per
// station object instead of re-running a FULL harmonic prediction per station
// per request (the old test cost S×C cos() evaluations on every /stations,
// /timeline and delta tick — the dominant API cost).
const resolvableCache = new WeakMap<IdxStation, boolean>();

export function isStationResolvable(data: HarmonicsData, station: IdxStation): boolean {
  const hit = resolvableCache.get(station);
  if (hit !== undefined) return hit;
  const name = station.isSubordinate ? station.offsets?.referenceName : station.name;
  const ok = name !== undefined && findStationHarmonics(data.records, name) !== undefined;
  resolvableCache.set(station, ok);
  return ok;
}

/** True for a station with known flood AND ebb directions — usable as a set/drift vector. */
export function isVectorCapable(s: IdxStation): boolean {
  return !!(s.offsets && s.offsets.floodDir !== null && s.offsets.ebbDir !== null);
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
    .filter((s) => s.isCurrent && isStationResolvable(data, s))
    .map((s) => ({
      station: s,
      distanceKm: Math.round(distanceKm(lat, lon, s.latitude, s.longitude) * 100) / 100,
      vectorCapable: isVectorCapable(s),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/**
 * True when the longitude spans [w1, e1] and [w2, e2] overlap modulo 360 —
 * map clients (Freeboard) send viewports past ±180 (e.g. 170…190 across the
 * antimeridian) while stations are stored in −180…180.
 */
export function lonSpansOverlap(w1: number, e1: number, w2: number, e2: number): boolean {
  const k = Math.ceil((w2 - e1) / 360);
  return w1 + 360 * k <= e2;
}

/** True when `lon` (any range) falls inside [west, east] modulo 360. */
export function lonInSpan(lon: number, west: number, east: number): boolean {
  return lonSpansOverlap(lon, lon, west, east);
}

/**
 * All current stations inside a lat/lon bounding box (no distance sort or
 * nearest-N cutoff — the point is to cover every station a map viewport can
 * see, not just the closest handful to one reference point). `limit` is
 * still applied as a safety cap on the response size.
 */
export function stationsInBbox(
  data: HarmonicsData,
  west: number,
  south: number,
  east: number,
  north: number,
  limit: number = 500,
): Array<{ station: IdxStation; vectorCapable: boolean }> {
  const result: Array<{ station: IdxStation; vectorCapable: boolean }> = [];
  for (const s of data.stations) {
    if (!s.isCurrent) continue;
    if (s.latitude < south || s.latitude > north || !lonInSpan(s.longitude, west, east)) continue;
    if (!isStationResolvable(data, s)) continue;
    result.push({
      station: s,
      vectorCapable: isVectorCapable(s),
    });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Exact angular longitude half-width (degrees, slightly padded) of a circle of
 * angular radius `dLatDeg` centred at `lat`: asin(sin d / cos(|lat|+d)).
 * Returns 360 when the circle reaches a pole (all longitudes).
 */
export function lonHalfWidthDeg(lat: number, dLatDeg: number): number {
  const cosP = Math.cos((Math.abs(lat) + dLatDeg) * DEG2RAD);
  const ratio = cosP > 0 ? Math.sin(dLatDeg * DEG2RAD) / cosP : 2;
  if (Math.abs(lat) + dLatDeg >= 90 || ratio >= 1) return 360;
  return (Math.asin(ratio) / DEG2RAD) * 1.01 + 1e-6;
}

/**
 * Spatial index over a dataset's current + resolvable legacy stations (same
 * cell scheme as utcefCoverageIndex: 0.5° cells, antimeridian-wrapped keys).
 * `stationAt` returns EXACTLY the station api.ts `stationVectorAt` picks:
 * nearestCurrentStations(…, 10) filtered by `vectorCapable && distanceKm <=
 * maxKm`, first element.
 *
 * Why only stations within maxKm matter: that result is the first capable
 * station among the 10 nearest, restricted to d <= maxKm. Sorted by rounded
 * distance, every station with d <= maxKm precedes every station beyond it,
 * so the top-10 restricted to d <= maxKm is just the first 10 of the
 * within-maxKm stations. Stations beyond maxKm can occupy top-10 slots only
 * after all within-range ones, so they never block a capable one. Hence we
 * gather all stations within maxKm (padded box + exact rounded-distance test),
 * sort by (distance, array order — the stable-sort tie-break), keep 10, then
 * take the first vector-capable one.
 */
export function legacyCoverageIndex(data: HarmonicsData, cellDeg = 0.5) {
  const stations = data.stations.filter((s) => s.isCurrent && isStationResolvable(data, s));
  const capable = isVectorCapable;
  const rank = new Map<IdxStation, number>();
  stations.forEach((s, i) => rank.set(s, i));
  const nLon = Math.round(360 / cellDeg);
  const key = (j: number, i: number) => `${j}:${((i % nLon) + nLon) % nLon}`;
  const cells = new Map<string, IdxStation[]>();
  for (const s of stations) {
    const k = key(Math.floor(s.latitude / cellDeg), Math.floor(s.longitude / cellDeg));
    const l = cells.get(k);
    if (l) l.push(s);
    else cells.set(k, [s]);
  }
  const capableStations = stations.filter(capable);
  return {
    /** The vector-capable indexed stations (computed once per dataset). */
    capable: capableStations,
    /** True when at least one indexed station is vector-capable (computed once per dataset). */
    hasVectorCapable: capableStations.length > 0,
    stationAt(lat: number, lon: number, maxKm: number): IdxStation | null {
      const cand: Array<{ s: IdxStation; d: number }> = [];
      const consider = (s: IdxStation) => {
        const d = Math.round(distanceKm(lat, lon, s.latitude, s.longitude) * 100) / 100;
        if (d <= maxKm) cand.push({ s, d });
      };
      let linear = !Number.isFinite(maxKm);
      if (!linear) {
        const dLat = maxKm / 110;
        // Exact angular half-width of a radius-d circle: asin(sin d / cos(lat))
        // (the small-angle d/cos(lat) under-covers close to a pole).
        const dLon = lonHalfWidthDeg(lat, dLat);
        const polar = dLon >= 360;
        const j0 = Math.floor((lat - dLat) / cellDeg);
        const j1 = Math.floor((lat + dLat) / cellDeg);
        const i0 = Math.floor((lon - dLon) / cellDeg);
        const i1 = polar ? i0 + nLon - 1 : Math.min(Math.floor((lon + dLon) / cellDeg), i0 + nLon - 1);
        if ((j1 - j0 + 1) * (i1 - i0 + 1) > stations.length) linear = true;
        else {
          for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (const s of cells.get(key(j, i)) ?? []) consider(s);
        }
      }
      if (linear) for (const s of stations) consider(s);
      cand.sort((a, b) => a.d - b.d || rank.get(a.s)! - rank.get(b.s)!);
      for (const c of cand.slice(0, 10)) if (capable(c.s)) return c.s;
      return null;
    },
  };
}

const legacyIndexCache = new WeakMap<HarmonicsData, ReturnType<typeof legacyCoverageIndex>>();
/** legacyCoverageIndex memoised per loaded HarmonicsData (a reload yields a new object). */
export function legacyCoverageIndexFor(data: HarmonicsData): ReturnType<typeof legacyCoverageIndex> {
  let index = legacyIndexCache.get(data);
  if (!index) legacyIndexCache.set(data, (index = legacyCoverageIndex(data)));
  return index;
}
