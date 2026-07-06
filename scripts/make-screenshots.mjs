// SPDX-FileCopyrightText: 2026 Marcel Verpaalen
// SPDX-License-Identifier: Apache-2.0

/**
 * Generates the App Store / README screenshots for the Tidal Currents
 * Manager webapp by driving the built webapp with Playwright and feeding it
 * a small set of SYNTHETIC demo fixtures (intercepted at the plugin's REST
 * layer) so the shots always show a rich, representative state regardless of
 * what data the target server actually has.
 *
 * Nothing here is machine-specific: the target URL and output directory are
 * parameters, the fixtures are generated in-file, and the coastline/HTML/JS
 * come from whatever server is hosting the webapp.
 *
 * Prerequisites: a running Signal K server with this plugin installed (so
 * the webapp is served), and Playwright available.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/make-screenshots.mjs
 *
 * Options (env vars):
 *   BASE_URL   webapp URL   (default http://localhost:3000/signalk-tidal-currents/)
 *   OUT_DIR    output dir   (default <repo>/img)
 *   CHROME     explicit Chromium executable path (optional; for playwright-core)
 *
 * Works with either `playwright` or `playwright-core` installed.
 */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('playwright-core'));
}

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000/signalk-tidal-currents/';
const OUT_DIR = process.env.OUT_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'img');
const THEME_KEY = 'tidal-currents-manager.theme';

const VESSEL = { latitude: 52.101, longitude: 4.29 };
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const poly = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const bbox = (w, s, e, n) => ({ min_lat: s, min_lon: w, max_lat: n, max_lon: e });

// --- Synthetic demo catalog ---------------------------------------------
function staticSrc(id, source, type, name, description, tags, w, s, e, n, files, extra = {}) {
  return {
    id, source, type, name, description,
    contributor: extra.contributor ?? source,
    url: extra.url ?? 'https://example.org',
    tags,
    region: { name: extra.region ?? name, bounding_box: bbox(w, s, e, n), boundary_geometry: poly(w, s, e, n) },
    update_check: { method: 'sha256', last_checked: iso(now - 3600_000) },
    files,
  };
}
function gribSrc(id, name, description, regionId, tags, w, s, e, n) {
  return {
    id, source: 'NOAA', type: 'grib2', name, description,
    contributor: 'NOAA / NCEP', url: 'https://nomads.ncep.noaa.gov', tags,
    region: { name, bounding_box: bbox(w, s, e, n), boundary_geometry: poly(w, s, e, n) },
    update_check: { method: 'expiry', last_checked: iso(now - 1800_000), max_age_hours: 24 },
    files: [{
      region_id: regionId, name, description, boundary_geometry: poly(w, s, e, n),
      type: 'forecast', url_template: 'https://nomads.ncep.noaa.gov/rtofs/{ymd}/{hh}/f{fff}.grb2',
      forecast_hours: [0, 6, 12, 18, 24], cycle_hours: ['00', '12'],
    }],
  };
}
const utFile = (fn, size) => [{ filename: fn, url: `https://example.org/${fn}`, sha256: 'a'.repeat(64), size_bytes: size }];

const sources = [
  staticSrc('nl_utcef', 'Rijkswaterstaat', 'utcef', 'Netherlands coastal currents',
    'High-resolution 2D harmonic tidal currents for the Dutch coast, Wadden Sea and estuaries.',
    ['tidal', 'currents', 'coastal', 'high-res', 'utcef', 'europe'],
    3.0, 51.0, 7.2, 53.7, utFile('regions/europe/netherlands.utcef', 8_400_000),
    { contributor: 'Rijkswaterstaat', region: 'Netherlands' }),
  staticSrc('emodnet_northsea_utcef', 'EMODnet Physics', 'utcef', 'North Sea & Channel tidal atlas',
    'Regional 2D harmonic current stations across the southern North Sea and the English Channel approaches.',
    ['tidal', 'currents', 'utcef', 'europe', 'north-sea'],
    -6.0, 48.0, 9.0, 58.0, utFile('regions/europe/north_sea.utcef', 14_000_000),
    { contributor: 'EMODnet Physics', region: 'North Sea' }),
  staticSrc('channel_utcef', 'SHOM', 'utcef', 'English Channel currents',
    'French hydrographic tidal-stream data for the Channel and its western approaches.',
    ['tidal', 'currents', 'utcef', 'channel', 'europe'],
    -5.5, 48.5, 2.0, 51.3, utFile('regions/europe/channel.utcef', 6_100_000),
    { contributor: 'SHOM', region: 'English Channel' }),
  staticSrc('med_utcef', 'CMEMS', 'utcef', 'Mediterranean tidal currents (FES2014)',
    'FES2014-derived harmonic currents across the Mediterranean basin. Citation required, non-commercial.',
    ['tidal', 'currents', 'utcef', 'fes2014', 'mediterranean'],
    -6.0, 30.0, 30.0, 46.0, utFile('regions/med/mediterranean.utcef', 22_000_000),
    { contributor: 'Copernicus Marine (CMEMS)', region: 'Mediterranean' }),
  staticSrc('iberia_utcef', 'Instituto Hidrográfico', 'utcef', 'Iberian Atlantic currents',
    'Tidal current stations along the Atlantic coast of Portugal and NW Spain.',
    ['tidal', 'currents', 'utcef', 'iberia', 'atlantic'],
    -12.0, 36.0, -6.0, 44.0, utFile('regions/atlantic/iberia.utcef', 5_200_000),
    { contributor: 'Instituto Hidrográfico', region: 'Iberian Atlantic' }),
  gribSrc('north_sea_grib', 'North Sea current forecast', 'NOAA RTOFS gridded surface-current forecast for the North Sea.',
    'north_sea', ['forecast', 'gridded', 'rtofs', 'grib2', 'hourly', 'north-sea'], 0.0, 51.0, 9.0, 58.0),
  gribSrc('biscay_grib', 'Bay of Biscay current forecast', 'NOAA RTOFS gridded surface-current forecast for the Bay of Biscay.',
    'biscay', ['forecast', 'gridded', 'rtofs', 'grib2', 'atlantic'], -8.0, 43.5, -1.0, 48.0),
  gribSrc('rtofs_nweurope_grib', 'NW Europe current forecast', 'NOAA RTOFS wide-area surface-current forecast covering NW European waters.',
    'nw_europe', ['forecast', 'gridded', 'rtofs', 'grib2', 'europe'], -12.0, 43.0, 13.0, 62.0),
  gribSrc('baltic_grib', 'Baltic Sea current forecast', 'NOAA RTOFS gridded surface-current forecast for the Baltic Sea.',
    'baltic', ['forecast', 'gridded', 'rtofs', 'grib2', 'baltic'], 9.0, 53.0, 30.0, 66.0),
  staticSrc('opencpn_harmonics', 'OpenCPN / XTide', 'harmonic', 'OpenCPN NW Europe harmonics',
    'Community XTide harmonic current stations bundled with OpenCPN, covering NW European coasts.',
    ['harmonic', 'stations', 'opencpn', 'europe'],
    -10.0, 44.0, 13.0, 60.0,
    [{ filename: 'HARMONIC', url: 'https://example.org/HARMONIC', sha256: 'b'.repeat(64), size_bytes: 2_600_000 },
     { filename: 'HARMONIC.IDX', url: 'https://example.org/HARMONIC.IDX', sha256: 'c'.repeat(64), size_bytes: 500_000 }],
    { contributor: 'OpenCPN / XTide', region: 'NW Europe' }),
];

const catalog = {
  status: 'cached',
  document: { catalog_schema_version: '1.0.0', version: 7, generated: iso(now - 3600_000), source_count: sources.length, sources },
  fetchedAt: iso(now - 22 * 60_000),
  error: null,
  sourceUrl: 'https://raw.githubusercontent.com/marcelrv/signalk-router-data/main/tide-current-index.json',
  warnings: [],
};

const datasets = [
  { id: 'nl_utcef', catalogSourceId: 'nl_utcef', type: 'utcef', name: 'Netherlands coastal currents',
    files: ['regions/europe/netherlands.utcef'], dir: 'utcef', sizeBytes: 8_400_000, downloadedAt: iso(now - 5 * 86400_000),
    status: 'active', autoUpdate: true, contributor: 'Rijkswaterstaat', sourceUrl: 'https://waterinfo.rws.nl',
    license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
  { id: 'north_sea_grib:north_sea:forecast', catalogSourceId: 'north_sea_grib', type: 'grib2', name: 'North Sea current forecast',
    files: ['north_sea_grib_north_sea_forecast_20260706_00_f024.grb2'], dir: 'grib', sizeBytes: 42_000_000,
    downloadedAt: iso(now - 20 * 3600_000), regionId: 'north_sea', fileType: 'forecast', status: 'update-available',
    updateCheckMethod: 'expiry', expiresAt: iso(now + 4 * 3600_000), remainingHours: 4, maxAgeHours: 24, autoUpdate: true,
    contributor: 'NOAA / NCEP' },
  { id: 'biscay_grib:biscay:forecast', catalogSourceId: 'biscay_grib', type: 'grib2', name: 'Bay of Biscay current forecast',
    files: ['biscay_grib_biscay_forecast_20260706_00_f024.grb2'], dir: 'grib', sizeBytes: 28_500_000,
    downloadedAt: iso(now - 21 * 3600_000), regionId: 'biscay', fileType: 'forecast', status: 'update-available',
    updateCheckMethod: 'expiry', expiresAt: iso(now + 2 * 3600_000), remainingHours: 2, maxAgeHours: 24, autoUpdate: false,
    contributor: 'NOAA / NCEP' },
  { id: 'opencpn_harmonics', catalogSourceId: 'opencpn_harmonics', type: 'harmonic', name: 'OpenCPN NW Europe harmonics',
    files: ['HARMONIC', 'HARMONIC.IDX'], dir: 'harmonic', sizeBytes: 3_100_000, downloadedAt: iso(now - 30 * 86400_000),
    status: 'active', autoUpdate: false, contributor: 'OpenCPN / XTide' },
];

const storage = { path: '/data', totalBytes: 531_502_202_880, freeBytes: 220_117_073_920, usedByPluginBytes: 82_000_000 };
const priority = { order: ['grib2', 'utcef', 'harmonic'], default: ['grib2', 'utcef', 'harmonic'],
  datasets: ['north_sea_grib:north_sea:forecast', 'biscay_grib:biscay:forecast', 'nl_utcef', 'opencpn_harmonics'] };
const vector = { source: 'utcef', station: { id: 'OSCHELDE_51p9_4p1', name: 'OSCHELDE grid 51.90,4.10', distanceKm: 3.2 },
  sample: { time: iso(now), speedKn: 1.2, direction: 108, u: 0.55, v: -0.18 } };

// --- Capture -------------------------------------------------------------
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const browser = await chromium.launch({
  args: ['--force-color-profile=srgb'],
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 960, height: 740 }, deviceScaleFactor: 2, colorScheme: 'light' });

await page.route('**/plugins/signalk-tidal-currents/**', (route) => {
  const p = new URL(route.request().url()).pathname;
  if (p.endsWith('/catalog')) return json(route, catalog);
  if (p.endsWith('/datasets')) return json(route, datasets);
  if (p.endsWith('/storage')) return json(route, storage);
  if (p.endsWith('/priority')) return json(route, priority);
  if (p.includes('/vector')) return json(route, vector);
  if (p.endsWith('/downloads')) return json(route, []);
  return json(route, {});
});
await page.route('**/vessels/self/navigation/position', (route) => json(route, { value: VESSEL }));

const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

const shot = (name) => page.screenshot({ path: path.join(OUT_DIR, name) });

async function setTheme(theme) {
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [THEME_KEY, theme]);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
}

await page.goto(BASE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// List view (light) — the default view.
await shot('screenshot-list.png');

// "Near You" download wizard.
await page.getByRole('button', { name: 'Download data for your area' }).click();
await page.waitForTimeout(500);
await shot('screenshot-near-you.png');
await page.getByRole('button', { name: 'Close' }).click();
await page.waitForTimeout(300);

// Map view, framed on all data via the "fit all" control.
await page.getByRole('button', { name: 'Map' }).click();
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Zoom to fit all data' }).click();
await page.waitForTimeout(1400);
await shot('screenshot-map.png');

// List view (dark theme) — demonstrates the night palette.
await setTheme('dark');
await shot('screenshot-list-dark.png');

console.log('Wrote screenshots to', OUT_DIR);
console.log('Page errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
