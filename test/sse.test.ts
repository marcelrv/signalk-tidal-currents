// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Exercises the SSE download-progress route (`GET /downloads/:id/events`)
 * over a REAL http.Server dispatching into registerManagerRoutes' handlers
 * with genuine http.IncomingMessage/ServerResponse objects — this is the
 * only way to honestly test the raw-stream contract the route depends on
 * (managerApi.test.ts's in-memory fake Req/Res harness can't exercise
 * writeHead/write/end/on('close') at all).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerManagerRoutes, ManagerRouterLike, ManagerState } from '../dist/managerApi.js';
import { createDownloadEngine } from '../dist/downloads.js';
import { DEFAULT_PRIORITY } from '../dist/priority.js';
import { CatalogClient, CatalogState } from '../dist/catalog.js';
import { CatalogDocument, CatalogSource } from '../dist/catalogTypes.js';

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-sse-'));
  return { root, manifestPath: path.join(root, 'install-manifest.json') };
}

function region() {
  return {
    name: 'Test', bounding_box: { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 },
    boundary_geometry: { type: 'Polygon' as const, coordinates: [] },
  };
}

function fakeCatalogClient(sources: CatalogSource[]): CatalogClient {
  const document: CatalogDocument = {
    catalog_schema_version: '1.0.0', version: 1, generated: new Date().toISOString(),
    source_count: sources.length, sources,
  };
  const state: CatalogState = { status: 'cached', document, fetchedAt: new Date().toISOString(), error: null, sourceUrl: 'https://example.org/catalog.json', warnings: [] };
  return { get: () => state, refresh: async () => state };
}

/** A minimal method+path router (supports ":param" single-segment params, the only pattern this API uses) dispatching onto real http req/res objects. */
function createRealRouter(): { router: ManagerRouterLike; server: http.Server } {
  interface Entry { method: string; regex: RegExp; keys: string[]; handler: (req: any, res: any) => void }
  const routes: Entry[] = [];

  function toRegex(p: string): { regex: RegExp; keys: string[] } {
    const keys: string[] = [];
    const pattern = p.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    });
    return { regex: new RegExp(`^${pattern}$`), keys };
  }
  function register(method: string) {
    return (p: string, handler: (req: any, res: any) => void) => {
      const { regex, keys } = toRegex(p);
      routes.push({ method, regex, keys, handler });
    };
  }
  const router: ManagerRouterLike = {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    delete: register('DELETE'),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = routes.find((r) => r.method === req.method && r.regex.test(url.pathname));
    if (!match) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const m = match.regex.exec(url.pathname)!;
    const params: Record<string, string> = {};
    match.keys.forEach((k, i) => (params[k] = m[i + 1]));
    const query: Record<string, unknown> = Object.fromEntries(url.searchParams);

    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
      }
      const mres = res as unknown as { status(c: number): unknown; json(b: unknown): void };
      mres.status = (code: number) => {
        res.statusCode = code;
        return mres;
      };
      mres.json = (b: unknown) => {
        if (!res.headersSent) res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(b));
      };
      match.handler({ params, query, body }, mres);
    });
  });

  return { router, server };
}

function baseMgr(overrides: Partial<ManagerState>): ManagerState {
  const { manifestPath, root } = tmpDirs();
  return {
    catalog: fakeCatalogClient([]),
    downloads: createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([]), catalogUrl: 'https://example.org/catalog.json' }),
    manifestPath,
    dataDir: root,
    getPriority: () => DEFAULT_PRIORITY,
    setPriority: () => {},
    getDatasetStack: () => [],
    setDatasetStack: () => {},
    apiState: { data: null, error: null },
    getVesselPosition: () => null,
    ...overrides,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

test('SSE: a quick job yields at least one data frame and the connection self-closes on completion', async () => {
  const contentServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '5' });
    res.end('hello');
  });
  const port1 = await listen(contentServer);
  try {
    const { root, manifestPath } = tmpDirs();
    const source: CatalogSource = {
      id: 'quick', source: 'test', type: 'harmonic', name: 'Quick', description: '',
      contributor: 'Test', url: `http://127.0.0.1:${port1}`, tags: [], region: region(),
      update_check: { method: 'sha256', last_checked: new Date().toISOString() },
      files: [{ filename: 'HARMONIC', url: `http://127.0.0.1:${port1}/f`, size_bytes: 5 }],
    };
    const downloads = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: 'https://example.org/catalog.json' });
    const mgr = baseMgr({ downloads, dataDir: root, manifestPath });
    const { router, server } = createRealRouter();
    registerManagerRoutes(router, mgr);
    const port2 = await listen(server);
    try {
      const job = downloads.start('quick');
      const resp = await fetch(`http://127.0.0.1:${port2}/downloads/${job.id}/events`);
      assert.equal(resp.headers.get('content-type'), 'text/event-stream');
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      assert.ok(text.includes('data: '), text);
      assert.ok(/"state":"done"/.test(text) || /"state":"error"/.test(text), text);
    } finally {
      server.close();
    }
  } finally {
    contentServer.close();
  }
});

test('SSE: an unknown job id returns a normal 404 JSON response, not a stream', async () => {
  const mgr = baseMgr({});
  const { router, server } = createRealRouter();
  registerManagerRoutes(router, mgr);
  const port = await listen(server);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/downloads/does-not-exist/events`);
    assert.equal(resp.status, 404);
    assert.notEqual(resp.headers.get('content-type'), 'text/event-stream');
    const body = await resp.json() as { error: unknown };
    assert.ok(typeof body.error === 'string');
  } finally {
    server.close();
  }
});

test('SSE: an aborted client connection does not crash the server (indirect: server stays responsive after)', async () => {
  const contentServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '30' });
    let sent = 0;
    const iv = setInterval(() => {
      res.write(Buffer.alloc(10, 65));
      sent += 10;
      if (sent >= 30) { clearInterval(iv); res.end(); }
    }, 200);
  });
  const port1 = await listen(contentServer);
  try {
    const { root, manifestPath } = tmpDirs();
    const source: CatalogSource = {
      id: 'slow', source: 'test', type: 'harmonic', name: 'Slow', description: '',
      contributor: 'Test', url: `http://127.0.0.1:${port1}`, tags: [], region: region(),
      update_check: { method: 'sha256', last_checked: new Date().toISOString() },
      files: [{ filename: 'HARMONIC', url: `http://127.0.0.1:${port1}/f`, size_bytes: 30 }],
    };
    const downloads = createDownloadEngine({ dataDir: root, manifestPath, catalog: fakeCatalogClient([source]), catalogUrl: 'https://example.org/catalog.json' });
    const mgr = baseMgr({ downloads, dataDir: root, manifestPath });
    const { router, server } = createRealRouter();
    registerManagerRoutes(router, mgr);
    const port2 = await listen(server);
    try {
      const job = downloads.start('slow');
      const controller = new AbortController();
      const streamPromise = fetch(`http://127.0.0.1:${port2}/downloads/${job.id}/events`, { signal: controller.signal }).catch(() => null);
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      await streamPromise;
      await new Promise((r) => setTimeout(r, 100));

      // The server must still respond normally to an unrelated request —
      // proves the disconnect's cleanup() didn't throw/leave the server wedged.
      const health = await fetch(`http://127.0.0.1:${port2}/downloads`);
      assert.equal(health.status, 200);
    } finally {
      server.close();
    }
  } finally {
    contentServer.close();
  }
});
