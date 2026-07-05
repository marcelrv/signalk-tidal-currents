// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * REST API for the Tidal Currents Manager webapp (PRD §7). Registered
 * alongside (not instead of) the existing prediction API in `api.ts`, on the
 * same two mount points (`/plugins/signalk-tidal-currents` and
 * `/signalk/v2/api/currents`).
 *
 * Phase 1 scope only — `GET /cleanup-candidates` (Smart Cleanup) is
 * deliberately NOT mounted here (Phase 2, see storage.ts).
 */

import * as fs from 'fs';
import * as path from 'path';

import { ApiState } from './api.js';
import { CatalogClient } from './catalog.js';
import { CatalogSourceType, StaticCatalogFile, isTemplateFile } from './catalogTypes.js';
import { DownloadEngine, FileSelector } from './downloads.js';
import { ManifestDir, readManifest, removeInstall, writeManifestAtomic } from './manifest.js';
import { DEFAULT_PRIORITY, SourceType, isValidPriorityOrder } from './priority.js';
import { StorageDirs, statStorage } from './storage.js';

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

export interface ManagerDirs {
  harmonic: string;
  grib2: string;
  utcef: string;
}

export interface ManagerState {
  catalog: CatalogClient;
  downloads: DownloadEngine;
  manifestPath: string;
  dirs: ManagerDirs;
  managerDir: string;
  getPriority(): SourceType[];
  setPriority(order: SourceType[]): void;
  /** Shared with the existing prediction ApiState so /datasets can reuse already-parsed metadata (titles, UTCEF license fields) instead of re-parsing files. */
  apiState: ApiState;
}

function dirForTag(tag: ManifestDir, dirs: ManagerDirs): string {
  if (tag === 'grib') return dirs.grib2;
  if (tag === 'utcef') return dirs.utcef;
  return dirs.harmonic;
}

/** Defense against path traversal: the resolved path must land inside one of the three managed dirs. */
function isWithinManagedDirs(fullPath: string, dirs: ManagerDirs): boolean {
  const resolved = path.resolve(fullPath);
  return [dirs.harmonic, dirs.grib2, dirs.utcef].some((d) => {
    const base = path.resolve(d);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

interface DatasetEntry {
  id: string;
  catalogSourceId: string | null;
  type: CatalogSourceType;
  name: string;
  files: string[];
  dir: ManifestDir;
  sizeBytes: number;
  downloadedAt: string | null;
  cycle?: string;
  status: 'active' | 'update-available' | 'error';
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
    const dirPath = dirForTag(install.dir, mgr.dirs);
    const filesExist = install.files.every((f) => fs.existsSync(path.join(dirPath, f)));
    const source = catalogDoc?.sources.find((s) => s.id === install.catalogSourceId);

    let status: DatasetEntry['status'] = filesExist ? 'active' : 'error';
    if (filesExist && source) {
      if (source.update_check.method === 'sha256' && install.sha256) {
        const staticFile = source.files.find(
          (f): f is StaticCatalogFile => !isTemplateFile(f) && !!f.sha256,
        );
        if (staticFile && staticFile.sha256 !== install.sha256) status = 'update-available';
      } else if (source.update_check.method === 'expiry' && install.cycle && source.update_check.max_age_hours) {
        const ageHours = (Date.now() - Date.parse(install.cycle)) / 3600_000;
        if (ageHours > source.update_check.max_age_hours) status = 'update-available';
      }
    }

    const entry: DatasetEntry = {
      id: install.id,
      catalogSourceId: install.catalogSourceId,
      type: install.type,
      name: source?.name ?? install.catalogSourceId,
      files: install.files,
      dir: install.dir,
      sizeBytes: install.size_bytes,
      downloadedAt: install.downloaded_at,
      cycle: install.cycle,
      status,
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

/** Legacy/manually-dropped files not tracked by the manifest (e.g. the auto-downloaded OpenCPN pair). */
function orphanDatasets(mgr: ManagerState): DatasetEntry[] {
  const manifest = readManifest(mgr.manifestPath);
  const referenced = new Set(manifest.installs.flatMap((i) => i.files.map((f) => `${i.dir}:${f}`)));
  const results: DatasetEntry[] = [];

  const scan = (tag: ManifestDir, dirPath: string, pattern: RegExp, type: CatalogSourceType) => {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dirPath).filter((f) => pattern.test(f));
    } catch {
      return;
    }
    for (const f of names) {
      if (referenced.has(`${tag}:${f}`)) continue;
      let sizeBytes: number;
      try {
        sizeBytes = fs.statSync(path.join(dirPath, f)).size;
      } catch {
        continue;
      }
      results.push({
        id: `orphan:${tag}:${f}`, catalogSourceId: null, type, name: f,
        files: [f], dir: tag, sizeBytes, downloadedAt: null, status: 'active',
      });
    }
  };
  scan('harmonic', mgr.dirs.harmonic, /^HARMONIC(\.IDX)?$|^HARMONICS_NO_US(\.IDX)?$/i, 'harmonic');
  scan('grib', mgr.dirs.grib2, /\.(grb2|grib2|grb|grib)$/i, 'grib2');
  scan('utcef', mgr.dirs.utcef, /\.utcef(\.gz)?$/i, 'utcef');
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
      const dirPath = dirForTag(install.dir, mgr.dirs);
      const targets = install.files.map((f) => path.join(dirPath, f));
      if (targets.some((t) => !isWithinManagedDirs(t, mgr.dirs))) {
        res.status(400).json({ error: 'refused: install references a path outside the managed directories' });
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
      const [, tag, filename] = orphanMatch;
      // The filename comes from the URL param — reject any path-separator or
      // parent-traversal component before it ever reaches path.join.
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        res.status(400).json({ error: 'refused: invalid filename' });
        return;
      }
      const target = path.join(dirForTag(tag as ManifestDir, mgr.dirs), filename);
      if (!isWithinManagedDirs(target, mgr.dirs)) {
        res.status(400).json({ error: 'refused: path outside the managed directories' });
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

  router.get('/storage', async (_req, res) => {
    const dirs: StorageDirs = { dataDir: mgr.dirs.harmonic, gribDir: mgr.dirs.grib2, utcefDir: mgr.dirs.utcef, managerDir: mgr.managerDir };
    res.json(await statStorage(dirs));
  });

  router.post('/downloads', (req, res) => {
    const body = (req.body ?? {}) as { sourceId?: string; region_id?: string; filename?: string };
    if (!body.sourceId) {
      res.status(400).json({ error: 'sourceId is required' });
      return;
    }
    const selector: FileSelector = { region_id: body.region_id, filename: body.filename };
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

  router.get('/priority', (_req, res) => {
    res.json({ order: mgr.getPriority(), default: DEFAULT_PRIORITY });
  });

  router.put('/priority', (req, res) => {
    const body = (req.body ?? {}) as { order?: unknown };
    if (!isValidPriorityOrder(body.order)) {
      res.status(400).json({ error: 'order must be a permutation of ["grib2","utcef","harmonic"]' });
      return;
    }
    mgr.setPriority(body.order);
    res.json({ order: mgr.getPriority() });
  });
}
