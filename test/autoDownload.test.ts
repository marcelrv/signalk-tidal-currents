// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AUTO_DOWNLOAD_FILE,
  AUTO_DOWNLOAD_RETRY_MS,
  MIGRATED_INTERVAL,
  createAutoDownloadScheduler,
  isValidInterval,
  loadAutoDownloadSettings,
  nextDueAt,
  saveAutoDownloadSettingsAtomic,
} from '../dist/autoDownload.js';
import { readManifest, writeManifestAtomic, ManifestInstall } from '../dist/manifest.js';
import { CatalogClient, CatalogState } from '../dist/catalog.js';
import { CatalogSource } from '../dist/catalogTypes.js';
import { DownloadEngine, DownloadJob } from '../dist/downloads.js';

const HOUR = 3600_000;

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-autodownload-'));
  return { root, manifestPath: path.join(root, 'install-manifest.json') };
}

function install(id: string, autoUpdate?: boolean): ManifestInstall {
  return {
    id, catalogSourceId: id, type: 'harmonic', files: ['f.dat'], sha256: 'old-hash', size_bytes: 1,
    downloaded_at: new Date().toISOString(), ...(autoUpdate === undefined ? {} : { autoUpdate }),
  } as ManifestInstall;
}

function source(id: string, sha256: string): CatalogSource {
  return {
    id, source: 'test', type: 'harmonic', name: id, description: '', contributor: 'T', url: 'https://x', tags: [],
    region: { name: 'r', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 }, boundary_geometry: { type: 'Polygon', coordinates: [] } },
    update_check: { method: 'sha256', last_checked: new Date().toISOString() },
    files: [{ filename: 'f.dat', url: 'https://x/f.dat', size_bytes: 1, sha256 }],
  } as unknown as CatalogSource;
}

/** Catalog whose refresh() swaps in `afterRefresh` sources and bumps fetchedAt to "now". */
function fakeCatalog(sources: CatalogSource[], fetchedAt: string | null, now: () => number, afterRefresh = sources) {
  let state: CatalogState = {
    status: 'cached', fetchedAt, error: null, sourceUrl: 'https://example.org/c.json', warnings: [],
    document: { catalog_schema_version: '1.0.0', version: 1, generated: '', source_count: sources.length, sources },
  };
  const client: CatalogClient & { refreshes: number } = {
    refreshes: 0,
    get: () => state,
    refresh: async () => {
      client.refreshes++;
      state = { ...state, fetchedAt: new Date(now()).toISOString(), document: { ...state.document!, sources: afterRefresh } };
      return state;
    },
  };
  return client;
}

function fakeDownloads(): DownloadEngine & { started: string[] } {
  const started: string[] = [];
  return {
    started,
    start: (id) => { started.push(id); return { id: `j${started.length}`, catalogSourceId: id, state: 'queued', bytes: 0, totalBytes: null } as DownloadJob; },
    get: () => undefined, list: () => [], cancel: () => {}, onUpdate: () => () => {}, onAnyDone: () => () => {}, hasInFlight: () => false,
  };
}

test('isValidInterval accepts only the offered choices', () => {
  for (const v of [0, 1, 6, 12, 24]) assert.ok(isValidInterval(v));
  for (const v of [3, -1, 1.5, '6', null, undefined]) assert.ok(!isValidInterval(v));
});

test('no settings file and no opted-in installs: Off, manifest untouched, file written', () => {
  const { root, manifestPath } = tmpDirs();
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('a'), install('b', false)] });
  const before = fs.readFileSync(manifestPath, 'utf8');
  const s = loadAutoDownloadSettings(root, manifestPath);
  assert.equal(s.intervalHours, 0);
  assert.equal(s.lastSweep, null);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(root, AUTO_DOWNLOAD_FILE)));
});

test('migration: old per-dataset opt-ins switch auto-download on and opt every other install out, once', () => {
  const { root, manifestPath } = tmpDirs();
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('on', true), install('never'), install('off', false)] });
  const s = loadAutoDownloadSettings(root, manifestPath);
  assert.equal(s.intervalHours, MIGRATED_INTERVAL);
  const byId = Object.fromEntries(readManifest(manifestPath).installs.map((i) => [i.id, i.autoUpdate]));
  assert.deepEqual(byId, { on: true, never: false, off: false });

  // Second load reads the saved file — a later re-include of 'never' must not be undone.
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('on', true), install('never', true), install('off', false)] });
  assert.equal(loadAutoDownloadSettings(root, manifestPath).intervalHours, MIGRATED_INTERVAL);
  assert.equal(readManifest(manifestPath).installs.find((i) => i.id === 'never')!.autoUpdate, true);
});

test('save/load round-trip; a corrupt file falls back to Off without migrating', () => {
  const { root, manifestPath } = tmpDirs();
  const lastSweep = { at: '2026-01-01T00:00:00.000Z', started: ['x'], skippedInFlight: [], skippedDiskFull: ['y'] };
  saveAutoDownloadSettingsAtomic(root, { intervalHours: 12, lastSweep });
  assert.deepEqual(loadAutoDownloadSettings(root, manifestPath), { intervalHours: 12, lastSweep });

  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('on', true)] });
  fs.writeFileSync(path.join(root, AUTO_DOWNLOAD_FILE), '{not json');
  assert.deepEqual(loadAutoDownloadSettings(root, manifestPath), { intervalHours: 0, lastSweep: null });
  fs.writeFileSync(path.join(root, AUTO_DOWNLOAD_FILE), JSON.stringify({ intervalHours: 5 }));
  assert.equal(loadAutoDownloadSettings(root, manifestPath).intervalHours, 0);
});

test('nextDueAt: null while Off, 0 when never swept, else last sweep + interval', () => {
  assert.equal(nextDueAt({ intervalHours: 0, lastSweep: null }), null);
  assert.equal(nextDueAt({ intervalHours: 6, lastSweep: null }), 0);
  const at = '2026-01-01T00:00:00.000Z';
  assert.equal(nextDueAt({ intervalHours: 6, lastSweep: { at, started: [], skippedInFlight: [], skippedDiskFull: [] } }), Date.parse(at) + 6 * HOUR);
});

test('scheduler: Off never sweeps; switching on sweeps at once; then waits for the interval', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('a'), install('optout', false)] });
  let t = Date.parse('2026-06-01T00:00:00Z');
  const now = () => t;
  const catalog = fakeCatalog([source('a', 'new'), source('optout', 'new')], new Date(t).toISOString(), now);
  const downloads = fakeDownloads();
  const sched = createAutoDownloadScheduler({ catalog, downloads, manifestPath, dataDir: root }, { now, timers: false });

  await sched.tick();
  assert.deepEqual(downloads.started, [], 'Off: no sweep');
  assert.equal(sched.status().nextCheckAt, null);

  const st = sched.setInterval(6);
  assert.equal(st.running, true, 'switching on starts a sweep right away');
  for (let i = 0; i < 200 && sched.status().running; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(sched.status().running, false);
  assert.deepEqual(downloads.started, ['a'], 'opted-out install is skipped');
  assert.equal(catalog.refreshes, 0, 'catalog fresh enough: no refresh');
  const saved = JSON.parse(fs.readFileSync(path.join(root, AUTO_DOWNLOAD_FILE), 'utf8'));
  assert.equal(saved.intervalHours, 6);
  assert.deepEqual(saved.lastSweep.started, ['a']);
  assert.equal(sched.status().nextCheckAt, new Date(t + 6 * HOUR).toISOString());

  t += 5 * HOUR;
  await sched.tick();
  assert.deepEqual(downloads.started, ['a'], 'not due yet');
  t += 1 * HOUR;
  await sched.tick();
  assert.deepEqual(downloads.started, ['a', 'a'], 'due again after the interval');
});

test('scheduler: a catalog older than the interval is refreshed before the sweep', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('a')] });
  saveAutoDownloadSettingsAtomic(root, { intervalHours: 1, lastSweep: null });
  const t = Date.parse('2026-06-01T00:00:00Z');
  // The cached catalog still has the installed hash; only a refresh reveals the update.
  const catalog = fakeCatalog([source('a', 'old-hash')], new Date(t - 2 * HOUR).toISOString(), () => t, [source('a', 'new')]);
  const downloads = fakeDownloads();
  const sched = createAutoDownloadScheduler({ catalog, downloads, manifestPath, dataDir: root }, { now: () => t, timers: false });
  await sched.tick();
  assert.equal(catalog.refreshes, 1);
  assert.deepEqual(downloads.started, ['a']);
});

test('scheduler: a persisted recent sweep is not repeated after a restart', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('a')] });
  const t = Date.parse('2026-06-01T12:00:00Z');
  saveAutoDownloadSettingsAtomic(root, {
    intervalHours: 24, lastSweep: { at: new Date(t - HOUR).toISOString(), started: [], skippedInFlight: [], skippedDiskFull: [] },
  });
  const downloads = fakeDownloads();
  const sched = createAutoDownloadScheduler(
    { catalog: fakeCatalog([source('a', 'new')], new Date(t).toISOString(), () => t), downloads, manifestPath, dataDir: root },
    { now: () => t, timers: false },
  );
  await sched.tick();
  assert.deepEqual(downloads.started, []);
});

test('nextDueAt: a failed sweep (catalog or run) retries after AUTO_DOWNLOAD_RETRY_MS, capped by the interval', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const base = { at, started: [], skippedInFlight: [], skippedDiskFull: [] };
  assert.equal(nextDueAt({ intervalHours: 24, lastSweep: { ...base, catalogError: 'offline' } }), Date.parse(at) + AUTO_DOWNLOAD_RETRY_MS);
  assert.equal(nextDueAt({ intervalHours: 24, lastSweep: { ...base, error: 'boom' } }), Date.parse(at) + AUTO_DOWNLOAD_RETRY_MS);
  assert.equal(nextDueAt({ intervalHours: 1, lastSweep: { ...base, catalogError: 'offline' } }), Date.parse(at) + Math.min(HOUR, AUTO_DOWNLOAD_RETRY_MS));
});

test('nextDueAt: a last sweep in the future (clock corrected backwards) is due now', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const lastSweep = { at: '2027-06-01T00:00:00.000Z', started: [], skippedInFlight: [], skippedDiskFull: [] };
  assert.equal(nextDueAt({ intervalHours: 6, lastSweep }, now), 0);
});

test('scheduler: a failed catalog refresh still records the sweep and retries after the short delay, not every tick', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('a')] });
  saveAutoDownloadSettingsAtomic(root, { intervalHours: 24, lastSweep: null });
  let t = Date.parse('2026-06-01T00:00:00Z');
  const now = () => t;
  const catalog = fakeCatalog([source('a', 'new')], new Date(t - 48 * HOUR).toISOString(), now);
  catalog.refresh = async () => {
    catalog.refreshes++;
    return { ...catalog.get(), error: 'fetch failed' };
  };
  const downloads = fakeDownloads();
  const sched = createAutoDownloadScheduler({ catalog, downloads, manifestPath, dataDir: root }, { now, timers: false });

  await sched.tick();
  assert.deepEqual(downloads.started, ['a'], 'sweep runs on the cached catalog');
  const saved = JSON.parse(fs.readFileSync(path.join(root, AUTO_DOWNLOAD_FILE), 'utf8'));
  assert.equal(saved.lastSweep.catalogError, 'fetch failed');
  assert.deepEqual(saved.lastSweep.started, ['a']);

  t += 5 * 60_000;
  await sched.tick();
  assert.deepEqual(downloads.started, ['a'], 'not re-run on the next 5-min tick');
  t += AUTO_DOWNLOAD_RETRY_MS;
  await sched.tick();
  assert.equal(catalog.refreshes, 2, 'retried after the short delay');
});

test('scheduler: stop() during a sweep keeps it from saving over the successor\'s settings', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('a')] });
  saveAutoDownloadSettingsAtomic(root, { intervalHours: 1, lastSweep: null });
  const t = Date.parse('2026-06-01T00:00:00Z');
  const catalog = fakeCatalog([source('a', 'new')], null, () => t);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const realRefresh = catalog.refresh;
  catalog.refresh = async () => { await gate; return realRefresh(); };
  const downloads = fakeDownloads();
  const old = createAutoDownloadScheduler({ catalog, downloads, manifestPath, dataDir: root }, { now: () => t, timers: false });
  const pending = old.tick();
  old.stop();
  const successor = createAutoDownloadScheduler({ catalog, downloads, manifestPath, dataDir: root }, { now: () => t, timers: false });
  successor.setInterval(0);
  release();
  await pending;
  assert.deepEqual(downloads.started, [], 'stopped sweep starts nothing');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, AUTO_DOWNLOAD_FILE), 'utf8')).intervalHours, 0);
});

test('setInterval throws when the settings cannot be saved (and keeps the old value)', () => {
  const { root, manifestPath } = tmpDirs();
  const notADir = path.join(root, 'file-not-dir');
  fs.writeFileSync(notADir, 'x');
  const sched = createAutoDownloadScheduler(
    { catalog: fakeCatalog([], null, Date.now), downloads: fakeDownloads(), manifestPath, dataDir: notADir },
    { timers: false },
  );
  assert.throws(() => sched.setInterval(6));
  assert.equal(sched.status().intervalHours, 0);
});

test('migration stays Off when its settings file cannot be saved', () => {
  const { root, manifestPath } = tmpDirs();
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [install('on', true), install('never')] });
  const notADir = path.join(root, 'file-not-dir');
  fs.writeFileSync(notADir, 'x');
  assert.equal(loadAutoDownloadSettings(notADir, manifestPath).intervalHours, 0);
});
