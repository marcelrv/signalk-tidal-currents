// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Exercises createCatalogClient() against the REAL signalk-router-data
 * catalog. SKIPS (does not fail) when offline, same convention as
 * download.test.ts / opencpn-data.test.ts. Guards against upstream
 * catalog-shape drift.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCatalogClient } from '../dist/catalog.js';

const CATALOG_URL = 'https://raw.githubusercontent.com/marcelrv/signalk-router-data/main/tide-current-index.json';

async function isOnline(): Promise<boolean> {
  try {
    const resp = await fetch(CATALOG_URL, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}

const online = await isOnline();

test(
  'real catalog parses with zero fatal warnings and includes every source type',
  { skip: !online && 'catalog unavailable (offline?)' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-catalog-live-'));
    try {
      const client = createCatalogClient({ url: CATALOG_URL, cacheFile: path.join(dir, 'catalog-cache.json') });
      const state = await client.refresh();
      assert.equal(state.status, 'cached', state.error ?? '');
      assert.ok(state.document && state.document.sources.length > 0);
      assert.equal(state.warnings.length, 0, state.warnings.join('; '));
      const types = new Set(state.document!.sources.map((s) => s.type));
      for (const t of ['harmonic', 'grib2', 'utcef'] as const) {
        assert.ok(types.has(t), `expected a "${t}" source in the live catalog`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
