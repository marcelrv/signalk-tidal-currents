# Changelog

## 0.2.0 — 2026-07-07

### Added

- **GRIB2 support**: gridded current fields (u/v or direction/speed,
  oceanographic discipline) parsed by a built-in dependency-free decoder —
  regular lat/lon grids, simple and complex packing (incl. spatial
  differencing), bitmaps for land masking. Validated against eccodes on
  real NCEP and BSH data.
- **JPEG2000 (template 5.40) decoding**: a vendored pure-JavaScript
  JPEG2000 decoder (derived from Mozilla PDF.js) handles GRIB2 files
  compressed with JPEG2000 — used by BSH (German Federal Maritime
  Agency) current forecasts. Full 16-bit precision is preserved (the
  upstream decoder clamped to 8 bits for display; modified to output
  `Float64Array`).
- **UTCEF support**: a third current source alongside legacy harmonic
  stations and GRIB grids. Reads `*.utcef` / `*.utcef.gz` (gzip)
  datasets and implements the `harmonic_constituents_currents` method —
  full 2D (u/v) harmonic currents, so **every UTCEF current station gives
  a real set/drift direction** (legacy reference stations carry no axis).
- New **dependency-free astronomical engine**: derives constituent speeds,
  Greenwich equilibrium arguments and Schureman/Foreman nodal corrections
  that UTCEF harmonic methods require (UTCEF, unlike the legacy files,
  does not ship precomputed year tables).
- **Tidal Currents Manager webapp**: a full download-management UI
  integrated into the Signal K admin console. Phase 1 provides catalog
  browsing (grouped by provider and region), per-dataset download with
  real-time SSE progress bars, dataset expiry countdowns, update-all,
  and a "Near You" wizard that intersects the vessel position with
  catalog coverage polygons and offers a single-click install. Phase 2
  adds per-dataset auto-update, a priority stack for multi-source
  resolution, smart cleanup of datasets far from the vessel, and a
  red-mode-compatible dark theme.
- **BSH forecast support** with FTP downloads (`basic-ftp`):
  - North Sea, Baltic Sea, Inner German Bight, and Elbe river grids
  - Nowcast + forecast-day files at +24h/+48h/+72h horizons
  - A `variant` field disambiguates multiple forecast horizons under the
    same region and type (always backward-compatible — absent on older
    entries, no behaviour change)
  - `chooseCycle()` falls back to the current time when the catalog's
    `latest_cycle` is stale past `max_age_hours`, so the next day's BSH
    file can be discovered without waiting for a catalog refresh
- Bounding-box queries (`GET /stations?bbox=…`, `GET /grid?bbox=…`) for
  full-viewport current stations and GRIB grid samples — replace the
  old nearest-N truncation on every pan/zoom.
- Viewport density control: every bbox response is thinned by a
  geographical cell-ladder so choropleth rendering stays fast at any
  zoom level.
- `GET /timeline?latitude=&longitude=` endpoint: set/drift series at a
  position with per-sample source selection; windows extending past the
  GRIB forecast horizon degrade to station data per-sample instead of
  failing entirely.
- **Source selection**: `GET /vector` and `environment.current` publishing
  prefer GRIB forecasts when they cover the position/time and fall back
  to the nearest vector-capable station (configurable via *Prefer GRIB
  over stations* or setting a full priority stack per dataset). Responses
  report the `source` used.
- Per-file parse caches: GRIB2 files are cached in decoded form so the
  grid endpoint stays fast even with multiple time queries against the
  same cycle.
- CI via the shared SignalK plugin-ci workflow (Linux x64/arm64, macOS,
  Windows × Node 22/24).

### Changed

- **Breaking**: the three independent *Harmonics/GRIB2/UTCEF Data
  Directory* settings are replaced by a single **Data Directory** setting.
  All three file kinds are now found by searching that one directory
  recursively — the Manager's own `harmonic/`/`grib/`/`utcef/` subfolders
  (further split by region for GRIB2/UTCEF) are just its own tidiness
  convention, not a structure anything requires. A file dropped in by hand
  works in any layout, including a copied/symlinked external OpenCPN
  `tcdata` folder. Existing installs: reconfigure to the single directory
  and re-download (or move) any previously-installed data.
- GRIB2 downloads land under a per-region subfolder (e.g.
  `grib/north_sea/…`) instead of flat in the GRIB directory, so several
  installed regions can be browsed and managed apart.
- `GET /` dataset summary now reports all loaded sources (harmonics,
  GRIB coverage, and/or UTCEF stations).
- `GET /vector` response: new `source` field; `station` is `null` for
  GRIB-backed answers. `speedKn` is a magnitude for GRIB samples (no
  flood/ebb axis in gridded data).
- The REST API responds as long as *any* source is loaded (previously
  required the harmonics files).
- Source-resolution order defaults to GRIB → UTCEF → legacy station
  (reversed to UTCEF → station → GRIB when *Prefer GRIB over stations*
  is off). Can be fully overridden per dataset via the priority stack UI.

## 0.1.0 — 2026-07-02

Initial release.

- Parser for OpenCPN/XTide legacy ASCII harmonic files
  (`HARMONIC` + `HARMONIC.IDX`), robust against real-world community
  bundles (ragged records, `x` placeholders, backtick minus signs,
  ISO-8859-1 accents).
- Harmonic prediction of tidal currents: signed flood/ebb speed at
  reference stations; offsets, multipliers and flood/ebb directions at
  subordinate stations (set/drift vectors).
- Publishes `environment.current` (v1 data model) from the nearest
  vector-capable station at the vessel position.
- REST API at `/signalk/v2/api/currents` (mirrored at
  `/plugins/signalk-tidal-currents`): station search, station timelines,
  point vector lookup; OpenAPI spec included.
- Auto-download of OpenCPN's `HARMONICS_NO_US` current-station data
  (weekly freshness check; never overwrites a user-provided
  `HARMONIC`/`HARMONIC.IDX` pair).
