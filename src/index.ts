// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * signalk-tidal-currents — Signal K server plugin.
 *
 * Predicts tidal currents from two kinds of sources and makes them
 * available two ways:
 *
 *  Sources:
 *  - OpenCPN/XTide legacy ASCII harmonic files (HARMONIC + HARMONIC.IDX):
 *    station-based harmonic prediction.
 *  - GRIB2 files with gridded current fields (u/v, discipline 10 category
 *    1): positional bilinear + time interpolation, no stations involved.
 *
 *  Outputs:
 *  - Signal K v1 data model: publishes `environment.current` deltas
 *    (setTrue in radians, drift in m/s) predicted at the vessel position.
 *  - v2-style REST API at /signalk/v2/api/currents (also mirrored at the
 *    v1 plugin path /plugins/signalk-tidal-currents): station search,
 *    station and position timelines, and a point vector lookup.
 */

import * as fs from 'fs';
import * as path from 'path';

import { registerRoutes, resolveVector, resolvedStationName, ApiState, RouterLike } from './api.js';
import { ensureStandardData } from './download.js';
import { createGribSource } from './gribcurrents.js';
import { HarmonicsData, loadHarmonicsDir } from './harmonics.js';
import { createUtcefSource } from './utcef.js';

const PLUGIN_ID = 'signalk-tidal-currents';
const DEG2RAD = Math.PI / 180;

interface Config {
  dataDir: string;
  gribDir: string;
  utcefDir: string;
  preferGrib: boolean;
  publishDelta: boolean;
  updateSeconds: number;
  maxStationDistanceKm: number;
  autoDownloadStandardData: boolean;
}

const DEFAULTS: Config = {
  dataDir: '',
  gribDir: '',
  utcefDir: '',
  preferGrib: true,
  publishDelta: true,
  updateSeconds: 60,
  maxStationDistanceKm: 15,
  autoDownloadStandardData: true,
};

// Deliberately loose server typing: the plugin only touches a small,
// long-stable subset of the ServerAPI surface.
// Plugin's own storage root (Signal K's standard per-plugin data dir).
// Harmonics and GRIB2 each get their own subdir under it by default —
// independently, so overriding one setting doesn't drag the other's
// default along with it (e.g. pointing dataDir at an external OpenCPN
// folder must not relocate the GRIB2 default into that folder too).
/* eslint-disable @typescript-eslint/no-explicit-any */
function defaultDirs(app: any): { dataDir: string; gribDir: string; utcefDir: string } {
  const pluginRoot = app.getDataDirPath ? app.getDataDirPath() : '.';
  return {
    dataDir: path.join(pluginRoot, 'tcdata'),
    gribDir: path.join(pluginRoot, 'grib'),
    utcefDir: path.join(pluginRoot, 'utcef'),
  };
}

function pluginConstructor(app: any) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const state: ApiState = { data: null, error: 'not started' };
  let mountedV2 = false;
  let deltaPublished = false;

  const plugin: any = {
    id: PLUGIN_ID,
    name: 'Tidal Currents',
    description:
      'Tidal current predictions from OpenCPN/XTide harmonic files and GRIB2 current fields',

    schema() {
      // Prefilled with the actual resolved default path (not an empty
      // sentinel) so the admin UI form shows it and a user can just click
      // Save without having to know or type a path.
      const defaults = defaultDirs(app);
      return {
        type: 'object',
        properties: {
          dataDir: {
            type: 'string',
            title: 'Harmonics Data Directory',
            description:
              'Directory containing a HARMONIC + HARMONIC.IDX pair (e.g. an OpenCPN tcdata folder).',
            default: defaults.dataDir,
          },
          gribDir: {
            type: 'string',
            title: 'GRIB2 Data Directory',
            description:
              'Directory scanned for GRIB2 files (*.grb2, *.grib2, *.grb, *.grib) with gridded ' +
              'current fields (u/v components, oceanographic discipline). New/updated files are ' +
              'picked up automatically within a minute (independent of the Harmonics Data ' +
              'Directory setting).',
            default: defaults.gribDir,
          },
          utcefDir: {
            type: 'string',
            title: 'UTCEF Data Directory',
            description:
              'Directory scanned for UTCEF files (*.utcef, *.utcef.gz) with harmonic current ' +
              'stations (harmonic_constituents_currents). These are full 2D vectors, so every ' +
              'UTCEF current station gives a real set/drift direction. New/updated files are ' +
              'picked up automatically within a minute (independent of the other directories).',
            default: defaults.utcefDir,
          },
          preferGrib: {
            type: 'boolean',
            title: 'Prefer GRIB over stations',
            description:
              'When both a GRIB grid and a harmonic station cover the position, use the GRIB ' +
              'forecast; stations remain the fallback outside GRIB coverage or beyond its time range',
            default: DEFAULTS.preferGrib,
          },
          publishDelta: {
            type: 'boolean',
            title: 'Publish environment.current',
            description:
              'Publish the predicted set/drift at the vessel position as Signal K deltas',
            default: DEFAULTS.publishDelta,
          },
          updateSeconds: {
            type: 'number',
            title: 'Delta Update Period (s)',
            default: DEFAULTS.updateSeconds,
            minimum: 10,
          },
          maxStationDistanceKm: {
            type: 'number',
            title: 'Max Station Distance (km)',
            description:
              'Only use a station for environment.current when a vector-capable one is within ' +
              'this range (GRIB coverage is not distance-limited)',
            default: DEFAULTS.maxStationDistanceKm,
            minimum: 1,
          },
          autoDownloadStandardData: {
            type: 'boolean',
            title: 'Auto-download OpenCPN standard data',
            description:
              "Download OpenCPN's HARMONICS_NO_US (+ .IDX) current-station data into the Harmonics " +
              'Data Directory if missing, and re-check for updates at most weekly. Never overwrites ' +
              'a file literally named HARMONIC/HARMONIC.IDX, so a custom pair you provide always wins.',
            default: DEFAULTS.autoDownloadStandardData,
          },
        },
      };
    },

    start(options: Partial<Config>) {
      const config: Config = { ...DEFAULTS, ...options };
      const defaults = defaultDirs(app);
      const dir = config.dataDir && config.dataDir.trim() !== '' ? config.dataDir : defaults.dataDir;
      const gribDir =
        config.gribDir && config.gribDir.trim() !== '' ? config.gribDir : defaults.gribDir;
      const utcefDir =
        config.utcefDir && config.utcefDir.trim() !== '' ? config.utcefDir : defaults.utcefDir;

      // Create both directories (default or user-specified) if missing, so
      // saving the config is enough — no manual mkdir before dropping in a
      // HARMONIC pair or GRIB2 files. Mode 0o777 (not 0o666): a directory
      // needs its execute/search bit for others to traverse into it or open
      // files inside by path, not just the read/write bits — omitting x
      // would make the directory unusable to any other account despite
      // "permissions" nominally being set. Runs on every start(), not just
      // first creation, so a directory that ended up owned/restricted by a
      // different account (e.g. a server run as root vs. a non-root Docker
      // user) self-heals instead of failing with EACCES on next use.
      // mkdirSync's mode is subject to the process umask, so chmod
      // afterwards to force it exactly. On Windows, POSIX mode bits mostly
      // don't apply (chmod there only toggles the read-only attribute) —
      // harmless no-op, not an error, so wrapped the same as any other
      // filesystem access here.
      for (const d of [dir, gribDir, utcefDir]) {
        try {
          fs.mkdirSync(d, { recursive: true, mode: 0o777 });
          fs.chmodSync(d, 0o777);
        } catch (e) {
          console.warn(`[${PLUGIN_ID}] could not create/chmod directory ${d}: ${e}`);
        }
      }

      state.grib = createGribSource(gribDir);
      state.utcef = createUtcefSource(utcefDir);
      state.preferGrib = config.preferGrib;

      const updateStatus = () => {
        const parts: string[] = [];
        if (state.data) {
          const currents = state.data.stations.filter((s) => s.isCurrent).length;
          parts.push(`${state.data.stations.length} stations (${currents} current)`);
        }
        const g = state.grib?.get();
        if (g && g.slots.length > 0) {
          parts.push(`${g.files.length} GRIB file(s), ${g.slots.length} forecast times`);
        }
        const u = state.utcef?.get();
        if (u && u.currentStations.length > 0) {
          parts.push(`${u.currentStations.length} UTCEF current station(s)`);
        }
        if (parts.length > 0) {
          app.setPluginStatus(`Loaded ${parts.join(' + ')}`);
        } else {
          app.setPluginError(
            `No current data: ${state.error ?? 'no harmonics pair'}, no GRIB2 files in ${gribDir}, ` +
              `and no UTCEF files in ${utcefDir}`,
          );
        }
      };

      const attemptLoad = (): boolean => {
        try {
          const data: HarmonicsData = loadHarmonicsDir(dir);
          state.data = data;
          state.error = null;
          updateStatus();
          return true;
        } catch (e) {
          state.data = null;
          state.error = e instanceof Error ? e.message : String(e);
          updateStatus();
          return false;
        }
      };

      attemptLoad(); // routes stay mounted below and report 503 if this failed

      // Mount the v2-style domain API (same routes as the v1 plugin path)
      // directly on the underlying express app via a prefix shim — avoids a
      // runtime dependency on express itself. Mounted regardless of whether
      // the initial load succeeded, same as the v1 path (registerWithRouter).
      if (!mountedV2 && typeof app.get === 'function') {
        try {
          const V2_BASE = '/signalk/v2/api/currents';
          const prefixed: RouterLike = {
            get: (p, h) => app.get(p === '/' ? V2_BASE : V2_BASE + p, h),
          };
          registerRoutes(prefixed, state);
          mountedV2 = true;
        } catch (e) {
          console.warn(`[${PLUGIN_ID}] could not mount /signalk/v2/api/currents: ${e}`);
        }
      }

      if (config.autoDownloadStandardData) {
        // Fire-and-forget: doesn't block start(). If it downloads
        // new/updated files, reload so the already-mounted routes (and the
        // publish loop below) pick them up without a restart.
        ensureStandardData(dir)
          .then((changed) => {
            if (changed) attemptLoad();
          })
          .catch((e) => {
            console.warn(`[${PLUGIN_ID}] OpenCPN standard data check failed: ${e}`);
          });
      }

      if (config.publishDelta) {
        const publish = () => {
          try {
            const pos = app.getSelfPath('navigation.position');
            const p = pos?.value ?? pos;
            if (typeof p?.latitude !== 'number' || typeof p?.longitude !== 'number') return;
            const resolved = resolveVector(
              state,
              p.latitude,
              p.longitude,
              Date.now(),
              config.maxStationDistanceKm,
            );
            if (!resolved || resolved.sample.direction === null) return;
            const origin =
              resolved.source === 'grib'
                ? 'GRIB2 forecast grid'
                : `${resolved.source === 'utcef' ? 'UTCEF' : 'station'}: ${resolvedStationName(resolved)}, ${resolved.distanceKm} km`;
            deltaPublished = true;
            app.handleMessage(PLUGIN_ID, {
              updates: [
                {
                  values: [
                    {
                      path: 'environment.current',
                      value: {
                        setTrue: resolved.sample.direction * DEG2RAD,
                        drift: Math.abs(resolved.sample.speedKn) * 0.514444,
                      },
                    },
                  ],
                  meta: [
                    {
                      path: 'environment.current',
                      value: {
                        description: `Predicted tidal current (${origin})`,
                      },
                    },
                  ],
                },
              ],
            });
          } catch {
            // vessel position not available yet — try again next tick
          }
        };
        publish();
        timer = setInterval(publish, Math.max(10, config.updateSeconds) * 1000);
      }
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (deltaPublished) {
        app.handleMessage(PLUGIN_ID, {
          updates: [
            {
              values: [
                {
                  path: 'environment.current',
                  value: { setTrue: null, drift: null },
                },
              ],
            },
          ],
        });
        deltaPublished = false;
      }
      state.data = null;
      state.grib = null;
      state.utcef = null;
      state.error = 'stopped';
      app.setPluginStatus('Stopped');
    },

    registerWithRouter(router: RouterLike) {
      // v1 plugin path: /plugins/signalk-tidal-currents/…
      registerRoutes(router, state);
    },

    getOpenApi: () => openApiSpec,
  };

  return plugin;
}

const openApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Tidal Currents API',
    version: '0.2.0',
    description:
      'Tidal current predictions from OpenCPN/XTide harmonic files (station-based), GRIB2 ' +
      'current fields (gridded, positional), and UTCEF datasets (station-based 2D harmonic ' +
      'currents). Legacy station samples: signed speed along the flood/ebb axis (+ = flood). ' +
      'UTCEF and GRIB samples: speed is a magnitude.',
  },
  paths: {
    '/': { get: { summary: 'Dataset summary (harmonics + GRIB + UTCEF sources)', responses: { '200': { description: 'OK' } } } },
    '/stations': {
      get: {
        summary: 'Nearest current stations (harmonic + UTCEF sources)',
        parameters: [
          { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/stations/{id}': {
      get: {
        summary: 'Station metadata',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Unknown station' } },
      },
    },
    '/stations/{id}/timeline': {
      get: {
        summary: 'Set/drift timeline for a station',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'start', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'end', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'step', in: 'query', schema: { type: 'integer', default: 10, description: 'minutes' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/timeline': {
      get: {
        summary:
          'Set/drift timeline at a position — per-sample source selection between the GRIB grids ' +
          'and the nearest vector-capable station',
        parameters: [
          { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'start', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'end', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'step', in: 'query', schema: { type: 'integer', default: 10, description: 'minutes' } },
        ],
        responses: { '200': { description: 'OK' }, '404': { description: 'No source covers the position/window' } },
      },
    },
    '/vector': {
      get: {
        summary:
          'Set/drift vector at a position (GRIB grid preferred, nearest usable station as fallback; ' +
          'response `source` says which)',
        parameters: [
          { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'OK' }, '404': { description: 'No coverage / no station in range' } },
      },
    },
  },
};

// Both named and default exports — Signal K's importOrRequire() uses
// module.default for ESM plugins.
export { pluginConstructor };
export default pluginConstructor;
