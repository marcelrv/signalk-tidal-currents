// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Disk-usage stats for the Storage & Health Dashboard (PRD §5.4), plus Smart
 * Cleanup (`cleanupCandidates`, PRD §9 Phase 2 — distance from the vessel to
 * each installed dataset's region, server-side as the PRD specifies).
 */

import * as fs from 'fs';
import * as path from 'path';

import { CatalogDocument, CatalogSourceType } from './catalogTypes.js';
import { InstallManifest } from './manifest.js';
import { distanceKm } from './predict.js';

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

export interface CleanupCandidate {
  id: string;
  catalogSourceId: string | null;
  name: string;
  type: CatalogSourceType;
  sizeBytes: number;
  /** null only when the install's catalogSourceId no longer resolves in the current catalog — surfaced regardless of maxDistanceNm since relevance can't be judged, sorted last. */
  distanceNm: number | null;
  downloadedAt: string | null;
}

/**
 * Clamps `lon` into `[minLon, maxLon]` for the nearest-point-on-bbox
 * distance below. Several real catalog regions cross the antimeridian
 * (e.g. Bering Sea: min_lon 155, max_lon -165 — the catalog's own
 * convention for "wraps through ±180"), where the valid range is actually
 * `[minLon, 180] ∪ [-180, maxLon]`, not a plain numeric interval.
 */
function clampLonToBbox(lon: number, minLon: number, maxLon: number): number {
  if (minLon <= maxLon) return Math.min(Math.max(lon, minLon), maxLon);
  if (lon >= minLon || lon <= maxLon) return lon; // already inside the wrapped range
  const distToMin = Math.min(Math.abs(lon - minLon), 360 - Math.abs(lon - minLon));
  const distToMax = Math.min(Math.abs(lon - maxLon), 360 - Math.abs(lon - maxLon));
  return distToMin <= distToMax ? minLon : maxLon;
}

/**
 * Installed datasets farther than `maxDistanceNm` from the vessel — safe
 * candidates to delete to free space (PRD §5.4 Smart Cleanup). Distance is
 * to the NEAREST POINT ON the source's bounding box (clamping the vessel
 * position into it), not the centroid: this is what the PRD's own wording
 * specifies ("distance from vessel position to dataset bboxes"), and it
 * correctly returns 0 when the vessel is currently inside a region — never
 * suggesting deletion of data being actively sailed through. Pure — returns
 * `[]` immediately when no vessel position is available.
 */
export function cleanupCandidates(
  manifest: InstallManifest,
  catalogDoc: CatalogDocument | null,
  vesselPos: { lat: number; lon: number } | null,
  maxDistanceNm: number,
): CleanupCandidate[] {
  if (!vesselPos) return [];

  const NM_PER_KM = 1 / 1.852;
  const candidates: CleanupCandidate[] = [];
  for (const install of manifest.installs) {
    const source = catalogDoc?.sources.find((s) => s.id === install.catalogSourceId);
    if (!source) {
      // Can't judge relevance without the source's region — always surface
      // it rather than silently hiding a dataset the catalog no longer knows
      // about (e.g. removed upstream since it was installed).
      candidates.push({
        id: install.id, catalogSourceId: install.catalogSourceId, name: install.catalogSourceId,
        type: install.type, sizeBytes: install.size_bytes, distanceNm: null, downloadedAt: install.downloaded_at,
      });
      continue;
    }
    const bbox = source.region.bounding_box;
    const clampedLat = Math.min(Math.max(vesselPos.lat, bbox.min_lat), bbox.max_lat);
    const clampedLon = clampLonToBbox(vesselPos.lon, bbox.min_lon, bbox.max_lon);
    const distanceNm = distanceKm(vesselPos.lat, vesselPos.lon, clampedLat, clampedLon) * NM_PER_KM;
    if (distanceNm > maxDistanceNm) {
      candidates.push({
        id: install.id, catalogSourceId: install.catalogSourceId, name: source.name,
        type: install.type, sizeBytes: install.size_bytes, distanceNm, downloadedAt: install.downloaded_at,
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.distanceNm === null && b.distanceNm === null) return b.sizeBytes - a.sizeBytes;
    if (a.distanceNm === null) return 1;
    if (b.distanceNm === null) return -1;
    return b.distanceNm - a.distanceNm || b.sizeBytes - a.sizeBytes;
  });
}
