# Changelog

## 0.3.1 — 2026-07-13

### Fixed

- Near You wizard now recommends only the single best not-yet-installed
  dataset per tier (**live forecast** vs **always-available backup**,
  split by `update_check.method`) instead of pre-selecting every catalog
  source whose polygon happens to cover the position — the
  always-matching global OpenCPN harmonic pack no longer gets
  auto-installed alongside a better regional dataset. A tier is skipped
  once anything in it is already installed for that position, so
  accepting one recommendation doesn't surface another on the next
  visit.
- The wizard's "Close" button was disabled in exactly the case where its
  label read "Close" (nothing left to install) — now only disabled while
  an install is actually in progress.
- Download-completion tracking no longer depends on a specific row's
  `DownloadButton` being mounted: a new global `GET /downloads/events`
  SSE stream keeps datasets/storage in sync regardless of view or active
  filters, fixing "Update"/"Update all" silently appearing to do
  nothing. `UpdateAllBanner` also no longer swallows a failed
  `startDownload` call silently.
- Template-file (forecast/nowcast) downloads now try progressively older
  cycles when the chosen one 404s/550s. Fixes BSH nowcast files, which
  are only ever published at the 00Z cycle — the catalog's shared
  `cycle_hours` metadata (same as the 00Z/12Z forecast files) previously
  led the plugin to request a 12Z nowcast that was never published,
  permanently failing to update.
- The auto-update sweep's in-flight check is now selector-aware
  (region/type/variant), so one BSH variant downloading no longer blocks
  its sibling variants from being checked in the same sweep.
- A template file's on-disk filename now includes `variant` explicitly,
  instead of relying on `forecast_hours` happening to differ between
  variants to avoid collisions.
- A successful re-download now removes the file(s) it superseded instead
  of leaving them behind as permanent orphans (skipped when the same
  cycle is re-requested and nothing actually changed).
- The update banner's itemized list now shows an estimated size for
  already-installed template datasets (from the prior download) instead
  of "size varies (forecast cycle)", via a new shared
  `estimatedSizeBytes()` helper shared with the wizard and browser list.

### Added

- GitHub Actions workflow to publish to npm (via OIDC trusted
  publishing) whenever a GitHub Release is published.

## 0.3.0 — 2026-07-11

### Added

- **10 new constituents** in the astronomical engine: M3, MK3, 2MK3, M8,
  2SM2, MSF, SA, S4, S6 and R2 — the engine now covers the full NOS
  standard set except M1/OO1 (whose nodal corrections need Schureman's
  full obliquity theory and contribute only ~1–3 cm/s). M3/M8 join
  M4/MN4/M6 in a generalized M2ⁿ overtide family; MK3/2MK3 use compound
  M2·K1 nodal factors; 2SM2/MSF are S2−M2 compounds.
  Together with the new **NOAA CO-OPS tidal current datasets** in
  [signalk-router-data](https://github.com/marcelrv/signalk-router-data)
  (2,544 US stations converted from NOAA's official harmonic
  constituents), predictions validate against NOAA's own published
  values to 1–6 cm/s RMSE — the shallow-water constituents cut the error
  at strong tidal passes (e.g. Burrows Pass, Puget Sound) from ~23 to
  ~6 cm/s.

### Changed

- Unknown-constituent warnings are aggregated to one per constituent
  name per UTCEF file instead of one per station (a whole-file property
  previously produced thousands of repeated warnings in the manager
  summary).

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
