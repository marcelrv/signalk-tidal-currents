// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Local install manifest (PRD §8) — the source of truth for update
 * detection: which catalog source produced which files on disk, with which
 * hash/cycle. Lives at `<dataDir>/install-manifest.json`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CatalogSourceType } from './catalogTypes.js';

export const MANIFEST_VERSION = 1;

export interface ManifestInstall {
  /** Stable id for this install: usually catalogSourceId, or `${catalogSourceId}:${region_id}` for a template multi-file install. */
  id: string;
  catalogSourceId: string;
  type: CatalogSourceType;
  /**
   * Paths relative to the plugin's single configured Data Directory,
   * forward-slash joined regardless of platform — not bare filenames. The
   * download engine organizes its own downloads into `harmonic/`, `grib/`,
   * `utcef/` subfolders (further split by region for GRIB2/UTCEF) purely as
   * its own convention; nothing reads `files` as implying that structure, so
   * a manually-dropped file anywhere under Data Directory works the same.
   * Must match `listDataFilesRecursive`'s relative-path format exactly, since
   * per-dataset priority (PRD §5.3 Phase 3) matches lookups against these
   * strings.
   */
  files: string[];
  /** Absent for template/expiry-type installs (no single hash covers multiple forecast-hour files). */
  sha256?: string;
  size_bytes: number;
  downloaded_at: string;
  /** ISO 8601 — present for expiry-type (grib2 forecast) installs. */
  cycle?: string;
  /** Present for template (forecast/nowcast) installs — the catalog file's `region_id`, needed to re-select the same template file on a future update without parsing it back out of `id`. */
  regionId?: string;
  /** Present for template installs — a region can carry BOTH a `forecast` and a `nowcast` file under the same region_id (observed in the real NOAA catalog), so region_id alone doesn't uniquely identify which one this install is. */
  fileType?: 'forecast' | 'nowcast';
  /** Opt-in "keep fresh when online" (PRD §5.5 Phase 2) — absent/false by default. Only meaningful for manifest-tracked installs (not orphans), since it drives `runAutoUpdateSweep`'s re-download decision. */
  autoUpdate?: boolean;
}

export interface InstallManifest {
  manifest_version: 1;
  installs: ManifestInstall[];
}

function emptyManifest(): InstallManifest {
  return { manifest_version: MANIFEST_VERSION, installs: [] };
}

/** Tolerant read: missing file or corrupt JSON never throws, just returns an empty manifest. */
export function readManifest(manifestPath: string): InstallManifest {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!raw || !Array.isArray(raw.installs)) return emptyManifest();
    return { manifest_version: MANIFEST_VERSION, installs: raw.installs };
  } catch {
    return emptyManifest();
  }
}

/** Pure — replace-by-id or append. */
export function upsertInstall(manifest: InstallManifest, install: ManifestInstall): InstallManifest {
  const installs = manifest.installs.filter((i) => i.id !== install.id);
  installs.push(install);
  return { manifest_version: MANIFEST_VERSION, installs };
}

/** Pure. */
export function removeInstall(manifest: InstallManifest, id: string): InstallManifest {
  return { manifest_version: MANIFEST_VERSION, installs: manifest.installs.filter((i) => i.id !== id) };
}

/**
 * Atomic write: write the full new JSON to a temp file in the SAME directory
 * (so the rename is same-filesystem, hence atomic on POSIX and Windows),
 * then rename over the target. A crash mid-write leaves either the old file
 * or the new one, never a half-written one.
 */
export function writeManifestAtomic(manifestPath: string, manifest: InstallManifest): void {
  const dir = path.dirname(manifestPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(manifestPath)}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, manifestPath);
}
