// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ManifestInstall, readManifest, removeInstall, upsertInstall, writeManifestAtomic } from '../dist/manifest.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-manifest-'));
}

function install(overrides: Partial<ManifestInstall> = {}): ManifestInstall {
  return {
    id: 'noaa-rtofs-west-conus',
    catalogSourceId: 'noaa-rtofs',
    type: 'grib2',
    files: ['grib/rtofs_west.grb2'],
    sha256: 'abc',
    size_bytes: 48211234,
    downloaded_at: '2026-07-04T10:00:00Z',
    ...overrides,
  };
}

test('missing manifest file reads as empty, does not throw', () => {
  const dir = tmpDir();
  const m = readManifest(path.join(dir, 'install-manifest.json'));
  assert.equal(m.manifest_version, 1);
  assert.deepEqual(m.installs, []);
});

test('corrupt manifest file reads as empty, does not throw', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'install-manifest.json');
  fs.writeFileSync(p, '{not valid json');
  const m = readManifest(p);
  assert.deepEqual(m.installs, []);
});

test('upsertInstall appends new, replaces by id, is pure (does not mutate input)', () => {
  const empty = { manifest_version: 1 as const, installs: [] };
  const withOne = upsertInstall(empty, install());
  assert.equal(empty.installs.length, 0, 'input must not be mutated');
  assert.equal(withOne.installs.length, 1);

  const replaced = upsertInstall(withOne, install({ size_bytes: 999 }));
  assert.equal(replaced.installs.length, 1);
  assert.equal(replaced.installs[0].size_bytes, 999);
});

test('removeInstall drops by id, is pure', () => {
  const withOne = upsertInstall({ manifest_version: 1, installs: [] }, install());
  const removed = removeInstall(withOne, install().id);
  assert.equal(withOne.installs.length, 1, 'input must not be mutated');
  assert.equal(removed.installs.length, 0);
});

test('writeManifestAtomic round-trips and never leaves a partial file visible', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'install-manifest.json');
  const manifest = upsertInstall({ manifest_version: 1, installs: [] }, install());
  writeManifestAtomic(p, manifest);

  const readBack = readManifest(p);
  assert.deepEqual(readBack.installs, manifest.installs);

  // No stray temp files should remain after a successful write.
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);

  // Overwrite with a second install; the previously-committed file must not
  // be corrupted by a stray/truncated temp file from an unrelated write.
  fs.writeFileSync(path.join(dir, '.install-manifest.json.tmp-deadbeef'), 'garbage');
  const manifest2 = upsertInstall(manifest, install({ id: 'other', catalogSourceId: 'other' }));
  writeManifestAtomic(p, manifest2);
  const readBack2 = readManifest(p);
  assert.equal(readBack2.installs.length, 2);
});
