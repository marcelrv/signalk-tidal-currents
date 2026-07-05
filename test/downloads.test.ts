// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Exercises the download engine against a local node:http server — fully
 * deterministic, no offline-skip needed (unlike catalog-live.test.ts, which
 * hits the real remote catalog).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDownloadEngine, DownloadJob } from '../dist/downloads.js';
import { readManifest } from '../dist/manifest.js';
import { CatalogDocument, CatalogSource } from '../dist/catalogTypes.js';
import { CatalogClient, CatalogState } from '../dist/catalog.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-downloads-'));
  const dirs = { harmonic: path.join(root, 'tcdata'), grib2: path.join(root, 'grib'), utcef: path.join(root, 'utcef') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { root, dirs, manifestPath: path.join(root, 'install-manifest.json') };
}

function fakeCatalogClient(sources: CatalogSource[]): CatalogClient {
  const document: CatalogDocument = {
    catalog_schema_version: '1.0.0', version: 1, generated: new Date().toISOString(),
    source_count: sources.length, sources,
  };
  const state: CatalogState = { status: 'cached', document, fetchedAt: new Date().toISOString(), error: null, sourceUrl: 'https://example.org/tide-current-index.json', warnings: [] };
  return { get: () => state, refresh: async () => state };
}

function region() {
  return {
    name: 'Test', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 },
    boundary_geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  };
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('static file with correct sha256 downloads, verifies, updates manifest', async () => {
  const content = Buffer.from('hello utcef world'.repeat(100));
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  await withServer(
    (req, res) => { res.writeHead(200, { 'Content-Length': String(content.length) }); res.end(content); },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'test-utcef', source: 'test', type: 'utcef', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'netherlands.utcef', url: `${baseUrl}/netherlands.utcef`, sha256, size_bytes: content.length }],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('test-utcef');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      const target = path.join(dirs.utcef, 'netherlands.utcef');
      assert.ok(fs.existsSync(target));
      assert.ok(!fs.existsSync(`${target}.part`));
      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      assert.equal(manifest.installs[0].sha256, sha256);
      assert.equal(manifest.installs[0].dir, 'utcef');
    },
  );
});

test('wrong sha256 fails the job, writes nothing to the manifest, cleans up', async () => {
  const content = Buffer.from('corrupted content');
  await withServer(
    (req, res) => { res.writeHead(200); res.end(content); },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'bad-hash', source: 'test', type: 'grib2', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'f.grb2', url: `${baseUrl}/f.grb2`, sha256: 'deadbeef'.repeat(8), size_bytes: content.length }],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('bad-hash');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'error');
      assert.ok(/sha256 mismatch/.test(final.error ?? ''));
      assert.ok(!fs.existsSync(path.join(dirs.grib2, 'f.grb2')));
      assert.equal(readManifest(manifestPath).installs.length, 0);
    },
  );
});

test('missing url and sha256 falls back to a catalog-derived base URL and skips verification', async () => {
  const content = Buffer.from('derived-url content');
  await withServer(
    (req, res) => {
      assert.equal(req.url, '/netherlands.utcef'); // proves the base-URL fallback was used
      res.writeHead(200); res.end(content);
    },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'no-url', source: 'test', type: 'utcef', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'netherlands.utcef', size_bytes: content.length }],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('no-url');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.ok(fs.existsSync(path.join(dirs.utcef, 'netherlands.utcef')));
      assert.equal(readManifest(manifestPath).installs[0].sha256, undefined);
    },
  );
});

test('job.bytes increases monotonically during a slow/chunked response', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Length': '30' });
      let sent = 0;
      const iv = setInterval(() => {
        res.write(Buffer.alloc(10, 65));
        sent += 10;
        if (sent >= 30) { clearInterval(iv); res.end(); }
      }, 20);
    },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'slow', source: 'test', type: 'harmonic', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'HARMONIC', url: `${baseUrl}/slow`, size_bytes: 30 }],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('slow');
      const samples: number[] = [];
      while (engine.get(job.id)!.state !== 'done' && engine.get(job.id)!.state !== 'error') {
        samples.push(engine.get(job.id)!.bytes);
        await new Promise((r) => setTimeout(r, 5));
      }
      samples.push(engine.get(job.id)!.bytes);
      assert.equal(engine.get(job.id)!.state, 'done');
      for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1], samples.join(','));
      assert.equal(samples[samples.length - 1], 30);
    },
  );
});

test('template file: exact {YYYYMMDD}/{HH}/{hour:03d} substitution, all forecast hours land, one manifest entry', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => { requestedPaths.push(req.url ?? ''); res.writeHead(200); res.end(Buffer.from('grib-bytes')); },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const cycleIso = '2026-07-03T00:00:00Z';
      const source: CatalogSource = {
        id: 'grib-template', source: 'noaa', type: 'grib2', name: 'Forecast', description: '',
        contributor: 'NOAA', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 24, latest_cycle: cycleIso },
        files: [{
          region_id: 'nw-europe', name: 'NW Europe', description: '', boundary_geometry: region().boundary_geometry,
          type: 'forecast', url_template: `${baseUrl}/{YYYYMMDD}/{HH}/f{hour:03d}.grb2`,
          forecast_hours: [24, 48], cycle_hours: ['00'],
        }],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('grib-template');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.deepEqual(requestedPaths.sort(), ['/20260703/00/f024.grb2', '/20260703/00/f048.grb2']);
      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      assert.equal(manifest.installs[0].id, 'grib-template:nw-europe:forecast');
      assert.equal(manifest.installs[0].files.length, 2);
      assert.equal(manifest.installs[0].cycle, cycleIso);
      assert.equal(manifest.installs[0].sha256, undefined);
      assert.equal(manifest.installs[0].dir, 'grib');
      assert.equal(manifest.installs[0].regionId, 'nw-europe');
      assert.equal(manifest.installs[0].fileType, 'forecast');
    },
  );
});

test('multi-region template source: region_id selector picks the RIGHT region, not just the first one', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => { requestedPaths.push(req.url ?? ''); res.writeHead(200); res.end(Buffer.from('grib-bytes')); },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const cycleIso = '2026-07-03T00:00:00Z';
      const mkTemplate = (regionId: string) => ({
        region_id: regionId, name: regionId, description: '', boundary_geometry: region().boundary_geometry,
        type: 'forecast' as const, url_template: `${baseUrl}/${regionId}/{YYYYMMDD}/{HH}/f{hour:03d}.grb2`,
        forecast_hours: [24], cycle_hours: ['00'],
      });
      const source: CatalogSource = {
        id: 'noaa-multi', source: 'noaa', type: 'grib2', name: 'NOAA Multi-Region', description: '',
        contributor: 'NOAA', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 24, latest_cycle: cycleIso },
        files: [mkTemplate('gulf-of-mexico'), mkTemplate('caribbean'), mkTemplate('west-coast')],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      // Without a selector, a genuinely ambiguous multi-region source must
      // still be rejected eagerly (not silently default to the first region).
      assert.throws(() => engine.start('noaa-multi'), /region_id selector is required/);

      const job = engine.start('noaa-multi', { region_id: 'caribbean' });
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.deepEqual(requestedPaths, ['/caribbean/20260703/00/f024.grb2']);
      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      assert.equal(manifest.installs[0].regionId, 'caribbean');
      assert.equal(manifest.installs[0].id, 'noaa-multi:caribbean:forecast');
    },
  );
});

test('a region with BOTH a forecast and a nowcast file (real NOAA shape): region_id alone is ambiguous, type disambiguates, both installs coexist', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => { requestedPaths.push(req.url ?? ''); res.writeHead(200); res.end(Buffer.from('x')); },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const cycleIso = '2026-07-03T00:00:00Z';
      const source: CatalogSource = {
        id: 'noaa_rtofs', source: 'noaa', type: 'grib2', name: 'NOAA RTOFS', description: '',
        contributor: 'NOAA', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 24, latest_cycle: cycleIso },
        files: [
          {
            region_id: 'west_atl', name: 'Western Atlantic', description: '', boundary_geometry: region().boundary_geometry,
            type: 'forecast', url_template: `${baseUrl}/forecast/{YYYYMMDD}/{HH}/f{hour:03d}.grb2`,
            forecast_hours: [24], cycle_hours: ['00'],
          },
          {
            region_id: 'west_atl', name: 'Western Atlantic', description: '', boundary_geometry: region().boundary_geometry,
            type: 'nowcast', url_template: `${baseUrl}/nowcast/{YYYYMMDD}/{HH}/n{hour:03d}.grb2`,
            forecast_hours: [24], cycle_hours: ['00'],
          },
        ],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      // region_id alone still resolves to 2 files — must be rejected, not
      // silently default to whichever came first in the catalog's array.
      assert.throws(() => engine.start('noaa_rtofs', { region_id: 'west_atl' }), /multiple types/);

      const forecastJob = engine.start('noaa_rtofs', { region_id: 'west_atl', type: 'forecast' });
      await waitFor(() => engine.get(forecastJob.id)!.state === 'done' || engine.get(forecastJob.id)!.state === 'error');
      assert.equal(engine.get(forecastJob.id)!.state, 'done', engine.get(forecastJob.id)!.error);

      const nowcastJob = engine.start('noaa_rtofs', { region_id: 'west_atl', type: 'nowcast' });
      await waitFor(() => engine.get(nowcastJob.id)!.state === 'done' || engine.get(nowcastJob.id)!.state === 'error');
      assert.equal(engine.get(nowcastJob.id)!.state, 'done', engine.get(nowcastJob.id)!.error);

      assert.deepEqual(requestedPaths.sort(), ['/forecast/20260703/00/f024.grb2', '/nowcast/20260703/00/n024.grb2']);
      const manifest = readManifest(manifestPath);
      // Both installs must coexist, not clobber each other.
      assert.equal(manifest.installs.length, 2);
      const ids = manifest.installs.map((i) => i.id).sort();
      assert.deepEqual(ids, ['noaa_rtofs:west_atl:forecast', 'noaa_rtofs:west_atl:nowcast']);
    },
  );
});

test('multi-file static source (e.g. a HARMONIC + .IDX pair): no selector required, both files download', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from('x')); },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'harmonic-pair', source: 'opencpn', type: 'harmonic', name: 'OpenCPN XTide Harmonics', description: '',
        contributor: 'OpenCPN', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [
          { filename: 'HARMONICS_NO_US', url: `${baseUrl}/HARMONICS_NO_US`, size_bytes: 1 },
          { filename: 'HARMONICS_NO_US.IDX', url: `${baseUrl}/HARMONICS_NO_US.IDX`, size_bytes: 1 },
        ],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      // The bug: this used to throw "2 files — a filename or region_id
      // selector is required" even though runJob downloads all static files
      // in a source together regardless of any selector.
      const job = engine.start('harmonic-pair');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.ok(fs.existsSync(path.join(dirs.harmonic, 'HARMONICS_NO_US')));
      assert.ok(fs.existsSync(path.join(dirs.harmonic, 'HARMONICS_NO_US.IDX')));
      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs[0].files.length, 2);
    },
  );
});

test('retry after a failed download leaves no stale .part blocking the next attempt', async () => {
  let attempt = 0;
  await withServer(
    (req, res) => {
      attempt++;
      if (attempt === 1) { res.destroy(); return; } // simulate a broken first attempt
      res.writeHead(200); res.end(Buffer.from('ok on retry'));
    },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'retry-me', source: 'test', type: 'harmonic', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'HARMONIC', url: `${baseUrl}/flaky`, size_bytes: 11 }],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const first = engine.start('retry-me');
      await waitFor(() => engine.get(first.id)!.state === 'done' || engine.get(first.id)!.state === 'error');
      assert.equal(engine.get(first.id)!.state, 'error');
      assert.ok(!fs.existsSync(path.join(dirs.harmonic, 'HARMONIC.part')));

      const second = engine.start('retry-me');
      await waitFor(() => engine.get(second.id)!.state === 'done' || engine.get(second.id)!.state === 'error');
      assert.equal(engine.get(second.id)!.state, 'done', engine.get(second.id)!.error);
      assert.ok(fs.existsSync(path.join(dirs.harmonic, 'HARMONIC')));
    },
  );
});

test('directory routing: harmonic/grib2/utcef land in their own configured dirs', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from('x')); },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const mk = (id: string, type: 'harmonic' | 'grib2' | 'utcef', filename: string): CatalogSource => ({
        id, source: 'test', type, name: id, description: '', contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename, url: `${baseUrl}/${filename}`, size_bytes: 1 }],
      });
      const sources = [mk('h', 'harmonic', 'HARMONIC'), mk('g', 'grib2', 'f.grb2'), mk('u', 'utcef', 'x.utcef')];
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient(sources), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const jobs: DownloadJob[] = [engine.start('h'), engine.start('g'), engine.start('u')];
      await waitFor(() => jobs.every((j) => ['done', 'error'].includes(engine.get(j.id)!.state)));
      for (const j of jobs) assert.equal(engine.get(j.id)!.state, 'done', engine.get(j.id)!.error);
      assert.ok(fs.existsSync(path.join(dirs.harmonic, 'HARMONIC')));
      assert.ok(fs.existsSync(path.join(dirs.grib2, 'f.grb2')));
      assert.ok(fs.existsSync(path.join(dirs.utcef, 'x.utcef')));
    },
  );
});

test('onUpdate() streams progress with monotonic bytes, terminal state last, double-unsubscribe is safe', async () => {
  // Chunks spaced well past the engine's 200ms progress-emit throttle, so
  // more than one progress notification is guaranteed to survive it (this
  // engine.start()/engine.onUpdate() call pair happens back-to-back with no
  // intervening await, so the subscription is registered before the fetch()
  // for this download can possibly resolve — no chunk can be missed).
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Length': '30' });
      let sent = 0;
      const iv = setInterval(() => {
        res.write(Buffer.alloc(10, 65));
        sent += 10;
        if (sent >= 30) { clearInterval(iv); res.end(); }
      }, 250);
    },
    async (baseUrl) => {
      const { dirs, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'watched', source: 'test', type: 'harmonic', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'HARMONIC', url: `${baseUrl}/slow`, size_bytes: 30 }],
      };
      const engine = createDownloadEngine({ dirs, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const job = engine.start('watched');
      const seen: DownloadJob[] = [];
      const unsubscribe = engine.onUpdate(job.id, (j) => seen.push(j));

      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error', 5000);

      assert.equal(engine.get(job.id)!.state, 'done');
      assert.ok(seen.length >= 2, `expected at least one progress emission and a terminal one, got ${seen.length}`);
      assert.equal(seen[seen.length - 1].state, 'done');
      assert.equal(seen[seen.length - 1].bytes, 30);
      for (let i = 1; i < seen.length; i++) assert.ok(seen[i].bytes >= seen[i - 1].bytes, seen.map((s) => s.bytes).join(','));

      unsubscribe();
      assert.doesNotThrow(() => unsubscribe());
    },
  );
});
