// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MAX_PUBLIC_SSE_CLIENTS, PUBLIC_CATALOG_ERROR, PUBLIC_DOWNLOAD_ERROR, registerManagerRoutes, ManagerRouterLike, ManagerState } from '../dist/managerApi.js';
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
  const handlers = new Map<string, (req: any, res: any) => void | Promise<void>>();
  const router: ManagerRouterLike = {
    get: (p, h) => handlers.set(`GET ${p}`, h),
    post: (p, h) => handlers.set(`POST ${p}`, h),
    put: (p, h) => handlers.set(`PUT ${p}`, h),
    delete: (p, h) => handlers.set(`DELETE ${p}`, h),
  };
  async function call(method: string, routePath: string, opts: { params?: Record<string, string>; body?: unknown; skPrincipal?: { permissions: string } } = {}): Promise<FakeRes> {
    const h = handlers.get(`${method} ${routePath}`);
    if (!h) throw new Error(`no handler registered for ${method} ${routePath}`);
    const result: FakeRes = { statusCode: 200, body: undefined };
    const res = {
      status(code: number) { result.statusCode = code; return res; },
      json(body: unknown) { result.body = body; },
    };
    await h({ params: opts.params ?? {}, query: {}, body: opts.body, skPrincipal: opts.skPrincipal }, res);
    return result;
  }
  return { router, call };
}

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-managerapi-'));
  for (const sub of ['harmonic', 'grib', 'utcef']) fs.mkdirSync(path.join(root, sub), { recursive: true });
  return { root, manifestPath: path.join(root, 'install-manifest.json') };
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
    onAnyDone: () => () => {},
    hasInFlight: () => false,
  };
}

function baseMgr(overrides: Partial<ManagerState> = {}): { mgr: ManagerState; dataDir: string; manifestPath: string } {
  const { root, manifestPath } = tmpDirs();
  let priority = [...DEFAULT_PRIORITY];
  let datasetStack: string[] = [];
  const mgr: ManagerState = {
    catalog: fakeCatalogClient(),
    downloads: fakeDownloadEngine(),
    manifestPath,
    dataDir: root,
    getPriority: () => priority,
    setPriority: (order) => { priority = order; },
    getDatasetStack: () => datasetStack,
    setDatasetStack: (ids) => { datasetStack = ids; },
    apiState: { data: null, error: null },
    getVesselPosition: () => null,
    ...overrides,
  };
  return { mgr, dataDir: root, manifestPath };
}

test('GET /catalog returns the current catalog state shape', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('GET', '/catalog');
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).status, 'empty');
});

test('public read routes go on the `reads` router; mutations and admin-only reads stay on the main router', () => {
  const { mgr } = baseMgr();
  const recordingRouter = (out: string[]): ManagerRouterLike => ({
    get: (p) => { out.push(`GET ${p}`); },
    post: (p) => { out.push(`POST ${p}`); },
    put: (p) => { out.push(`PUT ${p}`); },
    delete: (p) => { out.push(`DELETE ${p}`); },
  });
  const admin: string[] = [];
  const pub: string[] = [];
  registerManagerRoutes(recordingRouter(admin), mgr, recordingRouter(pub));
  assert.deepEqual(pub.sort(), ['GET /catalog', 'GET /datasets', 'GET /downloads', 'GET /downloads/:id', 'GET /downloads/:id/events', 'GET /downloads/events', 'GET /priority', 'GET /storage']);
  assert.deepEqual(admin.sort(), ['DELETE /datasets/:id', 'GET /cleanup-candidates', 'POST /catalog/refresh', 'POST /downloads', 'PUT /datasets/:id/auto-update', 'PUT /priority']);
});

test('GET /storage: non-admins share one cached scan; admins scan fresh and refresh it', async () => {
  const { mgr, dataDir } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const anon = { skPrincipal: { permissions: 'readonly' } };
  const before = ((await call('GET', '/storage', anon)).body as any).usedByPluginBytes;
  fs.writeFileSync(path.join(dataDir, 'grown.bin'), Buffer.alloc(4096));
  assert.equal(((await call('GET', '/storage', anon)).body as any).usedByPluginBytes, before, 'anon reuses the cached scan');
  const admin = ((await call('GET', '/storage', { skPrincipal: { permissions: 'admin' } })).body as any).usedByPluginBytes;
  assert.equal(admin, before + 4096, 'admin scans fresh');
  assert.equal(((await call('GET', '/storage', anon)).body as any).usedByPluginBytes, admin, "admin's scan refreshes the shared copy");
});

test('GET /storage hides the absolute data directory from non-admins only', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const anon = await call('GET', '/storage', { skPrincipal: { permissions: 'readonly' } });
  assert.equal((anon.body as any).path, undefined);
  const admin = await call('GET', '/storage', { skPrincipal: { permissions: 'admin' } });
  assert.equal(typeof (admin.body as any).path, 'string');
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
  const { mgr, dataDir, manifestPath } = baseMgr({
    apiState: {
      data: null, error: null,
      utcef: { get: () => ({ dir: path.join(dataDir, 'utcef'), files: ['nl.utcef'], currentStations: [], heightStationCount: 0, unsupportedFeatureCount: 0, warnings: [], license: 'CC-BY-4.0', licenseUrl: 'https://x/license', citationRequired: 'cite me', copyright: '(c) test' } as any), error: null },
    } as any,
  });
  fs.writeFileSync(path.join(dataDir, 'utcef', 'nl.utcef'), 'dummy');
  fs.writeFileSync(path.join(dataDir, 'harmonic', 'HARMONIC'), 'legacy'); // orphan — not in manifest
  const manifest: InstallManifest = { manifest_version: 1, installs: [] };
  writeManifestAtomic(manifestPath, upsertInstall(manifest, {
    id: 'nl-utcef', catalogSourceId: 'nl-utcef', type: 'utcef', files: ['utcef/nl.utcef'],
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
  const orphan = body.find((d) => d.id === 'orphan:harmonic:harmonic/HARMONIC');
  assert.ok(orphan, JSON.stringify(body));
  assert.equal(orphan.catalogSourceId, null);
});

test('GET /datasets finds a manually-dropped file in ANY folder structure under Data Directory, not just harmonic/grib/utcef', async () => {
  // The download engine's own harmonic/grib/utcef split (plus per-region
  // subfolders for GRIB2/UTCEF) is purely its own tidiness convention — nothing
  // requires a user's own files to follow it. A GRIB2 file dropped in some
  // unrelated nested folder (e.g. copied in from an old backup) must still
  // surface as an orphan dataset.
  const { mgr, dataDir } = baseMgr();
  const customDir = path.join(dataDir, 'my-own-backup', '2025-currents');
  fs.mkdirSync(customDir, { recursive: true });
  fs.writeFileSync(path.join(customDir, 'saildocs.grb2'), 'grib-bytes');

  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('GET', '/datasets');
  const body = res.body as any[];
  const orphan = body.find((d) => d.id === 'orphan:grib:my-own-backup/2025-currents/saildocs.grb2');
  assert.ok(orphan, JSON.stringify(body));
  assert.equal(orphan.type, 'grib2');
});

test('GET /datasets exposes expiry countdown fields for an expiry-method install nearing its max age', async () => {
  const { mgr, dataDir, manifestPath } = baseMgr();
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
  fs.writeFileSync(path.join(dataDir, 'grib', 'f.grb2'), 'x');
  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] }, {
    id: 'grib-forecast', catalogSourceId: 'grib-forecast', type: 'grib2', files: ['grib/f.grb2'],
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
  const { mgr, dataDir, manifestPath } = baseMgr();
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
  fs.writeFileSync(path.join(dataDir, 'grib', 'f.grb2'), 'x');
  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] }, {
    id: 'grib-forecast', catalogSourceId: 'grib-forecast', type: 'grib2', files: ['grib/f.grb2'],
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
  const { mgr, dataDir, manifestPath } = baseMgr();
  fs.writeFileSync(path.join(dataDir, 'grib', 'f.grb2'), 'x');
  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] }, {
    id: 'grib-install', catalogSourceId: 'grib-install', type: 'grib2', files: ['grib/f.grb2'],
    size_bytes: 1, downloaded_at: new Date().toISOString(),
  }));
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('DELETE', '/datasets/:id', { params: { id: 'grib-install' } });
  assert.equal(res.statusCode, 200);
  assert.ok(!fs.existsSync(path.join(dataDir, 'grib', 'f.grb2')));
});

test('DELETE /datasets/:id returns 404 for an unknown id', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('DELETE', '/datasets/:id', { params: { id: 'does-not-exist' } });
  assert.equal(res.statusCode, 404);
});

test('PUT /datasets/:id/auto-update enables the flag, persists across a re-read', async () => {
  const { mgr, manifestPath } = baseMgr();
  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] }, {
    id: 'grib-install', catalogSourceId: 'grib-install', type: 'grib2', files: [],
    size_bytes: 1, downloaded_at: new Date().toISOString(),
  }));
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('PUT', '/datasets/:id/auto-update', { params: { id: 'grib-install' }, body: { enabled: true } });
  assert.equal(res.statusCode, 200);

  const res2 = await call('GET', '/datasets', {});
  const entry = (res2.body as any[]).find((d) => d.id === 'grib-install');
  assert.equal(entry.autoUpdate, true);
});

test('PUT /datasets/:id/auto-update returns 400 when enabled is not a boolean', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('PUT', '/datasets/:id/auto-update', { params: { id: 'x' }, body: { enabled: 'yes' } });
  assert.equal(res.statusCode, 400);
});

test('PUT /datasets/:id/auto-update returns 404 for an unknown (or orphan) id', async () => {
  const { mgr } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const res = await call('PUT', '/datasets/:id/auto-update', { params: { id: 'orphan:harmonic:HARMONIC' }, body: { enabled: true } });
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

test('GET/PUT /priority dataset stack: persisted order first, unranked installs appended in type order', async () => {
  const { mgr, manifestPath } = baseMgr();
  let manifest: InstallManifest = { manifest_version: 1, installs: [] };
  for (const [id, type] of [['a-grib', 'grib2'], ['b-utcef', 'utcef'], ['c-utcef', 'utcef']] as const) {
    manifest = upsertInstall(manifest, {
      id, catalogSourceId: id, type, files: [`${id}.dat`],
      size_bytes: 1, downloaded_at: new Date().toISOString(),
    });
  }
  writeManifestAtomic(manifestPath, manifest);
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);

  // No stack persisted yet — everything appended in type order (grib2 first).
  const initial = await call('GET', '/priority');
  assert.deepEqual((initial.body as any).datasets, ['a-grib', 'b-utcef', 'c-utcef']);

  const bad = await call('PUT', '/priority', { body: { datasets: ['c-utcef', 'c-utcef'] } });
  assert.equal(bad.statusCode, 400); // duplicate id

  // Rank one dataset on top (with a stale id that must be dropped); the rest follow in type order.
  const good = await call('PUT', '/priority', { body: { datasets: ['c-utcef', 'gone-id'] } });
  assert.equal(good.statusCode, 200);
  assert.deepEqual((good.body as any).datasets, ['c-utcef', 'a-grib', 'b-utcef']);
});

test('non-admins get generic error texts (no paths, no catalog URL) on every job view and /catalog; admins see them verbatim', () => {
  const { mgr } = baseMgr();
  const err = "HTTP 404 fetching https://user:secret@intranet.example/cat/x.grb2; ENOSPC: write '/srv/data/grib/x.grb2.part'";
  const job: DownloadJob = { id: 'j', catalogSourceId: 's', state: 'error', bytes: 0, totalBytes: null, error: err };
  const anyDone: ((j: DownloadJob) => void)[] = [];
  const jobUpdate: ((j: DownloadJob) => void)[] = [];
  mgr.downloads = {
    ...fakeDownloadEngine(),
    list: () => [job],
    get: () => ({ ...job, state: 'active', error: undefined }),
    onUpdate: (_id, cb) => { jobUpdate.push(cb); return () => {}; },
    onAnyDone: (cb) => { anyDone.push(cb); return () => {}; },
  };
  mgr.catalog = { get: () => ({ status: 'cached', document: null, fetchedAt: null, error: 'fetch failed: https://intranet.example/c.json?token=abc', sourceUrl: 'https://intranet.example/c.json?token=abc', warnings: [] }), refresh: async () => mgr.catalog.get() } as CatalogClient;
  const handlers = new Map<string, (req: any, res: any) => void | Promise<void>>();
  registerManagerRoutes({ get: (p, h) => handlers.set(p, h), post: () => {}, put: () => {}, delete: () => {} }, mgr);
  const call = (p: string, principal?: { permissions: string }) => {
    let body: any;
    void handlers.get(p)!({ params: { id: 'j' }, query: {}, skPrincipal: principal }, { status() { return this; }, json(b: unknown) { body = b; } });
    return body;
  };
  const closers: (() => void)[] = [];
  const sse = (p: string, principal: { permissions: string }) => {
    const frames: any[] = [];
    const res = { status() { return res; }, json() {}, writeHead() {}, write(c: string) { if (c.startsWith('data: ')) frames.push(JSON.parse(c.slice(6))); return true; }, end() {}, on(_e: string, cb: () => void) { closers.push(cb); } };
    void handlers.get(p)!({ params: { id: 'j' }, query: {}, skPrincipal: principal }, res);
    return frames;
  };
  const anon = { permissions: 'readonly' };
  const admin = { permissions: 'admin' };
  assert.equal(call('/downloads', anon)[0].error, PUBLIC_DOWNLOAD_ERROR);
  assert.equal(call('/downloads/:id', anon).error, undefined, 'no error → nothing to hide');
  assert.equal(call('/downloads', admin)[0].error, err);
  assert.equal(call('/downloads')[0].error, err); // security off: no principal

  try {
    const anonGlobal = sse('/downloads/events', anon);
    const adminGlobal = sse('/downloads/events', admin);
    const anonJob = sse('/downloads/:id/events', anon);
    anyDone.forEach((cb) => cb(job));
    jobUpdate.forEach((cb) => cb(job));
    assert.equal(anonGlobal[0].error, PUBLIC_DOWNLOAD_ERROR);
    assert.equal(adminGlobal[0].error, err);
    assert.equal(anonJob.at(-1).error, PUBLIC_DOWNLOAD_ERROR);
  } finally {
    closers.forEach((c) => c()); // clears the heartbeat timers
  }

  const cat = call('/catalog', anon);
  assert.equal(cat.sourceUrl, '');
  assert.equal(cat.error, PUBLIC_CATALOG_ERROR);
  assert.ok(!JSON.stringify(cat).includes('intranet'), JSON.stringify(cat));
  const adminCat = call('/catalog', admin);
  assert.equal(adminCat.sourceUrl, 'https://intranet.example/c.json?token=abc');
  assert.match(adminCat.error, /token=abc/);
});

test('non-admin shared reads (/datasets, /storage, /priority) are invalidated by every change made through the plugin', async () => {
  const { mgr, dataDir, manifestPath } = baseMgr();
  let fireDone: ((j: DownloadJob) => void) | null = null;
  mgr.downloads = { ...fakeDownloadEngine(), onAnyDone: (cb) => { fireDone = cb; return () => { fireDone = null; }; } };
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr); // before any engine-specific hook exists, like registerWithRouter before start()
  const anon = { skPrincipal: { permissions: 'readonly' } };
  const count = async () => ((await call('GET', '/datasets', anon)).body as unknown[]).length;
  const used = async () => ((await call('GET', '/storage', anon)).body as any).usedByPluginBytes as number;

  // 1. A download finishing (onAnyDone) — hooked lazily, on the engine current at request time.
  assert.equal(await count(), 0);
  const usedBefore = await used();
  fs.writeFileSync(path.join(dataDir, 'grib', 'a.grb2'), Buffer.alloc(64));
  assert.equal(await count(), 0, 'cached until something changes');
  fireDone!({ id: 'j', catalogSourceId: 's', state: 'done', bytes: 64, totalBytes: 64 });
  assert.equal(await count(), 1, 'completion invalidates /datasets');
  assert.equal(await used(), usedBefore + 64, 'completion invalidates /storage');

  // 2. start()/restart swaps the engine: the old hook is dropped, the new one is used.
  let fireDone2: ((j: DownloadJob) => void) | null = null;
  mgr.downloads = { ...fakeDownloadEngine(), onAnyDone: (cb) => { fireDone2 = cb; return () => {}; } };
  fs.writeFileSync(path.join(dataDir, 'grib', 'b.grb2'), Buffer.alloc(8));
  assert.equal(await count(), 2, 'a new engine invalidates by itself');
  assert.equal(fireDone, null, 'hook on the replaced engine was removed');
  fs.writeFileSync(path.join(dataDir, 'grib', 'c.grb2'), Buffer.alloc(8));
  assert.equal(await count(), 2);
  fireDone2!({ id: 'k', catalogSourceId: 's', state: 'error', bytes: 0, totalBytes: null });
  assert.equal(await count(), 3);

  // 3. Mutation routes.
  const del = await call('DELETE', '/datasets/:id', { params: { id: 'orphan:grib:grib/c.grb2' } });
  assert.equal(del.statusCode, 200);
  assert.equal(await count(), 2, 'DELETE invalidates');

  writeManifestAtomic(manifestPath, upsertInstall({ manifest_version: 1, installs: [] } as InstallManifest, {
    id: 'inst-1', catalogSourceId: 'src', type: 'grib2', files: ['grib/a.grb2'], downloaded_at: new Date().toISOString(), size_bytes: 64,
  } as any));
  fireDone2!({ id: 'm', catalogSourceId: 'src', state: 'done', bytes: 64, totalBytes: 64 });
  const pri = async () => ((await call('GET', '/priority', anon)).body as any);
  assert.deepEqual((await pri()).datasets, ['inst-1']);
  const datasetsNow = (await call('GET', '/datasets', anon)).body as any[];
  assert.equal(datasetsNow.find((d) => d.id === 'inst-1').autoUpdate, false);
  assert.equal((await call('PUT', '/datasets/:id/auto-update', { params: { id: 'inst-1' }, body: { enabled: true } })).statusCode, 200);
  assert.equal(((await call('GET', '/datasets', anon)).body as any[]).find((d) => d.id === 'inst-1').autoUpdate, true, 'auto-update invalidates');

  assert.equal((await call('PUT', '/priority', { body: { order: ['harmonic', 'utcef', 'grib2'] } })).statusCode, 200);
  assert.deepEqual((await pri()).order, ['harmonic', 'utcef', 'grib2'], 'PUT /priority invalidates');

  // 4. A catalog that re-synced (new fetchedAt) invalidates too.
  let fetchedAt = '2026-01-01T00:00:00Z';
  mgr.catalog = { get: () => ({ status: 'cached', document: null, fetchedAt, error: null, sourceUrl: '', warnings: [] }), refresh: async () => mgr.catalog.get() } as CatalogClient;
  await count();
  fs.writeFileSync(path.join(dataDir, 'grib', 'd.grb2'), Buffer.alloc(8));
  const n = await count();
  fetchedAt = '2026-01-02T00:00:00Z';
  assert.equal(await count(), n + 1, 'catalog re-sync invalidates');
});

test('a failing read is a 500 (generic text for non-admins, verbatim for admins) and is not cached', async () => {
  const { mgr } = baseMgr();
  let fail = true;
  mgr.getPriority = () => { if (fail) throw new Error('boom /secret/path'); return [...DEFAULT_PRIORITY]; };
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const anon = { skPrincipal: { permissions: 'readonly' } };
  const r1 = await call('GET', '/priority', anon);
  assert.equal(r1.statusCode, 500);
  assert.ok(!JSON.stringify(r1.body).includes('secret'));
  const a1 = await call('GET', '/priority', { skPrincipal: { permissions: 'admin' } });
  assert.equal(a1.statusCode, 500, 'a synchronous throw on the admin path is a 500 too, not an unhandled rejection');
  assert.match(JSON.stringify(a1.body), /boom/, 'admins see the real error');
  fail = false;
  const r2 = await call('GET', '/priority', anon);
  assert.equal(r2.statusCode, 200, 'the failure was not cached');
});

for (const route of ['/downloads/events', '/downloads/:id/events']) test(`SSE ${route} caps concurrent non-admin viewers (503 beyond MAX_PUBLIC_SSE_CLIENTS); admins are never capped`, () => {
  const { mgr } = baseMgr();
  const jobId = mgr.downloads.start('s', {}).id; // the per-job feed 404s an unknown job before admission
  const handlers = new Map<string, (req: any, res: any) => void | Promise<void>>();
  registerManagerRoutes({ get: (p, h) => handlers.set(p, h), post: () => {}, put: () => {}, delete: () => {} }, mgr);
  const closers: (() => void)[] = [];
  const open = (principal: { permissions: string }) => {
    let status = 200;
    const res = {
      status(c: number) { status = c; return res; }, json() {},
      writeHead() {}, write() { return true; }, end() {},
      on(_e: string, cb: () => void) { closers.push(cb); },
    };
    void handlers.get(route)!({ params: { id: jobId }, query: {}, skPrincipal: principal }, res);
    return status;
  };
  for (let i = 0; i < MAX_PUBLIC_SSE_CLIENTS; i++) assert.equal(open({ permissions: 'readonly' }), 200);
  assert.equal(open({ permissions: 'readonly' }), 503);
  assert.equal(open({ permissions: 'admin' }), 200);
  closers[0](); // one viewer disconnects → a slot frees up
  assert.equal(open({ permissions: 'readonly' }), 200);
  closers.forEach((c) => c());
});

test('GET /datasets: non-admins share one cached scan; admins scan fresh and refresh it', async () => {
  const { mgr, dataDir } = baseMgr();
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr);
  const anon = { skPrincipal: { permissions: 'readonly' } };
  const admin = { skPrincipal: { permissions: 'admin' } };
  const before = ((await call('GET', '/datasets', anon)).body as unknown[]).length;
  fs.writeFileSync(path.join(dataDir, 'x.grb2'), Buffer.alloc(16));
  assert.equal(((await call('GET', '/datasets', anon)).body as unknown[]).length, before, 'anon reuses the cached list');
  assert.equal(((await call('GET', '/datasets', admin)).body as unknown[]).length, before + 1, 'admin scans fresh');
  assert.equal(((await call('GET', '/datasets', anon)).body as unknown[]).length, before + 1, 'admin refreshed the shared cache');
});

test('securityEnabled: a missing principal is NOT admin (fails closed)', async () => {
  const { mgr } = baseMgr();
  mgr.catalog = { get: () => ({ status: 'cached', document: null, fetchedAt: null, error: null, sourceUrl: 'https://intranet.example/c.json', warnings: [] }), refresh: async () => mgr.catalog.get() } as CatalogClient;
  const { router, call } = makeHarness();
  registerManagerRoutes(router, mgr, router, { securityEnabled: () => true });
  assert.equal(((await call('GET', '/catalog')).body as any).sourceUrl, '');
  assert.ok(!('path' in ((await call('GET', '/storage')).body as any)));
  assert.equal(((await call('GET', '/catalog', { skPrincipal: { permissions: 'admin' } })).body as any).sourceUrl, 'https://intranet.example/c.json');
});

test('SSE /downloads/:id/events on a terminal job closes at once and frees its public slot', () => {
  const { mgr } = baseMgr();
  mgr.downloads = { ...fakeDownloadEngine(), get: (id) => ({ id, catalogSourceId: 's', state: 'done', bytes: 1, totalBytes: 1 }) };
  const handlers = new Map<string, (req: any, res: any) => void | Promise<void>>();
  registerManagerRoutes({ get: (p, h) => handlers.set(p, h), post: () => {}, put: () => {}, delete: () => {} }, mgr);
  for (let i = 0; i < MAX_PUBLIC_SSE_CLIENTS + 1; i++) {
    let status = 200;
    let ended = false;
    const res = {
      status(c: number) { status = c; return res; }, json() {},
      writeHead() {}, write() { return true; }, end() { ended = true; },
      on() {},
    };
    void handlers.get('/downloads/:id/events')!({ params: { id: 'j' }, query: {}, skPrincipal: { permissions: 'readonly' } }, res);
    assert.equal(status, 200);
    assert.ok(ended, 'stream ended after the snapshot');
  }
});
