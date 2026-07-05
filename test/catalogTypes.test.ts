// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isTemplateFile, StaticCatalogFile, validateCatalogDocument } from '../dist/catalogTypes.js';

function staticFile(overrides: Record<string, unknown> = {}) {
  return { filename: 'foo.utcef', url: 'https://example.org/foo.utcef', sha256: 'abc123', size_bytes: 1234, ...overrides };
}

function region() {
  return {
    name: 'Test region',
    bounding_box: { min_lat: 51, min_lon: 3, max_lat: 54, max_lon: 7 },
    boundary_geometry: { type: 'Polygon', coordinates: [[[3, 51], [7, 51], [7, 54], [3, 54], [3, 51]]] },
  };
}

function updateCheck() {
  return { method: 'sha256', last_checked: '2026-07-03T10:30:00Z' };
}

function validDoc(sources: unknown[]) {
  return {
    catalog_schema_version: '1.0.0',
    version: 1,
    generated: '2026-07-03T10:30:00Z',
    source_count: sources.length,
    sources,
  };
}

test('accepts a valid document with a static file source', () => {
  const doc = validDoc([
    {
      id: 'noaa-rtofs', source: 'noaa', type: 'grib2', name: 'NOAA RTOFS', description: '…',
      contributor: 'NOAA', url: 'https://example.org', tags: ['grib2'], region: region(),
      update_check: updateCheck(), files: [staticFile()],
    },
  ]);
  const { document, warnings } = validateCatalogDocument(doc);
  assert.equal(document.sources.length, 1);
  assert.equal(warnings.length, 0);
  assert.equal(isTemplateFile(document.sources[0].files[0]), false);
});

test('accepts a valid document with a template (forecast) file source', () => {
  const templateFile = {
    region_id: 'nw-europe', name: 'NW Europe', description: '…',
    boundary_geometry: region().boundary_geometry,
    type: 'forecast', url_template: 'https://example.org/{YYYYMMDD}/{HH}/f{hour:03d}.grb2',
    forecast_hours: [24, 48, 72], cycle_hours: ['00'],
  };
  const doc = validDoc([
    {
      id: 'grib-template', source: 'noaa', type: 'grib2', name: 'Forecast', description: '…',
      contributor: 'NOAA', url: 'https://example.org', tags: [], region: region(),
      update_check: { method: 'expiry', last_checked: '2026-07-03T10:30:00Z', max_age_hours: 24, latest_cycle: '2026-07-03T00:00:00Z' },
      files: [templateFile],
    },
  ]);
  const { document, warnings } = validateCatalogDocument(doc);
  assert.equal(document.sources.length, 1);
  assert.equal(warnings.length, 0);
  assert.ok(isTemplateFile(document.sources[0].files[0]));
});

test('drops an individually malformed source but keeps the rest', () => {
  const good = {
    id: 'good', source: 'noaa', type: 'grib2', name: 'Good', description: '…',
    contributor: 'NOAA', url: 'https://example.org', tags: [], region: region(),
    update_check: updateCheck(), files: [staticFile()],
  };
  const bad = { id: 'bad', type: 'not-a-real-type', region: region(), update_check: updateCheck() };
  const { document, warnings } = validateCatalogDocument(validDoc([good, bad]));
  assert.equal(document.sources.length, 1);
  assert.equal(document.sources[0].id, 'good');
  assert.ok(warnings.some((w) => /bad/.test(w)));
});

test('rejects the whole document on a catalog_schema_version major mismatch', () => {
  const doc = validDoc([]);
  (doc as any).catalog_schema_version = '2.0.0';
  assert.throws(() => validateCatalogDocument(doc), /major 2/);
});

test('tolerates a source missing url on a static file (real-world catalog gap)', () => {
  const doc = validDoc([
    {
      id: 'utcef-nl', source: 'signalk-router-data', type: 'utcef', name: 'Netherlands', description: '…',
      contributor: 'AVISO+', url: 'https://example.org', tags: [], region: region(),
      update_check: updateCheck(), files: [staticFile({ url: undefined })],
    },
  ]);
  const { document, warnings } = validateCatalogDocument(doc);
  assert.equal(document.sources.length, 1);
  assert.equal((document.sources[0].files[0] as StaticCatalogFile).url, undefined);
  assert.equal(warnings.length, 0);
});
