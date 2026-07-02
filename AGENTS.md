# AGENTS.md — signalk-tidal-currents

Signal K server plugin predicting tidal currents (set/drift) from
OpenCPN/XTide legacy ASCII harmonic files (`HARMONIC` + `HARMONIC.IDX`).

## Toolchain — Docker only

- **No local node/npm** — use Docker for all Node.js commands (same
  convention as signalk-autoroute):
  ```bash
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$(pwd):/work" -w /work node:22 <command>
  ```
- Build: `… node:22 npm run build`
- Tests: `… node:22 npm test` (builds `dist/` + `dist-test/`, runs `node --test`)
- Always use `python3` (not `python`) for any helper scripts.

## Architecture

- `src/harmonics.ts` — parser. `loadHarmonicsDir(dir)` →
  `{ constituents, records, stations }`. **Format quirks it must keep
  handling**: ragged records (more/fewer constituent lines than the table —
  record starts are detected structurally as *name line + meridian line +
  datum line*), `x 0 0` placeholder rows, backtick used as minus sign in
  IDX longitudes, ISO-8859-1 encoding (French accents), `COUNTRY`/`REGION`/
  `XREF`/`TZ` header noise in the IDX.
- `src/predict.ts` — harmonic prediction.
  `v(t) = datum + Σ f·A·cos(ω·t + V₀ − φ)`, `t` in hours since year start
  **at the station meridian**. Subordinate currents: evaluate the reference
  at flood-/ebb-shifted times with per-branch multipliers, pick the
  phase-consistent branch (weaker signal near slack). Directions come from
  the subordinate `^` line (flood/ebb degrees true); reference current
  stations have **no axis** in this format → `vectorCapable: false`.
- `src/api.ts` — REST routes, express-free (`RouterLike` shim). Mounted at
  `/plugins/signalk-tidal-currents` (via `registerWithRouter`) **and**
  `/signalk/v2/api/currents` (via an app.get prefix shim in `start()`).
- `src/index.ts` — plugin entry. Publishes `environment.current` deltas
  (v1 data model) from the nearest vector-capable station within
  `maxStationDistanceKm`. Both **named and default exports** must point to
  `pluginConstructor` — Signal K's `importOrRequire()` returns
  `module.default` for ESM.

## File format cheat sheet

- IDX station line: `<type><zone> <lon> <lat> <TZH>:<TZM> <name>` where
  type ∈ `T` (tide ref), `t` (tide sub), `C` (current ref), `c` (current
  sub); `U/u` are legacy aliases of `C/c`.
- Current subordinate offsets line:
  `^<floodOffMin> <floodMpy> <floodAdd> <ebbOffMin> <ebbMpy> <ebbAdd>
  <staId> <floodDir> <ebbDir> <refFileNum> <reference name>`
  (multiplier `0` means `1.0`; dir > 360 means unusable).
- HARMONIC: constituent speed table → equilibrium args per year → node
  factors per year (`*END*`-terminated) → station records
  (`name / meridian / datum+units / constituent rows`). Units `knots` ⇒
  current station.

## Testing & validation

- Unit tests use the **synthetic fixture** in `test/fixtures/` (no
  provenance issues) — keep it synthetic; do not commit real harmonic data.
- Real-data integration test (`test/opencpn-data.test.ts`) uses the
  `HARMONICS_NO_US(.IDX)` pair from the OpenCPN repository. It is
  **downloaded on demand** into the gitignored `test/data-opencpn/` cache
  and the test **skips when offline**. The files are *not* vendored into
  this repo: they carry no explicit license (derived from XTide harmonic
  data whose non-US portions were withdrawn over licensing; OpenCPN ships
  them under its GPL umbrella), so redistribution inside this Apache-2.0
  project is not safely possible.
- The prediction engine was validated against signalk-tides (independent
  Neaps/TICON implementation): HW/LW times for a Dutch reference station
  agreed within ±12 minutes over a full day.

## Publishing

- npm keywords `signalk-node-server-plugin` + `signalk-category-*` make it
  appear in the Signal K AppStore; `signalk.displayName`/`appIcon` control
  presentation. `npm publish` after `npm run build` (`prepublishOnly` covers
  it).
- **Never bundle harmonic data files** — provenance/licensing varies.

## Roadmap notes

- `.tcd` (libtcd binary) support requires porting libtcd's bit-unpacking —
  the format is public domain (spec: Depner, OAML TCD, 2003); do NOT copy
  OpenCPN's GPLv2 `tcds_binary_harmonic.cpp`.
- signalk-autoroute integration: its `FlowField` provider interface consumes
  `GET /vector`-style samples; a `StationFlowField` there should prefer this
  plugin's stations and fall back to its height-gradient estimate.
