# Changelog

## 0.2.0 — 2026-07-03

### Added

- **GRIB2 support**: gridded current fields (u/v or direction/speed,
  oceanographic discipline) parsed by a built-in dependency-free decoder —
  regular lat/lon grids, simple and complex packing (incl. spatial
  differencing), bitmaps for land masking. Validated against eccodes on
  real NCEP data.
- New **GRIB2 Data Directory** setting (default: a `grib` subdirectory of
  the plugin's own data directory, independent of Harmonics Data
  Directory); new/updated files are picked up automatically within a
  minute — no restart needed.
- New `GET /timeline?latitude=&longitude=` endpoint: set/drift series at a
  position with per-sample source selection, so windows extending past the
  GRIB forecast horizon degrade to station data instead of failing.
- **Source selection**: `GET /vector` and `environment.current` publishing
  prefer the GRIB forecast when it covers the position/time and fall back
  to the nearest vector-capable station (configurable via *Prefer GRIB
  over stations*). Responses report the `source` used.
- CI via the shared SignalK plugin-ci workflow (Linux x64/arm64, macOS,
  Windows × Node 22/24); results visible on the App Store *Indicators* tab.

### Changed

- `GET /` dataset summary now reports both sources (harmonics + GRIB
  coverage, time range, bounding box).
- `GET /vector` response: new `source` field; `station` is `null` for
  GRIB-backed answers. `speedKn` is a magnitude for GRIB samples (no
  flood/ebb axis in gridded data).
- The REST API responds as long as *either* source is loaded (previously
  required the harmonics files).
- Default **Harmonics Data Directory** moved to a `tcdata` subdirectory of
  the plugin's own Signal K data directory (previously the data directory
  itself); only affects fresh installs that never set the setting
  explicitly.

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
