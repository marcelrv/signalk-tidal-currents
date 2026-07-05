// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared install-vs-catalog staleness check, used both by `managerApi.ts`'s
 * `/datasets` listing (display) and `autoUpdate.ts`'s sweep (decides what to
 * re-download) — kept in one place so the two never disagree about what
 * "update-available" means.
 */

import { CatalogSource, StaticCatalogFile, isTemplateFile } from './catalogTypes.js';
import { ManifestInstall } from './manifest.js';

export interface InstallStatus {
  status: 'active' | 'update-available' | 'error';
  updateCheckMethod?: 'sha256' | 'expiry';
  expiresAt?: string;
  remainingHours?: number;
  maxAgeHours?: number;
}

/**
 * `filesExist` is passed in (rather than checked here) since the caller
 * already knows the resolved directory and this function has no filesystem
 * access of its own — keeps it pure and cheap to call from a sweep loop.
 */
export function computeInstallStatus(
  install: ManifestInstall,
  source: CatalogSource | undefined,
  filesExist: boolean,
): InstallStatus {
  let status: InstallStatus['status'] = filesExist ? 'active' : 'error';
  if (!filesExist || !source) return { status };

  if (source.update_check.method === 'sha256' && install.sha256) {
    const staticFile = source.files.find((f): f is StaticCatalogFile => !isTemplateFile(f) && !!f.sha256);
    if (staticFile && staticFile.sha256 !== install.sha256) status = 'update-available';
    return { status };
  }

  if (source.update_check.method === 'expiry' && install.cycle && source.update_check.max_age_hours) {
    const maxAgeHours = source.update_check.max_age_hours;
    const cycleMs = Date.parse(install.cycle);
    const ageHours = (Date.now() - cycleMs) / 3600_000;
    const remainingHours = maxAgeHours - ageHours;
    if (ageHours > maxAgeHours) status = 'update-available';
    return {
      status,
      updateCheckMethod: 'expiry',
      expiresAt: new Date(cycleMs + maxAgeHours * 3600_000).toISOString(),
      remainingHours,
      maxAgeHours,
    };
  }

  return { status };
}
