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
  return { root, manifestPath: path.join(root, 'install-manifest.json') };
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
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'test-utcef', source: 'test', type: 'utcef', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'netherlands.utcef', url: `${baseUrl}/netherlands.utcef`, sha256, size_bytes: content.length }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('test-utcef');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      const target = path.join(root, 'utcef', 'netherlands.utcef');
      assert.ok(fs.existsSync(target));
      assert.ok(!fs.existsSync(`${target}.part`));
      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      assert.equal(manifest.installs[0].sha256, sha256);
    },
  );
});

test('wrong sha256 fails the job, writes nothing to the manifest, cleans up', async () => {
  const content = Buffer.from('corrupted content');
  await withServer(
    (req, res) => { res.writeHead(200); res.end(content); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'bad-hash', source: 'test', type: 'grib2', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'f.grb2', url: `${baseUrl}/f.grb2`, sha256: 'deadbeef'.repeat(8), size_bytes: content.length }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('bad-hash');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'error');
      assert.ok(/sha256 mismatch/.test(final.error ?? ''));
      assert.ok(!fs.existsSync(path.join(root, 'grib', 'f.grb2')));
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
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'no-url', source: 'test', type: 'utcef', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'netherlands.utcef', size_bytes: content.length }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('no-url');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.ok(fs.existsSync(path.join(root, 'utcef', 'netherlands.utcef')));
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
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'slow', source: 'test', type: 'harmonic', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'HARMONIC', url: `${baseUrl}/slow`, size_bytes: 30 }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('slow');
      const samples: number[] = [];
      const totalSamples: (number | null)[] = [];
      while (engine.get(job.id)!.state !== 'done' && engine.get(job.id)!.state !== 'error') {
        samples.push(engine.get(job.id)!.bytes);
        totalSamples.push(engine.get(job.id)!.totalBytes);
        await new Promise((r) => setTimeout(r, 5));
      }
      samples.push(engine.get(job.id)!.bytes);
      assert.equal(engine.get(job.id)!.state, 'done');
      for (let i = 1; i < samples.length; i++) assert.ok(samples[i] >= samples[i - 1], samples.join(','));
      assert.equal(samples[samples.length - 1], 30);
      // Regression: totalBytes must reflect the real 30-byte Content-Length
      // throughout — NOT re-accumulate it on every one of the 3 chunk events
      // (which would inflate it to 90 and make bytes/totalBytes stay near 0%
      // until the download was already finished).
      for (const t of totalSamples) if (t !== null) assert.equal(t, 30, totalSamples.join(','));
    },
  );
});

test('template file: exact {YYYYMMDD}/{HH}/{hour:03d} substitution, all forecast hours land, one manifest entry', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => { requestedPaths.push(req.url ?? ''); res.writeHead(200); res.end(Buffer.from('grib-bytes')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const now = new Date();
      const cycleIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
      const ymd = cycleIso.slice(0, 10).replace(/-/g, '');
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
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const job = engine.start('grib-template');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.deepEqual(requestedPaths.sort(), [`/${ymd}/00/f024.grb2`, `/${ymd}/00/f048.grb2`]);
      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      assert.equal(manifest.installs[0].id, 'grib-template:nw-europe:forecast');
      assert.equal(manifest.installs[0].files.length, 2);
      assert.equal(Date.parse(manifest.installs[0].cycle!), Date.parse(cycleIso));
      assert.equal(manifest.installs[0].sha256, undefined);
      assert.equal(manifest.installs[0].regionId, 'nw-europe');
      assert.equal(manifest.installs[0].fileType, 'forecast');

      // Files land under grib/<region>/ — the download engine's own
      // subfolder convention — not flat in the Data Directory, so a boat
      // with several regions installed can browse/manage them by region
      // instead of a flat pile of same-looking filenames.
      for (const f of manifest.installs[0].files) {
        assert.match(f, /^grib\/nw-europe\//);
        assert.ok(fs.existsSync(path.join(root, f)), `${f} missing on disk`);
      }
    },
  );
});

test('template downloads of two different regions land in separate subfolders, never colliding', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from('grib-bytes')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
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
        files: [mkTemplate('west_atl'), mkTemplate('west_conus')],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const east = engine.start('noaa-multi', { region_id: 'west_atl' });
      await waitFor(() => engine.get(east.id)!.state === 'done' || engine.get(east.id)!.state === 'error');
      assert.equal(engine.get(east.id)!.state, 'done', engine.get(east.id)!.error);

      const west = engine.start('noaa-multi', { region_id: 'west_conus' });
      await waitFor(() => engine.get(west.id)!.state === 'done' || engine.get(west.id)!.state === 'error');
      assert.equal(engine.get(west.id)!.state, 'done', engine.get(west.id)!.error);

      assert.deepEqual(
        fs.readdirSync(path.join(root, 'grib')).sort(),
        ['west_atl', 'west_conus'],
        'each region gets its own subfolder under the GRIB dir',
      );
      const manifest = readManifest(manifestPath);
      const eastFiles = manifest.installs.find((i) => i.regionId === 'west_atl')!.files;
      const westFiles = manifest.installs.find((i) => i.regionId === 'west_conus')!.files;
      assert.ok(eastFiles.every((f) => f.startsWith('grib/west_atl/')));
      assert.ok(westFiles.every((f) => f.startsWith('grib/west_conus/')));
    },
  );
});

test('multi-region template source: region_id selector picks the RIGHT region, not just the first one', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => { requestedPaths.push(req.url ?? ''); res.writeHead(200); res.end(Buffer.from('grib-bytes')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const now = new Date();
      const cycleIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
      const ymd = cycleIso.slice(0, 10).replace(/-/g, '');
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
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      // Without a selector, a genuinely ambiguous multi-region source must
      // still be rejected eagerly (not silently default to the first region).
      assert.throws(() => engine.start('noaa-multi'), /region_id selector is required/);

      const job = engine.start('noaa-multi', { region_id: 'caribbean' });
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.deepEqual(requestedPaths, [`/caribbean/${ymd}/00/f024.grb2`]);
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
      const { root, manifestPath } = tmpDirs();
      const now = new Date();
      const cycleIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)).toISOString();
      const ymd = cycleIso.slice(0, 10).replace(/-/g, '');
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
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      // region_id alone still resolves to 2 files — must be rejected, not
      // silently default to whichever came first in the catalog's array.
      assert.throws(() => engine.start('noaa_rtofs', { region_id: 'west_atl' }), /multiple types/);

      const forecastJob = engine.start('noaa_rtofs', { region_id: 'west_atl', type: 'forecast' });
      await waitFor(() => engine.get(forecastJob.id)!.state === 'done' || engine.get(forecastJob.id)!.state === 'error');
      assert.equal(engine.get(forecastJob.id)!.state, 'done', engine.get(forecastJob.id)!.error);

      const nowcastJob = engine.start('noaa_rtofs', { region_id: 'west_atl', type: 'nowcast' });
      await waitFor(() => engine.get(nowcastJob.id)!.state === 'done' || engine.get(nowcastJob.id)!.state === 'error');
      assert.equal(engine.get(nowcastJob.id)!.state, 'done', engine.get(nowcastJob.id)!.error);

      assert.deepEqual(requestedPaths.sort(), [`/forecast/${ymd}/00/f024.grb2`, `/nowcast/${ymd}/00/n024.grb2`]);
      const manifest = readManifest(manifestPath);
      // Both installs must coexist, not clobber each other.
      assert.equal(manifest.installs.length, 2);
      const ids = manifest.installs.map((i) => i.id).sort();
      assert.deepEqual(ids, ['noaa_rtofs:west_atl:forecast', 'noaa_rtofs:west_atl:nowcast']);
    },
  );
});

test('a region with THREE forecast files sharing region_id + type, distinguished by variant: variant disambiguates, all three installs coexist', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => { requestedPaths.push(req.url ?? ''); res.writeHead(200); res.end(Buffer.from('x')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      // chooseCycle extracts the hour directly from latest_cycle without
      // filtering by cycle_hours — set 12Z so all three files (+24h at 00/12Z,
      // +48h/+72h at 12Z) resolve to the same valid cycle hour.
      const now = new Date();
      const cycleIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0)).toISOString();
      const ymd = cycleIso.slice(0, 10).replace(/-/g, '');
      const source: CatalogSource = {
        id: 'bsh_currents', source: 'bsh', type: 'grib2', name: 'BSH Currents', description: '',
        contributor: 'BSH', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 12, latest_cycle: cycleIso },
        files: [
          {
            region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
            type: 'forecast', variant: '+24h', url_template: `${baseUrl}/24h/{YYYYMMDD}/{HH}/f{hour:03d}.grb2`,
            forecast_hours: [24], cycle_hours: ['00', '12'],
          },
          {
            region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
            type: 'forecast', variant: '+48h', url_template: `${baseUrl}/48h/{YYYYMMDD}/{HH}/f{hour:03d}.grb2`,
            forecast_hours: [48], cycle_hours: ['12'],
          },
          {
            region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
            type: 'forecast', variant: '+72h', url_template: `${baseUrl}/72h/{YYYYMMDD}/{HH}/f{hour:03d}.grb2`,
            forecast_hours: [72], cycle_hours: ['12'],
          },
        ],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      // region_id + type alone still resolves to 3 files — must be rejected
      assert.throws(() => engine.start('bsh_currents', { region_id: 'north_sea', type: 'forecast' }), /multiple variants/);

      const job24 = engine.start('bsh_currents', { region_id: 'north_sea', type: 'forecast', variant: '+24h' });
      await waitFor(() => engine.get(job24.id)!.state === 'done' || engine.get(job24.id)!.state === 'error');
      assert.equal(engine.get(job24.id)!.state, 'done', engine.get(job24.id)!.error);

      const job48 = engine.start('bsh_currents', { region_id: 'north_sea', type: 'forecast', variant: '+48h' });
      await waitFor(() => engine.get(job48.id)!.state === 'done' || engine.get(job48.id)!.state === 'error');
      assert.equal(engine.get(job48.id)!.state, 'done', engine.get(job48.id)!.error);

      const job72 = engine.start('bsh_currents', { region_id: 'north_sea', type: 'forecast', variant: '+72h' });
      await waitFor(() => engine.get(job72.id)!.state === 'done' || engine.get(job72.id)!.state === 'error');
      assert.equal(engine.get(job72.id)!.state, 'done', engine.get(job72.id)!.error);

      assert.deepEqual(requestedPaths.sort(), [`/24h/${ymd}/12/f024.grb2`, `/48h/${ymd}/12/f048.grb2`, `/72h/${ymd}/12/f072.grb2`]);

      const manifest = readManifest(manifestPath);
      // All three installs must coexist, not clobber each other.
      assert.equal(manifest.installs.length, 3);
      const ids = manifest.installs.map((i) => i.id).sort();
      assert.deepEqual(ids, [
        'bsh_currents:north_sea:forecast:+24h',
        'bsh_currents:north_sea:forecast:+48h',
        'bsh_currents:north_sea:forecast:+72h',
      ]);
    },
  );
});

test('multi-file static source (e.g. a HARMONIC + .IDX pair): no selector required, both files download', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from('x')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'harmonic-pair', source: 'opencpn', type: 'harmonic', name: 'OpenCPN XTide Harmonics', description: '',
        contributor: 'OpenCPN', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [
          { filename: 'HARMONICS_NO_US', url: `${baseUrl}/HARMONICS_NO_US`, size_bytes: 1 },
          { filename: 'HARMONICS_NO_US.IDX', url: `${baseUrl}/HARMONICS_NO_US.IDX`, size_bytes: 1 },
        ],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      // The bug: this used to throw "2 files — a filename or region_id
      // selector is required" even though runJob downloads all static files
      // in a source together regardless of any selector.
      const job = engine.start('harmonic-pair');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');
      const final = engine.get(job.id)!;
      assert.equal(final.state, 'done', final.error);
      assert.ok(fs.existsSync(path.join(root, 'harmonic', 'HARMONICS_NO_US')));
      assert.ok(fs.existsSync(path.join(root, 'harmonic', 'HARMONICS_NO_US.IDX')));
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
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'retry-me', source: 'test', type: 'harmonic', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'HARMONIC', url: `${baseUrl}/flaky`, size_bytes: 11 }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const first = engine.start('retry-me');
      await waitFor(() => engine.get(first.id)!.state === 'done' || engine.get(first.id)!.state === 'error');
      assert.equal(engine.get(first.id)!.state, 'error');
      assert.ok(!fs.existsSync(path.join(root, 'harmonic', 'HARMONIC.part')));

      const second = engine.start('retry-me');
      await waitFor(() => engine.get(second.id)!.state === 'done' || engine.get(second.id)!.state === 'error');
      assert.equal(engine.get(second.id)!.state, 'done', engine.get(second.id)!.error);
      assert.ok(fs.existsSync(path.join(root, 'harmonic', 'HARMONIC')));
    },
  );
});

test('subfolder routing: harmonic/grib2/utcef land in their own subfolder under the single Data Directory', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from('x')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const mk = (id: string, type: 'harmonic' | 'grib2' | 'utcef', filename: string): CatalogSource => ({
        id, source: 'test', type, name: id, description: '', contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename, url: `${baseUrl}/${filename}`, size_bytes: 1 }],
      });
      const sources = [mk('h', 'harmonic', 'HARMONIC'), mk('g', 'grib2', 'f.grb2'), mk('u', 'utcef', 'x.utcef')];
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient(sources), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const jobs: DownloadJob[] = [engine.start('h'), engine.start('g'), engine.start('u')];
      await waitFor(() => jobs.every((j) => ['done', 'error'].includes(engine.get(j.id)!.state)));
      for (const j of jobs) assert.equal(engine.get(j.id)!.state, 'done', engine.get(j.id)!.error);
      assert.ok(fs.existsSync(path.join(root, 'harmonic', 'HARMONIC')));
      assert.ok(fs.existsSync(path.join(root, 'grib', 'f.grb2')));
      assert.ok(fs.existsSync(path.join(root, 'utcef', 'x.utcef')));
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
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'watched', source: 'test', type: 'harmonic', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'HARMONIC', url: `${baseUrl}/slow`, size_bytes: 30 }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

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

test('onAnyDone() fires for a job the caller never subscribed to via onUpdate(), only on terminal state', async () => {
  const content = Buffer.from('fires-without-onupdate');
  await withServer(
    (req, res) => { res.writeHead(200, { 'Content-Length': String(content.length) }); res.end(content); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'unwatched', source: 'test', type: 'harmonic', name: 'Test', description: '',
        contributor: 'Test', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'sha256', last_checked: new Date().toISOString() },
        files: [{ filename: 'HARMONIC', url: `${baseUrl}/f`, size_bytes: content.length }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });
      const done: DownloadJob[] = [];
      engine.onAnyDone((j) => done.push(j));

      const job = engine.start('unwatched');
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error');

      assert.equal(done.length, 1, JSON.stringify(done));
      assert.equal(done[0].id, job.id);
      assert.equal(done[0].state, 'done');
    },
  );
});
