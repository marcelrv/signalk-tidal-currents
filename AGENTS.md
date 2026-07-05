# AGENTS.md — signalk-tidal-currents

Signal K server plugin predicting tidal currents (set/drift) from three
sources: OpenCPN/XTide legacy ASCII harmonic files (`HARMONIC` +
`HARMONIC.IDX`, station-based), GRIB2 gridded current fields (positional —
no station concept), and UTCEF datasets (`*.utcef[.gz]`, station-based 2D
harmonic currents — see `specs/utcef-specification.md` in `router-data`).

## Toolchain rules (repo-wide, not machine-specific)

- npm scripts must stay **cross-platform** (CI runs them on Windows/macOS
  too): no `rm -rf`, `cp -r`, shell globs or quoting tricks — use
  `node -e "require('fs')…"` one-liners instead.

## CI

- `.github/workflows/signalk-ci.yml` calls the reusable
  `SignalK/signalk-server/.github/workflows/plugin-ci.yml@master`:
  Linux x64/arm64, macOS, Windows × Node 22/24 on every push/PR, plus
  package/exports/schema/lifecycle validation. The App Store shows this
  per-platform matrix on the plugin's *Indicators* tab. armv7 (Cerbo GX)
  and the signalk-server integration test run via manual
  workflow_dispatch.
- Network-dependent tests must **skip, not fail, when offline** (see
  opencpn-data.test.ts) and write only to
  `os.tmpdir()` or gitignored caches.

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
- `src/grib2.ts` — dependency-free GRIB2 decoder, written from the WMO
  spec + NCEP template docs (**do NOT copy GPL decoders** — wgrib2/g2c/
  OpenCPN are format references only). Scope: grid template 3.0 (regular
  lat/lon incl. scan-mode normalization to south→north/west→east),
  product templates with the 4.0 leading layout (+ 4.8 interval end
  time), data representation 5.0/5.2/5.3 (complex packing: byte-aligned
  blocks, primary missing management, spatial differencing orders 0/1/2 —
  order 0 occurs in eccodes output), bitmap section. GRIB2 signed ints
  are **sign-magnitude**, not two's complement. Unsupported messages go
  to `skipped`, never throw.
- `src/gribcurrents.ts` — GRIB current source. Pairs discipline 10 /
  category 1 fields (u/v params 2/3 or dir/speed 0/1; direction =
  TOWARD) per valid time, shallowest level wins. `gribVectorAt` =
  bilinear in space (NaN corners dropped + weights renormalized for
  coastlines) and linear in time (±3 h clamp slack at the range edges).
  `createGribSource(dir)` re-stats the dir at most 1×/min and reloads on
  file-set change.
- `src/astro.ts` — dependency-free astronomical engine for UTCEF. UTCEF
  carries only amplitude + Greenwich phase; this derives ω (catalog
  speeds), V₀ (Greenwich equilibrium arg from the mean-longitude
  polynomials), and the Schureman/Foreman nodal `f`/`u` cosine series. The
  legacy HARMONIC path does **not** use this — it reads ω/V₀/f from the
  file's own year tables. Correctness is anchored in tests by the identity
  *dV₀/dt == catalog speed* for every constituent.
- `src/utcef.ts` — UTCEF source. Parses `*.utcef` / `*.utcef.gz` (gzip via
  built-in `zlib`); implements `harmonic_constituents_currents` (full 2D
  u/v vectors → always direction-capable, unlike legacy reference
  stations). `harmonic_constituents_heights` is parsed+counted but **not
  published** (this is a currents plugin); `relative_time_offset` is
  counted as unsupported (needs reference-port HW/range-ratio — deferred).
  Canonical id is the top-level `Feature.id`; `station_id` is only an
  alias. Rejects unknown schema **major** versions. `utcefVectorAt` prefers
  a station whose `representative_area` polygon contains the point, else
  nearest within `maxKm`. `createUtcefSource(dir)` mirrors the GRIB source's
  1×/min reload.
- `src/api.ts` — REST routes, express-free (`RouterLike` shim). Mounted at
  `/plugins/signalk-tidal-currents` (via `registerWithRouter`) **and**
  `/signalk/v2/api/currents` (via an app.get prefix shim in `start()`).
  `resolveVector()` picks a source in preference order GRIB → UTCEF →
  legacy station (or UTCEF → station → GRIB when `preferGrib` is false);
  `/timeline` (positional) selects the source **per sample** so windows
  past the GRIB horizon degrade to the other sources. Station endpoints
  (`/stations`, `/stations/:id[/timeline]`) serve **both** harmonics and
  UTCEF stations. `speedKn` is signed for legacy station samples, a
  magnitude for UTCEF and GRIB samples. `/stations?bbox=w,s,e,n` (vs. the nearest-N
  `?latitude=&longitude=` form) returns **every** current station inside
  a viewport, capped at `limit` (default/max 500) — no distance sort,
  since there's no single reference point. `/grid?bbox=…` is the gridded
  equivalent for GRIB coverage (`gribGridSamples()` in `gribcurrents.ts`):
  samples are chosen from the source grid's own fixed (i, j) index
  lattice at a stride targeting `maxPoints` (never finer than native
  resolution) — **not** at bbox-relative offsets, so a given physical
  point always lands at the same lat/lon and panning/zooming a map
  doesn't reshuffle the arrows' positions. Both `/stations?bbox=` and
  `/grid?bbox=` exist so a map can show full-viewport current coverage
  instead of a fixed nearest-N station list.
- `src/index.ts` — plugin entry. Publishes `environment.current` deltas
  (v1 data model) via `resolveVector` (GRIB not distance-limited;
  stations within `maxStationDistanceKm`). Both **named and default
  exports** must point to `pluginConstructor` — Signal K's
  `importOrRequire()` returns `module.default` for ESM.

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
- GRIB2 currents: discipline 10, category 1; params 0=dir(TOWARD),
  1=speed, 2=u, 3=v; surface type 1 or 160 (depth, shallowest wins).
  Longitudes stored 0–360; lat/lon in 1e-6°; scan flag 0x40 = south→north.

## Testing & validation

- Unit tests use the **synthetic fixture** in `test/fixtures/` (no
  provenance issues) — keep it synthetic; do not commit real harmonic data.
- GRIB2 tests are fully synthetic: `test/grib2-testutil.ts` is an
  independent encoder (simple packing + section builders); complex-packing
  tests hand-assemble the bit-level section 5/7 layouts. The decoder was
  additionally cross-validated (not in CI) against eccodes on a real NCEP
  GFS subset re-encoded as grid_complex and
  grid_complex_spatial_differencing — exact value match within packing
  quantization.
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

## Before committing

- Run `npm pack --dry-run` and check the "Tarball Contents" listing before
  creating a commit that touches `package.json` `files`, adds new
  root-level assets (README/CHANGELOG/img/…), or changes what should ship.
  Catches the class of bug where a published tarball is missing something
  the App Store needs (README images, CHANGELOG.md) — cheaper to catch
  here than after a broken publish.

## Publishing

- npm keywords `signalk-node-server-plugin` + `signalk-category-*` make it
  appear in the Signal K AppStore; `signalk.displayName`/`appIcon` control
  presentation. `npm publish` after `npm run build` (`prepublishOnly` covers
  it).
- **App Store README rendering**: raw HTML is NOT rendered (no rehype-raw)
  — use pure Markdown only. Relative image paths in `![…](…)` syntax are
  rewritten to `unpkg.com/<pkg>@<version>/<path>`, so referenced images
  must be inside the published tarball (`files`).
- **App Store Changelog tab**: prefers GitHub Releases (public
  `releases.atom` of the repo in package.json); falls back to
  `CHANGELOG.md` at the package root fetched from unpkg. Keep
  `CHANGELOG.md` updated per release and listed in `files`; creating a
  GitHub Release per version gives the nicest result.
- **Never bundle harmonic data files** — provenance/licensing varies.

### Release flow — npm and GitHub Releases must stay in sync

Day-to-day commits land on `main` without touching `version` or
`CHANGELOG.md` — those two only move together, at the moment of an
actual release. Every published npm version needs a matching GitHub
Release (same version number), because the App Store Changelog tab
prefers GitHub Releases over `CHANGELOG.md` — a gap between them means
the tab shows the wrong (or no) notes for the latest version. When ready
to cut a release:

1. Add a section to `CHANGELOG.md` for the new version (this is also the
   source text for the release notes — keep them identical).
2. Bump `version` in `package.json` to match.
3. Run the [Before committing](#before-committing) check, then commit.
4. `npm publish` (after `npm run build`; `prepublishOnly` covers the build).
5. Tag and create the GitHub Release for the **same version**, using the
   matching CHANGELOG section as the release body:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <(sed -n '/## X.Y.Z/,/## /p' CHANGELOG.md | sed '$d')
   ```
   (or paste the section manually into `gh release create --notes` /
   the GitHub UI — the `sed` one-liner is a convenience, not a requirement).
- Never `npm publish` a version without also creating its GitHub Release
  (or vice versa) — do both in the same sitting so they never drift.

## Roadmap notes

- `.tcd` (libtcd binary) support requires porting libtcd's bit-unpacking —
  the format is public domain (spec: Depner, OAML TCD, 2003); do NOT copy
  OpenCPN's GPLv2 `tcds_binary_harmonic.cpp`.
- signalk-autoroute integration: its `FlowField` provider interface consumes
  `GET /vector`-style samples; a `StationFlowField` there should prefer this
  plugin's stations and fall back to its height-gradient estimate.
