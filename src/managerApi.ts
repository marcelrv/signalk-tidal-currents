// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * REST API for the Tidal Currents Manager webapp (PRD §7). Registered
 * alongside (not instead of) the existing prediction API in `api.ts`. The
 * manager routes live only on the `/plugins/signalk-tidal-currents` path
 * (where `router.access('readonly')` applies); the prediction API stays on
 * both that and `/signalk/v2/api/currents`.
 */

import * as fs from 'fs';
import * as path from 'path';

import { ApiState } from './api.js';
import { CatalogClient } from './catalog.js';
import { CatalogSourceType } from './catalogTypes.js';
import { computeInstallStatus } from './datasetStatus.js';
import { DownloadEngine, DownloadJob, FileSelector } from './downloads.js';
import { readManifest, removeInstall, upsertInstall, writeManifestAtomic } from './manifest.js';
import { DEFAULT_PRIORITY, SourceType, isValidDatasetStack, isValidPriorityOrder, resolveDatasetStack } from './priority.js';
import { StorageStats, cleanupCandidates, statStorage } from './storage.js';
import { listDataFilesRecursive } from './utcef.js';

/** Orphan-scan classification tag — same three labels the download engine's own subfolder convention uses, kept only for the `orphan:<tag>:<path>` id shape and the UI's type icon; not used to resolve a path (there's only one configured directory now). */
export type OrphanTag = 'harmonic' | 'grib' | 'utcef';

interface MReq {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body?: unknown;
  /** Set by signalk-server's security layer; absent when security is off. */
  skPrincipal?: { permissions?: string };
}

/** Optional hooks for `registerManagerRoutes`. */
export interface ManagerRouteOptions {
  /** True when the server enforces security. Without it (tests) a missing principal is treated as "security off". */
  securityEnabled?: () => boolean;
}

/** Concurrent SSE streams allowed for non-admin viewers (shared by both feeds) — beyond it they get a 503 and the webapp falls back to polling. */
export const MAX_PUBLIC_SSE_CLIENTS = 32;

/** How long non-admin /storage and /datasets requests reuse one data-dir scan (the walks are synchronous — anonymous visitors must not be able to trigger them at will). */
export const PUBLIC_SCAN_TTL_MS = 30_000;
/** Former name of PUBLIC_SCAN_TTL_MS, kept for importers. */
export const PUBLIC_STORAGE_TTL_MS = PUBLIC_SCAN_TTL_MS;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
interface MRes {
  json(body: unknown): void;
  status(code: number): MRes;
}
export interface ManagerRouterLike {
  get(path: string, handler: (req: MReq, res: MRes) => void): void;
  post(path: string, handler: (req: MReq, res: MRes) => void): void;
  put(path: string, handler: (req: MReq, res: MRes) => void): void;
  delete(path: string, handler: (req: MReq, res: MRes) => void): void;
}

/**
 * A wider view of the response object, used ONLY by the SSE download-progress
 * route. `MRes` above is a narrow TS view over the SAME real Express `res`
 * signalk-server hands to every route handler (registerWithRouter/the v2
 * `app.get` shim mount real Express objects, not a runtime shim) — so this
 * is just a locally-scoped wider type for one handler, not a new mechanism.
 */
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: 'close', cb: () => void): void;
}

export interface ManagerState {
  catalog: CatalogClient;
  downloads: DownloadEngine;
  manifestPath: string;
  /** The plugin's single configured Data Directory — every install's `files` are relative to this. */
  dataDir: string;
  getPriority(): SourceType[];
  setPriority(order: SourceType[]): void;
  /** Persisted per-dataset stack (PRD §5.3 Phase 3) — raw install ids as saved, NOT the resolved full stack. */
  getDatasetStack(): string[];
  setDatasetStack(ids: string[]): void;
  /** Shared with the existing prediction ApiState so /datasets can reuse already-parsed metadata (titles, UTCEF license fields) instead of re-parsing files. */
  apiState: ApiState;
  /** Server-side vessel position for Smart Cleanup's distance math (PRD §5.4 Phase 2) — null when no position fix is available. */
  getVesselPosition(): { lat: number; lon: number } | null;
}

/** Defense against path traversal: the resolved path must land inside the managed Data Directory. */
function isWithinManagedDir(fullPath: string, dataDir: string): boolean {
  const resolved = path.resolve(fullPath);
  const base = path.resolve(dataDir);
  return resolved === base || resolved.startsWith(base + path.sep);
}

interface DatasetEntry {
  id: string;
  catalogSourceId: string | null;
  type: CatalogSourceType;
  name: string;
  files: string[];
  sizeBytes: number;
  downloadedAt: string | null;
  cycle?: string;
  /** Present for template (forecast/nowcast) installs — needed to re-select the same region on a future update (e.g. "Update All"). */
  regionId?: string;
  /** Present for template installs — a region can carry both a forecast and a nowcast file, so region_id alone doesn't uniquely re-select the same one. */
  fileType?: 'forecast' | 'nowcast';
  /** Present for template installs where region_id + fileType still doesn't uniquely identify the file (e.g. BSH's +24h/+48h/+72h forecast-day files). */
  variant?: string;
  status: 'active' | 'update-available' | 'error';
  /** Present only for expiry-method (grib2 forecast) installs — the countdown fields for PRD §5.5's "expires in 14h" display. */
  updateCheckMethod?: 'sha256' | 'expiry';
  expiresAt?: string;
  remainingHours?: number;
  maxAgeHours?: number;
  /** Opt-in "keep fresh when online" (PRD §5.5 Phase 2) — always false for orphans, which aren't manifest-tracked so there's nothing to toggle. */
  autoUpdate: boolean;
  contributor?: string;
  sourceUrl?: string;
  // UTCEF-only attribution surface (PRD §5.7) — parsed from the file's own metadata, see utcef.ts.
  license?: string;
  licenseUrl?: string;
  citationRequired?: string;
  copyright?: string;
}

function installedDatasets(mgr: ManagerState): DatasetEntry[] {
  const manifest = readManifest(mgr.manifestPath);
  const catalogDoc = mgr.catalog.get().document;
  const utcefData = mgr.apiState.utcef?.get();

  return manifest.installs.map((install) => {
    const filesExist = install.files.every((f) => fs.existsSync(path.join(mgr.dataDir, f)));
    const source = catalogDoc?.sources.find((s) => s.id === install.catalogSourceId);

    const { status, ...expiry } = computeInstallStatus(install, source, filesExist);

    const entry: DatasetEntry = {
      id: install.id,
      catalogSourceId: install.catalogSourceId,
      type: install.type,
      name: source?.name ?? install.catalogSourceId,
      files: install.files,
      sizeBytes: install.size_bytes,
      downloadedAt: install.downloaded_at,
      cycle: install.cycle,
      regionId: install.regionId,
      fileType: install.fileType,
      variant: install.variant,
      status,
      ...expiry,
      autoUpdate: install.autoUpdate ?? false,
      contributor: source?.contributor,
      sourceUrl: source?.url,
    };
    if (install.type === 'utcef' && utcefData) {
      entry.license = utcefData.license;
      entry.licenseUrl = utcefData.licenseUrl;
      entry.citationRequired = utcefData.citationRequired;
      entry.copyright = utcefData.copyright;
    }
    return entry;
  });
}

/**
 * Legacy/manually-dropped files not tracked by the manifest (e.g. the
 * auto-downloaded OpenCPN pair). All three patterns scan the SAME single
 * Data Directory, recursively — there's no per-type directory to scope to
 * anymore, and a manually-dropped file works from any subpath, not just the
 * download engine's own `harmonic`/`grib`/`utcef` convention.
 */
function orphanDatasets(mgr: ManagerState): DatasetEntry[] {
  const manifest = readManifest(mgr.manifestPath);
  const referenced = new Set(manifest.installs.flatMap((i) => i.files));
  const results: DatasetEntry[] = [];

  const scan = (tag: OrphanTag, pattern: RegExp, type: CatalogSourceType) => {
    let names: string[];
    try {
      names = listDataFilesRecursive(mgr.dataDir, pattern);
    } catch {
      return;
    }
    for (const f of names) {
      if (referenced.has(f)) continue;
      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(path.join(mgr.dataDir, f)).size;
      } catch {
        continue;
      }
      results.push({
        id: `orphan:${tag}:${f}`, catalogSourceId: null, type, name: f,
        files: [f], sizeBytes, downloadedAt: null, status: 'active', autoUpdate: false,
      });
    }
  };
  scan('harmonic', /^HARMONIC(\.IDX)?$|^HARMONICS_NO_US(\.IDX)?$/i, 'harmonic');
  scan('grib', /\.(grb2|grib2|grb|grib)$/i, 'grib2');
  scan('utcef', /\.utcef(\.gz)?$/i, 'utcef');
  return results;
}

/** The GET-only router the public read routes are registered on — see `registerManagerRoutes`. */
export type ManagerReadRouterLike = Pick<ManagerRouterLike, 'get'>;

/**
 * Mount the Tidal Currents Manager routes. Mutations (and admin-only reads
 * such as /cleanup-candidates) go on `router`; the read-only manager view
 * (catalog, datasets, storage, downloads, priority) is registered EXPLICITLY
 * on `reads`. registerWithRouter passes signalk-server's
 * `router.access('readonly')` there, so those GETs are readable by
 * read-only users (incl. anonymous visitors under `allow_readonly`, e.g. a
 * public demo) while everything on `router` stays admin-only. A new route is
 * public only if it is registered on `reads` — never by HTTP method alone.
 */
export function registerManagerRoutes(router: ManagerRouterLike, mgr: ManagerState, reads: ManagerReadRouterLike = router, opts: ManagerRouteOptions = {}): void {
  // Admin iff security is off or the principal is admin. With security on,
  // every request reaching a plugin route carries a principal (anonymous
  // `allow_readonly` visitors get 'readonly'); a MISSING one must not fail
  // open to admin, so it is only trusted when security is known to be off.
  const isAdminRequest = (req: MReq) => {
    if (opts.securityEnabled ? !opts.securityEnabled() : !req.skPrincipal) return true;
    return req.skPrincipal?.permissions === 'admin';
  };
  // Read-only visitors must not learn the server's filesystem layout or the
  // operator's config: strip the data directory from download error strings
  // (e.g. "ENOSPC … '/home/…/x.grb2'") and the configured catalog URL from
  // /catalog. Admins see everything verbatim.
  // Only whole-path occurrences of the ABSOLUTE (resolved) data dir are
  // replaced — '/data' must not match inside 'https://host/data/x', and a
  // relative form (e.g. 'data') would hit ordinary words while revealing no
  // filesystem layout anyway.
  const dataDirRe = () => {
    const abs = mgr.dataDir ? path.resolve(mgr.dataDir).replace(/[\\/]+$/, '') : '';
    if (abs === '') return null; // unset, or the filesystem root
    return new RegExp(`(^|[^\\w.:/\\\\-])${escapeRegExp(abs)}(?=[\\\\/]|$|[^\\w.-])`, 'g');
  };
  const redactPath = (s: string) => {
    const re = dataDirRe();
    return re ? s.replace(re, '$1<data dir>') : s;
  };
  const jobFor = (req: MReq) => <T extends { error?: string }>(job: T): T =>
    job.error && !isAdminRequest(req) ? { ...job, error: redactPath(job.error) } : job;

  let publicSseClients = 0;
  /** Admits an SSE subscriber; returns a release callback, or null (503 already sent) when non-admin viewers are at the cap. */
  const admitSse = (req: MReq, res: MRes): (() => void) | null => {
    if (isAdminRequest(req)) return () => {};
    if (publicSseClients >= MAX_PUBLIC_SSE_CLIENTS) {
      res.status(503).json({ error: 'too many live viewers — poll /downloads instead' });
      return null;
    }
    publicSseClients++;
    let released = false;
    return () => {
      if (!released) publicSseClients--;
      released = true;
    };
  };

  reads.get('/catalog', (req, res) => {
    const state = mgr.catalog.get();
    if (isAdminRequest(req)) {
      res.json(state);
      return;
    }
    const { sourceUrl, ...rest } = state;
    const error = state.error && sourceUrl ? state.error.split(sourceUrl).join('<catalog url>') : state.error;
    res.json({ ...rest, sourceUrl: '', error: error === null ? null : redactPath(error) });
  });

  router.post('/catalog/refresh', async (_req, res) => {
    const state = await mgr.catalog.refresh();
    if (state.error) {
      res.status(502).json(state);
      return;
    }
    res.json(state);
  });

  // Same sharing as /storage below: the scan is synchronous (manifest read,
  // per-file existsSync, recursive walks), so non-admins reuse one result
  // per PUBLIC_SCAN_TTL_MS; admins compute fresh and refresh the shared copy.
  let publicDatasets: { at: number; list: unknown[] } | null = null;
  reads.get('/datasets', (req, res) => {
    if (isAdminRequest(req)) {
      const list = [...installedDatasets(mgr), ...orphanDatasets(mgr)];
      publicDatasets = { at: Date.now(), list };
      res.json(list);
      return;
    }
    if (!publicDatasets || Date.now() - publicDatasets.at > PUBLIC_SCAN_TTL_MS) {
      publicDatasets = { at: Date.now(), list: [...installedDatasets(mgr), ...orphanDatasets(mgr)] };
    }
    res.json(publicDatasets.list);
  });

  router.delete('/datasets/:id', (req, res) => {
    const id = req.params.id;
    const manifest = readManifest(mgr.manifestPath);
    const install = manifest.installs.find((i) => i.id === id);
    if (install) {
      const targets = install.files.map((f) => path.join(mgr.dataDir, f));
      if (targets.some((t) => !isWithinManagedDir(t, mgr.dataDir))) {
        res.status(400).json({ error: 'refused: install references a path outside the managed directory' });
        return;
      }
      for (const t of targets) {
        try { fs.unlinkSync(t); } catch { /* already gone */ }
      }
      writeManifestAtomic(mgr.manifestPath, removeInstall(manifest, id));
      res.json({ ok: true });
      return;
    }

    const orphanMatch = /^orphan:(harmonic|grib|utcef):(.+)$/.exec(id);
    if (orphanMatch) {
      const [, , filename] = orphanMatch; // tag is no longer needed to resolve a path — one shared Data Directory now
      // The filename comes from the URL param. Forward-slash subpaths are
      // legitimate (catalog downloads land in subdirs, and the orphan scan
      // reports them that way) — but reject backslashes, parent traversal,
      // and absolute paths before it ever reaches path.join.
      // isWithinManagedDir below re-checks the resolved result regardless.
      if (filename.includes('\\') || filename.startsWith('/') || filename.split('/').includes('..')) {
        res.status(400).json({ error: 'refused: invalid filename' });
        return;
      }
      const target = path.join(mgr.dataDir, filename);
      if (!isWithinManagedDir(target, mgr.dataDir)) {
        res.status(400).json({ error: 'refused: path outside the managed directory' });
        return;
      }
      try {
        fs.unlinkSync(target);
      } catch {
        res.status(404).json({ error: `file not found: ${filename}` });
        return;
      }
      res.json({ ok: true });
      return;
    }

    res.status(404).json({ error: `unknown dataset id: ${id}` });
  });

  // Per-dataset "keep fresh when online" opt-in (PRD §5.5 Phase 2). Only
  // meaningful for manifest-tracked installs — an orphan has no
  // catalogSourceId for `runAutoUpdateSweep` to re-download against.
  router.put('/datasets/:id/auto-update', (req, res) => {
    const id = req.params.id;
    const body = (req.body ?? {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const manifest = readManifest(mgr.manifestPath);
    const install = manifest.installs.find((i) => i.id === id);
    if (!install) {
      res.status(404).json({ error: `unknown dataset id: ${id}` });
      return;
    }
    const updated = { ...install, autoUpdate: body.enabled };
    writeManifestAtomic(mgr.manifestPath, upsertInstall(manifest, updated));
    res.json({ ok: true, autoUpdate: body.enabled });
  });

  // Non-admins share one scan per PUBLIC_SCAN_TTL_MS (overlapping
  // requests await the same promise); admins always scan fresh, and their
  // result refreshes the shared copy (e.g. right after a download/delete).
  let publicStorage: { at: number; stats: Promise<Omit<StorageStats, 'path'>> } | null = null;
  const publicView = ({ path: _dataDir, ...rest }: StorageStats) => rest;
  reads.get('/storage', async (req, res) => {
    if (isAdminRequest(req)) {
      const stats = await statStorage(mgr.dataDir);
      publicStorage = { at: Date.now(), stats: Promise.resolve(publicView(stats)) };
      res.json(stats);
      return;
    }
    if (!publicStorage || Date.now() - publicStorage.at > PUBLIC_SCAN_TTL_MS) {
      const stats = statStorage(mgr.dataDir).then(publicView);
      publicStorage = { at: Date.now(), stats };
      stats.catch(() => { if (publicStorage?.stats === stats) publicStorage = null; }); // don't cache a failure
    }
    res.json(await publicStorage.stats);
  });

  router.get('/cleanup-candidates', (req, res) => {
    const parsed = parseFloat(String(req.query.maxDistanceNm));
    const maxDistanceNm = Number.isFinite(parsed) && parsed >= 0 ? parsed : 50; // plausible day-sail/cruising default, tunable via the query param
    const vesselPosition = mgr.getVesselPosition();
    const candidates = cleanupCandidates(readManifest(mgr.manifestPath), mgr.catalog.get().document, vesselPosition, maxDistanceNm);
    res.json({ vesselPosition, maxDistanceNm, candidates });
  });

  router.post('/downloads', (req, res) => {
    const body = (req.body ?? {}) as { sourceId?: string; region_id?: string; type?: 'forecast' | 'nowcast'; variant?: string; filename?: string };
    if (!body.sourceId) {
      res.status(400).json({ error: 'sourceId is required' });
      return;
    }
    const selector: FileSelector = { region_id: body.region_id, type: body.type, variant: body.variant, filename: body.filename };
    try {
      const job = mgr.downloads.start(body.sourceId, selector);
      res.json(job);
    } catch (e) {
      res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  reads.get('/downloads', (req, res) => {
    res.json(mgr.downloads.list().map(jobFor(req)));
  });

  // Global completion feed (fixes "Update"/"Update all" appearing to do
  // nothing when no per-job SSE/poll subscription happens to be mounted for
  // that exact job — e.g. Map view, or a filter hiding the row): one
  // long-lived stream, independent of any specific job id, that emits every
  // job the moment it reaches a terminal state via `onAnyDone` (already
  // fires regardless of whether anyone called `onUpdate` for that job).
  // Registered BEFORE `/downloads/:id` below so the literal path wins.
  reads.get('/downloads/events', (req, res) => {
    const admitted = admitSse(req, res);
    if (!admitted) return;
    const release: () => void = admitted; // non-null alias for the hoisted cleanup() below
    const publicJob = jobFor(req);
    const raw = res as unknown as SseRes;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    // Flush immediately — some proxies/compression middleware hold headers
    // AND body back until the first write, so without this a client sees
    // nothing at all (not even the response headers) until the next
    // heartbeat, up to 15s later, or the next job completion, whichever
    // comes first (the per-job SSE route below doesn't hit this because it
    // always has a real `send(job)` to write right after `writeHead`).
    raw.write(':connected\n\n');
    const heartbeat = setInterval(() => {
      if (!closed) raw.write(':hb\n\n');
    }, 15_000);

    const unsubscribe = mgr.downloads.onAnyDone((job) => {
      if (!closed) raw.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
    });

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      release();
      raw.end();
    }

    raw.on('close', cleanup);
  });

  reads.get('/downloads/:id', (req, res) => {
    const job = mgr.downloads.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: `unknown download job: ${req.params.id}` });
      return;
    }
    res.json(jobFor(req)(job));
  });

  // SSE progress (PRD §9 Phase 2) — an upgrade layered on top of the polling
  // route above, not a replacement: the frontend falls back to polling if
  // this fails/isn't available, and this route itself sends an immediate
  // snapshot on connect so a client that subscribes after the job already
  // progressed (or even finished) still gets a correct current state rather
  // than waiting for an event that may never come.
  reads.get('/downloads/:id/events', (req, res) => {
    const job = mgr.downloads.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: `unknown download job: ${req.params.id}` });
      return;
    }
    const admitted = admitSse(req, res);
    if (!admitted) return;
    const release: () => void = admitted; // non-null alias for the hoisted cleanup() below
    const publicJob = jobFor(req);
    const raw = res as unknown as SseRes;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const send = (j: DownloadJob) => {
      if (closed) return;
      raw.write(`data: ${JSON.stringify(publicJob(j))}\n\n`);
    };
    send(job);

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: () => void = () => {};
    function cleanup(): void {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      release();
      raw.end();
    }

    // A job that is already terminal will never fire another update, so the
    // snapshot is the whole stream — close now instead of holding a public
    // SSE slot open forever.
    if (job.state === 'done' || job.state === 'error') {
      cleanup();
      return;
    }

    heartbeat = setInterval(() => {
      if (!closed) raw.write(':hb\n\n');
    }, 15_000);

    unsubscribe = mgr.downloads.onUpdate(req.params.id, (updated) => {
      send(updated);
      if (updated.state === 'done' || updated.state === 'error') cleanup();
    });

    raw.on('close', cleanup);
  });

  // `datasets` is the RESOLVED full stack (persisted order first, then any
  // unranked installs appended in type-order) so the webapp can render the
  // whole Phase 3 priority stack directly without re-deriving the merge.
  const resolvedStack = () =>
    resolveDatasetStack(mgr.getDatasetStack(), mgr.getPriority(), readManifest(mgr.manifestPath).installs);

  reads.get('/priority', (_req, res) => {
    res.json({ order: mgr.getPriority(), default: DEFAULT_PRIORITY, datasets: resolvedStack().map((e) => e.id) });
  });

  router.put('/priority', (req, res) => {
    const body = (req.body ?? {}) as { order?: unknown; datasets?: unknown };
    if (body.order === undefined && body.datasets === undefined) {
      res.status(400).json({ error: 'order and/or datasets is required' });
      return;
    }
    if (body.order !== undefined && !isValidPriorityOrder(body.order)) {
      res.status(400).json({ error: 'order must be a permutation of ["grib2","utcef","harmonic"]' });
      return;
    }
    if (body.datasets !== undefined && !isValidDatasetStack(body.datasets)) {
      res.status(400).json({ error: 'datasets must be an array of unique install ids' });
      return;
    }
    if (body.order !== undefined) mgr.setPriority(body.order as SourceType[]);
    if (body.datasets !== undefined) mgr.setDatasetStack(body.datasets as string[]);
    res.json({ order: mgr.getPriority(), default: DEFAULT_PRIORITY, datasets: resolvedStack().map((e) => e.id) });
  });
}
