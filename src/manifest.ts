// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Local install manifest (PRD §8) — the source of truth for update
 * detection: which catalog source produced which files on disk, with which
 * hash/cycle. Lives at `<managerDir>/install-manifest.json`.
 *
 * `dir` is a symbolic tag ('harmonic'|'grib'|'utcef'), not an absolute path —
 * it's resolved against the LIVE configured directories at read time, so a
 * config change or Docker volume remount doesn't orphan the manifest.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CatalogSourceType } from './catalogTypes.js';

export const MANIFEST_VERSION = 1;

export type ManifestDir = 'harmonic' | 'grib' | 'utcef';

export interface ManifestInstall {
  /** Stable id for this install: usually catalogSourceId, or `${catalogSourceId}:${region_id}` for a template multi-file install. */
  id: string;
  catalogSourceId: string;
  type: CatalogSourceType;
  /** Filenames only, relative to the resolved `dir`. */
  files: string[];
  dir: ManifestDir;
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
