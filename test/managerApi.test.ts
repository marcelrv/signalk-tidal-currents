// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerManagerRoutes, ManagerRouterLike, ManagerState } from '../dist/managerApi.js';
import { writeManifestAtomic, upsertInstall, InstallManifest } from '../dist/manifest.js';
import { DEFAULT_PRIORITY } from '../dist/priority.js';
import { CatalogClient, CatalogState } from '../dist/catalog.js';
import { CatalogDocument, CatalogSource } from '../dist/catalogTypes.js';
import { DownloadEngine, DownloadJob } from '../dist/downloads.js';

interface FakeRes {
  statusCode: number;
  body: unknown;
}

/** Minimal in-file RouterLike capture harness: records handlers, and a matching fake Req/Res pair. */
function makeHarness() {
  const handlers = new Map<string, (req: any, res: any) => void>();
  const router: ManagerRouterLike = {
    get: (p, h) => handlers.set(`GET ${p}`, h),
    post: (p, h) => handlers.set(`POST ${p}`, h),
    put: (p, h) => handlers.set(`PUT ${p}`, h),
    delete: (p, h) => handlers.set(`DELETE ${p}`, h),
  };
  async function call(method: string, routePath: string, opts: { params?: Record<string, string>; body?: unknown } = {}): Promise<FakeRes> {
    const h = handlers.get(`${method} ${routePath}`);
    if (!h) throw new Error(`no handler registered for ${method} ${routePath}`);
    const result: FakeRes = { statusCode: 200, body: undefined };
    const res = {
      status(code: number) { result.statusCode = code; return res; },
      json(body: unknown) { result.body = body; },
    };
    await h({ params: opts.params ?? {}, query: {}, body: opts.body }, res);
    return result;
  }
  return { router, call };
}

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-managerapi-'));
  const dirs = { harmonic: path.join(root, 'tcdata'), grib2: path.join(root, 'grib'), utcef: path.join(root, 'utcef') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { root, dirs, manifestPath: path.join(root, 'install-manifest.json') };
}

function fakeCatalogClient(sources: CatalogSource[] = [], opts: { refreshFails?: boolean } = {}): CatalogClient {
  const document: CatalogDocument | null = sources.length
    ? { catalog_schema_version: '1.0.0', version: 1, generated: new Date().toISOString(), source_count: sources.length, sources }
    : null;
  const state: CatalogState = document
    ? { status: 'cached', document, fetchedAt: new Date().toISOString(), error: null, sourceUrl: 'https://example.org/catalog.json', warnings: [] }
    : { status: 'empty', document: null, fetchedAt: null, error: null, sourceUrl: 'https://example.org/catalog.json', warnings: [] };
  return {
    get: () => state,
    refresh: async () => {
      if (opts.refreshFails) return { ...state, status: state.document ? 'cached' : 'error', error: 'network down' };
      return state;
    },
  };
}

function fakeDownloadEngine(): DownloadEngine {
  const jobs = new Map<string, DownloadJob>();
  return {
    start: (sourceId) => {
      const job: DownloadJob = { id: 'job-1', catalogSourceId: sourceId, state: 'queued', bytes: 0, totalBytes: null };
      jobs.set(job.id, job);
      return job;
    },
    get: (id) => jobs.get(id),
    list: () => [...jobs.values()],
    cancel: () => {},
    onUpdate: () => () => {},
  };
}

function baseMgr(overrides: Partial<ManagerState> = {}): { mgr: ManagerState; dirs: ReturnType<typeof tmpDirs>['dirs']; manifestPath: string } {
  const { dirs, manifestPath, root } = tmpDirs();
  let priority = [...DEFAULT_PRIORITY];
  const mgr: ManagerState = {
    catalog: fakeCatalogClient(),
    downloads: fakeDownloadEngine(),
    manifestPath,
    dirs,
    managerDir: root,
    getPriority: () => priority,
    setPriority: (order) => { priority = order; },
    apiState: { data: null, error: null },
    getVesselPosition: () => null,
    ...overrides,
  };
  return { mgr, dirs, manifestPath };
}

test('GET /catalog returns the current catalog state shape', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('GET', '/catalog');
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).status, 'empty');
});

test('POST /catalog/refresh returns 502 with the cached copy on failure', async () => {
  const source: CatalogSource = {
    id: 's', source: 'test', type: 'grib2', name: 'S', description: '', contributor: 'C', url: 'https://x',
    tags: [], region: { name: 'r', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 }, boundary_geometry: { type: 'Polygon', coordinates: [] } },
    update_check: { method: 'sha256', last_checked: new Date().toISOString() }, files: [],
  };
  const { mgr } = baseMgr({ catalog: fakeCatalogClient([source], { refreshFails: true }) });
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('POST', '/catalog/refresh');
  assert.equal(res.statusCode, 502);
  assert.equal((res.body as any).error, 'network down');
  assert.equal((res.body as any).document.sources.length, 1); // cached copy still present
});

test('GET /datasets merges manifest installs, orphan files, and UTCEF license metadata', async () => {
  const { mgr, dirs, manifestPath } = baseMgr({
    apiState: {
      data: null, error: null,
      utcef: { get: () => ({ dir: dirs.utcef, files: ['nl.utcef'], currentStations: [], heightStationCount: 0, unsupportedFeatureCount: 0, warnings: [], license: 'CC-BY-4.0', licenseUrl: 'https://x/license', citationRequired: 'cite me', copyright: '(c) test' } as any), error: null },
    } as any,
  });
  fs.writeFileSync(path.join(dirs.utcef, 'nl.utcef'), 'dummy');
  fs.writeFileSync(path.join(dirs.harmonic, 'HARMONIC'), 'legacy'); // orphan — not in manifest
  const manifest: InstallManifest = { manifest_version: 1, installs: [] };
  writeManifestAtomic(manifestPath, upsertInstall(manifest, {
    id: 'nl-utcef', catalogSourceId: 'nl-utcef', type: 'utcef', files: ['nl.utcef'], dir: 'utcef',
    size_bytes: 5, downloaded_at: new Date().toISOString(),
  }));

  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('GET', '/datasets');
  const body = res.body as any[];
  const installed = body.find((d) => d.id === 'nl-utcef');
  assert.ok(installed, JSON.stringify(body));
  assert.equal(installed.license, 'CC-BY-4.0');
  assert.equal(installed.citationRequired, 'cite me');
  const orphan = body.find((d) => d.id === 'orphan:harmonic:HARMONIC');
  assert.ok(orphan, JSON.stringify(body));
  assert.equal(orphan.catalogSourceId, null);
});

test('GET /datasets exposes expiry countdown fields for an expiry-method install nearing its max age', async () => {
  const { mgr, dirs, manifestPath } = baseMgr();
  const maxAgeHours = 24;
  const ageHours = 21.6; // 10% of maxAgeHours remaining
  const cycleMs = Date.now() - ageHours * 3600_000;
  const source: CatalogSource = {
    id: 'grib-forecast', source: 'noaa', type: 'grib2', name: 'Forecast', description: '',
    contributor: 'NOAA', url: 'https://x', tags: [],
    region: { name: 'r', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 }, boundary_geometry: { type: 'Polygon', coordinates: [] } },
    update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: maxAgeHours },
    files: [],
  };
  mgr.catalog = {
    get: () => ({ status: 'cached', document: { catalog_schema_version: '1.0.0', version: 1, generated: '', source_count: 1, sources: [source] }, fetchedAt: new Date().toISOString(), error: null, sourceUrl: '', warnings: [] }),
    refresh: async () => mgr.catalog.get(),
  };
  fs.writeFileSync(path.join(dirs.grib2, 'f.grb2'), 'x');
  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] }, {
    id: 'grib-forecast', catalogSourceId: 'grib-forecast', type: 'grib2', files: ['f.grb2'], dir: 'grib',
    size_bytes: 1, downloaded_at: new Date().toISOString(), cycle: new Date(cycleMs).toISOString(),
  }));

  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('GET', '/datasets');
  const entry = (res.body as any[]).find((d) => d.id === 'grib-forecast');
  assert.ok(entry, JSON.stringify(res.body));
  assert.equal(entry.status, 'active'); // not yet past max_age_hours
  assert.equal(entry.updateCheckMethod, 'expiry');
  assert.equal(entry.maxAgeHours, maxAgeHours);
  assert.ok(Math.abs(entry.remainingHours - 2.4) < 0.01, entry.remainingHours);
  assert.equal(entry.expiresAt, new Date(cycleMs + maxAgeHours * 3600_000).toISOString());
});

test('GET /datasets reports a negative remainingHours once past max_age_hours, status stays update-available', async () => {
  const { mgr, dirs, manifestPath } = baseMgr();
  const maxAgeHours = 24;
  const cycleMs = Date.now() - 30 * 3600_000; // 6h past expiry
  const source: CatalogSource = {
    id: 'grib-forecast', source: 'noaa', type: 'grib2', name: 'Forecast', description: '',
    contributor: 'NOAA', url: 'https://x', tags: [],
    region: { name: 'r', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 }, boundary_geometry: { type: 'Polygon', coordinates: [] } },
    update_check: { method: 'expiry', last_checked: new Date().toISOString(), max_age_hours: maxAgeHours },
    files: [],
  };
  mgr.catalog = {
    get: () => ({ status: 'cached', document: { catalog_schema_version: '1.0.0', version: 1, generated: '', source_count: 1, sources: [source] }, fetchedAt: new Date().toISOString(), error: null, sourceUrl: '', warnings: [] }),
    refresh: async () => mgr.catalog.get(),
  };
  fs.writeFileSync(path.join(dirs.grib2, 'f.grb2'), 'x');
  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] }, {
    id: 'grib-forecast', catalogSourceId: 'grib-forecast', type: 'grib2', files: ['f.grb2'], dir: 'grib',
    size_bytes: 1, downloaded_at: new Date().toISOString(), cycle: new Date(cycleMs).toISOString(),
  }));

  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('GET', '/datasets');
  const entry = (res.body as any[]).find((d) => d.id === 'grib-forecast');
  assert.ok(entry, JSON.stringify(res.body));
  assert.equal(entry.status, 'update-available');
  assert.ok(entry.remainingHours < 0, entry.remainingHours);
});

test('DELETE /datasets/:id refuses an orphan id with a path-traversal filename', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('DELETE', '/datasets/:id', { params: { id: 'orphan:harmonic:../../../etc/passwd' } });
  assert.equal(res.statusCode, 400);
});

test('DELETE /datasets/:id deletes a real install and its files, updates the manifest', async () => {
  const { mgr, dirs, manifestPath } = baseMgr();
  fs.writeFileSync(path.join(dirs.grib2, 'f.grb2'), 'x');
  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] }, {
    id: 'grib-install', catalogSourceId: 'grib-install', type: 'grib2', files: ['f.grb2'], dir: 'grib',
    size_bytes: 1, downloaded_at: new Date().toISOString(),
  }));
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('DELETE', '/datasets/:id', { params: { id: 'grib-install' } });
  assert.equal(res.statusCode, 200);
  assert.ok(!fs.existsSync(path.join(dirs.grib2, 'f.grb2')));
});

test('DELETE /datasets/:id returns 404 for an unknown id', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('DELETE', '/datasets/:id', { params: { id: 'does-not-exist' } });
  assert.equal(res.statusCode, 404);
});

test('GET /priority returns the current order and default', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('GET', '/priority');
  assert.deepEqual((res.body as any).order, DEFAULT_PRIORITY);
  assert.deepEqual((res.body as any).default, DEFAULT_PRIORITY);
});

test('PUT /priority validates the order, 400 on an invalid permutation', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const bad = await call('PUT', '/priority', { body: { order: ['grib2', 'grib2', 'harmonic'] } });
  assert.equal(bad.statusCode, 400);
  const good = await call('PUT', '/priority', { body: { order: ['utcef', 'harmonic', 'grib2'] } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual((good.body as any).order, ['utcef', 'harmonic', 'grib2']);
  const after = await call('GET', '/priority');
  assert.deepEqual((after.body as any).order, ['utcef', 'harmonic', 'grib2']);
});
