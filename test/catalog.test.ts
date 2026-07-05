// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCatalogClient } from '../dist/catalog.js';

function tmpCacheFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-catalog-'));
  return path.join(dir, 'catalog-cache.json');
}

function validCatalogJson(sourceId = 'src-1') {
  return {
    catalog_schema_version: '1.0.0',
    version: 1,
    generated: '2026-07-03T10:30:00Z',
    source_count: 1,
    sources: [
      {
        id: sourceId, source: 'noaa', type: 'grib2', name: 'Test', description: '…',
        contributor: 'NOAA', url: 'https://example.org', tags: [],
        region: {
          name: 'Test', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 },
          boundary_geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
        update_check: { method: 'sha256', last_checked: '2026-07-03T10:30:00Z' },
        files: [{ filename: 'f.grb2', url: 'https://example.org/f.grb2', sha256: 'x', size_bytes: 10 }],
      },
    ],
  };
}

test('starts empty with no cache file, refresh() populates it', async () => {
  const cacheFile = tmpCacheFile();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, json: async () => validCatalogJson() })) as any;
    const client = createCatalogClient({ url: 'https://example.org/catalog.json', cacheFile });
    assert.equal(client.get().status, 'empty');
    const state = await client.refresh();
    assert.equal(state.status, 'cached');
    assert.equal(state.document?.sources.length, 1);
    assert.ok(state.fetchedAt);
    assert.equal(state.error, null);
    assert.ok(fs.existsSync(cacheFile));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});

test('a failed refresh() keeps serving the previously cached document, sets error', async () => {
  const cacheFile = tmpCacheFile();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, json: async () => validCatalogJson() })) as any;
    const client = createCatalogClient({ url: 'https://example.org/catalog.json', cacheFile });
    await client.refresh();

    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as any;
    const state = await client.refresh();
    assert.equal(state.status, 'cached');
    assert.equal(state.document?.sources.length, 1); // unchanged, not nulled out
    assert.ok(state.error && /network down/.test(state.error));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});

test('loads the cached document from disk on startup (offline-first)', async () => {
  const cacheFile = tmpCacheFile();
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, json: async () => validCatalogJson('from-disk') })) as any;
    const first = createCatalogClient({ url: 'https://example.org/catalog.json', cacheFile });
    await first.refresh();

    // A brand new client instance, simulating a plugin restart with no network.
    globalThis.fetch = (async () => {
      throw new Error('should not be called on construction');
    }) as any;
    const second = createCatalogClient({ url: 'https://example.org/catalog.json', cacheFile });
    const state = second.get();
    assert.equal(state.status, 'cached');
    assert.equal(state.document?.sources[0].id, 'from-disk');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});

test('tolerates a missing/corrupt cache file', () => {
  const cacheFile = tmpCacheFile();
  fs.writeFileSync(cacheFile, '{not valid json');
  try {
    const client = createCatalogClient({ url: 'https://example.org/catalog.json', cacheFile });
    assert.equal(client.get().status, 'empty');
  } finally {
    fs.rmSync(path.dirname(cacheFile), { recursive: true, force: true });
  }
});
