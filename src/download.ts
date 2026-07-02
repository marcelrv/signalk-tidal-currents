// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Optional fallback data source: OpenCPN's `HARMONICS_NO_US` (+ `.IDX`)
 * pair, fetched from the OpenCPN GitHub repository when missing locally,
 * and re-checked (conditionally, via ETag) at most once a week thereafter
 * so the plugin doesn't hit GitHub on every server restart.
 *
 * Never overwrites a user-provided HARMONIC/HARMONIC.IDX pair: the
 * download lands under its own filename, and findHarmonicFiles() prefers a
 * file literally named HARMONIC when both are present in the same dir.
 */

import * as fs from 'fs';
import * as path from 'path';

export const OPENCPN_BASE_URL = 'https://raw.githubusercontent.com/OpenCPN/OpenCPN/master/data/tcdata';
export const OPENCPN_FILES = ['HARMONICS_NO_US', 'HARMONICS_NO_US.IDX'];

const CHECK_INTERVAL_MS = 7 * 24 * 3600_000;
const STATE_FILE = '.signalk-tidal-currents-download-state.json';

interface DownloadState {
  lastCheckedAt: string;
  etags: Record<string, string>;
}

function statePath(dir: string): string {
  return path.join(dir, STATE_FILE);
}

function readState(dir: string): DownloadState {
  try {
    return JSON.parse(fs.readFileSync(statePath(dir), 'utf8'));
  } catch {
    return { lastCheckedAt: '', etags: {} };
  }
}

function writeState(dir: string, state: DownloadState): void {
  fs.writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

async function fetchIfChanged(
  url: string,
  etag: string | undefined,
): Promise<{ changed: boolean; body?: Buffer; etag?: string }> {
  const resp = await fetch(url, etag ? { headers: { 'If-None-Match': etag } } : undefined);
  if (resp.status === 304) return { changed: false };
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  // Read as raw bytes, not text: these files are ISO-8859-1 (French
  // accents in station names) and decoding as UTF-8 would corrupt them.
  const body = Buffer.from(await resp.arrayBuffer());
  return { changed: true, body, etag: resp.headers.get('etag') ?? undefined };
}

/**
 * Ensures OpenCPN's standard HARMONICS_NO_US pair is present and reasonably
 * current in `dir`. Downloads immediately if either file is missing;
 * otherwise checks for updates at most once every 7 days. Returns true if
 * new/updated files were written (caller should reload harmonics data).
 */
export async function ensureStandardData(dir: string): Promise<boolean> {
  const targets = OPENCPN_FILES.map((f) => path.join(dir, f));
  const missing = targets.some((p) => !fs.existsSync(p));
  const state = readState(dir);
  const staleCheck =
    !state.lastCheckedAt || Date.now() - Date.parse(state.lastCheckedAt) > CHECK_INTERVAL_MS;

  if (!missing && !staleCheck) return false;

  fs.mkdirSync(dir, { recursive: true });
  let changed = false;
  const nextEtags: Record<string, string> = { ...state.etags };
  for (let i = 0; i < OPENCPN_FILES.length; i++) {
    const name = OPENCPN_FILES[i];
    const target = targets[i];
    const forceDownload = !fs.existsSync(target);
    const result = await fetchIfChanged(
      `${OPENCPN_BASE_URL}/${name}`,
      forceDownload ? undefined : state.etags[name],
    );
    if (result.changed && result.body) {
      fs.writeFileSync(target, result.body);
      changed = true;
      if (result.etag) nextEtags[name] = result.etag;
    }
  }
  writeState(dir, { lastCheckedAt: new Date().toISOString(), etags: nextEtags });
  return changed;
}
