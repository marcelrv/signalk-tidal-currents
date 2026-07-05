// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Fetches and caches the tide/current catalog document (see catalogTypes.ts).
 *
 * Offline-first: a failed refresh() never clears the last known-good
 * document — it keeps serving the cached copy and reports the error
 * alongside it, so the manager UI can render "Last catalog sync: X ago"
 * even with no connectivity (PRD §5.5 / §9 airplane-mode acceptance test).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CatalogDocument, validateCatalogDocument } from './catalogTypes.js';

export type CatalogStatus = 'empty' | 'cached' | 'error';

export interface CatalogState {
  status: CatalogStatus;
  document: CatalogDocument | null;
  /** ISO 8601 of the last SUCCESSFUL fetch, or null before one has happened. */
  fetchedAt: string | null;
  /** Most recent refresh error, if any — set even while status is 'cached' (stale-but-usable). */
  error: string | null;
  sourceUrl: string;
  warnings: string[];
}

export interface CatalogClient {
  get(): CatalogState;
  refresh(): Promise<CatalogState>;
}

export interface CatalogClientOptions {
  url: string;
  cacheFile: string;
}

interface CacheFileShape {
  fetchedAt: string;
  document: CatalogDocument;
}

function writeAtomic(file: string, contents: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

function loadCachedCatalog(cacheFile: string): { document: CatalogDocument; fetchedAt: string } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CacheFileShape;
    if (!raw || typeof raw.fetchedAt !== 'string' || !raw.document) return null;
    return { document: raw.document, fetchedAt: raw.fetchedAt };
  } catch {
    return null;
  }
}

function writeCachedCatalogAtomic(cacheFile: string, document: CatalogDocument, fetchedAt: string): void {
  const shape: CacheFileShape = { fetchedAt, document };
  writeAtomic(cacheFile, JSON.stringify(shape, null, 2));
}

export function createCatalogClient(opts: CatalogClientOptions): CatalogClient {
  const cached = loadCachedCatalog(opts.cacheFile);
  let state: CatalogState = cached
    ? { status: 'cached', document: cached.document, fetchedAt: cached.fetchedAt, error: null, sourceUrl: opts.url, warnings: [] }
    : { status: 'empty', document: null, fetchedAt: null, error: null, sourceUrl: opts.url, warnings: [] };

  return {
    get(): CatalogState {
      return state;
    },
    async refresh(): Promise<CatalogState> {
      try {
        const resp = await fetch(opts.url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching catalog`);
        const raw = await resp.json();
        const { document, warnings } = validateCatalogDocument(raw);
        const fetchedAt = new Date().toISOString();
        writeCachedCatalogAtomic(opts.cacheFile, document, fetchedAt);
        state = { status: 'cached', document, fetchedAt, error: null, sourceUrl: opts.url, warnings };
      } catch (e) {
        // Keep serving the previous document (if any) — never null it out on
        // a transient network failure.
        state = {
          ...state,
          status: state.document ? 'cached' : 'error',
          error: e instanceof Error ? e.message : String(e),
        };
      }
      return state;
    },
  };
}
