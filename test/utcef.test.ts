// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import {
  createUtcefSource,
  loadUtcefDir,
  nearestUtcefStations,
  parseUtcef,
  utcefSampleAt,
  utcefVectorAt,
} from '../dist/utcef.js';
import { astronomicalArgs, nodeFactors } from '../dist/astro.js';

const KNOTS_TO_MS = 0.514444;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'utcef-test-'));
}

/** CRC-32 (used to build a spec-valid ZIP for the container test). */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

/** Minimal single-entry ZIP (deflate) — a real `.utcef` container. */
function makeZip(entryName: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const comp = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const name = Buffer.from(entryName, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localPart = Buffer.concat([local, name, comp]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); // deflate
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42); // local header offset
  const centralPart = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16); // central dir offset
  return Buffer.concat([localPart, centralPart, eocd]);
}

/** The three-method reference document from the UTCEF spec (canonical Feature.id). */
function referenceDoc(): unknown {
  return {
    metadata: {
      schema_version: '1.0.0',
      dataset_version: '2026.07.03',
      title: 'Test dataset',
      last_updated: '2026-07-03T11:45:00Z',
      region: { name: 'Test', bbox: [3.1, 51.1, 4.9, 53.5] },
      data_sources: [{ name: 'test' }],
      copyright: 'c',
      license: 'CC-BY-4.0',
    },
    dataset: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'NL_02_BG',
          geometry: { type: 'Point', coordinates: [3.68437, 51.65315] },
          properties: {
            prediction_method: 'relative_time_offset',
            reference_port: 'NL_PORT_VLI',
            hours_relative_to: 'high_water_at_reference_port',
            data_unit_speed: 'knots',
            interpolation: { method: 'linear_range_ratio' },
            tidal_stream_table: [{ hour: 0, direction: 101, spring_rate: 1.2, neap_rate: 0.7 }],
          },
        },
        {
          type: 'Feature',
          id: 'NL_03_OFF',
          geometry: { type: 'Point', coordinates: [3.2145, 51.9821] },
          properties: {
            station_name: 'Zeeland Offshore 03',
            prediction_method: 'harmonic_constituents_currents',
            data_unit_speed: 'meters_per_second',
            mean_offset: { u_residual: 0.012, v_residual: -0.004 },
            harmonic_constituents: {
              M2: { u_amplitude: 0.452, u_phase_g: 112.4, v_amplitude: 0.121, v_phase_g: 345.1 },
              S2: { u_amplitude: 0.151, u_phase_g: 145.2, v_amplitude: 0.042, v_phase_g: 12.3 },
              K1: { u_amplitude: 0.052, u_phase_g: 85.1, v_amplitude: 0.018, v_phase_g: 264.3 },
            },
          },
        },
        {
          type: 'Feature',
          id: 'NL_PORT_VLI',
          geometry: { type: 'Point', coordinates: [3.5681, 51.4422] },
          properties: {
            station_name: 'Vlissingen Reference Port',
            prediction_method: 'harmonic_constituents_heights',
            data_unit_height: 'meters',
            chart_datum: 'LAT',
            mean_sea_level: 1.95,
            harmonic_constituents: { M2: { amplitude: 1.745, phase_g: 105.8 } },
          },
        },
      ],
    },
  };
}

test('loads the reference document: one current station, one height, one unsupported', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ref.utcef'), JSON.stringify(referenceDoc()));
  const data = loadUtcefDir(dir)!;
  assert.equal(data.currentStations.length, 1);
  assert.equal(data.heightStationCount, 1);
  assert.equal(data.unsupportedFeatureCount, 1); // relative_time_offset not yet implemented
  const st = data.currentStations[0];
  assert.equal(st.id, 'NL_03_OFF');
  assert.equal(st.name, 'Zeeland Offshore 03');
  assert.equal(st.constituents.length, 3);
  assert.equal(st.meanU, 0.012);
});

test('createUtcefSource: invalidate() forces an immediate reload, bypassing checkIntervalMs', () => {
  const dir = tmpDir();
  // Long interval — without invalidate(), a get() right after dropping a new
  // file in would still return the stale (null) result for up to a minute.
  const src = createUtcefSource(dir, 60_000);
  assert.equal(src.get(), null);
  fs.writeFileSync(path.join(dir, 'ref.utcef'), JSON.stringify(referenceDoc()));
  assert.equal(src.get(), null, 'still within checkIntervalMs — should not have reloaded yet');
  src.invalidate();
  const data = src.get();
  assert.ok(data && data.currentStations.length === 1, 'invalidate() should force the very next get() to reload');
});

test('surfaces license/citation/attribution metadata (PRD attribution surface)', () => {
  const dir = tmpDir();
  const doc = referenceDoc() as any;
  doc.metadata.license_url = 'https://example.org/license.pdf';
  doc.metadata.citation_required = 'Please cite Test Dataset 2026';
  doc.metadata.data_sources = [{ name: 'Test Model', url: 'https://example.org', role: 'Model Developer' }];
  fs.writeFileSync(path.join(dir, 'ref.utcef'), JSON.stringify(doc));
  const data = loadUtcefDir(dir)!;
  assert.equal(data.copyright, 'c');
  assert.equal(data.license, 'CC-BY-4.0');
  assert.equal(data.licenseUrl, 'https://example.org/license.pdf');
  assert.equal(data.citationRequired, 'Please cite Test Dataset 2026');
  assert.deepEqual(data.dataSources, [
    { name: 'Test Model', url: 'https://example.org', role: 'Model Developer' },
  ]);
});

test('predicts a finite, well-formed set/drift vector', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ref.utcef'), JSON.stringify(referenceDoc()));
  const st = loadUtcefDir(dir)!.currentStations[0];
  const s = utcefSampleAt(st, Date.UTC(2026, 6, 4, 12, 0, 0));
  assert.ok(Number.isFinite(s.u!) && Number.isFinite(s.v!));
  assert.ok(s.speedKn! >= 0);
  assert.ok(s.direction! >= 0 && s.direction! < 360);
  // Deterministic for a given instant.
  const s2 = utcefSampleAt(st, Date.UTC(2026, 6, 4, 12, 0, 0));
  assert.deepEqual(s, s2);
});

test('a pure-S2 station repeats with a 12-hour period', () => {
  const st = {
    id: 'S2ONLY',
    name: 'S2 only',
    latitude: 52,
    longitude: 4,
    meanU: 0,
    meanV: 0,
    constituents: [{ name: 'S2', uAmp: 1, uPhaseG: 0, vAmp: 0, vPhaseG: 0 }],
  };
  const t = Date.UTC(2026, 6, 4, 8, 0, 0);
  const a = utcefSampleAt(st, t);
  const b = utcefSampleAt(st, t + 12 * 3600_000);
  assert.ok(Math.abs(a.u! - b.u!) < 1e-3, `S2 12h apart: ${a.u} vs ${b.u}`);
});

test('knots amplitudes are converted to m/s', () => {
  const st = {
    id: 'KN',
    name: 'knots station',
    latitude: 52,
    longitude: 4,
    meanU: 0,
    meanV: 0,
    // 1.0-knot M2 amplitude on u should peak at ~0.5144 m/s.
    constituents: [{ name: 'M2', uAmp: 1 * KNOTS_TO_MS, uPhaseG: 0, vAmp: 0, vPhaseG: 0 }],
  };
  const t0 = Date.UTC(2026, 6, 4);
  let maxU = 0;
  for (let h = 0; h < 13; h += 0.01) {
    const s = utcefSampleAt(st, t0 + h * 3600_000);
    maxU = Math.max(maxU, Math.abs(s.u!));
  }
  // The M2 node factor f (≈0.96–1.04) scales the amplitude, so the peak is
  // f·A, not A itself — the correct harmonic behaviour.
  const expected = nodeFactors(astronomicalArgs(t0), 'M2')!.f * KNOTS_TO_MS;
  assert.ok(Math.abs(maxU - expected) < 0.003, `peak |u| ${maxU} ≈ f·${KNOTS_TO_MS} = ${expected}`);
});

test('parseUtcef converts a knots station amplitude at load time', () => {
  const doc = {
    metadata: { schema_version: '1.0.0' },
    dataset: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'K',
          geometry: { type: 'Point', coordinates: [4, 52] },
          properties: {
            prediction_method: 'harmonic_constituents_currents',
            data_unit_speed: 'knots',
            harmonic_constituents: { M2: { u_amplitude: 2, u_phase_g: 0, v_amplitude: 0, v_phase_g: 0 } },
          },
        },
      ],
    },
  };
  const warnings: string[] = [];
  const parsed = parseUtcef(JSON.stringify(doc), 'x', warnings);
  assert.ok(Math.abs(parsed.currentStations[0].constituents[0].uAmp - 2 * KNOTS_TO_MS) < 1e-9);
});

test('rejects an unsupported major schema version', () => {
  const dir = tmpDir();
  const doc = referenceDoc() as any;
  doc.metadata.schema_version = '2.0.0';
  fs.writeFileSync(path.join(dir, 'v2.utcef'), JSON.stringify(doc));
  const data = loadUtcefDir(dir)!;
  assert.equal(data.currentStations.length, 0);
  assert.ok(data.warnings.some((w) => /major 2/.test(w)), data.warnings.join('; '));
});

test('warns on an unknown constituent but keeps the known ones', () => {
  const dir = tmpDir();
  const doc = {
    metadata: { schema_version: '1.1.0' },
    dataset: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'U',
          geometry: { type: 'Point', coordinates: [4, 52] },
          properties: {
            prediction_method: 'harmonic_constituents_currents',
            data_unit_speed: 'meters_per_second',
            harmonic_constituents: {
              M2: { u_amplitude: 0.5, u_phase_g: 100, v_amplitude: 0.1, v_phase_g: 200 },
              XX9: { u_amplitude: 0.5, u_phase_g: 0, v_amplitude: 0, v_phase_g: 0 },
            },
          },
        },
      ],
    },
  };
  fs.writeFileSync(path.join(dir, 'u.utcef'), JSON.stringify(doc));
  const data = loadUtcefDir(dir)!;
  assert.equal(data.currentStations.length, 1);
  assert.equal(data.currentStations[0].constituents.length, 1); // XX9 dropped
  assert.ok(data.warnings.some((w) => /XX9/.test(w)));
});

test('reads gzip-compressed .utcef.gz files (legacy, detected by magic bytes)', () => {
  const dir = tmpDir();
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(referenceDoc())));
  fs.writeFileSync(path.join(dir, 'ref.utcef.gz'), gz);
  const data = loadUtcefDir(dir)!;
  assert.equal(data.currentStations.length, 1);
  assert.equal(data.currentStations[0].id, 'NL_03_OFF');
});

test('reads a ZIP-container .utcef file (the spec container form)', () => {
  const dir = tmpDir();
  // A real ZIP archive whose payload member is `<basename>.json`.
  const zip = makeZip('ref.json', JSON.stringify(referenceDoc()));
  fs.writeFileSync(path.join(dir, 'ref.utcef'), zip);
  // Sanity: the file really is a ZIP (starts with "PK", opens as .zip).
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  const data = loadUtcefDir(dir)!;
  assert.equal(data.currentStations.length, 1);
  assert.equal(data.currentStations[0].id, 'NL_03_OFF');
  assert.equal(data.heightStationCount, 1);
});

test('representative_area wins over nearest-station distance', () => {
  const dir = tmpDir();
  const mk = (id: string, lon: number, lat: number, area?: unknown) => ({
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      prediction_method: 'harmonic_constituents_currents',
      data_unit_speed: 'meters_per_second',
      representative_area: area,
      harmonic_constituents: { M2: { u_amplitude: 0.5, u_phase_g: 100, v_amplitude: 0.1, v_phase_g: 200 } },
    },
  });
  const doc = {
    metadata: { schema_version: '1.0.0' },
    dataset: {
      type: 'FeatureCollection',
      features: [
        // Nearest by point distance, but no area.
        mk('NEAR', 4.01, 52.01),
        // Far point, but its area contains the query.
        mk('AREA', 5.0, 53.0, {
          type: 'Polygon',
          coordinates: [[[3.9, 51.9], [4.1, 51.9], [4.1, 52.1], [3.9, 52.1], [3.9, 51.9]]],
        }),
      ],
    },
  };
  fs.writeFileSync(path.join(dir, 'a.utcef'), JSON.stringify(doc));
  const data = loadUtcefDir(dir)!;
  const nearest = nearestUtcefStations(data, 52.0, 4.0, 1)[0];
  assert.equal(nearest.station.id, 'NEAR');
  const hit = utcefVectorAt(data, 52.0, 4.0, Date.now())!;
  assert.equal(hit.station.id, 'AREA'); // area containment overrides nearest
});

test('Feature.id is canonical; station_id alias is not required', () => {
  const dir = tmpDir();
  const doc = {
    metadata: { schema_version: '1.0.0' },
    dataset: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'CANON',
          geometry: { type: 'Point', coordinates: [4, 52] },
          properties: {
            station_id: 'ALIAS_IGNORED',
            prediction_method: 'harmonic_constituents_currents',
            data_unit_speed: 'meters_per_second',
            harmonic_constituents: { M2: { u_amplitude: 0.5, u_phase_g: 0, v_amplitude: 0, v_phase_g: 0 } },
          },
        },
      ],
    },
  };
  fs.writeFileSync(path.join(dir, 'c.utcef'), JSON.stringify(doc));
  const data = loadUtcefDir(dir)!;
  assert.equal(data.currentStations[0].id, 'CANON');
});

test('loadUtcefDir per-file cache: unchanged files are reused, changed files re-parsed, deleted files evicted', () => {
  const dir = tmpDir();
  const docB = {
    metadata: { schema_version: '1.0.0' },
    dataset: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'B_STATION',
          geometry: { type: 'Point', coordinates: [5, 52] },
          properties: {
            prediction_method: 'harmonic_constituents_currents',
            data_unit_speed: 'meters_per_second',
            harmonic_constituents: { M2: { u_amplitude: 0.3, u_phase_g: 0, v_amplitude: 0, v_phase_g: 0 } },
          },
        },
      ],
    },
  };
  fs.writeFileSync(path.join(dir, 'a.utcef'), JSON.stringify(referenceDoc()));
  fs.writeFileSync(path.join(dir, 'b.utcef'), JSON.stringify(docB));

  const cache = new Map();
  const first = loadUtcefDir(dir, cache)!;
  assert.equal(first.currentStations.length, 2);
  const aStationFirst = first.currentStations.find((s) => s.id === 'NL_03_OFF')!;

  // Nothing changed: the cached parse (same station OBJECT) must be reused.
  const second = loadUtcefDir(dir, cache)!;
  const aStationSecond = second.currentStations.find((s) => s.id === 'NL_03_OFF')!;
  assert.equal(aStationSecond, aStationFirst);

  // Change b only (bump mtime into the future so sig differs even on
  // coarse-mtime filesystems): a's parse must survive untouched.
  fs.writeFileSync(path.join(dir, 'b.utcef'), JSON.stringify(docB));
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(path.join(dir, 'b.utcef'), future, future);
  const bSigBefore = cache.get('b.utcef')!.sig;
  const third = loadUtcefDir(dir, cache)!;
  assert.equal(third.currentStations.find((s) => s.id === 'NL_03_OFF'), aStationFirst);
  assert.notEqual(cache.get('b.utcef')!.sig, bSigBefore);

  // Delete b: its cache entry must be evicted, a still served from cache.
  fs.unlinkSync(path.join(dir, 'b.utcef'));
  const fourth = loadUtcefDir(dir, cache)!;
  assert.equal(fourth.currentStations.length, 1);
  assert.equal(cache.has('b.utcef'), false);
  assert.equal(cache.has('a.utcef'), true);
});

test('loadUtcefDir per-file cache: a corrupt file is parsed once per change, its warning re-surfaced from cache', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'ok.utcef'), JSON.stringify(referenceDoc()));
  fs.writeFileSync(path.join(dir, 'bad.utcef'), '{not json');
  const cache = new Map();
  const first = loadUtcefDir(dir, cache)!;
  assert.ok(first.warnings.some((w) => w.startsWith('bad.utcef')));
  assert.equal(cache.get('bad.utcef')!.parsed, null);
  const badEntry = cache.get('bad.utcef')!;
  const second = loadUtcefDir(dir, cache)!;
  assert.ok(second.warnings.some((w) => w.startsWith('bad.utcef')));
  assert.equal(cache.get('bad.utcef'), badEntry); // same entry — not re-parsed
});
