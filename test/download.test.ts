// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Exercises ensureStandardData() against the real OpenCPN GitHub source.
 * SKIPS (does not fail) when offline, same convention as
 * opencpn-data.test.ts.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureStandardData, OPENCPN_BASE_URL, OPENCPN_FILES } from '../dist/download.js';

async function isOnline(): Promise<boolean> {
  try {
    const resp = await fetch(`${OPENCPN_BASE_URL}/${OPENCPN_FILES[0]}`, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}

const online = await isOnline();

test(
  'ensureStandardData downloads on first run, skips network on second (fresh check)',
  { skip: !online && 'data unavailable (offline?)' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-dl-'));
    try {
      const first = await ensureStandardData(dir);
      assert.equal(first, true, 'first call should download');
      for (const name of OPENCPN_FILES) {
        const p = path.join(dir, name);
        assert.ok(fs.existsSync(p), `${name} missing after download`);
        assert.ok(fs.statSync(p).size > 10_000, `${name} suspiciously small`);
      }

      const second = await ensureStandardData(dir);
      assert.equal(second, false, 'second call within the week should not re-download');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
