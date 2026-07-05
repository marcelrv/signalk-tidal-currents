// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { statStorage } from '../dist/storage.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-storage-'));
}

test('usedByPluginBytes matches known fixture sizes, no double-count when dirs overlap', async () => {
  const root = tmpDir();
  const dataDir = path.join(root, 'tcdata');
  const gribDir = path.join(root, 'grib');
  const utcefDir = path.join(root, 'utcef');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(gribDir, { recursive: true });
  fs.mkdirSync(utcefDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'a'), Buffer.alloc(100));
  fs.writeFileSync(path.join(gribDir, 'b'), Buffer.alloc(250));
  fs.writeFileSync(path.join(utcefDir, 'c'), Buffer.alloc(10));
  // managerDir defaults to the parent of the other three in index.ts — here
  // that's `root` itself, which recursively contains all three subdirs.
  // usedByPluginBytes must count each file once, not double it via managerDir.
  const stats = await statStorage({ dataDir, gribDir, utcefDir, managerDir: root });
  assert.equal(stats.usedByPluginBytes, 360);
});

test('missing directories are tolerated (0 bytes, no throw)', async () => {
  const root = tmpDir();
  const missing = path.join(root, 'does-not-exist');
  const stats = await statStorage({ dataDir: missing, gribDir: missing, utcefDir: missing, managerDir: missing });
  assert.equal(stats.usedByPluginBytes, 0);
});

test('degrades totalBytes/freeBytes to null instead of throwing when statfs is unavailable', async () => {
  const root = tmpDir();
  const originalStatfs = (fs.promises as any).statfs;
  try {
    delete (fs.promises as any).statfs;
    const stats = await statStorage({ dataDir: root, gribDir: root, utcefDir: root, managerDir: root });
    assert.equal(stats.totalBytes, null);
    assert.equal(stats.freeBytes, null);
  } finally {
    (fs.promises as any).statfs = originalStatfs;
  }
});

test('reports real total/free bytes when statfs is available', async () => {
  const root = tmpDir();
  if (!(fs.promises as any).statfs) return; // Node <18.15 — skip silently, degrade path covered above
  const stats = await statStorage({ dataDir: root, gribDir: root, utcefDir: root, managerDir: root });
  assert.ok(typeof stats.totalBytes === 'number' && stats.totalBytes! > 0);
});
