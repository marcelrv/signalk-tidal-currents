// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Catalog-driven download engine (PRD §7 `POST/GET /downloads`).
 *
 * Single in-memory FIFO, one job at a time — appropriate for Pi/Cerbo-class
 * disks/networks and simplest to reason about for Phase 1. Resumability
 * decision (see docs/PRD-tidal-currents-manager.md discussion / plan): retry
 * from scratch, not byte-range resume — not a named Phase-1 deliverable, and
 * origin servers aren't contractually guaranteed to honor `Range`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CatalogClient } from './catalog.js';
import {
  CatalogFile,
  CatalogSource,
  CatalogSourceType,
  StaticCatalogFile,
  TemplateCatalogFile,
  isTemplateFile,
} from './catalogTypes.js';
import { ManifestDir, ManifestInstall, readManifest, upsertInstall, writeManifestAtomic } from './manifest.js';

export type DownloadJobState = 'queued' | 'active' | 'done' | 'error';

export interface DownloadJob {
  id: string;
  catalogSourceId: string;
  state: DownloadJobState;
  bytes: number;
  /** null until Content-Length is observed (template/forecast files often lack a known size up front). */
  totalBytes: number | null;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  resultInstallId?: string;
}

export interface FileSelector {
  region_id?: string;
  filename?: string;
}

export interface DownloadEngineDirs {
  harmonic: string;
  grib2: string;
  utcef: string;
}

export interface DownloadEngineOptions {
  dirs: DownloadEngineDirs;
  manifestPath: string;
  catalog: CatalogClient;
  /** Used to derive a fallback base URL when a static file entry omits `url` (observed real-world catalog gap). */
  catalogUrl: string;
}

export interface DownloadEngine {
  start(sourceId: string, fileSelector?: FileSelector): DownloadJob;
  get(id: string): DownloadJob | undefined;
  list(): DownloadJob[];
  cancel(id: string): void;
}

function dirAndTagForType(type: CatalogSourceType, dirs: DownloadEngineDirs): { dir: string; tag: ManifestDir } {
  if (type === 'grib2') return { dir: dirs.grib2, tag: 'grib' };
  if (type === 'utcef') return { dir: dirs.utcef, tag: 'utcef' };
  return { dir: dirs.harmonic, tag: 'harmonic' };
}

/** Resolves the base URL to prefix a bare filename with, when a file entry has no `url` of its own. */
function catalogBaseUrl(catalogUrl: string): string {
  const slash = catalogUrl.lastIndexOf('/');
  return slash >= 0 ? catalogUrl.slice(0, slash + 1) : catalogUrl;
}

function resolveStaticUrl(file: StaticCatalogFile, catalogUrl: string): string | null {
  if (file.url) return file.url;
  if (!file.filename) return null;
  return `${catalogBaseUrl(catalogUrl)}${file.filename}`;
}

function pad3(n: number): string {
  return String(n).padStart(3, '0');
}

/** Chooses the forecast cycle (YYYYMMDD + HH) to download: `update_check.latest_cycle` when known, else the latest `cycle_hours` entry not after the current UTC hour. */
function chooseCycle(file: TemplateCatalogFile, latestCycle: string | undefined): { ymd: string; hh: string; iso: string } {
  if (latestCycle) {
    const d = new Date(latestCycle);
    return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ''), hh: d.toISOString().slice(11, 13), iso: latestCycle };
  }
  const now = new Date();
  const hours = [...file.cycle_hours].map((h) => parseInt(h, 10)).filter((h) => Number.isFinite(h)).sort((a, b) => a - b);
  const nowHH = now.getUTCHours();
  let chosen = [...hours].reverse().find((h) => h <= nowHH);
  let day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (chosen === undefined) {
    // Every cycle today is still in the future — use yesterday's latest cycle.
    chosen = hours[hours.length - 1];
    day = new Date(day.getTime() - 24 * 3600_000);
  }
  const hh = String(chosen ?? 0).padStart(2, '0');
  const ymd = day.toISOString().slice(0, 10).replace(/-/g, '');
  return { ymd, hh, iso: new Date(`${day.toISOString().slice(0, 10)}T${hh}:00:00Z`).toISOString() };
}

function fillTemplate(template: string, ymd: string, hh: string, forecastHour: number): string {
  return template
    .replace(/\{YYYYMMDD\}/g, ymd)
    .replace(/\{HH\}/g, hh)
    .replace(/\{hour:03d\}/g, pad3(forecastHour));
}

function pickFile(source: CatalogSource, selector?: FileSelector): CatalogFile {
  if (selector?.filename) {
    const f = source.files.find((f) => !isTemplateFile(f) && f.filename === selector.filename);
    if (!f) throw new Error(`no file named "${selector.filename}" in source "${source.id}"`);
    return f;
  }
  if (selector?.region_id) {
    const f = source.files.find((f) => isTemplateFile(f) && f.region_id === selector.region_id);
    if (!f) throw new Error(`no template file for region "${selector.region_id}" in source "${source.id}"`);
    return f;
  }
  if (source.files.length === 1) return source.files[0];
  throw new Error(`source "${source.id}" has ${source.files.length} files — a filename or region_id selector is required`);
}

async function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
}

/** Streams one URL into `<target>.part`, hashing incrementally; renames into place on success. */
async function downloadOne(
  url: string,
  target: string,
  onProgress: (deltaBytes: number, totalBytes: number | null) => void,
  signal: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  const resp = await fetch(url, { signal });
  if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const totalBytes = (() => {
    const len = resp.headers.get('content-length');
    const n = len ? parseInt(len, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  })();

  const partPath = `${target}.part`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const out = fs.createWriteStream(partPath);
  const hash = crypto.createHash('sha256');
  let size = 0;

  const reader = resp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        size += value.length;
        onProgress(value.length, totalBytes);
        await writeChunk(out, value);
      }
    }
    await new Promise<void>((resolve) => out.end(resolve));
  } catch (e) {
    await new Promise<void>((resolve) => out.end(resolve));
    try { fs.unlinkSync(partPath); } catch { /* best effort — nothing to clean up if it never got created */ }
    throw e;
  }

  fs.renameSync(partPath, target);
  return { sha256: hash.digest('hex'), size };
}

export function createDownloadEngine(opts: DownloadEngineOptions): DownloadEngine {
  const jobs = new Map<string, DownloadJob>();
  const abortControllers = new Map<string, AbortController>();
  const queue: string[] = [];
  let processing = false;

  function targetDirFor(type: CatalogSourceType): { dir: string; tag: ManifestDir } {
    return dirAndTagForType(type, opts.dirs);
  }

  async function runJob(job: DownloadJob): Promise<void> {
    const document = opts.catalog.get().document;
    const source = document?.sources.find((s) => s.id === job.catalogSourceId);
    if (!source) throw new Error(`catalog source "${job.catalogSourceId}" no longer in the cached catalog`);

    const { dir, tag } = targetDirFor(source.type);
    const controller = abortControllers.get(job.id)!;

    const staticFiles = source.files.filter((f): f is StaticCatalogFile => !isTemplateFile(f));
    if (staticFiles.length === source.files.length) {
      // Static-file source: download every matching file (normally exactly
      // one, but a source could list several — e.g. a HARMONIC + .IDX pair).
      // A single sha256 is only meaningful when there's exactly one file.
      let sha256: string | undefined;
      const names: string[] = [];
      let sizeBytes = 0;
      for (const file of staticFiles) {
        const url = resolveStaticUrl(file, opts.catalogUrl);
        if (!url) throw new Error(`file "${file.filename}" has no url and none could be derived`);
        const target = path.join(dir, file.filename);
        const result = await downloadOne(url, target, (delta, total) => {
          job.bytes += delta;
          if (total !== null) job.totalBytes = (job.totalBytes ?? 0) + total;
        }, controller.signal);
        if (file.sha256 && file.sha256 !== result.sha256) {
          try { fs.unlinkSync(target); } catch { /* best effort */ }
          throw new Error(`sha256 mismatch for ${file.filename}: expected ${file.sha256}, got ${result.sha256}`);
        }
        // No integrity hash provided by the catalog for this file — skip
        // verification rather than failing (covers the observed real-world
        // catalog gap where some static utcef entries omit both url/sha256).
        names.push(file.filename);
        sizeBytes += result.size;
        // Record the hash only when there's exactly one file AND the catalog
        // actually declared one to verify against — a locally-computed hash
        // the catalog never asserted isn't a fact worth persisting.
        if (staticFiles.length === 1 && file.sha256) sha256 = result.sha256;
      }
      const install: ManifestInstall = {
        id: source.id,
        catalogSourceId: source.id,
        type: source.type,
        files: names,
        dir: tag,
        sha256,
        size_bytes: sizeBytes,
        downloaded_at: new Date().toISOString(),
      };
      const manifest = readManifest(opts.manifestPath);
      writeManifestAtomic(opts.manifestPath, upsertInstall(manifest, install));
      job.resultInstallId = install.id;
      return;
    }

    // Template (forecast/nowcast) source: download every forecast_hours entry
    // for one chosen cycle as a single manifest install — multi-hour coverage
    // is what gribcurrents.ts's time interpolation actually needs.
    const templateFile = source.files.find((f) => isTemplateFile(f)) as TemplateCatalogFile;
    const { ymd, hh, iso } = chooseCycle(templateFile, source.update_check.latest_cycle);
    const names: string[] = [];
    let sizeBytes = 0;
    for (const hour of templateFile.forecast_hours) {
      const url = fillTemplate(templateFile.url_template, ymd, hh, hour);
      const filename = `${source.id}_${ymd}${hh}_f${pad3(hour)}${path.extname(new URL(url).pathname) || '.grb2'}`;
      const target = path.join(dir, filename);
      const result = await downloadOne(url, target, (delta, total) => {
        job.bytes += delta;
        if (total !== null) job.totalBytes = (job.totalBytes ?? 0) + total;
      }, controller.signal);
      names.push(filename);
      sizeBytes += result.size;
    }
    const install: ManifestInstall = {
      id: `${source.id}:${templateFile.region_id}`,
      catalogSourceId: source.id,
      type: source.type,
      files: names,
      dir: tag,
      size_bytes: sizeBytes,
      downloaded_at: new Date().toISOString(),
      cycle: iso,
    };
    const manifest = readManifest(opts.manifestPath);
    writeManifestAtomic(opts.manifestPath, upsertInstall(manifest, install));
    job.resultInstallId = install.id;
  }

  function processQueue(): void {
    if (processing) return;
    processing = true;
    (async () => {
      while (queue.length > 0) {
        const id = queue.shift()!;
        const job = jobs.get(id);
        if (!job) continue;
        job.state = 'active';
        job.startedAt = new Date().toISOString();
        try {
          await runJob(job);
          job.state = 'done';
        } catch (e) {
          job.state = 'error';
          job.error = e instanceof Error ? e.message : String(e);
        } finally {
          job.finishedAt = new Date().toISOString();
          abortControllers.delete(id);
        }
      }
      processing = false;
    })().catch(() => {
      // Defensive only — runJob/finally above already catch per-job errors;
      // this guards against a truly unexpected throw from the loop itself.
      processing = false;
    });
  }

  return {
    start(sourceId: string, fileSelector?: FileSelector): DownloadJob {
      const document = opts.catalog.get().document;
      const source = document?.sources.find((s) => s.id === sourceId);
      if (!source) throw new Error(`unknown catalog source: ${sourceId}`);
      pickFile(source, fileSelector); // validates the selector eagerly, before queueing

      const id = crypto.randomUUID();
      const job: DownloadJob = { id, catalogSourceId: sourceId, state: 'queued', bytes: 0, totalBytes: null };
      jobs.set(id, job);
      abortControllers.set(id, new AbortController());
      queue.push(id);
      processQueue();
      return job;
    },
    get(id: string): DownloadJob | undefined {
      return jobs.get(id);
    },
    list(): DownloadJob[] {
      return [...jobs.values()];
    },
    cancel(id: string): void {
      abortControllers.get(id)?.abort();
      const idx = queue.indexOf(id);
      if (idx >= 0) queue.splice(idx, 1);
      const job = jobs.get(id);
      if (job && (job.state === 'queued' || job.state === 'active')) {
        job.state = 'error';
        job.error = 'cancelled';
        job.finishedAt = new Date().toISOString();
      }
    },
  };
}
