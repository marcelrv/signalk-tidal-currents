// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * One-time (re-)vendoring of the offline coastline layer used by the Tidal
 * Currents Manager webapp's Map view (PRD §5.1/§6.3: local vector source
 * only, no tile/CDN URL at runtime). Not part of `npm run build` — the
 * result must be committed so the webapp works fully offline and so the
 * build itself doesn't require network access.
 *
 * Source: Natural Earth's public-domain 1:110m Cultural/Physical Vectors
 * "land" layer, via the well-known nvkelso/natural-earth-vector mirror.
 *
 * Usage: node scripts/fetch-coastline.mjs
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson';
const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'webapp',
  'static-assets',
  'coastline-110m.geojson',
);

const resp = await fetch(SOURCE_URL);
if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${SOURCE_URL}`);
const geojson = await resp.json();
if (geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
  throw new Error('unexpected response shape — not a GeoJSON FeatureCollection');
}

fs.writeFileSync(OUT_PATH, JSON.stringify(geojson));
console.log(`Wrote ${geojson.features.length} feature(s) to ${OUT_PATH}`);
