// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cleanupCandidates, statStorage } from '../dist/storage.js';
import { distanceKm } from '../dist/predict.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'signalk-tidal-currents-storage-'));
}

test('usedByPluginBytes sums every file under the single Data Directory, nested or not', async () => {
  const root = tmpDir();
  const grib = path.join(root, 'grib');
  const utcef = path.join(root, 'utcef');
  fs.mkdirSync(grib, { recursive: true });
  fs.mkdirSync(utcef, { recursive: true });
  fs.writeFileSync(path.join(root, 'a'), Buffer.alloc(100));
  fs.writeFileSync(path.join(grib, 'b'), Buffer.alloc(250));
  fs.writeFileSync(path.join(utcef, 'c'), Buffer.alloc(10));
  const stats = await statStorage(root);
  assert.equal(stats.usedByPluginBytes, 360);
});

test('missing directory is tolerated (0 bytes, no throw)', async () => {
  const root = tmpDir();
  const missing = path.join(root, 'does-not-exist');
  const stats = await statStorage(missing);
  assert.equal(stats.usedByPluginBytes, 0);
});

test('degrades totalBytes/freeBytes to null instead of throwing when statfs is unavailable', async () => {
  const root = tmpDir();
  const originalStatfs = (fs.promises as any).statfs;
  try {
    delete (fs.promises as any).statfs;
    const stats = await statStorage(root);
    assert.equal(stats.totalBytes, null);
    assert.equal(stats.freeBytes, null);
  } finally {
    (fs.promises as any).statfs = originalStatfs;
  }
});

test('reports real total/free bytes when statfs is available', async () => {
  const root = tmpDir();
  if (!(fs.promises as any).statfs) return; // Node <18.15 — skip silently, degrade path covered above
  const stats = await statStorage(root);
  assert.ok(typeof stats.totalBytes === 'number' && stats.totalBytes! > 0);
});

// --- cleanupCandidates (PRD §9 Phase 2: Smart Cleanup) ---

function mkSource(id: string, bbox: { min_lat: number; min_lon: number; max_lat: number; max_lon: number }) {
  return {
    id, source: 'test', type: 'grib2' as const, name: `Source ${id}`, description: '', contributor: 'Test', url: 'https://x',
    tags: [],
    region: { name: id, bounding_box: bbox, boundary_geometry: { type: 'Polygon' as const, coordinates: [] } },
    update_check: { method: 'sha256' as const, last_checked: new Date().toISOString() },
    files: [],
  };
}

function mkInstall(id: string, catalogSourceId: string, sizeBytes: number) {
  return {
    id, catalogSourceId, type: 'grib2' as const, files: ['f.grb2'],
    size_bytes: sizeBytes, downloaded_at: new Date().toISOString(),
  };
}

function catalogWith(...sources: ReturnType<typeof mkSource>[]) {
  return { catalog_schema_version: '1.0.0', version: 1, generated: '', source_count: sources.length, sources };
}

test('cleanupCandidates: vessel inside a source bbox is excluded (distance 0)', () => {
  const manifest = { manifest_version: 1 as const, installs: [mkInstall('a', 'src-a', 100)] };
  const catalogDoc = catalogWith(mkSource('src-a', { min_lat: 0, min_lon: 0, max_lat: 10, max_lon: 10 }));
  const candidates = cleanupCandidates(manifest, catalogDoc, { lat: 5, lon: 5 }, 1);
  assert.deepEqual(candidates, []);
});

test('cleanupCandidates: vessel far outside a bbox is included with correct nm distance', () => {
  const manifest = { manifest_version: 1 as const, installs: [mkInstall('a', 'src-a', 100)] };
  const bbox = { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 };
  const catalogDoc = catalogWith(mkSource('src-a', bbox));
  const vessel = { lat: 10, lon: 0 };
  const candidates = cleanupCandidates(manifest, catalogDoc, vessel, 50);
  assert.equal(candidates.length, 1);
  // Cross-check against the same distanceKm the implementation uses, applied
  // to the expected clamped point (lat clamped to bbox.max_lat=1, lon
  // unchanged since 0 is already inside [0,1]) — this verifies the
  // clamping/nm-conversion logic, not the haversine formula itself.
  const expectedNm = (distanceKm(vessel.lat, vessel.lon, 1, 0) / 1.852);
  assert.ok(Math.abs(candidates[0].distanceNm! - expectedNm) < 0.01, `${candidates[0].distanceNm} vs ${expectedNm}`);
});

// --- antimeridian-crossing bbox (e.g. the real Bering Sea catalog entry: min_lon 155, max_lon -165) ---

test('cleanupCandidates: vessel INSIDE an antimeridian-crossing bbox is excluded (distance 0)', () => {
  const manifest = { manifest_version: 1 as const, installs: [mkInstall('a', 'bering', 100)] };
  const bbox = { min_lat: 50, min_lon: 155, max_lat: 65, max_lon: -165 };
  const catalogDoc = catalogWith(mkSource('bering', bbox));
  // 178°E — inside the wrapped [155,180] ∪ [-180,-165] range, and inside the lat range.
  const candidates = cleanupCandidates(manifest, catalogDoc, { lat: 60, lon: 178 }, 1);
  assert.deepEqual(candidates, []);
});

test('cleanupCandidates: vessel OUTSIDE an antimeridian-crossing bbox clamps to the nearer edge, not a wildly wrong point', () => {
  const manifest = { manifest_version: 1 as const, installs: [mkInstall('a', 'bering', 100)] };
  const bbox = { min_lat: 50, min_lon: 155, max_lat: 65, max_lon: -165 };
  const catalogDoc = catalogWith(mkSource('bering', bbox));
  // 120°E is well outside the wrapped range — nearer to min_lon (155) than max_lon (-165, i.e. 195°E).
  const vessel = { lat: 60, lon: 120 };
  const candidates = cleanupCandidates(manifest, catalogDoc, vessel, 50);
  assert.equal(candidates.length, 1);
  const expectedNm = distanceKm(vessel.lat, vessel.lon, 60, 155) / 1.852;
  assert.ok(Math.abs(candidates[0].distanceNm! - expectedNm) < 0.01, `${candidates[0].distanceNm} vs ${expectedNm}`);
});

test('cleanupCandidates: an install whose catalogSourceId no longer resolves is always included, null distance, sorted last', () => {
  const manifest = {
    manifest_version: 1 as const,
    installs: [mkInstall('gone', 'no-longer-in-catalog', 500), mkInstall('far', 'src-far', 100)],
  };
  const catalogDoc = catalogWith(mkSource('src-far', { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 }));
  const candidates = cleanupCandidates(manifest, catalogDoc, { lat: 50, lon: 0 }, 10);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[candidates.length - 1].id, 'gone');
  assert.equal(candidates[candidates.length - 1].distanceNm, null);
});

test('cleanupCandidates: returns [] immediately when no vessel position is available', () => {
  const manifest = { manifest_version: 1 as const, installs: [mkInstall('a', 'src-a', 100)] };
  const catalogDoc = catalogWith(mkSource('src-a', { min_lat: 0, min_lon: 0, max_lat: 1, max_lon: 1 }));
  assert.deepEqual(cleanupCandidates(manifest, catalogDoc, null, 10), []);
});

test('cleanupCandidates: sorts by distance descending, then size descending, among resolvable candidates', () => {
  const manifest = {
    manifest_version: 1 as const,
    installs: [mkInstall('near', 'src-near', 10), mkInstall('far-small', 'src-far', 5), mkInstall('far-big', 'src-far2', 500)],
  };
  const catalogDoc = catalogWith(
    // vessel at (0,0) is OUTSIDE all three bboxes below, so all three have a
    // positive distance (unlike a bbox containing (0,0), which would clamp
    // to 0 and never qualify as a candidate regardless of maxDistanceNm).
    mkSource('src-near', { min_lat: 2, min_lon: 0, max_lat: 3, max_lon: 1 }),
    mkSource('src-far', { min_lat: 20, min_lon: 0, max_lat: 21, max_lon: 1 }),
    mkSource('src-far2', { min_lat: 20, min_lon: 0, max_lat: 21, max_lon: 1 }),
  );
  const candidates = cleanupCandidates(manifest, catalogDoc, { lat: 0, lon: 0 }, 1);
  assert.deepEqual(candidates.map((c) => c.id), ['far-big', 'far-small', 'near']);
});
