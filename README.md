<p align="center">
  <img src="img/icon.svg" width="96" alt="signalk-tidal-currents icon" />
</p>

# signalk-tidal-currents

A [Signal K](https://signalk.org) server plugin that predicts **tidal currents**
(set & drift) from OpenCPN/XTide legacy ASCII harmonic files — the
`HARMONIC` + `HARMONIC.IDX` pair used by OpenCPN and the classic DOS tide
programs.

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
- **Signal K v1 data model**: publishes `environment.current`
  (`setTrue` rad / `drift` m/s) predicted at the vessel position from the
  nearest vector-capable station.
- **v2-style REST API** at `/signalk/v2/api/currents` (also mirrored at the
  v1 plugin path `/plugins/signalk-tidal-currents`): station search by
  position, per-station set/drift timelines, point vector lookup. OpenAPI
  spec included (Admin UI → Documentation → OpenAPI).

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
pair (plugin config → *Harmonics Data Directory*; defaults to
`<server config dir>/tcdata`).

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

> ⚠️ **Disclaimer**: community harmonic data is not official hydrographic
> data (the V10 bundle explicitly notes it is *not* from SHOM). Subordinate
> station predictions use the classic offset/multiplier approximation.
> Treat all output as estimates — never as your sole source for navigation.

## REST API

Base: `/signalk/v2/api/currents` (same routes at
`/plugins/signalk-tidal-currents`).

| Endpoint | Description |
| --- | --- |
| `GET /` | Dataset summary (station counts, year range, source) |
| `GET /stations?latitude=&longitude=&limit=` | Nearest current stations, closest first |
| `GET /stations/{id}` | Station metadata incl. flood/ebb directions and offsets |
| `GET /stations/{id}/timeline?start=&end=&step=` | Set/drift series (default 24 h, 10-min step) |
| `GET /vector?latitude=&longitude=&time=` | Set/drift vector from the nearest vector-capable station |

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

`GET /vector?latitude=52.0&longitude=4.7`:

```json
{
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

## Plugin configuration

| Setting | Default | Description |
| --- | --- | --- |
| Harmonics Data Directory | `<config>/tcdata` | Folder with `HARMONIC` + `HARMONIC.IDX` |
| Publish environment.current | `true` | Emit deltas at the vessel position |
| Delta Update Period | `60 s` | How often to re-predict |
| Max Station Distance | `15 km` | Don't publish when no station is nearby |
| Auto-download OpenCPN standard data | `true` | Fetch/refresh OpenCPN's `HARMONICS_NO_US` pair into the data directory (see [Data files](#data-files)) |

## Roadmap

- **XTide `.tcd` (libtcd) support** — the bit-packed binary format used for
  the NOAA/US data. The format is public domain with a written spec, but no
  maintained JS decoder exists yet; this needs a port of libtcd's
  bit-unpacking.
- Interpolation between stations; harmonic subordinate handling refinements.

## Development

No local Node.js required — everything runs via Docker (see `AGENTS.md`):

```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 sh -c "npm install && npm test"
```

## Acknowledgements & licensing

- File-format knowledge derives from the classic
  [XTide](https://flaterco.com/xtide/) ASCII harmonics format and OpenCPN's
  documentation of it. The parser here is an independent reimplementation
  (OpenCPN's own parser is GPLv2 and was used as a *format reference only*).
- This plugin is licensed under the **Apache License 2.0**. Source files
  carry SPDX headers.
- Harmonic data files are **not** included — their licenses/provenance vary;
  bring your own. (The integration tests download OpenCPN's
  `HARMONICS_NO_US` pair into a local cache on demand for the same reason:
  those files carry no explicit standalone license, so they cannot be
  redistributed inside this Apache-2.0 project.)
