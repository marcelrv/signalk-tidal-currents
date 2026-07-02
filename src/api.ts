// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * REST API for tidal current predictions.
 *
 * Mounted twice by the plugin:
 *   /plugins/signalk-tidal-currents/…   (Signal K v1 plugin router — always)
 *   /signalk/v2/api/currents/…          (v2-style domain API, same routes)
 *
 * Endpoints:
 *   GET /                       — dataset summary
 *   GET /stations?latitude=&longitude=[&limit=]   — nearest current stations
 *   GET /stations/:id           — station metadata
 *   GET /stations/:id/timeline?start=&end=[&step=] — signed speed + set/drift
 *   GET /vector?latitude=&longitude=[&time=]       — nearest usable vector
 */

import { HarmonicsData, IdxStation } from './harmonics.js';
import {
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

export function registerRoutes(router: RouterLike, state: ApiState): void {
  const notReady = (res: Res): boolean => {
    if (!state.data) {
      res.status(503).json({ error: state.error ?? 'harmonics data not loaded' });
      return true;
    }
    return false;
  };

  router.get('/', (_req, res) => {
    if (notReady(res)) return;
    const d = state.data!;
    const currents = d.stations.filter((s) => s.isCurrent);
    res.json({
      source: d.sourceDir,
      constituents: d.constituents.names.length,
      years: `${d.constituents.firstYear}–${d.constituents.firstYear + d.constituents.numYears - 1}`,
      stations: d.stations.length,
      currentStations: currents.length,
      vectorCapable: currents.filter(
        (s) => s.offsets && s.offsets.floodDir !== null && s.offsets.ebbDir !== null,
      ).length,
      disclaimer:
        'Predictions from community harmonic data — not official, do not use as sole source for navigation.',
    });
  });

  router.get('/stations', (req, res) => {
    if (notReady(res)) return;
    const lat = parseFloat(String(req.query.latitude));
    const lon = parseFloat(String(req.query.longitude));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: 'latitude and longitude query parameters are required' });
      return;
    }
    const limit = Math.min(50, parseInt(String(req.query.limit), 10) || 10);
    const result = nearestCurrentStations(state.data!, lat, lon, limit).map((n) =>
      stationInfo(n.station, { distanceKm: n.distanceKm, vectorCapable: n.vectorCapable }),
    );
    res.json(result);
  });

  router.get('/stations/:id', (req, res) => {
    if (notReady(res)) return;
    const s = state.data!.stations.find((st) => st.id === req.params.id);
    if (!s) {
      res.status(404).json({ error: `unknown station: ${req.params.id}` });
      return;
    }
    res.json(stationInfo(s, { offsets: s.offsets }));
  });

  router.get('/stations/:id/timeline', (req, res) => {
    if (notReady(res)) return;
    const s = state.data!.stations.find((st) => st.id === req.params.id);
    if (!s) {
      res.status(404).json({ error: `unknown station: ${req.params.id}` });
      return;
    }
    const start = req.query.start ? Date.parse(String(req.query.start)) : Date.now();
    const endDefault = start + 24 * 3600_000;
    const end = req.query.end ? Date.parse(String(req.query.end)) : endDefault;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      res.status(400).json({ error: 'invalid start/end — expected ISO 8601, end after start' });
      return;
    }
    const stepMin = Math.max(5, Math.min(120, parseInt(String(req.query.step), 10) || 10));
    if ((end - start) / (stepMin * 60_000) > 20000) {
      res.status(400).json({ error: 'window too large for the requested step' });
      return;
    }
    const samples = timeline(state.data!, s, start, end, stepMin * 60_000);
    res.json({
      station: stationInfo(s),
      units: { speedKn: 'knots (signed, + = flood)', u: 'm/s east', v: 'm/s north' },
      estimated: s.isSubordinate,
      timeline: samples,
    });
  });

  router.get('/vector', (req, res) => {
    if (notReady(res)) return;
    const lat = parseFloat(String(req.query.latitude));
    const lon = parseFloat(String(req.query.longitude));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: 'latitude and longitude query parameters are required' });
      return;
    }
    const time = req.query.time ? Date.parse(String(req.query.time)) : Date.now();
    if (!Number.isFinite(time)) {
      res.status(400).json({ error: 'invalid time — expected ISO 8601' });
      return;
    }
    const near = nearestCurrentStations(state.data!, lat, lon, 10).filter((n) => n.vectorCapable);
    if (near.length === 0) {
      res.status(404).json({ error: 'no vector-capable current station nearby' });
      return;
    }
    const sample = currentSampleAt(state.data!, near[0].station, time);
    res.json({
      station: stationInfo(near[0].station, { distanceKm: near[0].distanceKm }),
      sample,
    });
  });
}
