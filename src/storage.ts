// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Disk-usage stats for the Storage & Health Dashboard (PRD §5.4, Phase 1
 * scope: gauge only). `cleanupCandidates` is a Phase 2 feature (Smart
 * Cleanup) — its signature is reserved here for forward reference but it is
 * NOT implemented or route-wired in Phase 1.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StorageStats {
  /** Path fs.promises.statfs was run against (the manager's own data root). */
  path: string;
  /** null when fs.promises.statfs is unavailable (Node <18.15) — degrade, don't throw. */
  totalBytes: number | null;
  freeBytes: number | null;
  usedByPluginBytes: number;
}

/**
 * Recursively sums file sizes under `dir`, skipping any subdirectory whose
 * resolved path is in `exclude` (including `dir` itself) — used so walking
 * `managerDir` doesn't double-count `dataDir`/`gribDir`/`utcefDir` when they
 * are (as by default) subdirectories of it; those three are summed
 * separately by the caller so they're still counted when configured OUTSIDE
 * managerDir (e.g. an external OpenCPN folder).
 */
function dirSizeBytes(dir: string, exclude: ReadonlySet<string> = new Set()): number {
  if (exclude.has(path.resolve(dir))) return 0;
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full, exclude);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        // file removed mid-walk — ignore
      }
    }
  }
  return total;
}

export interface StorageDirs {
  dataDir: string;
  gribDir: string;
  utcefDir: string;
  managerDir: string;
}

export async function statStorage(dirs: StorageDirs): Promise<StorageStats> {
  // managerDir defaults to the PARENT of dataDir/gribDir/utcefDir, so walking
  // it naively would double-count them; exclude those three from the
  // managerDir walk and sum each of them separately instead (which also
  // correctly counts them when a user points one outside managerDir, e.g.
  // an external OpenCPN folder for dataDir).
  const contentDirs = [dirs.dataDir, dirs.gribDir, dirs.utcefDir];
  const exclude = new Set(contentDirs.map((d) => path.resolve(d)));
  const usedByPluginBytes =
    dirSizeBytes(dirs.managerDir, exclude) + contentDirs.reduce((sum, d) => sum + dirSizeBytes(d), 0);

  let totalBytes: number | null = null;
  let freeBytes: number | null = null;
  try {
    // fs.promises.statfs — Node >=18.15. Wrapped defensively: older point
    // releases (some Pi/Cerbo GX installs) may not have it.
    const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bfree: number }> }).statfs;
    if (statfs) {
      const s = await statfs(dirs.managerDir);
      totalBytes = s.bsize * s.blocks;
      freeBytes = s.bsize * s.bfree;
    }
  } catch {
    // degrade to usedByPluginBytes-only
  }

  return { path: dirs.managerDir, totalBytes, freeBytes, usedByPluginBytes };
}

// Phase 2 — reserved for Smart Cleanup (PRD §5.4), NOT implemented/mounted:
// export interface CleanupCandidate { id: string; distanceNm: number; sizeBytes: number; }
// export async function cleanupCandidates(
//   manifest: InstallManifest, catalog: CatalogDocument,
//   vesselPos: { lat: number; lon: number }, maxDistanceNm: number,
// ): Promise<CleanupCandidate[]> { throw new Error('Phase 2 — not implemented'); }
