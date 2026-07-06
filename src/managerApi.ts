// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * REST API for the Tidal Currents Manager webapp (PRD §7). Registered
 * alongside (not instead of) the existing prediction API in `api.ts`, on the
 * same two mount points (`/plugins/signalk-tidal-currents` and
 * `/signalk/v2/api/currents`).
 */

import * as fs from 'fs';
import * as path from 'path';

import { ApiState } from './api.js';
import { CatalogClient } from './catalog.js';
import { CatalogSourceType } from './catalogTypes.js';
import { computeInstallStatus } from './datasetStatus.js';
import { DownloadEngine, FileSelector } from './downloads.js';
import { readManifest, removeInstall, upsertInstall, writeManifestAtomic } from './manifest.js';
import { DEFAULT_PRIORITY, SourceType, isValidDatasetStack, isValidPriorityOrder, resolveDatasetStack } from './priority.js';
import { cleanupCandidates, statStorage } from './storage.js';
import { listDataFilesRecursive } from './utcef.js';

/** Orphan-scan classification tag — same three labels the download engine's own subfolder convention uses, kept only for the `orphan:<tag>:<path>` id shape and the UI's type icon; not used to resolve a path (there's only one configured directory now). */
export type OrphanTag = 'harmonic' | 'grib' | 'utcef';

interface MReq {
  params: Record<string, string>;
  query: Record<string, unknown>;
  body?: unknown;
}
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

export function registerManagerRoutes(router: ManagerRouterLike, mgr: ManagerState): void {
  router.get('/catalog', (_req, res) => {
    res.json(mgr.catalog.get());
  });

  router.post('/catalog/refresh', async (_req, res) => {
    const state = await mgr.catalog.refresh();
    if (state.error) {
      res.status(502).json(state);
      return;
    }
    res.json(state);
  });

  router.get('/datasets', (_req, res) => {
    res.json([...installedDatasets(mgr), ...orphanDatasets(mgr)]);
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

  router.get('/storage', async (_req, res) => {
    res.json(await statStorage(mgr.dataDir));
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

  router.get('/downloads', (_req, res) => {
    res.json(mgr.downloads.list());
  });

  router.get('/downloads/:id', (req, res) => {
    const job = mgr.downloads.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: `unknown download job: ${req.params.id}` });
      return;
    }
    res.json(job);
  });

  // SSE progress (PRD §9 Phase 2) — an upgrade layered on top of the polling
  // route above, not a replacement: the frontend falls back to polling if
  // this fails/isn't available, and this route itself sends an immediate
  // snapshot on connect so a client that subscribes after the job already
  // progressed (or even finished) still gets a correct current state rather
  // than waiting for an event that may never come.
  router.get('/downloads/:id/events', (req, res) => {
    const job = mgr.downloads.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: `unknown download job: ${req.params.id}` });
      return;
    }
    const raw = res as unknown as SseRes;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let closed = false;
    const send = (j: unknown) => {
      if (closed) return;
      raw.write(`data: ${JSON.stringify(j)}\n\n`);
    };
    send(job);

    const heartbeat = setInterval(() => {
      if (!closed) raw.write(':hb\n\n');
    }, 15_000);

    const unsubscribe = mgr.downloads.onUpdate(req.params.id, (updated) => {
      send(updated);
      if (updated.state === 'done' || updated.state === 'error') cleanup();
    });

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    }

    raw.on('close', cleanup);
  });

  // `datasets` is the RESOLVED full stack (persisted order first, then any
  // unranked installs appended in type-order) so the webapp can render the
  // whole Phase 3 priority stack directly without re-deriving the merge.
  const resolvedStack = () =>
    resolveDatasetStack(mgr.getDatasetStack(), mgr.getPriority(), readManifest(mgr.manifestPath).installs);

  router.get('/priority', (_req, res) => {
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
