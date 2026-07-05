// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * REST API for tidal current predictions.
 *
 * Mounted twice by the plugin:
 *   /plugins/signalk-tidal-currents/…   (Signal K v1 plugin router — always)
 *   /signalk/v2/api/currents/…          (v2-style domain API, same routes)
 *
 * Two data sources feed the API:
 *   - harmonic STATIONS (HARMONIC/HARMONIC.IDX) — station-centric endpoints
 *   - gridded GRIB2 current fields — positional only, no station concept
 *
 * Endpoints:
 *   GET /                       — dataset summary (both sources)
 *   GET /stations?latitude=&longitude=[&limit=]    — nearest current stations (harmonics only)
 *   GET /stations?bbox=w,s,e,n[&limit=]             — every current station inside a viewport (harmonics only)
 *   GET /stations/:id           — station metadata
 *   GET /stations/:id/timeline?start=&end=[&step=] — signed speed + set/drift
 *   GET /timeline?latitude=&longitude=[&start=&end=&step=] — position timeline (GRIB and/or station)
 *   GET /vector?latitude=&longitude=[&time=]       — vector at a position (GRIB preferred, station fallback)
 *   GET /grid?bbox=w,s,e,n[&time=&maxPoints=]      — sampled GRIB vector field over a viewport (GRIB only)
 */

import { GribSource, gribGridSamples, gribSummary, gribVectorAt } from './gribcurrents.js';
import { HarmonicsData, IdxStation } from './harmonics.js';
import { SourceType } from './priority.js';
import {
  CurrentSample,
  currentSampleAt,
  nearestCurrentStations,
  stationsInBbox,
  timeline,
} from './predict.js';
import {
  UtcefCurrentStation,
  UtcefSource,
  nearestUtcefStations,
  utcefSampleAt,
  utcefSummary,
  utcefVectorAt,
} from './utcef.js';

// Minimal express-compatible typings (the router instance is supplied by the
// Signal K server; this plugin has no runtime dependency on express).
interface Req {
  params: Record<string, string>;
  query: Record<string, unknown>;
}
interface Res {
  json(body: unknown): void;
  status(code: number): Res;
}
export interface RouterLike {
  get(path: string, handler: (req: Req, res: Res) => void): void;
}

export interface ApiState {
  data: HarmonicsData | null;
  error: string | null;
  /** Gridded GRIB2 current source; null/undefined when not configured. */
  grib?: GribSource | null;
  /** UTCEF current source; null/undefined when not configured. */
  utcef?: UtcefSource | null;
  /** When several sources cover a position/time, use GRIB first (default true). Superseded by sourcePriority when set. */
  preferGrib?: boolean;
  /** Explicit source-type rank (PRD §5.3 Phase 1); falls back to the preferGrib boolean when unset. */
  sourcePriority?: SourceType[];
}

export interface ResolvedVector {
  source: 'grib' | 'utcef' | 'station';
  sample: CurrentSample;
  /** Legacy-station path only: */
  station?: IdxStation;
  /** UTCEF-station path only: */
  utcefStation?: UtcefCurrentStation;
  distanceKm?: number;
}

/** Human-readable name of whichever station backed a resolved vector. */
export function resolvedStationName(r: ResolvedVector): string | null {
  if (r.source === 'station') return r.station?.name ?? null;
  if (r.source === 'utcef') return r.utcefStation?.name ?? null;
  return null;
}

/**
 * Vector at a position/time from the best available source. GRIB (a forecast
 * grid) wins when it covers the position/time unless preferGrib is false;
 * among station-type sources the modern UTCEF vector data is tried before the
 * legacy OpenCPN harmonics. `maxStationKm` bounds the station searches
 * (Infinity for the REST API, the configured limit for delta publishing).
 */
export function resolveVector(
  state: ApiState,
  lat: number,
  lon: number,
  timeMs: number,
  maxStationKm = Infinity,
): ResolvedVector | null {
  const fromGrib = (): ResolvedVector | null => {
    const g = state.grib?.get();
    if (!g) return null;
    const sample = gribVectorAt(g, lat, lon, timeMs);
    return sample ? { source: 'grib', sample } : null;
  };
  const fromUtcef = (): ResolvedVector | null => {
    const u = state.utcef?.get();
    if (!u) return null;
    const hit = utcefVectorAt(u, lat, lon, timeMs, maxStationKm);
    return hit
      ? { source: 'utcef', sample: hit.sample, utcefStation: hit.station, distanceKm: hit.distanceKm }
      : null;
  };
  const fromStation = (): ResolvedVector | null => {
    if (!state.data) return null;
    const near = nearestCurrentStations(state.data, lat, lon, 10).filter(
      (n) => n.vectorCapable && n.distanceKm <= maxStationKm,
    );
    if (near.length === 0) return null;
    const sample = currentSampleAt(state.data, near[0].station, timeMs);
    if (!sample) return null;
    return { source: 'station', sample, station: near[0].station, distanceKm: near[0].distanceKm };
  };
  const fns: Record<SourceType, () => ResolvedVector | null> = { grib2: fromGrib, utcef: fromUtcef, harmonic: fromStation };
  for (const key of sourceRank(state)) {
    const r = fns[key]();
    if (r) return r;
  }
  return null;
}

/**
 * Source-type rank to try in order: an explicit `sourcePriority` (PRD §5.3
 * Phase 1) wins when set; otherwise falls back to the legacy `preferGrib`
 * boolean so existing saved configs keep behaving the same way.
 */
function sourceRank(state: ApiState): SourceType[] {
  return state.sourcePriority ?? (state.preferGrib === false ? ['utcef', 'harmonic', 'grib2'] : ['grib2', 'utcef', 'harmonic']);
}

function stationInfo(s: IdxStation, extra: Record<string, unknown> = {}) {
  return {
    id: s.id,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    type: s.isSubordinate ? 'subordinate' : 'reference',
    referenceName: s.offsets?.referenceName,
    floodDir: s.offsets?.floodDir ?? null,
    ebbDir: s.offsets?.ebbDir ?? null,
    ...extra,
  };
}

/** stationInfo-compatible view of a UTCEF current station (always vector-capable). */
function utcefStationInfo(s: UtcefCurrentStation, extra: Record<string, unknown> = {}) {
  return {
    id: s.id,
    name: s.name,
    latitude: s.latitude,
    longitude: s.longitude,
    type: 'harmonic',
    source: 'utcef' as const,
    constituents: s.constituents.length,
    vectorCapable: true,
    ...extra,
  };
}

function parsePosition(req: Req, res: Res): { lat: number; lon: number } | null {
  const lat = parseFloat(String(req.query.latitude));
  const lon = parseFloat(String(req.query.longitude));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'latitude and longitude query parameters are required' });
    return null;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    res.status(400).json({ error: 'latitude must be between -90 and 90, longitude between -180 and 180' });
    return null;
  }
  return { lat, lon };
}

function parseBbox(
  req: Req,
  res: Res,
): { west: number; south: number; east: number; north: number } | null {
  const parts = String(req.query.bbox ?? '').split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    res.status(400).json({ error: 'bbox query parameter must be "west,south,east,north"' });
    return null;
  }
  const [west, south, east, north] = parts;
  if (south >= north || west >= east) {
    res.status(400).json({ error: 'bbox must have south < north and west < east' });
    return null;
  }
  return { west, south, east, north };
}

function parseWindow(
  req: Req,
  res: Res,
): { start: number; end: number; stepMs: number } | null {
  const start = req.query.start ? Date.parse(String(req.query.start)) : Date.now();
  const end = req.query.end ? Date.parse(String(req.query.end)) : start + 24 * 3600_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    res.status(400).json({ error: 'invalid start/end — expected ISO 8601, end after start' });
    return null;
  }
  const stepMin = Math.max(5, Math.min(120, parseInt(String(req.query.step), 10) || 10));
  if ((end - start) / (stepMin * 60_000) > 2000) {
    res.status(400).json({ error: 'window too large for the requested step' });
    return null;
  }
  return { start, end, stepMs: stepMin * 60_000 };
}

export function registerRoutes(router: RouterLike, state: ApiState): void {
  const gribData = () => state.grib?.get() ?? null;
  const utcefData = () => state.utcef?.get() ?? null;

  /** 503 unless at least one source (harmonics, UTCEF or GRIB) is loaded. */
  const notReady = (res: Res): boolean => {
    const u = utcefData();
    if (!state.data && !gribData() && !(u && u.currentStations.length > 0)) {
      res.status(503).json({
        error: state.error ?? 'no current data loaded (harmonics, UTCEF or GRIB2)',
      });
      return true;
    }
    return false;
  };

  router.get('/', (_req, res) => {
    if (notReady(res)) return;
    const d = state.data;
    const currents = d ? d.stations.filter((s) => s.isCurrent) : [];
    const g = gribData();
    res.json({
      harmonics: d
        ? {
            source: d.sourceDir,
            constituents: d.constituents.names.length,
            years: `${d.constituents.firstYear}–${d.constituents.firstYear + d.constituents.numYears - 1}`,
            stations: d.stations.length,
            currentStations: currents.length,
            vectorCapable: currents.filter(
              (s) => s.offsets && s.offsets.floodDir !== null && s.offsets.ebbDir !== null,
            ).length,
          }
        : null,
      grib: g ? gribSummary(g) : null,
      utcef: (() => {
        const u = utcefData();
        return u ? utcefSummary(u) : null;
      })(),
      preferredSource: state.preferGrib === false ? 'station' : 'grib',
      disclaimer:
        'Predictions from community harmonic data, UTCEF datasets and/or forecast model GRIBs — not official, do not use as sole source for navigation.',
    });
  });

  router.get('/stations', (req, res) => {
    const u = utcefData();
    const haveUtcef = !!(u && u.currentStations.length > 0);
    // Station endpoints need a station-type source; either harmonics or UTCEF.
    if (!state.data && !haveUtcef) {
      res.status(503).json({ error: state.error ?? 'no station data loaded (harmonics or UTCEF)' });
      return;
    }

    // bbox mode: every station in a map viewport, not just the nearest few
    // to a single reference point.
    if (req.query.bbox !== undefined) {
      const bbox = parseBbox(req, res);
      if (!bbox) return;
      const limit = Math.min(500, parseInt(String(req.query.limit), 10) || 500);
      const result: unknown[] = state.data
        ? stationsInBbox(state.data, bbox.west, bbox.south, bbox.east, bbox.north, limit).map((n) =>
            stationInfo(n.station, { vectorCapable: n.vectorCapable }),
          )
        : [];
      if (u) {
        for (const s of u.currentStations) {
          if (
            s.latitude >= bbox.south && s.latitude <= bbox.north &&
            s.longitude >= bbox.west && s.longitude <= bbox.east
          ) {
            result.push(utcefStationInfo(s));
            if (result.length >= limit) break;
          }
        }
      }
      res.json(result);
      return;
    }

    const pos = parsePosition(req, res);
    if (!pos) return;
    const limit = Math.min(50, parseInt(String(req.query.limit), 10) || 10);
    const legacy = state.data
      ? nearestCurrentStations(state.data, pos.lat, pos.lon, limit).map((n) => ({
          distanceKm: n.distanceKm,
          info: stationInfo(n.station, { distanceKm: n.distanceKm, vectorCapable: n.vectorCapable }),
        }))
      : [];
    const utcefNear = u
      ? nearestUtcefStations(u, pos.lat, pos.lon, limit).map((n) => ({
          distanceKm: n.distanceKm,
          info: utcefStationInfo(n.station, { distanceKm: n.distanceKm }),
        }))
      : [];
    const result = [...legacy, ...utcefNear]
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, limit)
      .map((n) => n.info);
    res.json(result);
  });

  router.get('/stations/:id', (req, res) => {
    const s = state.data?.stations.find((st) => st.id === req.params.id);
    if (s) {
      res.json(stationInfo(s, { offsets: s.offsets }));
      return;
    }
    const us = utcefData()?.currentStations.find((st) => st.id === req.params.id);
    if (us) {
      res.json(utcefStationInfo(us));
      return;
    }
    res.status(404).json({ error: `unknown station: ${req.params.id}` });
  });

  router.get('/stations/:id/timeline', (req, res) => {
    const win = parseWindow(req, res);
    if (!win) return;

    const s = state.data?.stations.find((st) => st.id === req.params.id);
    if (s) {
      const samples = timeline(state.data!, s, win.start, win.end, win.stepMs);
      res.json({
        station: stationInfo(s),
        units: { speedKn: 'knots (signed, + = flood)', u: 'm/s east', v: 'm/s north' },
        estimated: s.isSubordinate,
        timeline: samples,
      });
      return;
    }

    const us = utcefData()?.currentStations.find((st) => st.id === req.params.id);
    if (us) {
      const samples: CurrentSample[] = [];
      for (let t = win.start; t <= win.end; t += win.stepMs) samples.push(utcefSampleAt(us, t));
      res.json({
        station: utcefStationInfo(us),
        units: { speedKn: 'knots (magnitude)', u: 'm/s east', v: 'm/s north' },
        estimated: false,
        timeline: samples,
      });
      return;
    }

    res.status(404).json({ error: `unknown station: ${req.params.id}` });
  });

  // Position-based timeline — the natural access pattern for gridded GRIB
  // data (no station in the request). Each sample is taken from the
  // preferred source that covers the position at that instant, so a window
  // extending past the GRIB forecast horizon degrades to station data
  // per-sample rather than failing.
  router.get('/timeline', (req, res) => {
    if (notReady(res)) return;
    const pos = parsePosition(req, res);
    if (!pos) return;
    const win = parseWindow(req, res);
    if (!win) return;

    // Resolve the fallback stations once, not per sample.
    const near = state.data
      ? nearestCurrentStations(state.data, pos.lat, pos.lon, 10).filter((n) => n.vectorCapable)
      : [];
    const station = near.length > 0 ? near[0] : null;
    const u = utcefData();
    const utcefNear = u ? nearestUtcefStations(u, pos.lat, pos.lon, 1)[0] ?? null : null;
    const g = gribData();

    // Per-sample source candidates in preference order (same policy as
    // resolveVector, via the same sourceRank()).
    const fromGrib = (t: number) => (g ? gribVectorAt(g, pos.lat, pos.lon, t) : null);
    const fromUtcef = (t: number) => (utcefNear ? utcefSampleAt(utcefNear.station, t) : null);
    const fromStation = (t: number) =>
      station && state.data ? currentSampleAt(state.data, station.station, t) : null;
    const fns: Record<SourceType, (t: number) => CurrentSample | null> = { grib2: fromGrib, utcef: fromUtcef, harmonic: fromStation };
    const sourceLabel: Record<SourceType, 'grib' | 'utcef' | 'station'> = { grib2: 'grib', utcef: 'utcef', harmonic: 'station' };
    const candidates: Array<{ source: 'grib' | 'utcef' | 'station'; fn: (t: number) => CurrentSample | null }> =
      sourceRank(state).map((key) => ({ source: sourceLabel[key], fn: fns[key] }));

    const samples: Array<CurrentSample & { source: 'grib' | 'utcef' | 'station' }> = [];
    const usedSources = new Set<string>();
    for (let t = win.start; t <= win.end; t += win.stepMs) {
      for (const cand of candidates) {
        const s = cand.fn(t);
        if (s) {
          usedSources.add(cand.source);
          samples.push({ ...s, source: cand.source });
          break;
        }
      }
    }
    if (samples.length === 0) {
      res.status(404).json({ error: 'no current data source covers this position/window' });
      return;
    }
    res.json({
      position: { latitude: pos.lat, longitude: pos.lon },
      station: usedSources.has('station') && station
        ? stationInfo(station.station, { distanceKm: station.distanceKm })
        : null,
      utcefStation: usedSources.has('utcef') && utcefNear
        ? utcefStationInfo(utcefNear.station, { distanceKm: utcefNear.distanceKm })
        : null,
      units: {
        speedKn:
          'knots (legacy-station samples: signed along flood/ebb axis; UTCEF/GRIB samples: magnitude)',
        u: 'm/s east',
        v: 'm/s north',
      },
      timeline: samples,
    });
  });

  router.get('/vector', (req, res) => {
    if (notReady(res)) return;
    const pos = parsePosition(req, res);
    if (!pos) return;
    const time = req.query.time ? Date.parse(String(req.query.time)) : Date.now();
    if (!Number.isFinite(time)) {
      res.status(400).json({ error: 'invalid time — expected ISO 8601' });
      return;
    }
    const resolved = resolveVector(state, pos.lat, pos.lon, time);
    if (!resolved) {
      res.status(404).json({ error: 'no GRIB coverage and no vector-capable current station nearby' });
      return;
    }
    res.json({
      source: resolved.source,
      station: resolved.station
        ? stationInfo(resolved.station, { distanceKm: resolved.distanceKm })
        : resolved.utcefStation
          ? utcefStationInfo(resolved.utcefStation, { distanceKm: resolved.distanceKm })
          : null,
      sample: resolved.sample,
    });
  });

  // Sampled GRIB vector field over a viewport — the gridded-data equivalent
  // of /stations?bbox=…, for maps that want current arrows even away from
  // harmonic station locations.
  router.get('/grid', (req, res) => {
    const g = gribData();
    if (!g) {
      res.status(503).json({ error: 'no GRIB current field loaded' });
      return;
    }
    const bbox = parseBbox(req, res);
    if (!bbox) return;
    const time = req.query.time ? Date.parse(String(req.query.time)) : Date.now();
    if (!Number.isFinite(time)) {
      res.status(400).json({ error: 'invalid time — expected ISO 8601' });
      return;
    }
    const maxPoints = Math.min(2000, Math.max(1, parseInt(String(req.query.maxPoints), 10) || 400));
    const points = gribGridSamples(g, bbox, time, maxPoints);
    res.json({ time: new Date(time).toISOString(), units: { speedKn: 'knots (magnitude)', u: 'm/s east', v: 'm/s north' }, points });
  });
}
