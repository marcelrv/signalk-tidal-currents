// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * signalk-tidal-currents — Signal K server plugin.
 *
 * Predicts tidal currents from OpenCPN/XTide legacy ASCII harmonic files
 * (HARMONIC + HARMONIC.IDX) and makes them available two ways:
 *
 *  - Signal K v1 data model: publishes `environment.current` deltas
 *    (setTrue in radians, drift in m/s) predicted at the vessel position
 *    from the nearest vector-capable current station.
 *  - v2-style REST API at /signalk/v2/api/currents (also mirrored at the
 *    v1 plugin path /plugins/signalk-tidal-currents): station search,
 *    per-station set/drift timelines, and a point vector lookup.
 */

import * as path from 'path';

import { registerRoutes, ApiState, RouterLike } from './api.js';
import { ensureStandardData } from './download.js';
import { HarmonicsData, loadHarmonicsDir } from './harmonics.js';
import { currentSampleAt, nearestCurrentStations } from './predict.js';

const PLUGIN_ID = 'signalk-tidal-currents';
const DEG2RAD = Math.PI / 180;

interface Config {
  dataDir: string;
  publishDelta: boolean;
  updateSeconds: number;
  maxStationDistanceKm: number;
  autoDownloadStandardData: boolean;
}

const DEFAULTS: Config = {
  dataDir: '',
  publishDelta: true,
  updateSeconds: 60,
  maxStationDistanceKm: 15,
  autoDownloadStandardData: true,
};

// Deliberately loose server typing: the plugin only touches a small,
// long-stable subset of the ServerAPI surface.
/* eslint-disable @typescript-eslint/no-explicit-any */
function pluginConstructor(app: any) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const state: ApiState = { data: null, error: 'not started' };
  let mountedV2 = false;
  let deltaPublished = false;

  const plugin: any = {
    id: PLUGIN_ID,
    name: 'Tidal Currents',
    description:
      'Tidal current predictions from OpenCPN/XTide harmonic files (HARMONIC/HARMONIC.IDX)',

    schema() {
      return {
        type: 'object',
        properties: {
          dataDir: {
            type: 'string',
            title: 'Harmonics Data Directory',
            description:
              'Directory containing a HARMONIC + HARMONIC.IDX pair (e.g. an OpenCPN tcdata folder). ' +
              'Default: <server config dir>/tcdata',
            default: DEFAULTS.dataDir,
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
              'Only publish environment.current when a vector-capable station is within this range',
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
      const dir =
        config.dataDir && config.dataDir.trim() !== ''
          ? config.dataDir
          : path.join(app.getDataDirPath ? path.dirname(app.getDataDirPath()) : '.', 'tcdata');

      const attemptLoad = (): boolean => {
        try {
          const data: HarmonicsData = loadHarmonicsDir(dir);
          state.data = data;
          state.error = null;
          const currents = data.stations.filter((s) => s.isCurrent).length;
          app.setPluginStatus(
            `Loaded ${data.stations.length} stations (${currents} current) from ${dir}`,
          );
          return true;
        } catch (e) {
          state.data = null;
          state.error = e instanceof Error ? e.message : String(e);
          app.setPluginError(`Failed to load harmonics: ${state.error}`);
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
            const near = nearestCurrentStations(state.data!, p.latitude, p.longitude, 10)
              .filter((n) => n.vectorCapable && n.distanceKm <= config.maxStationDistanceKm);
            if (near.length === 0) return;
            const sample = currentSampleAt(state.data!, near[0].station, Date.now());
            if (!sample || sample.direction === null) return;
            deltaPublished = true;
            app.handleMessage(PLUGIN_ID, {
              updates: [
                {
                  values: [
                    {
                      path: 'environment.current',
                      value: {
                        setTrue: sample.direction * DEG2RAD,
                        drift: Math.abs(sample.speedKn) * 0.514444,
                      },
                    },
                  ],
                  meta: [
                    {
                      path: 'environment.current',
                      value: {
                        description: `Predicted tidal current (station: ${near[0].station.name}, ${near[0].distanceKm} km)`,
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
    version: '0.1.0',
    description:
      'Tidal current predictions from OpenCPN/XTide harmonic files. ' +
      'Signed speed is along the flood/ebb axis (+ = flood).',
  },
  paths: {
    '/': { get: { summary: 'Dataset summary', responses: { '200': { description: 'OK' } } } },
    '/stations': {
      get: {
        summary: 'Nearest current stations',
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
    '/vector': {
      get: {
        summary: 'Set/drift vector at a position from the nearest usable station',
        parameters: [
          { name: 'latitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'longitude', in: 'query', required: true, schema: { type: 'number' } },
          { name: 'time', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { '200': { description: 'OK' }, '404': { description: 'No station in range' } },
      },
    },
  },
};

// Both named and default exports — Signal K's importOrRequire() uses
// module.default for ESM plugins.
export { pluginConstructor };
export default pluginConstructor;
