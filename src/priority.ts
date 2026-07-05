// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Source priority, persisted as a small override file so the webapp's
 * reorder UI survives restarts independently of the plugin's JSON-schema
 * config form. Two layers:
 *
 * - `order` (PRD §5.3 Phase 1): an ordered list of the three source TYPES —
 *   grib2/utcef/harmonic. The fallback rank for anything not covered below.
 * - `datasets` (PRD §5.3 Phase 3): an ordered list of manifest install ids —
 *   the per-dataset priority stack, top wins ACROSS types. Installs not in
 *   the list are appended in type-order (see resolveDatasetStack), so a
 *   fresh download slots in without the user having to re-rank everything.
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

/** True iff `datasets` is a list of unique, non-empty strings (install ids). */
export function isValidDatasetStack(datasets: unknown): datasets is string[] {
  if (!Array.isArray(datasets)) return false;
  const seen = new Set<string>();
  for (const v of datasets) {
    if (typeof v !== 'string' || v === '' || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

export interface PriorityOverride {
  order: SourceType[] | null;
  /** Persisted per-dataset stack (manifest install ids, top wins) — [] when never set. */
  datasets: string[];
}

/** Tolerant read: missing/corrupt file or invalid contents → nulls/empty (caller falls back to defaults). */
export function loadPriorityOverride(managerDir: string): PriorityOverride {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(managerDir, 'priority.json'), 'utf8'));
    return {
      order: isValidPriorityOrder(raw?.order) ? raw.order : null,
      datasets: isValidDatasetStack(raw?.datasets) ? raw.datasets : [],
    };
  } catch {
    return { order: null, datasets: [] };
  }
}

export function savePriorityOverrideAtomic(managerDir: string, order: SourceType[], datasets: string[] = []): void {
  fs.mkdirSync(managerDir, { recursive: true });
  const file = path.join(managerDir, 'priority.json');
  const tmp = path.join(managerDir, `.priority.json.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify({ order, datasets }, null, 2));
  fs.renameSync(tmp, file);
}

/** One installed dataset in the effective priority stack, top-first. */
export interface DatasetRankEntry {
  /** Manifest install id. */
  id: string;
  type: SourceType;
  /** Filenames (relative to the type's data dir) the install owns — what the per-dataset source probes filter on. */
  files: string[];
}

/**
 * The effective full stack: the persisted order first (ids that no longer
 * exist are dropped), then every remaining install appended in type-order.
 * Pure — callers pass the current manifest installs.
 */
export function resolveDatasetStack(
  persisted: string[],
  typeOrder: SourceType[],
  installs: Array<{ id: string; type: SourceType; files: string[] }>,
): DatasetRankEntry[] {
  const byId = new Map(installs.map((i) => [i.id, i]));
  const stack: DatasetRankEntry[] = [];
  for (const id of persisted) {
    const install = byId.get(id);
    if (!install) continue;
    stack.push({ id: install.id, type: install.type, files: install.files });
    byId.delete(id);
  }
  const rank = new Map(typeOrder.map((t, i) => [t, i]));
  const rest = [...byId.values()].sort((a, b) => (rank.get(a.type) ?? 9) - (rank.get(b.type) ?? 9));
  for (const install of rest) stack.push({ id: install.id, type: install.type, files: install.files });
  return stack;
}
