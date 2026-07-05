// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-type priority (PRD §5.3 Phase 1: an ordered list of the three
 * source TYPES — grib2/utcef/harmonic — not yet per-dataset, see PRD §7's
 * note that per-dataset priority is a Phase 3 backend refactor). Persisted
 * as a small override file so the webapp's reorder list survives restarts
 * independently of the plugin's own JSON-schema config form.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type SourceType = 'grib2' | 'utcef' | 'harmonic';

export const DEFAULT_PRIORITY: SourceType[] = ['grib2', 'utcef', 'harmonic'];

const VALID: ReadonlySet<SourceType> = new Set(['grib2', 'utcef', 'harmonic']);

/** True iff `order` is exactly a permutation of the 3 known source types. */
export function isValidPriorityOrder(order: unknown): order is SourceType[] {
  if (!Array.isArray(order) || order.length !== 3) return false;
  const seen = new Set<string>();
  for (const v of order) {
    if (typeof v !== 'string' || !VALID.has(v as SourceType) || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

/** Tolerant read: missing/corrupt file or invalid contents → null (caller falls back to DEFAULT_PRIORITY). */
export function loadPriorityOverride(managerDir: string): SourceType[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(managerDir, 'priority.json'), 'utf8'));
    return isValidPriorityOrder(raw?.order) ? raw.order : null;
  } catch {
    return null;
  }
}

export function savePriorityOverrideAtomic(managerDir: string, order: SourceType[]): void {
  fs.mkdirSync(managerDir, { recursive: true });
  const file = path.join(managerDir, 'priority.json');
  const tmp = path.join(managerDir, `.priority.json.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify({ order }, null, 2));
  fs.renameSync(tmp, file);
}
