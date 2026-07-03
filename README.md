![signalk-tidal-currents icon](img/icon.svg)

# signalk-tidal-currents

A [Signal K](https://signalk.org) server plugin that predicts **tidal currents**
(set & drift) from two kinds of sources:

- OpenCPN/XTide legacy ASCII harmonic files — the `HARMONIC` +
  `HARMONIC.IDX` pair used by OpenCPN and the classic DOS tide programs
  (station-based harmonic prediction), and
- **GRIB2 files** with gridded current fields (u/v velocity components from
  ocean/tidal models) — positional lookups with bilinear interpolation in
  space and linear interpolation in time; no stations involved.

Unlike tide-height plugins (e.g. the excellent
[signalk-tides](https://github.com/bkeepers/signalk-tides)), this plugin is
about **water movement**: how fast the tidal stream runs and in which
direction, per station, at any time. Typical uses: passage planning around
tidal gates, current-aware routing (e.g.
[signalk-autoroute](https://github.com/marcelrv/signalk-autoroute)), and
showing predicted set/drift on instruments.

## Features

- Parses OpenCPN/XTide **ASCII harmonic files** (`HARMONIC` +
  `HARMONIC.IDX`), including current reference stations (harmonic
  constituents in knots) and subordinate current stations (flood/ebb time
  offsets, multipliers and **flood/ebb directions**).
- Robust against real-world community files (ragged records, `x`
  placeholders, backtick minus signs, ISO-8859-1 accents).
- Parses **GRIB2 current fields** with a built-in dependency-free decoder
  (regular lat/lon grids; simple and complex packing incl. spatial
  differencing; bitmaps for land masking). Accepts u/v component fields
  (the common encoding) and direction/speed fields. New files dropped into
  the GRIB directory are picked up automatically — no restart needed.
- **Source selection**: when both a GRIB grid and a harmonic station cover
  a position, the GRIB forecast wins (configurable); stations are the
  fallback outside GRIB coverage or beyond the GRIB time range. The
  harmonics-only limitation that reference stations carry **no direction**
  does not apply to GRIB data — grids are always vector-capable.
- **Signal K v1 data model**: publishes `environment.current`
  (`setTrue` rad / `drift` m/s) predicted at the vessel position.
- **v2-style REST API** at `/signalk/v2/api/currents` (also mirrored at the
  v1 plugin path `/plugins/signalk-tidal-currents`): station search by
  position, station and **position timelines**, point vector lookup.
  OpenAPI spec included (Admin UI → Documentation → OpenAPI).

## Which Signal K API — v1 or v2?

Both, deliberately:

- **v1** is the Signal K *data model* (full/delta). It is still the standard
  way to publish live values — every instrument and app understands
  `environment.current`, so predictions are published there as deltas.
- **v2** is the newer family of *domain REST APIs* (`/signalk/v2/api/…`)
  for request/response data. Station metadata and timelines don't belong in
  the vessel data model, so they are served REST-style under
  `/signalk/v2/api/currents`, following the same convention as
  signalk-tides (`/signalk/v2/api/tides`).

## Data files

Point the plugin at a directory containing a `HARMONIC` + `HARMONIC.IDX`
pair (plugin config → *Harmonics Data Directory*; defaults to a `tcdata`
subdirectory of this plugin's own data directory,
`<server config dir>/plugin-config-data/signalk-tidal-currents/tcdata`
— Signal K's standard per-plugin storage location).

**Auto-download (default: on)**: with *Auto-download OpenCPN standard data*
enabled (plugin config), the plugin fetches OpenCPN's `HARMONICS_NO_US` (+
`.IDX`) pair — current stations for the Americas — straight from the
[OpenCPN GitHub repository](https://github.com/OpenCPN/OpenCPN/tree/master/data/tcdata)
into the Harmonics Data Directory if it's missing, so the plugin works out
of the box with no manual setup. It re-checks for updates at most once a
week (a conditional HTTP request; no download if unchanged) — quiet on
every other server restart. It never overwrites a file you name exactly
`HARMONIC`/`HARMONIC.IDX`: if you drop a custom pair (e.g. a community
bundle) into the same directory, that pair always takes priority. Turn the
option off if you don't want the plugin making outbound network requests.

Where to get data manually:

- **OpenCPN installations** ship a `tcdata` folder. Note: the files bundled
  with current OpenCPN releases contain current stations **for the Americas
  only** (from NOAA/XTide) — the bundled European data (TICON) is
  heights-only. Typical locations if OpenCPN is already installed:
  - **Linux:** `/usr/share/opencpn/tcdata/` (or
    `/usr/local/share/opencpn/tcdata/` for from-source installs)
  - **macOS:** `/Applications/OpenCPN.app/Contents/SharedSupport/tcdata/`
  - **Windows:** `C:\Program Files (x86)\OpenCPN\tcdata\`

  (Exact paths vary by OpenCPN version/packaging — check the install
  directory if not found.) Without installing OpenCPN, the same
  `HARMONICS_NO_US` + `.IDX` pair can be fetched directly from the
  [OpenCPN GitHub repository](https://github.com/OpenCPN/OpenCPN/tree/master/data/tcdata),
  or grab the full app from [opencpn.org](https://opencpn.org/) (its
  installer bundles `tcdata`).
- **Community harmonic bundles** (e.g. the French "HARMONICS V10" set
  circulating among cruisers) add ~150 current stations in W-Europe,
  including dense coverage of the Dutch Waddenzee and the Channel coast.
  These circulate informally on cruising/OpenCPN forums rather than a
  single canonical URL — search for "HARMONICS V10" or ask in the OpenCPN
  community.

### GRIB2 current files

Drop GRIB2 files (`*.grb2`, `*.grib2`, `*.grb`, `*.grib`) containing
current fields into the GRIB directory (plugin config → *GRIB2 Data
Directory*; defaults to a `grib` subdirectory of this plugin's own data
directory — independent of the Harmonics Data Directory setting, so
pointing the latter at an external OpenCPN folder doesn't relocate the
GRIB2 default there too). The directory is re-scanned about once a
minute, so downloading a fresh forecast file into it takes effect without
a restart.

What the plugin looks for inside the files:

- **Ocean-current fields**: GRIB2 discipline 10 (oceanographic products),
  category 1 (currents) — either u/v components (parameters 2/3, the usual
  encoding) or direction/speed (parameters 0/1).
- **Surface level** (or depth-below-sea-level; the shallowest level wins).
- Regular latitude/longitude grids, simple or complex packing (with or
  without spatial differencing) — what the common sources produce.
  JPEG2000-packed files (some NOAA products) are not supported; most GRIB
  delivery services (Saildocs, XyGrib, qtVlm, Expedition) provide
  currents in the supported packings.

Typical sources of current GRIBs: Saildocs (`RTOFS` requests), XyGrib/
openSkiron, qtVlm's download service, national met/hydrographic services,
or commercial weather routing providers.

> ⚠️ **Disclaimer**: community harmonic data is not official hydrographic
> data. Subordinate
> station predictions use the classic offset/multiplier approximation, and
> GRIB currents are model forecasts with their own errors.
> Treat all output as estimates — never as your sole source for navigation.

## REST API

Base: `/signalk/v2/api/currents` (same routes at
`/plugins/signalk-tidal-currents`).

| Endpoint | Description |
| --- | --- |
| `GET /` | Dataset summary for both sources (stations, GRIB coverage/time range) |
| `GET /stations?latitude=&longitude=&limit=` | Nearest current stations, closest first (harmonics only) |
| `GET /stations/{id}` | Station metadata incl. flood/ebb directions and offsets |
| `GET /stations/{id}/timeline?start=&end=&step=` | Set/drift series for one station (default 24 h, 10-min step) |
| `GET /timeline?latitude=&longitude=&start=&end=&step=` | Set/drift series at a **position** — per-sample source selection (GRIB / station) |
| `GET /vector?latitude=&longitude=&time=` | Set/drift vector at a position (GRIB preferred, station fallback) |

**Stations vs positions**: station endpoints only make sense for the
harmonic source — GRIB data has no stations, so GRIB-backed lookups are
purely positional (`/vector`, `/timeline`). `/vector` and `/timeline`
report which source produced each answer (`source` field; per-sample in
`/timeline`, so a window extending past the GRIB forecast horizon degrades
to station data sample-by-sample rather than failing).

**"Vector-capable" stations**: reference current stations in the XTide ASCII
format only carry a signed speed (harmonic constituents in knots) — they're
typically sited in a narrow channel where flow is bidirectional along an
axis that the file format never records. Subordinate current stations, by
contrast, carry explicit flood/ebb direction headings (degrees true) in
their `^` offset line, which is what lets the plugin resolve them into a
true set/drift vector (`direction`, `u`, `v`). Reference stations are
therefore skipped by `/vector` and by `environment.current` publishing
(`vectorCapable: false` in `/stations`), even though their raw signed speed
is still available via `/stations/{id}/timeline`.

`GET /stations?latitude=52.0&longitude=4.7&limit=2`:

```json
[
  {
    "id": "texel-noorderhaaks",
    "name": "Texel, Noorderhaaks",
    "latitude": 53.0092,
    "longitude": 4.6967,
    "type": "subordinate",
    "referenceName": "Texel Reference",
    "floodDir": 112,
    "ebbDir": 292,
    "distanceKm": 122.4,
    "vectorCapable": true
  },
  {
    "id": "texel-reference",
    "name": "Texel Reference",
    "latitude": 53.0,
    "longitude": 4.75,
    "type": "reference",
    "referenceName": null,
    "floodDir": null,
    "ebbDir": null,
    "distanceKm": 123.1,
    "vectorCapable": false
  }
]
```

`GET /vector?latitude=52.0&longitude=4.7` (station fallback; with GRIB
coverage `source` is `"grib"` and `station` is `null`):

```json
{
  "source": "station",
  "station": {
    "id": "texel-noorderhaaks",
    "name": "Texel, Noorderhaaks",
    "latitude": 53.0092,
    "longitude": 4.6967,
    "type": "subordinate",
    "referenceName": "Texel Reference",
    "floodDir": 112,
    "ebbDir": 292,
    "distanceKm": 122.4
  },
  "sample": {
    "time": "2026-07-02T12:30:00.000Z",
    "speedKn": 3.03,
    "direction": 345,
    "u": -0.404,
    "v": 1.506
  }
}
```

Timeline sample entry:

```json
{
  "time": "2026-07-02T12:30:00.000Z",
  "speedKn": 3.03,        // signed along-axis speed, + = flood
  "direction": 345,       // degrees true
  "u": -0.404,            // m/s east component
  "v": 1.506              // m/s north component
}
```

Note on `speedKn`: for **station** samples it is signed along the
flood/ebb axis (+ = flood); for **GRIB** samples there is no flood/ebb
axis, so it is simply the current's magnitude (`direction`/`u`/`v` carry
the vector either way).

## Plugin configuration

| Setting | Default | Description |
| --- | --- | --- |
| Harmonics Data Directory | `<plugin data dir>/tcdata` | Folder with `HARMONIC` + `HARMONIC.IDX` |
| GRIB2 Data Directory | `<plugin data dir>/grib` | Folder scanned for GRIB2 current files, independent of Harmonics Data Directory (see [GRIB2 current files](#grib2-current-files)) |
| Prefer GRIB over stations | `true` | Use the GRIB forecast when both sources cover a position |
| Publish environment.current | `true` | Emit deltas at the vessel position |
| Delta Update Period | `60 s` | How often to re-predict |
| Max Station Distance | `15 km` | Don't publish from a station when none is nearby (GRIB coverage is not distance-limited) |
| Auto-download OpenCPN standard data | `true` | Fetch/refresh OpenCPN's `HARMONICS_NO_US` pair into the data directory (see [Data files](#data-files)) |

`<plugin data dir>` is Signal K's standard per-plugin storage location:
`<server config dir>/plugin-config-data/signalk-tidal-currents`.

## Roadmap

- **XTide `.tcd` (libtcd) support** — the bit-packed binary format used for
  the NOAA/US data. The format is public domain with a written spec, but no
  maintained JS decoder exists yet; this needs a port of libtcd's
  bit-unpacking.
- GRIB2 JPEG2000 (template 5.40) packing — needs a JS JPEG2000 codec.
- Interpolation between stations; harmonic subordinate handling refinements.

## Development

```bash
npm install
npm test   # builds and runs the node:test suite (no extra tooling needed)
```

CI runs the shared
[SignalK plugin-ci workflow](https://github.com/SignalK/signalk-server/blob/master/.github/workflows/plugin-ci.yml)
across Linux (x64/arm64), macOS and Windows; the results appear on the
plugin's App Store *Indicators* tab.

## Acknowledgements & licensing

- File-format knowledge derives from the classic
  [XTide](https://flaterco.com/xtide/) ASCII harmonics format and OpenCPN's
  documentation of it. The parser here is an independent reimplementation
  (OpenCPN's own parser is GPLv2 and was used as a *format reference only*).
- The GRIB2 decoder is likewise an independent implementation from the WMO
  FM 92 specification and NCEP's public template documentation (no code
  from wgrib2/g2c/eccodes); it was validated against eccodes output on
  real NCEP files.
- This plugin is licensed under the **Apache License 2.0**. Source files
  carry SPDX headers.
- Harmonic data files are **not** included — their licenses/provenance vary;
  bring your own. (The integration tests download OpenCPN's
  `HARMONICS_NO_US` pair into a local cache on demand for the same reason:
  those files carry no explicit standalone license, so they cannot be
  redistributed inside this Apache-2.0 project.)
