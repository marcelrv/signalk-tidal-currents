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
import { DownloadEngine, DownloadJob } from '../dist/downloads.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-autoupdate-'));
  const dirs = { harmonic: path.join(root, 'tcdata'), grib2: path.join(root, 'grib'), utcef: path.join(root, 'utcef') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { root, dirs, manifestPath: path.join(root, 'install-manifest.json') };
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
    type: 'harmonic', files: ['f.dat'], dir: 'harmonic', sha256: 'old-hash',
    size_bytes: 100, downloaded_at: new Date().toISOString(), autoUpdate: true,
    ...overrides,
  } as ManifestInstall;
}

class FakeDownloadEngine implements DownloadEngine {
  started: string[] = [];
  jobs: DownloadJob[] = [];
  throwFor = new Set<string>();
  start(sourceId: string): DownloadJob {
    if (this.throwFor.has(sourceId)) throw new Error(`refused: ${sourceId}`);
    this.started.push(sourceId);
    const job: DownloadJob = { id: `job-${this.started.length}`, catalogSourceId: sourceId, state: 'active', bytes: 0, totalBytes: null };
    this.jobs.push(job);
    return job;
  }
  get(id: string) { return this.jobs.find((j) => j.id === id); }
  list() { return this.jobs; }
  cancel() { /* unused */ }
  onUpdate() { return () => {}; }
  onAnyDone() { return () => {}; }
}

function baseDeps(root: string, dirs: AutoUpdateDeps['dirs'], manifestPath: string, catalog: CatalogClient, downloads: DownloadEngine): AutoUpdateDeps {
  return { catalog, downloads, manifestPath, dirs, managerDir: root };
}

test('starts an enabled + stale (sha256 mismatch) install, ignores a disabled one and a fresh one', async () => {
  const { root, dirs, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(dirs.harmonic, 'f.dat'), 'x');

  const stale = mkInstall({ id: 'stale', catalogSourceId: 'stale', sha256: 'old-hash' });
  const disabled = mkInstall({ id: 'disabled', catalogSourceId: 'disabled', sha256: 'old-hash', autoUpdate: false });
  const fresh = mkInstall({ id: 'fresh', catalogSourceId: 'fresh', sha256: 'current-hash' });
  fs.writeFileSync(path.join(dirs.harmonic, 'f2.dat'), 'x');
  disabled.files = ['f.dat'];
  fresh.files = ['f.dat'];

  const manifest: InstallManifest = { manifest_version: 1, installs: [stale, disabled, fresh] };
  writeManifestAtomic(manifestPath, manifest);

  const catalog = fakeCatalogClient([mkSource('stale', 'new-hash'), mkSource('disabled', 'new-hash'), mkSource('fresh', 'current-hash')]);
  const downloads = new FakeDownloadEngine();
  const result = await runAutoUpdateSweep(baseDeps(root, dirs, manifestPath, catalog, downloads));

  assert.deepEqual(result.started, ['stale']);
  assert.deepEqual(downloads.started, ['stale']);
});

test('skips a candidate whose source already has a job queued/active', async () => {
  const { root, dirs, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(dirs.harmonic, 'f.dat'), 'x');
  const stale = mkInstall({ id: 'stale', catalogSourceId: 'stale', sha256: 'old-hash' });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [stale] });

  const catalog = fakeCatalogClient([mkSource('stale', 'new-hash')]);
  const downloads = new FakeDownloadEngine();
  downloads.jobs.push({ id: 'existing', catalogSourceId: 'stale', state: 'active', bytes: 0, totalBytes: null });

  const result = await runAutoUpdateSweep(baseDeps(root, dirs, manifestPath, catalog, downloads));
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.skippedInFlight, ['stale']);
});

test('start() failure for one candidate (e.g. source removed) does not abort the rest of the sweep', async () => {
  const { root, dirs, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(dirs.harmonic, 'f.dat'), 'x');
  const a = mkInstall({ id: 'a', catalogSourceId: 'a', sha256: 'old-hash' });
  const b = mkInstall({ id: 'b', catalogSourceId: 'b', sha256: 'old-hash' });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [a, b] });

  const catalog = fakeCatalogClient([mkSource('a', 'new-hash'), mkSource('b', 'new-hash')]);
  const downloads = new FakeDownloadEngine();
  downloads.throwFor.add('a');

  const result = await runAutoUpdateSweep(baseDeps(root, dirs, manifestPath, catalog, downloads));
  assert.deepEqual(result.started, ['b']);
});

test('skips a candidate that would push disk usage past 90% full', async () => {
  const { root, dirs, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(dirs.harmonic, 'f.dat'), 'x');
  const stale = mkInstall({ id: 'stale', catalogSourceId: 'stale', sha256: 'old-hash', size_bytes: 50 });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [stale] });

  const catalog = fakeCatalogClient([mkSource('stale', 'new-hash')]);
  const downloads = new FakeDownloadEngine();

  const originalStatfs = (fs.promises as any).statfs;
  // 100 total bytes, 51 free (49 used) — adding the 50-byte re-download
  // would push used-after to 99/100 = 99%, over the 90% threshold.
  (fs.promises as any).statfs = async () => ({ bsize: 1, blocks: 100, bfree: 51 });
  try {
    const result = await runAutoUpdateSweep(baseDeps(root, dirs, manifestPath, catalog, downloads));
    assert.deepEqual(result.started, []);
    assert.deepEqual(result.skippedDiskFull, ['stale']);
  } finally {
    (fs.promises as any).statfs = originalStatfs;
  }
});

test('no candidates when nothing is stale or nothing has autoUpdate enabled', async () => {
  const { root, dirs, manifestPath } = tmpDirs();
  fs.writeFileSync(path.join(dirs.harmonic, 'f.dat'), 'x');
  const fresh = mkInstall({ id: 'fresh', catalogSourceId: 'fresh', sha256: 'current-hash' });
  writeManifestAtomic(manifestPath, { manifest_version: 1, installs: [fresh] });

  const catalog = fakeCatalogClient([mkSource('fresh', 'current-hash')]);
  const downloads = new FakeDownloadEngine();
  const result = await runAutoUpdateSweep(baseDeps(root, dirs, manifestPath, catalog, downloads));
  assert.deepEqual(result.started, []);
});
