// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * "Keep fresh when online" (PRD §5.5 Phase 2) — periodically re-downloads
 * any manifest install that has opted in via `autoUpdate: true` AND is
 * currently stale (per `computeInstallStatus`, the same check the /datasets
 * listing uses). Invoked on a recurring timer from `index.ts` (not just a
 * check-on-restart) since this plugin is expected to run for weeks
 * unattended on a boat.
 *
 * Safety: never starts a download that would push disk usage past 90% full
 * (same threshold the webapp's own Update-All banner warns on), and never
 * double-queues a source/region that already has a job in flight. A
 * template/forecast install has no catalog-declared size up front — its
 * PREVIOUS install's `size_bytes` is used as a same-source empirical
 * estimate (a real prior download of the exact same region, not a guess).
 */

import * as fs from 'fs';
import * as path from 'path';

import { CatalogClient } from './catalog.js';
import { computeInstallStatus } from './datasetStatus.js';
import { DownloadEngine } from './downloads.js';
import { ManifestInstall, readManifest } from './manifest.js';
import { statStorage } from './storage.js';

const DISK_FULL_THRESHOLD = 0.9;

export interface AutoUpdateDeps {
  catalog: CatalogClient;
  downloads: DownloadEngine;
  manifestPath: string;
  /** The plugin's single configured Data Directory. */
  dataDir: string;
}

export interface AutoUpdateResult {
  started: string[];
  /** Skipped because a job for the same source/region was already queued/active — not an error, just avoids piling up duplicate jobs across sweeps. */
  skippedInFlight: string[];
  /** Skipped because starting it would push disk usage past the 90% threshold. */
  skippedDiskFull: string[];
}

function filesExist(install: ManifestInstall, dataDir: string): boolean {
  return install.files.every((f) => fs.existsSync(path.join(dataDir, f)));
}

export async function runAutoUpdateSweep(deps: AutoUpdateDeps): Promise<AutoUpdateResult> {
  const manifest = readManifest(deps.manifestPath);
  const catalogDoc = deps.catalog.get().document;
  const result: AutoUpdateResult = { started: [], skippedInFlight: [], skippedDiskFull: [] };

  const candidates = manifest.installs.filter((install) => {
    if (!install.autoUpdate) return false;
    const source = catalogDoc?.sources.find((s) => s.id === install.catalogSourceId);
    const status = computeInstallStatus(install, source, filesExist(install, deps.dataDir));
    return status.status === 'update-available';
  });
  if (candidates.length === 0) return result;

  const storage = await statStorage(deps.dataDir);
  let projectedUsedBytes = storage.totalBytes !== null && storage.freeBytes !== null ? storage.totalBytes - storage.freeBytes : null;

  for (const install of candidates) {
    // Variant-aware: a nowcast job in flight for `bsh_currents` must not
    // block its sibling forecast+24h/+48h variants of the SAME source, which
    // are separate files with their own stale status.
    if (deps.downloads.hasInFlight(install.catalogSourceId, { region_id: install.regionId, type: install.fileType, variant: install.variant })) {
      result.skippedInFlight.push(install.id);
      continue;
    }
    if (storage.totalBytes !== null && projectedUsedBytes !== null) {
      const usedAfter = (projectedUsedBytes + install.size_bytes) / storage.totalBytes;
      if (usedAfter > DISK_FULL_THRESHOLD) {
        result.skippedDiskFull.push(install.id);
        continue;
      }
    }
    try {
      deps.downloads.start(install.catalogSourceId, { region_id: install.regionId, type: install.fileType, variant: install.variant });
      result.started.push(install.id);
      if (projectedUsedBytes !== null) projectedUsedBytes += install.size_bytes;
    } catch {
      // Source removed from the catalog since install, or some other
      // start()-time validation failure — skip it, don't abort the rest of
      // the sweep over one bad candidate.
    }
  }

  return result;
}
