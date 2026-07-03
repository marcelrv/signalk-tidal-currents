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
 *   GET /stations?latitude=&longitude=[&limit=]   — nearest current stations (harmonics only)
 *   GET /stations/:id           — station metadata
 *   GET /stations/:id/timeline?start=&end=[&step=] — signed speed + set/drift
 *   GET /timeline?latitude=&longitude=[&start=&end=&step=] — position timeline (GRIB and/or station)
 *   GET /vector?latitude=&longitude=[&time=]       — vector at a position (GRIB preferred, station fallback)
 */

import { GribSource, gribSummary, gribVectorAt } from './gribcurrents.js';
import { HarmonicsData, IdxStation } from './harmonics.js';
import {
  CurrentSample,
  currentSampleAt,
  nearestCurrentStations,
  timeline,
} from './predict.js';

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
  /** When both sources cover a position/time, use GRIB (default true). */
  preferGrib?: boolean;
}

export interface ResolvedVector {
  source: 'grib' | 'station';
  sample: CurrentSample;
  /** Station path only: */
  station?: IdxStation;
  distanceKm?: number;
}

/**
 * Vector at a position/time from the best available source. GRIB wins when
 * it covers the position/time (unless preferGrib is false), stations are
 * the fallback; `maxStationKm` bounds the station search (Infinity for the
 * REST API, the configured limit for delta publishing).
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
  return state.preferGrib === false
    ? fromStation() ?? fromGrib()
    : fromGrib() ?? fromStation();
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

  /** 503 unless at least one source (harmonics or GRIB) is loaded. */
  const notReady = (res: Res): boolean => {
    if (!state.data && !gribData()) {
      res.status(503).json({ error: state.error ?? 'no current data loaded (harmonics or GRIB2)' });
      return true;
    }
    return false;
  };

  /** 503 unless harmonic station data is loaded (station endpoints). */
  const stationsNotReady = (res: Res): boolean => {
    if (!state.data) {
      res.status(503).json({ error: state.error ?? 'harmonics data not loaded' });
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
      preferredSource: state.preferGrib === false ? 'station' : 'grib',
      disclaimer:
        'Predictions from community harmonic data and/or forecast model GRIBs — not official, do not use as sole source for navigation.',
    });
  });

  router.get('/stations', (req, res) => {
    if (stationsNotReady(res)) return;
    const pos = parsePosition(req, res);
    if (!pos) return;
    const limit = Math.min(50, parseInt(String(req.query.limit), 10) || 10);
    const result = nearestCurrentStations(state.data!, pos.lat, pos.lon, limit).map((n) =>
      stationInfo(n.station, { distanceKm: n.distanceKm, vectorCapable: n.vectorCapable }),
    );
    res.json(result);
  });

  router.get('/stations/:id', (req, res) => {
    if (stationsNotReady(res)) return;
    const s = state.data!.stations.find((st) => st.id === req.params.id);
    if (!s) {
      res.status(404).json({ error: `unknown station: ${req.params.id}` });
      return;
    }
    res.json(stationInfo(s, { offsets: s.offsets }));
  });

  router.get('/stations/:id/timeline', (req, res) => {
    if (stationsNotReady(res)) return;
    const s = state.data!.stations.find((st) => st.id === req.params.id);
    if (!s) {
      res.status(404).json({ error: `unknown station: ${req.params.id}` });
      return;
    }
    const win = parseWindow(req, res);
    if (!win) return;
    const samples = timeline(state.data!, s, win.start, win.end, win.stepMs);
    res.json({
      station: stationInfo(s),
      units: { speedKn: 'knots (signed, + = flood)', u: 'm/s east', v: 'm/s north' },
      estimated: s.isSubordinate,
      timeline: samples,
    });
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

    // Resolve the fallback station once, not per sample.
    const near = state.data
      ? nearestCurrentStations(state.data, pos.lat, pos.lon, 10).filter((n) => n.vectorCapable)
      : [];
    const station = near.length > 0 ? near[0] : null;
    const g = gribData();
    const gribFirst = state.preferGrib !== false;

    const samples: Array<CurrentSample & { source: 'grib' | 'station' }> = [];
    const usedSources = new Set<string>();
    for (let t = win.start; t <= win.end; t += win.stepMs) {
      const fromGrib = () => (g ? gribVectorAt(g, pos.lat, pos.lon, t) : null);
      const fromStation = () =>
        station && state.data ? currentSampleAt(state.data, station.station, t) : null;
      let source: 'grib' | 'station' = gribFirst ? 'grib' : 'station';
      let s = gribFirst ? fromGrib() : fromStation();
      if (!s) {
        source = gribFirst ? 'station' : 'grib';
        s = gribFirst ? fromStation() : fromGrib();
      }
      if (!s) continue;
      usedSources.add(source);
      samples.push({ ...s, source });
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
      units: {
        speedKn: 'knots (station samples: signed along flood/ebb axis; grib samples: magnitude)',
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
        : null,
      sample: resolved.sample,
    });
  });
}
