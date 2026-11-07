// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-download: a scheduled "Update All" (issue #1). One user-facing
 * setting, the interval: `0` = Off, otherwise every 1/6/12/24 h. While it is
 * on, every installed dataset that is not opted out (`autoUpdate !== false`)
 * and has gone stale is re-downloaded by `runAutoUpdateSweep`, the same set
 * the webapp's Update All banner would start.
 *
 * Persisted in `<dataDir>/auto-download.json` (written by the webapp, NOT the
 * Signal K plugin config): the interval plus the last sweep's outcome. The
 * last sweep time is persisted so a plugin restart does not trigger an extra
 * round of downloads.
 *
 * Scheduling is a fixed short tick that asks "is a sweep due?" rather than
 * one timer per interval, so changing the interval needs no timer re-arm and
 * takes effect within one tick (or immediately via `setInterval`).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { AutoUpdateDeps, AutoUpdateResult, runAutoUpdateSweep } from './autoUpdate.js';
import { readManifest, writeManifestAtomic } from './manifest.js';

export const AUTO_DOWNLOAD_CHOICES = [0, 1, 6, 12, 24] as const;
export type AutoDownloadInterval = (typeof AUTO_DOWNLOAD_CHOICES)[number];
export const AUTO_DOWNLOAD_FILE = 'auto-download.json';
/** How often the scheduler checks whether a sweep is due. */
export const AUTO_DOWNLOAD_TICK_MS = 5 * 60_000;
/** First check after start(), so data already stale at boot is not left waiting a whole tick. */
export const AUTO_DOWNLOAD_BOOT_DELAY_MS = 10_000;
/** Interval the migration picks for installs that opted in under the old per-dataset model (whose default cadence was 30 min). */
export const MIGRATED_INTERVAL: AutoDownloadInterval = 1;

export interface AutoDownloadSweepRecord extends AutoUpdateResult {
  /** ISO 8601 time the sweep ran. */
  at: string;
  /** Set when the sweep itself failed (e.g. unreadable manifest). */
  error?: string;
}

export interface AutoDownloadSettings {
  intervalHours: AutoDownloadInterval;
  lastSweep: AutoDownloadSweepRecord | null;
}

export interface AutoDownloadStatus extends AutoDownloadSettings {
  choices: readonly AutoDownloadInterval[];
  /** When the next sweep is expected (ISO 8601), null while Off. */
  nextCheckAt: string | null;
  running: boolean;
}

export function isValidInterval(v: unknown): v is AutoDownloadInterval {
  return typeof v === 'number' && (AUTO_DOWNLOAD_CHOICES as readonly number[]).includes(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function parseSweepRecord(raw: unknown): AutoDownloadSweepRecord | null {
  const r = raw as Partial<AutoDownloadSweepRecord> | null;
  if (!r || typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  return {
    at: r.at,
    started: isStringArray(r.started) ? r.started : [],
    skippedInFlight: isStringArray(r.skippedInFlight) ? r.skippedInFlight : [],
    skippedDiskFull: isStringArray(r.skippedDiskFull) ? r.skippedDiskFull : [],
    ...(typeof r.error === 'string' ? { error: r.error } : {}),
  };
}

export function saveAutoDownloadSettingsAtomic(dataDir: string, settings: AutoDownloadSettings): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, AUTO_DOWNLOAD_FILE);
  const tmp = path.join(dataDir, `.${AUTO_DOWNLOAD_FILE}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Tolerant read. A missing file triggers the one-time migration from the old
 * per-dataset opt-in model: if any install has `autoUpdate: true`, auto-
 * download is switched on at `MIGRATED_INTERVAL` and every OTHER install is
 * marked opted out (`autoUpdate: false`), so exactly the same datasets keep
 * being refreshed. The result is saved at once, so it runs only once. A file
 * that exists but is corrupt falls back to Off without migrating.
 */
export function loadAutoDownloadSettings(dataDir: string, manifestPath: string): AutoDownloadSettings {
  const file = path.join(dataDir, AUTO_DOWNLOAD_FILE);
  let text: string | null = null;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  if (text !== null) {
    try {
      const raw = JSON.parse(text);
      return {
        intervalHours: isValidInterval(raw?.intervalHours) ? raw.intervalHours : 0,
        lastSweep: parseSweepRecord(raw?.lastSweep),
      };
    } catch {
      return { intervalHours: 0, lastSweep: null };
    }
  }

  const manifest = readManifest(manifestPath);
  const settings: AutoDownloadSettings = { intervalHours: 0, lastSweep: null };
  if (manifest.installs.some((i) => i.autoUpdate === true)) {
    settings.intervalHours = MIGRATED_INTERVAL;
    writeManifestAtomic(manifestPath, {
      ...manifest,
      installs: manifest.installs.map((i) => (i.autoUpdate === true ? i : { ...i, autoUpdate: false })),
    });
  }
  try {
    saveAutoDownloadSettingsAtomic(dataDir, settings);
  } catch {
    // Read-only data dir: still usable, the migration simply re-runs next start.
  }
  return settings;
}

/** Epoch ms when the next sweep is due: null while Off, 0 when it has never run (due now). */
export function nextDueAt(settings: AutoDownloadSettings): number | null {
  if (settings.intervalHours === 0) return null;
  if (!settings.lastSweep) return 0;
  return Date.parse(settings.lastSweep.at) + settings.intervalHours * 3600_000;
}

export interface AutoDownloadController {
  status(): AutoDownloadStatus;
  /** Persists the new interval and, when that makes a sweep due, starts it without waiting. */
  setInterval(hours: AutoDownloadInterval): AutoDownloadStatus;
  /** Runs a sweep if one is due. Resolves when it is done (or immediately when not due / already running). */
  tick(): Promise<void>;
  stop(): void;
}

export interface AutoDownloadSchedulerOptions {
  now?: () => number;
  /** Start the boot + recurring timers (default true; tests drive `tick()` by hand). */
  timers?: boolean;
  log?: (msg: string) => void;
}

export function createAutoDownloadScheduler(deps: AutoUpdateDeps, opts: AutoDownloadSchedulerOptions = {}): AutoDownloadController {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  let settings = loadAutoDownloadSettings(deps.dataDir, deps.manifestPath);
  let running = false;

  const persist = () => {
    try {
      saveAutoDownloadSettingsAtomic(deps.dataDir, settings);
    } catch (e) {
      log(`could not save ${AUTO_DOWNLOAD_FILE}: ${e}`);
    }
  };

  const tick = async () => {
    const due = nextDueAt(settings);
    if (running || due === null || now() < due) return;
    running = true;
    const intervalMs = settings.intervalHours * 3600_000;
    try {
      // sha256-checked sources only show as stale once the catalog has the
      // new hash; the catalog's own refresh runs daily by default, which
      // would make the hourly choice meaningless. Best effort: on failure
      // the cached catalog is used.
      const fetchedAt = deps.catalog.get().fetchedAt;
      if (!fetchedAt || now() - Date.parse(fetchedAt) > intervalMs) {
        try {
          await deps.catalog.refresh();
        } catch (e) {
          log(`catalog refresh before auto-download failed: ${e}`);
        }
      }
      const result = await runAutoUpdateSweep(deps);
      settings = { ...settings, lastSweep: { at: new Date(now()).toISOString(), ...result } };
      if (result.started.length > 0 || result.skippedDiskFull.length > 0) {
        log(`auto-download: started ${result.started.length}, skipped (disk almost full) ${result.skippedDiskFull.length}`);
      }
    } catch (e) {
      settings = {
        ...settings,
        lastSweep: { at: new Date(now()).toISOString(), started: [], skippedInFlight: [], skippedDiskFull: [], error: String(e) },
      };
      log(`auto-download sweep failed: ${e}`);
    } finally {
      running = false;
      persist();
    }
  };

  const status = (): AutoDownloadStatus => {
    const due = nextDueAt(settings);
    return {
      ...settings,
      choices: AUTO_DOWNLOAD_CHOICES,
      nextCheckAt: due === null ? null : new Date(Math.max(due, now())).toISOString(),
      running,
    };
  };

  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.timers !== false) {
    bootTimer = setTimeout(() => void tick(), AUTO_DOWNLOAD_BOOT_DELAY_MS);
    tickTimer = setInterval(() => void tick(), AUTO_DOWNLOAD_TICK_MS);
  }

  return {
    status,
    setInterval(hours) {
      settings = { ...settings, intervalHours: hours };
      persist();
      void tick();
      return status();
    },
    tick,
    stop() {
      if (bootTimer) clearTimeout(bootTimer);
      if (tickTimer) clearInterval(tickTimer);
      bootTimer = tickTimer = null;
    },
  };
}
