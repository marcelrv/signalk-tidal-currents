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

test('hasInFlight() distinguishes selectors of the SAME source by region/type/variant (BSH-style: a nowcast job in flight must not report a sibling forecast variant as in flight)', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'Content-Length': '30' });
      let sent = 0;
      const iv = setInterval(() => {
        sent += 10;
        if (sent >= 30) { clearInterval(iv); res.end(Buffer.alloc(10, 65)); return; }
        res.write(Buffer.alloc(10, 65));
      }, 200);
    },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'bsh_currents', source: 'bsh', type: 'grib2', name: 'BSH Currents', description: '',
        contributor: 'BSH', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString() },
        files: [
          {
            region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
            type: 'nowcast', url_template: `${baseUrl}/nowcast.grb2`, forecast_hours: [0], cycle_hours: ['00'],
          },
          {
            region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
            type: 'forecast', variant: '+24h', url_template: `${baseUrl}/24h.grb2`, forecast_hours: [24], cycle_hours: ['00'],
          },
        ],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const job = engine.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });
      await waitFor(() => engine.get(job.id)!.state === 'active');

      assert.equal(engine.hasInFlight('bsh_currents', { region_id: 'north_sea', type: 'nowcast' }), true);
      assert.equal(engine.hasInFlight('bsh_currents', { region_id: 'north_sea', type: 'forecast', variant: '+24h' }), false);
      assert.equal(engine.hasInFlight('bsh_currents'), true, 'a bare selector overlaps any selector of the same source');
      assert.equal(engine.hasInFlight('other_source', { region_id: 'north_sea', type: 'nowcast' }), false);

      engine.cancel(job.id);
      await waitFor(() => engine.get(job.id)!.state === 'error');
    },
  );
});

test('a template file whose chosen cycle 404s falls back to the next-older cycle in the SAME cycle_hours list (BSH nowcast-only-at-00Z-not-12Z scenario)', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => {
      requestedPaths.push(req.url ?? '');
      if ((req.url ?? '').endsWith('/12.grb2')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200);
      res.end(Buffer.from('nowcast-data'));
    },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
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
            type: 'nowcast', url_template: `${baseUrl}/{HH}.grb2`, forecast_hours: [0], cycle_hours: ['00', '12'],
          },
        ],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const job = engine.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error', 5000);

      assert.equal(engine.get(job.id)!.state, 'done', engine.get(job.id)!.error);
      assert.deepEqual(requestedPaths, ['/12.grb2', '/00.grb2'], 'must try the chosen 12Z cycle first, then fall back to 00Z');

      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      // The install's recorded cycle must reflect the cycle that ACTUALLY succeeded (00Z), not the originally-chosen one (12Z).
      assert.equal(manifest.installs[0].cycle, new Date(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`).toISOString());
    },
  );
});

test('when EVERY latest_cycle-anchored candidate 404s, a fallback anchored on the real current time is tried before giving up (BSH forecast-at-12Z-while-shared-latest_cycle-tracks-00Z scenario)', async () => {
  const requestedPaths: string[] = [];
  const now = new Date();
  const todayYmd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const successPath = `/${todayYmd}/00.grb2`;
  await withServer(
    (req, res) => {
      const url = req.url ?? '';
      requestedPaths.push(url);
      if (url === successPath) {
        res.writeHead(200);
        res.end(Buffer.from('forecast-data'));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'bsh_currents', source: 'bsh', type: 'grib2', name: 'BSH Currents', description: '',
        contributor: 'BSH', url: baseUrl, tags: [], region: region(),
        // Pinned to a date decades in the past with no max_age_hours (so
        // staleness never forces a fallback to `now` on its own) — every
        // latest_cycle-anchored candidate is guaranteed to land on a date
        // that will never match `successPath`.
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), latest_cycle: '1970-01-01T00:00:00Z' },
        files: [
          {
            region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
            type: 'forecast', variant: '+24h', url_template: `${baseUrl}/{YYYYMMDD}/{HH}.grb2`,
            forecast_hours: [24], cycle_hours: ['00'],
          },
        ],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const job = engine.start('bsh_currents', { region_id: 'north_sea', type: 'forecast', variant: '+24h' });
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error', 5000);

      assert.equal(engine.get(job.id)!.state, 'done', engine.get(job.id)!.error);
      // 3 doomed latest_cycle-anchored attempts (1970 and its two predecessor
      // 00Z cycles), then the fallback anchored on the real current day succeeds.
      assert.equal(requestedPaths.length, 4, requestedPaths.join(', '));
      assert.equal(requestedPaths[3], successPath);
      assert.ok(requestedPaths.slice(0, 3).every((p) => p.startsWith('/19')), 'the primary candidates must all be anchored on the pinned 1970 latest_cycle, not today');

      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      assert.equal(manifest.installs[0].cycle, new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString());
    },
  );
});

test('a template file download failure that is NOT "file not found" (e.g. HTTP 500) propagates immediately, without trying an older cycle', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    (req, res) => {
      requestedPaths.push(req.url ?? '');
      res.writeHead(500);
      res.end('server error');
    },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const now = new Date();
      const cycleIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0)).toISOString();
      const source: CatalogSource = {
        id: 'bsh_currents', source: 'bsh', type: 'grib2', name: 'BSH Currents', description: '',
        contributor: 'BSH', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 12, latest_cycle: cycleIso },
        files: [
          {
            region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
            type: 'nowcast', url_template: `${baseUrl}/{HH}.grb2`, forecast_hours: [0], cycle_hours: ['00', '12'],
          },
        ],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const job = engine.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });
      await waitFor(() => engine.get(job.id)!.state === 'done' || engine.get(job.id)!.state === 'error', 5000);

      assert.equal(engine.get(job.id)!.state, 'error');
      assert.match(engine.get(job.id)!.error ?? '', /HTTP 500/);
      assert.deepEqual(requestedPaths, ['/12.grb2'], 'a non-not-found error must not trigger a fallback attempt at an older cycle');
    },
  );
});

test('two variants of the same region+type that happen to share a forecast hour no longer collide on disk (variant is now part of the filename)', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from(req.url ?? '')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const cycleIso = '2026-07-03T00:00:00Z';
      const mkVariant = (variant: string) => ({
        region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
        type: 'forecast' as const, url_template: `${baseUrl}/${variant}/{YYYYMMDD}/{HH}/f{hour:03d}.grb2`,
        // Same forecast_hours on purpose — this is the scenario the old
        // filename (region+type only) couldn't distinguish.
        forecast_hours: [24], cycle_hours: ['00'], variant,
      });
      const source: CatalogSource = {
        id: 'bsh_currents', source: 'bsh', type: 'grib2', name: 'BSH Currents', description: '',
        contributor: 'BSH', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 24, latest_cycle: cycleIso },
        files: [mkVariant('am'), mkVariant('pm')],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const am = engine.start('bsh_currents', { region_id: 'north_sea', type: 'forecast', variant: 'am' });
      await waitFor(() => engine.get(am.id)!.state === 'done' || engine.get(am.id)!.state === 'error');
      assert.equal(engine.get(am.id)!.state, 'done', engine.get(am.id)!.error);

      const pm = engine.start('bsh_currents', { region_id: 'north_sea', type: 'forecast', variant: 'pm' });
      await waitFor(() => engine.get(pm.id)!.state === 'done' || engine.get(pm.id)!.state === 'error');
      assert.equal(engine.get(pm.id)!.state, 'done', engine.get(pm.id)!.error);

      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 2, 'both variants must have their own install, not overwrite each other');
      const files = manifest.installs.flatMap((i) => i.files);
      assert.equal(new Set(files).size, files.length, 'the two variants must not land on the same on-disk filename');
      for (const f of files) {
        assert.ok(fs.existsSync(path.join(root, f)), `${f} missing on disk`);
      }
    },
  );
});

test('a successful re-download of the SAME region/type/variant at a NEW cycle deletes the file it superseded (no orphan left behind)', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from(req.url ?? '')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'bsh_currents', source: 'bsh', type: 'grib2', name: 'BSH Currents', description: '',
        contributor: 'BSH', url: baseUrl, tags: [], region: region(),
        // A huge max_age_hours pins `latest_cycle` as the deterministic choice
        // (the "stale snapshot, use now instead" branch never kicks in).
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 999999, latest_cycle: '2026-07-01T00:00:00Z' },
        files: [{
          region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
          type: 'nowcast', url_template: `${baseUrl}/{YYYYMMDD}/{HH}.grb2`, forecast_hours: [0], cycle_hours: ['00'],
        }],
      };
      // A real CatalogClient (not fakeCatalogClient's frozen snapshot) so the
      // second download can resolve a genuinely different cycle by mutating
      // the SAME source object's update_check between the two engine.start() calls.
      const document: CatalogDocument = { catalog_schema_version: '1.0.0', version: 1, generated: new Date().toISOString(), source_count: 1, sources: [source] };
      const state: CatalogState = { status: 'cached', document, fetchedAt: new Date().toISOString(), error: null, sourceUrl: 'https://x', warnings: [] };
      const catalog: CatalogClient = { get: () => state, refresh: async () => state };

      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog, catalogUrl: `${baseUrl}/tide-current-index.json` });

      const job1 = engine.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });
      await waitFor(() => engine.get(job1.id)!.state === 'done' || engine.get(job1.id)!.state === 'error');
      assert.equal(engine.get(job1.id)!.state, 'done', engine.get(job1.id)!.error);
      const firstFile = path.join(root, readManifest(manifestPath).installs[0].files[0]);
      assert.ok(fs.existsSync(firstFile));

      source.update_check = { ...source.update_check, latest_cycle: '2026-07-02T00:00:00Z' };

      const job2 = engine.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });
      await waitFor(() => engine.get(job2.id)!.state === 'done' || engine.get(job2.id)!.state === 'error');
      assert.equal(engine.get(job2.id)!.state, 'done', engine.get(job2.id)!.error);

      const manifestAfterSecond = readManifest(manifestPath);
      assert.equal(manifestAfterSecond.installs.length, 1, 'still one logical install for this region/type/variant, not two');
      const secondFile = path.join(root, manifestAfterSecond.installs[0].files[0]);
      assert.notEqual(secondFile, firstFile, 'the second cycle must use a different filename');
      assert.ok(fs.existsSync(secondFile), 'the new cycle file must exist');
      assert.ok(!fs.existsSync(firstFile), 'the superseded first-cycle file must have been deleted, not left as an orphan');
    },
  );
});

test('re-requesting the SAME cycle (no new data yet) does not delete the file it just (re)wrote', async () => {
  await withServer(
    (req, res) => { res.writeHead(200); res.end(Buffer.from('same-cycle-data')); },
    async (baseUrl) => {
      const { root, manifestPath } = tmpDirs();
      const source: CatalogSource = {
        id: 'bsh_currents', source: 'bsh', type: 'grib2', name: 'BSH Currents', description: '',
        contributor: 'BSH', url: baseUrl, tags: [], region: region(),
        update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: 999999, latest_cycle: '2026-07-01T00:00:00Z' },
        files: [{
          region_id: 'north_sea', name: 'North Sea', description: '', boundary_geometry: region().boundary_geometry,
          type: 'nowcast', url_template: `${baseUrl}/{YYYYMMDD}/{HH}.grb2`, forecast_hours: [0], cycle_hours: ['00'],
        }],
      };
      const engine = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: `${baseUrl}/tide-current-index.json` });

      const job1 = engine.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });
      await waitFor(() => engine.get(job1.id)!.state === 'done' || engine.get(job1.id)!.state === 'error');
      assert.equal(engine.get(job1.id)!.state, 'done', engine.get(job1.id)!.error);

      const job2 = engine.start('bsh_currents', { region_id: 'north_sea', type: 'nowcast' });
      await waitFor(() => engine.get(job2.id)!.state === 'done' || engine.get(job2.id)!.state === 'error');
      assert.equal(engine.get(job2.id)!.state, 'done', engine.get(job2.id)!.error);

      const manifest = readManifest(manifestPath);
      assert.equal(manifest.installs.length, 1);
      const file = path.join(root, manifest.installs[0].files[0]);
      assert.ok(fs.existsSync(file), 'the (re-)downloaded file must still exist — must not delete what it just wrote');
    },
  );
});
