// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * In-process handle to the current-prediction API, published to other
 * plugins through Signal K's PropertyValues mechanism as the well-known
 * property `currentsApi` (see README "In-process API for other plugins").
 *
 * The methods run the SAME handlers as the HTTP routes
 * (`handleStations` / `handleStationTimeline` in src/api.ts) against a
 * capturing response, so the in-process results are byte-for-byte the JSON
 * that `GET /signalk/v2/api/currents/stations…` returns and cannot drift.
 * An HTTP error status (400/404/503) becomes a rejected promise carrying a
 * `CurrentsApiError` with the same status and body.
 *
 * The handle is one stable object per plugin instance that reads the live
 * `ApiState` at call time: it stays valid across a config save (stop/start)
 * and rejects while the plugin is stopped, so it never serves stale data.
 */

import { ApiState, Req, Res, handleStationTimeline, handleStations } from './api.js';
import { CurrentSample } from './predict.js';

/** PropertyValues name the handle is emitted under. */
export const CURRENTS_API_PROPERTY = 'currentsApi';
/** Contract version; bump only on a change that would break a consumer. */
export const CURRENTS_API_VERSION = 1;
export const CURRENTS_API_PROVIDER_ID = 'signalk-tidal-currents';

/** One element of `GET /stations?latitude=&longitude=` (legacy harmonic or UTCEF station). */
export interface CurrentStationDto {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** 'reference' | 'subordinate' (legacy harmonic) or 'harmonic' (UTCEF). */
  type: string;
  distanceKm: number;
  /** True when the station gives a direction (set), not just signed speed. */
  vectorCapable: boolean;
  source?: 'utcef';
  [key: string]: unknown;
}

/** Body of `GET /stations/:id/timeline`. */
export interface CurrentTimelineDto {
  station: Record<string, unknown> & { id: string; name: string; latitude: number; longitude: number };
  units: { speedKn: string; u: string; v: string };
  estimated: boolean;
  timeline: CurrentSample[];
}

export interface CurrentsApiV1 {
  readonly version: 1;
  readonly providerId: string;
  findStations(latitude: number, longitude: number, limit?: number): Promise<CurrentStationDto[]>;
  getTimeline(stationId: string, startIso: string, endIso: string, stepMinutes?: number): Promise<CurrentTimelineDto>;
}

/** Rejection reason of a handle method: the HTTP status and JSON body the matching route would send. */
export class CurrentsApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const msg = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : `HTTP ${status}`;
    super(msg);
    this.name = 'CurrentsApiError';
  }
}

/** Runs a route handler against a capturing response; resolves with the 2xx body, rejects with CurrentsApiError otherwise. */
function invoke(
  handler: (state: ApiState, req: Req, res: Res) => void,
  state: ApiState,
  params: Record<string, string>,
  query: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res: Res = {
      status(code) {
        status = code;
        return res;
      },
      json(body) {
        if (status >= 400) reject(new CurrentsApiError(status, body));
        else resolve(body);
      },
    };
    try {
      handler(state, { params, query }, res);
    } catch (e) {
      reject(e);
    }
  });
}

/** Only the keys that were given — an absent key must reach the handler as absent, exactly like an omitted query parameter. */
function definedOnly(q: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined));
}

/**
 * Builds the handle. `isRunning` gates every call: while it returns false
 * (before start(), after stop()) the methods reject with status 503.
 */
export function createCurrentsApi(state: ApiState, isRunning: () => boolean): CurrentsApiV1 {
  const notRunning = () => Promise.reject(new CurrentsApiError(503, { error: `${CURRENTS_API_PROVIDER_ID} is not running` }));
  return Object.freeze({
    version: CURRENTS_API_VERSION,
    providerId: CURRENTS_API_PROVIDER_ID,
    findStations(latitude: number, longitude: number, limit?: number) {
      if (!isRunning()) return notRunning();
      return invoke(handleStations, state, {}, definedOnly({ latitude, longitude, limit })) as Promise<CurrentStationDto[]>;
    },
    getTimeline(stationId: string, startIso: string, endIso: string, stepMinutes?: number) {
      if (!isRunning()) return notRunning();
      return invoke(handleStationTimeline, state, { id: String(stationId) }, definedOnly({ start: startIso, end: endIso, step: stepMinutes })) as Promise<CurrentTimelineDto>;
    },
  });
}
