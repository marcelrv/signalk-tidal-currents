// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runAutoUpdateSweep, AutoUpdateDeps } from '../dist/autoUpdate.js';
import { writeManifestAtomic, InstallManifest, ManifestInstall } from '../dist/manifest.js';
import { CatalogClient, CatalogState } from '../dist/catalog.js';
import { CatalogDocument, CatalogSource } from '../dist/catalogTypes.js';
import { DownloadEngine, DownloadJob, FileSelector, selectorsOverlap } from '../dist/downloads.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-autoupdate-'));
  return { root, manifestPath: path.join(root, 'install-manifest.json') };
}

function fakeCatalogClient(sources: CatalogSource[]): CatalogClient {
  const document: CatalogDocument = {
    catalog_schema_version: '1.0.0', version: 1, generated: new Date().toISOString(),
    source_count: sources.length, sources,
  };
  const state: CatalogState = { status: 'cached', document, fetchedAt: new Date().toISOString(), error: null, sourceUrl: 'https://example.org/x.json', warnings: [] };
  return { get: () => state, refresh: async () => state };
}

function region() {
  return {
    name: 'Test', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 },
    boundary_geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  };
}

function mkSource(id: string, sha256: string): CatalogSource {
  return {
    id, source: 'test', type: 'harmonic', name: `Source ${id}`, description: '', contributor: 'Test', url: 'https://x',
    tags: [], region: region(),
    update_check: { method: 'sha256', last_checked: new Date().toISOString() },
    files: [{ filename: 'f.dat', url: 'https://x/f.dat', size_bytes: 100, sha256 }],
  } as unknown as CatalogSource;
}

function mkInstall(overrides: Partial<ManifestInstall> & Pick<ManifestInstall, 'id' | 'catalogSourceId'>): ManifestInstall {
  return {
    type: 'harmonic', files: ['f.dat'], sha256: 'old-hash',
    size_bytes: 100, downloaded_at: new Date().toISOString(), autoUpdate: true,
    ...overrides,
  } as ManifestInstall;
}

class FakeDownloadEngine implements DownloadEngine {
  started: string[] = [];
  jobs: DownloadJob[] = [];
  selectors = new Map<string, FileSelector | undefined>();
  throwFor = new Set<string>();
  start(sourceId: string, fileSelector?: FileSelector): DownloadJob {
    if (this.throwFor.has(sourceId)) throw new Error(`refused: ${sourceId}`);
    this.started.push(sourceId);
    const job: DownloadJob = { id: `job-${this.started.length}`, catalogSourceId: sourceId, state: 'active', bytes: 0, totalBytes: null };
    this.jobs.push(job);
    this.selectors.set(job.id, fileSelector);
    return job;
  }
  get(id: string) { return this.jobs.find((j) => j.id === id); }
  list() { return this.jobs; }
  cancel() { /* unused */ }
  onUpdate() { return () => {}; }
  onAnyDone() { return () => {}; }
  hasInFlight(sourceId: string, selector?: FileSelector): boolean {
    return this.jobs.some(
      (j) => j.catalogSourceId === sourceId && (j.state === 'queued' || j.state === 'active') && selectorsOverlap(this.selectors.get(j.id), selector),
    );
  }
}

function baseDeps(root: string, manifestPath: string, catalog: CatalogClient, downloads: DownloadEngine): AutoUpdateDeps {
  return { catalog, downloads, manifestPath, dataDir: root };
}

test('starts an enabled + stale (sha256 mismatch) install, ignores a disabled one and a fresh one', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');

  const stale = mkInstall({ id: 'stale', catalogSourceId: 'stale', sha256: 'old-hash' });
  const disabled = mkInstall({ id: 'disabled', catalogSourceId: 'disabled', sha256: 'old-hash', autoUpdate: false });
  const fresh = mkInstall({ id: 'fresh', catalogSourceId: 'fresh', sha256: 'current-hash' });
  fs.writeFileSync(path.join(root, 'f2.dat'), 'x');
  disabled.files = ['f.dat'];
  fresh.files = ['f.dat'];

  const manifest: InstallManifest = { manifest_version: 1, installs: [stale, disabled, fresh] };
  writeManifestAtomic(manifestPath, manifest);

  const catalog = fakeCatalogClient([mkSource('stale', 'new-hash'), mkSource('disabled', 'new-hash'), mkSource('fresh', 'current-hash')]);
  const downloads = new FakeDownloadEngine();
  const result = await runAutoUpdateSweep(baseDeps(root, manifestPath, catalog, downloads));

  assert.deepEqual(result.started, ['stale']);
  assert.deepEqual(downloads.started, ['stale']);
});

test('skips a candidate whose source already has a job queued/active', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  const stale = mkInstall({ id: 'stale', catalogSourceId: 'stale', sha256: 'old-hash' });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [stale] });

  const catalog = fakeCatalogClient([mkSource('stale', 'new-hash')]);
  const downloads = new FakeDownloadEngine();
  downloads.jobs.push({ id: 'existing', catalogSourceId: 'stale', state: 'active', bytes: 0, totalBytes: null });

  const result = await runAutoUpdateSweep(baseDeps(root, manifestPath, catalog, downloads));
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.skippedInFlight, ['stale']);
});

test('start() failure for one candidate (e.g. source removed) does not abort the rest of the sweep', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  const a = mkInstall({ id: 'a', catalogSourceId: 'a', sha256: 'old-hash' });
  const b = mkInstall({ id: 'b', catalogSourceId: 'b', sha256: 'old-hash' });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [a, b] });

  const catalog = fakeCatalogClient([mkSource('a', 'new-hash'), mkSource('b', 'new-hash')]);
  const downloads = new FakeDownloadEngine();
  downloads.throwFor.add('a');

  const result = await runAutoUpdateSweep(baseDeps(root, manifestPath, catalog, downloads));
  assert.deepEqual(result.started, ['b']);
});

test('skips a candidate that would push disk usage past 90% full', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  const stale = mkInstall({ id: 'stale', catalogSourceId: 'stale', sha256: 'old-hash', size_bytes: 50 });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [stale] });

  const catalog = fakeCatalogClient([mkSource('stale', 'new-hash')]);
  const downloads = new FakeDownloadEngine();

  const originalStatfs = (fs.promises as any).statfs;
  // 100 total bytes, 51 free (49 used) — adding the 50-byte re-download
  // would push used-after to 99/100 = 99%, over the 90% threshold.
  (fs.promises as any).statfs = async () => ({ bsize: 1, blocks: 100, bfree: 51 });
  try {
    const result = await runAutoUpdateSweep(baseDeps(root, manifestPath, catalog, downloads));
    assert.deepEqual(result.started, []);
    assert.deepEqual(result.skippedDiskFull, ['stale']);
  } finally {
    (fs.promises as any).statfs = originalStatfs;
  }
});

test('no candidates when nothing is stale or nothing has autoUpdate enabled', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'f.dat'), 'x');
  const fresh = mkInstall({ id: 'fresh', catalogSourceId: 'fresh', sha256: 'current-hash' });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [fresh] });

  const catalog = fakeCatalogClient([mkSource('fresh', 'current-hash')]);
  const downloads = new FakeDownloadEngine();
  const result = await runAutoUpdateSweep(baseDeps(root, manifestPath, catalog, downloads));
  assert.deepEqual(result.started, []);
});

function mkTemplateSource(id: string, files: Array<{ region_id: string; type: 'nowcast' | 'forecast'; variant?: string }>): CatalogSource {
  return {
    id, source: 'bsh', type: 'grib2', name: `Source ${id}`, description: '', contributor: 'Test', url: 'https://x',
    tags: [], region: region(),
    update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 1 },
    files: files.map((f) => ({
      region_id: f.region_id, name: f.region_id, description: '', boundary_geometry: region().boundary_geometry,
      type: f.type, variant: f.variant, url_template: 'https://x/{YYYYMMDD}/{HH}/f{hour:03d}.grb2',
      forecast_hours: [24], cycle_hours: ['00'],
    })),
  } as unknown as CatalogSource;
}

function mkTemplateInstall(overrides: Partial<ManifestInstall> & Pick<ManifestInstall, 'id' | 'catalogSourceId'>): ManifestInstall {
  return {
    type: 'grib2', files: ['f.dat'], size_bytes: 100, downloaded_at: new Date().toISOString(), autoUpdate: true,
    // 48h old vs the source's 1h max_age_hours above — always stale.
    cycle: new Date(Date.now() - 48 * 3600_000).toISOString(),
    ...overrides,
  } as ManifestInstall;
}

test('a BSH-style nowcast job already in flight does not block its sibling forecast+24h variant of the SAME source', async () => {
  const { root, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(root, 'nowcast.dat'), 'x');
  fs.writeFileSync(path.join(root, 'forecast.dat'), 'x');

  const nowcastInstall = mkTemplateInstall({
    id: 'bsh_currents:north_sea:nowcast', catalogSourceId: 'bsh_currents', files: ['nowcast.dat'],
    regionId: 'north_sea', fileType: 'nowcast',
  });
  const forecastInstall = mkTemplateInstall({
    id: 'bsh_currents:north_sea:forecast:+24h', catalogSourceId: 'bsh_currents', files: ['forecast.dat'],
    regionId: 'north_sea', fileType: 'forecast', variant: '+24h',
  });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [nowcastInstall, forecastInstall] });

  const catalog = fakeCatalogClient([
    mkTemplateSource('bsh_currents', [
      { region_id: 'north_sea', type: 'nowcast' },
      { region_id: 'north_sea', type: 'forecast', variant: '+24h' },
    ]),
  ]);
  const downloads = new FakeDownloadEngine();
  // A previous sweep already started the nowcast variant; it's still in flight.
  downloads.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });

  const result = await runAutoUpdateSweep(baseDeps(root, manifestPath, catalog, downloads));

  assert.deepEqual(result.skippedInFlight, ['bsh_currents:north_sea:nowcast']);
  assert.deepEqual(result.started, ['bsh_currents:north_sea:forecast:+24h']);
});
