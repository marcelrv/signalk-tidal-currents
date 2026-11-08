/**
 * Plugin-level wiring of the /plugins/signalk-tidal-currents routes:
 * signalk-server keeps that path admin-only except routes registered through
 * `router.access('readonly')`. Pins exactly which routes go public, so a
 * refactor can't silently expose a mutation to anonymous `allow_readonly`
 * visitors (or hide the read-only manager view from them).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { pluginConstructor } from '../dist/index.js';

function recordingRouter() {
  const admin: string[] = [];
  const pub: string[] = [];
  const levels: string[] = [];
  const rec = (out: string[], method: string) => (p: string) => { out.push(`${method} ${p}`); };
  const router = {
    get: rec(admin, 'GET'),
    post: rec(admin, 'POST'),
    put: rec(admin, 'PUT'),
    delete: rec(admin, 'DELETE'),
    access: (level: string) => {
      levels.push(level);
      return { get: rec(pub, 'GET'), post: rec(pub, 'POST'), put: rec(pub, 'PUT'), delete: rec(pub, 'DELETE') };
    },
  };
  return { router, admin, pub, levels };
}

test('registerWithRouter: only GET routes go through access("readonly"); every mutation stays admin-only', () => {
  const plugin = pluginConstructor({});
  const { router, admin, pub, levels } = recordingRouter();
  plugin.registerWithRouter(router as any);

  assert.ok(levels.length > 0 && levels.every((l) => l === 'readonly'), `levels: ${levels}`);
  assert.deepEqual(pub.filter((r) => !r.startsWith('GET ')), [], 'no mutation may be readonly-accessible');
  for (const r of ['GET /catalog', 'GET /datasets', 'GET /storage', 'GET /priority', 'GET /downloads', 'GET /downloads/events', 'GET /settings/auto-download', 'GET /vector', 'GET /stations', 'GET /grid']) {
    assert.ok(pub.includes(r), `${r} should be readonly-accessible`);
  }
  for (const r of ['POST /catalog/refresh', 'POST /downloads', 'DELETE /datasets/:id', 'PUT /datasets/:id/auto-update', 'PUT /priority', 'PUT /settings/auto-download', 'GET /cleanup-candidates']) {
    assert.ok(admin.includes(r), `${r} should stay admin-only`);
  }
});

test('registerWithRouter: older servers without router.access register everything on the (admin-only) router', () => {
  const plugin = pluginConstructor({});
  const { router, admin, pub } = recordingRouter();
  const { access: _access, ...legacy } = router;
  plugin.registerWithRouter(legacy as any);
  assert.deepEqual(pub, []);
  assert.ok(admin.includes('GET /catalog') && admin.includes('POST /downloads'));
});
