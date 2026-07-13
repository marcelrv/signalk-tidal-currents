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
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { Client as FtpClient } from 'basic-ftp';

import { CatalogClient } from './catalog.js';
import {
  CatalogFile,
  CatalogSource,
  CatalogSourceType,
  StaticCatalogFile,
  TemplateCatalogFile,
  isTemplateFile,
} from './catalogTypes.js';
import { ManifestInstall, readManifest, upsertInstall, writeManifestAtomic } from './manifest.js';

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
  /** Disambiguates when a region has BOTH a forecast and a nowcast template file (observed in the real NOAA catalog — same region_id, two products). */
  type?: 'forecast' | 'nowcast';
  /** Disambiguates when region_id + type alone still resolve to more than one file (e.g. BSH's separate +24h/+48h/+72h forecast-day files, all type "forecast" under the same region_id). */
  variant?: string;
  filename?: string;
}

export interface DownloadEngineOptions {
  /** The plugin's single configured Data Directory — every download lands somewhere under this one root. */
  dataDir: string;
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
  /** Subscribes to every update (state transition or throttled progress tick) for one job; returns an unsubscribe function. Backs the SSE route (PRD §9 Phase 2). */
  onUpdate(id: string, listener: (job: DownloadJob) => void): () => void;
  /**
   * Fires once for ANY job (regardless of id, and regardless of whether a
   * caller happened to already be watching it via `onUpdate`) the moment it
   * reaches a terminal state (`done`/`error`). Lets `index.ts` react to
   * "a download just finished" without needing to know job ids ahead of
   * time — used to force an immediate GRIB/UTCEF directory recheck instead
   * of waiting for their own lazy poll interval.
   */
  onAnyDone(listener: (job: DownloadJob) => void): () => void;
  /**
   * True iff a queued/active job exists for this exact `sourceId` AND an
   * equivalent `FileSelector` (region_id/type/variant compared field-by-field;
   * a field omitted on EITHER side is treated as a wildcard for that field,
   * matching how a bare `sourceId` job — no selector — is "in flight" for any
   * selector of that source). Used by the auto-update sweep so one BSH
   * variant's in-flight job doesn't cause its sibling variants (same
   * `sourceId`, different `region_id`/`variant`) to be skipped too.
   */
  hasInFlight(sourceId: string, selector?: FileSelector): boolean;
}

/** Progress-only updates are throttled to at most once per this many ms per job — state transitions always emit immediately regardless. */
const PROGRESS_EMIT_THROTTLE_MS = 200;

/**
 * Subfolder the download engine files a source's TYPE under, within the
 * single configured Data Directory — its own tidiness convention (so a boat
 * with several GRIB2 regions and a pile of UTCEF datasets can still browse
 * them apart), not a structure anything else requires: the readers
 * (createGribSource/createUtcefSource/loadHarmonicsDir) all scan the whole
 * Data Directory recursively, so a manually-dropped file works from any
 * subpath, including outside these three folders entirely.
 */
function subdirForType(type: CatalogSourceType): string {
  if (type === 'grib2') return 'grib';
  if (type === 'utcef') return 'utcef';
  return 'harmonic';
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

function cycleSlot(day: Date, hour: number): { ymd: string; hh: string; iso: string } {
  const hh = String(hour).padStart(2, '0');
  const ymd = day.toISOString().slice(0, 10).replace(/-/g, '');
  return { ymd, hh, iso: new Date(`${day.toISOString().slice(0, 10)}T${hh}:00:00Z`).toISOString() };
}

/**
 * Best-first cycle candidates for `file`: `[0]` is the normal choice
 * (`update_check.latest_cycle` when known, else the latest `cycle_hours`
 * entry not after the current UTC hour); `[1..]` step progressively OLDER
 * through the SAME file's `cycle_hours` list (wrapping to the previous day
 * past the earliest hour). The fallback candidates exist because a file's
 * declared `cycle_hours` isn't always what the upstream server actually
 * publishes for THAT specific file — observed on BSH: the catalog lists
 * `cycle_hours: ['00','12']` for both the nowcast and forecast-day files of
 * a region, but the real server only publishes the nowcast/analysis file at
 * 00Z, never 12Z, even though the 12Z forecast files DO exist. Callers only
 * consult candidates beyond `[0]` when the chosen one 404s/550s
 * (`isFileNotFoundError`) — never for other failures, where an older cycle
 * wouldn't fix the actual problem.
 */
function chooseCycleCandidates(
  file: TemplateCatalogFile,
  latestCycle: string | undefined,
  maxAgeHours: number | undefined,
  count: number,
): Array<{ ymd: string; hh: string; iso: string }> {
  const hours = [...file.cycle_hours].map((h) => parseInt(h, 10)).filter((h) => Number.isFinite(h)).sort((a, b) => a - b);
  const now = new Date();
  if (hours.length === 0) return [cycleSlot(now, now.getUTCHours())];

  // The catalog's latest_cycle is the most recent cycle the source knows about
  // across all its files. If the latest cycle hour is valid for this file,
  // use it. Otherwise fall back to the current time (e.g. BSH publishes analysis
  // at 00Z but forecast-day files only at 12Z; at 00Z the latest_cycle is 00Z
  // but we want today's 12Z file if it has already been published).
  //
  // When maxAgeHours is known and latest_cycle + maxAgeHours is already past,
  // the catalog snapshot is stale — the current file is expired and a newer
  // cycle should be available. Fall back to now as the upper bound so the
  // next cycle can be discovered.
  let upperBound: Date;
  if (latestCycle) {
    const d = new Date(latestCycle);
    if (hours.includes(d.getUTCHours())) {
      upperBound = (maxAgeHours !== undefined && Date.now() - d.getTime() > maxAgeHours * 3600_000) ? now : d;
    } else {
      upperBound = now;
    }
  } else {
    upperBound = now;
  }
  const boundHH = upperBound.getUTCHours();
  const descending = [...hours].reverse();
  let idx = descending.findIndex((h) => h <= boundHH);
  let day = new Date(Date.UTC(upperBound.getUTCFullYear(), upperBound.getUTCMonth(), upperBound.getUTCDate()));
  if (idx === -1) {
    // Every cycle today is still in the future — use yesterday's latest cycle.
    idx = 0;
    day = new Date(day.getTime() - 24 * 3600_000);
  }

  const candidates: Array<{ ymd: string; hh: string; iso: string }> = [];
  for (let i = 0; i < count; i++) {
    candidates.push(cycleSlot(day, descending[idx]));
    idx++;
    if (idx >= descending.length) {
      idx = 0;
      day = new Date(day.getTime() - 24 * 3600_000);
    }
  }
  return candidates;
}

/** True iff `e` is a "the file genuinely doesn't exist" failure (FTP 550, HTTP 404) — the class of error where trying an OLDER published cycle is a reasonable, safe recovery. Any other failure (network, auth, disk) is left to propagate as-is; an older cycle wouldn't fix those, and silently substituting one would mask the real problem. */
function isFileNotFoundError(e: unknown): boolean {
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 550) return true;
  if (e instanceof Error && /^HTTP 404\b/.test(e.message)) return true;
  return false;
}

function fillTemplate(template: string, ymd: string, hh: string, forecastHour: number): string {
  return template
    .replace(/\{YYYYMMDD\}/g, ymd)
    .replace(/\{HH\}/g, hh)
    .replace(/\{hour:03d\}/g, pad3(forecastHour));
}

/**
 * Validates a selector eagerly (before queueing) against what `runJob` will
 * actually do. A multi-file STATIC source (e.g. a HARMONIC + .IDX pair) is
 * downloaded as one atomic bundle regardless of selector — so no selector is
 * ever required there. TEMPLATE files are ambiguous without a `region_id`
 * whenever a source has more than one; some real catalog regions (observed
 * in NOAA's) additionally carry BOTH a `forecast` and a `nowcast` file under
 * the SAME `region_id` — those need `type` too, or `region_id` alone still
 * resolves to more than one file. A few sources (BSH) go one step further:
 * multiple files share BOTH `region_id` AND `type` (e.g. three separate
 * +24h/+48h/+72h forecast-day files, all "forecast") because their upstream
 * cycle availability can't be bundled into one templated file — those need
 * `variant` too.
 */
function pickFile(source: CatalogSource, selector?: FileSelector): CatalogFile {
  const templateFiles = source.files.filter(isTemplateFile);
  if (selector?.filename) {
    const f = source.files.find((f) => !isTemplateFile(f) && f.filename === selector.filename);
    if (!f) throw new Error(`no file named "${selector.filename}" in source "${source.id}"`);
    return f;
  }
  if (selector?.region_id) {
    let matches = templateFiles.filter((f) => f.region_id === selector.region_id);
    if (selector.type) matches = matches.filter((f) => f.type === selector.type);
    if (selector.variant !== undefined) matches = matches.filter((f) => f.variant === selector.variant);
    if (matches.length === 0) {
      throw new Error(
        `no template file for region "${selector.region_id}"${selector.type ? ` (${selector.type})` : ''}` +
          `${selector.variant ? ` variant "${selector.variant}"` : ''} in source "${source.id}"`,
      );
    }
    if (matches.length > 1) {
      // Report whichever field is actually still ambiguous: if every match
      // shares the same type, the leftover ambiguity is by variant (the BSH
      // case), not type (the NOAA forecast/nowcast case) — naming the wrong
      // field would repeat "(forecast, forecast, forecast)" instead of
      // telling the caller what selector would actually resolve it.
      const byVariant = matches.every((f) => f.type === matches[0].type);
      const field = byVariant ? 'variant' : 'type';
      const values = byVariant ? matches.map((f) => f.variant ?? '(none)') : matches.map((f) => f.type);
      throw new Error(
        `region "${selector.region_id}" in source "${source.id}" has multiple ${field}s (${values.join(', ')}) — a ${field} selector is required`,
      );
    }
    return matches[0];
  }
  if (templateFiles.length > 1) {
    throw new Error(`source "${source.id}" has ${templateFiles.length} template regions — a region_id selector is required`);
  }
  if (source.files.length === 0) throw new Error(`source "${source.id}" has no files`);
  return templateFiles[0] ?? source.files[0];
}

/** True iff two selectors could refer to the same file — a field left unset on either side is a wildcard for that field, so a bare `undefined` selector (no region_id at all) overlaps every selector of the same source. Exported so tests can exercise `hasInFlight`-equivalent matching without duplicating the semantics. */
export function selectorsOverlap(a: FileSelector | undefined, b: FileSelector | undefined): boolean {
  if (a?.region_id !== undefined && b?.region_id !== undefined && a.region_id !== b.region_id) return false;
  if (a?.type !== undefined && b?.type !== undefined && a.type !== b.type) return false;
  if (a?.variant !== undefined && b?.variant !== undefined && a.variant !== b.variant) return false;
  return true;
}

async function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
}

/** Streams one FTP URL into `<target>.part`, then hashes and renames it into place on success. */
async function downloadOneFtp(
  url: string,
  target: string,
  onProgress: (deltaBytes: number, totalBytes: number | null) => void,
  signal: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  const parsed = new URL(url);
  const client = new FtpClient();
  client.ftp.verbose = false;

  const partPath = `${target}.part`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const out = fs.createWriteStream(partPath);

  let lastOverall = 0;
  client.trackProgress((info) => {
    const delta = info.bytesOverall - lastOverall;
    if (delta > 0) {
      onProgress(delta, null);
      lastOverall = info.bytesOverall;
    }
  });

  const cleanup = () => {
    try { client.close(); } catch { /* ignore */ }
    try { out.destroy(); } catch { /* ignore */ }
  };
  signal.addEventListener('abort', cleanup, { once: true });

  try {
    await client.access({
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 21,
      user: parsed.username || 'anonymous',
      password: parsed.password || 'anonymous@',
      secure: false,
    });
    await client.downloadTo(out, parsed.pathname);
    await new Promise<void>((resolve) => out.end(resolve));
  } catch (e) {
    cleanup();
    try { fs.unlinkSync(partPath); } catch { /* best effort */ }
    throw e;
  } finally {
    signal.removeEventListener('abort', cleanup);
    cleanup();
  }

  fs.renameSync(partPath, target);
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) {
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), size: fs.statSync(target).size };
}

/** Streams one URL into `<target>.part`, hashing incrementally; renames into place on success. */
async function downloadOne(
  url: string,
  target: string,
  onProgress: (deltaBytes: number, totalBytes: number | null) => void,
  signal: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  if (url.startsWith('ftp://')) {
    return downloadOneFtp(url, target, onProgress, signal);
  }
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
  const selectors = new Map<string, FileSelector | undefined>();
  const queue: string[] = [];
  let processing = false;

  // Small number of concurrent SSE viewers expected at once (one browser tab
  // per boat, typically) — unbounded listener count is not a leak signal here.
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const lastEmitAt = new Map<string, number>();

  /** Emits a snapshot of `job` to its subscribers. State transitions (the default) always emit immediately; pass `progressOnly: true` from a byte-progress callback to throttle. */
  function notify(job: DownloadJob, progressOnly = false): void {
    if (progressOnly) {
      const last = lastEmitAt.get(job.id) ?? 0;
      if (Date.now() - last < PROGRESS_EMIT_THROTTLE_MS) return;
    }
    lastEmitAt.set(job.id, Date.now());
    if (job.state === 'done' || job.state === 'error') {
      lastEmitAt.delete(job.id);
      emitter.emit('any-done', { ...job });
    }
    emitter.emit(`job:${job.id}`, { ...job });
  }

  async function runJob(job: DownloadJob): Promise<void> {
    const document = opts.catalog.get().document;
    const source = document?.sources.find((s) => s.id === job.catalogSourceId);
    if (!source) throw new Error(`catalog source "${job.catalogSourceId}" no longer in the cached catalog`);

    const subdir = subdirForType(source.type);
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
        // file.filename may itself carry a catalog-supplied region path
        // (e.g. "regions/europe/netherlands.utcef") — always forward-slash
        // joined here regardless of platform, same reasoning as regionDir
        // below.
        const relName = `${subdir}/${file.filename}`;
        const target = path.join(opts.dataDir, relName);
        // `total` is the SAME constant Content-Length on every chunk callback
        // (see downloadOne) — only fold it into job.totalBytes once per file,
        // or it inflates by (chunk count × file size) and the progress
        // percentage stays near 0 until the download is already done.
        let totalCounted = false;
        const result = await downloadOne(url, target, (delta, total) => {
          job.bytes += delta;
          if (total !== null && !totalCounted) {
            job.totalBytes = (job.totalBytes ?? 0) + total;
            totalCounted = true;
          }
          notify(job, true);
        }, controller.signal);
        if (file.sha256 && file.sha256 !== result.sha256) {
          try { fs.unlinkSync(target); } catch { /* best effort */ }
          throw new Error(`sha256 mismatch for ${file.filename}: expected ${file.sha256}, got ${result.sha256}`);
        }
        // No integrity hash provided by the catalog for this file — skip
        // verification rather than failing (covers the observed real-world
        // catalog gap where some static utcef entries omit both url/sha256).
        names.push(relName);
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
    // is what gribcurrents.ts's time interpolation actually needs. When the
    // source has multiple region-scoped template files, the selector's
    // region_id says which one — NOT just "the first one found" (a source
    // like a multi-region NOAA forecast lists one template file per region).
    const templateFiles = source.files.filter(isTemplateFile);
    const selector = selectors.get(job.id);
    const templateFile = selector?.region_id
      ? templateFiles.find((f) =>
          f.region_id === selector.region_id &&
          (!selector.type || f.type === selector.type) &&
          (selector.variant === undefined || f.variant === selector.variant),
        )
      : templateFiles[0];
    if (!templateFile) {
      throw new Error(`no template file for region "${selector?.region_id}"${selector?.type ? ` (${selector.type})` : ''} in source "${source.id}"`);
    }
    const cycleCandidates = chooseCycleCandidates(templateFile, source.update_check.latest_cycle, source.update_check.max_age_hours, 3);
    // The region (and forecast/nowcast type) MUST be part of the filename:
    // multi-region template sources (e.g. NOAA RTOFS) share one url_template
    // pattern, and a source-id-only name made every region's download land
    // on the SAME file — each region silently overwriting the previous one
    // while the manifest kept claiming all of them were installed. `variant`
    // is included explicitly too (not left to the `f{hour}` suffix below to
    // disambiguate implicitly) — today every BSH variant happens to have a
    // distinct forecast_hours value, but nothing guarantees that stays true,
    // and two same-hour variants would otherwise silently collide on disk.
    const regionTag = `${templateFile.region_id}_${templateFile.type}${templateFile.variant ? `_${templateFile.variant}` : ''}`.replace(/[^A-Za-z0-9._-]+/g, '-');
    // Files land under a per-region subfolder (region_id, sanitized) rather
    // than flat in the type directory — with several regions installed
    // (a boat cruising both US coasts, say), a flat GRIB directory becomes a
    // pile of same-looking filenames with no way to browse "what do I have
    // for the Pacific". Forecast and nowcast share the folder (only the
    // filename, via regionTag above, tells them apart) so both show up
    // together for that region. Always joined with a literal '/' — this
    // becomes both the on-disk path (via path.join below, OS-normalized) and
    // the manifest's `files` entry, which must match listDataFilesRecursive's
    // forward-slash-joined keys (used to restrict per-dataset lookups to
    // this install's own files) on every platform, not just POSIX.
    const regionDir = templateFile.region_id.replace(/[^A-Za-z0-9._-]+/g, '-');

    let chosen: { ymd: string; hh: string; iso: string } | null = null;
    let names: string[] = [];
    let sizeBytes = 0;
    let lastNotFoundError: unknown = null;
    for (const candidate of cycleCandidates) {
      names = [];
      sizeBytes = 0;
      job.bytes = 0;
      job.totalBytes = null;
      try {
        for (const hour of templateFile.forecast_hours) {
          const url = fillTemplate(templateFile.url_template, candidate.ymd, candidate.hh, hour);
          const filename = `${source.id}_${regionTag}_${candidate.ymd}${candidate.hh}_f${pad3(hour)}${path.extname(new URL(url).pathname) || '.grb2'}`;
          const relName = `${subdir}/${regionDir}/${filename}`;
          const target = path.join(opts.dataDir, relName);
          // Same fix as the static-file branch above: `total` repeats on every
          // chunk, only count it once per forecast-hour file.
          let totalCounted = false;
          const result = await downloadOne(url, target, (delta, total) => {
            job.bytes += delta;
            if (total !== null && !totalCounted) {
              job.totalBytes = (job.totalBytes ?? 0) + total;
              totalCounted = true;
            }
            notify(job, true);
          }, controller.signal);
          names.push(relName);
          sizeBytes += result.size;
        }
        chosen = candidate;
        break;
      } catch (e) {
        for (const relName of names) {
          try { fs.unlinkSync(path.join(opts.dataDir, relName)); } catch { /* best effort */ }
        }
        if (!isFileNotFoundError(e)) throw e;
        lastNotFoundError = e;
        // else: this cycle genuinely isn't published for this file yet — try the next-older candidate.
      }
    }
    if (!chosen) {
      throw lastNotFoundError instanceof Error ? lastNotFoundError : new Error(`no cycle candidate available for "${templateFile.region_id}" (${templateFile.type}) in source "${source.id}"`);
    }

    const install: ManifestInstall = {
      // Some real catalog regions carry BOTH a forecast and a nowcast file
      // under the SAME region_id (observed in the NOAA catalog) — the id
      // must include the file's own `type` too, or downloading one would
      // silently clobber the other's manifest entry. A few sources go one
      // step further: multiple files share BOTH region_id AND type (e.g.
      // BSH's +24h/+48h/+72h forecast-day files, all "forecast") and need
      // `variant` in the id as well, or downloading day+1 then day+2 would
      // silently overwrite each other's manifest entry.
      id: `${source.id}:${templateFile.region_id}:${templateFile.type}${templateFile.variant ? `:${templateFile.variant}` : ''}`,
      catalogSourceId: source.id,
      type: source.type,
      files: names,
      size_bytes: sizeBytes,
      downloaded_at: new Date().toISOString(),
      cycle: chosen.iso,
      regionId: templateFile.region_id,
      fileType: templateFile.type,
      variant: templateFile.variant,
    };
    const manifest = readManifest(opts.manifestPath);
    // Capture the install this one is about to replace (same id — same
    // source/region/type/variant, just a different cycle) BEFORE upserting,
    // so its now-superseded files can be removed once the new cycle is
    // safely in place. Without this, every successful update left the prior
    // cycle's file behind forever (the on-disk name always encodes the
    // cycle, so a new download never overwrites the old one) — accumulating
    // as an orphan (`orphan:grib:...`) the user had to notice and delete by
    // hand.
    const previousInstall = manifest.installs.find((i) => i.id === install.id);
    writeManifestAtomic(opts.manifestPath, upsertInstall(manifest, install));
    job.resultInstallId = install.id;

    if (previousInstall) {
      for (const relName of previousInstall.files) {
        if (names.includes(relName)) continue; // same cycle re-requested — this path is the file we just (re)wrote, not a stale one
        try { fs.unlinkSync(path.join(opts.dataDir, relName)); } catch { /* best effort — already gone, or a permissions issue; not fatal */ }
      }
    }
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
        notify(job);
        try {
          await runJob(job);
          job.state = 'done';
        } catch (e) {
          job.state = 'error';
          job.error = e instanceof Error ? e.message : String(e);
        } finally {
          job.finishedAt = new Date().toISOString();
          abortControllers.delete(id);
          selectors.delete(id);
          notify(job);
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
      selectors.set(id, fileSelector);
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
    onUpdate(id: string, listener: (job: DownloadJob) => void): () => void {
      const channel = `job:${id}`;
      emitter.on(channel, listener);
      return () => emitter.off(channel, listener);
    },
    onAnyDone(listener: (job: DownloadJob) => void): () => void {
      emitter.on('any-done', listener);
      return () => emitter.off('any-done', listener);
    },
    hasInFlight(sourceId: string, selector?: FileSelector): boolean {
      return [...jobs.values()].some(
        (j) =>
          j.catalogSourceId === sourceId &&
          (j.state === 'queued' || j.state === 'active') &&
          selectorsOverlap(selectors.get(j.id), selector),
      );
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
        notify(job);
      }
    },
  };
}
