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
  TOWARD) per valid time, shallowest level wins. **Series model**: one
  `GridSeries` per distinct grid geometry (`data.series`, no merged slot
  list, no cross-grid dedup). A series dedups per valid time **within its
  grid**: shallowest depth, then newest `refTime`, then later file name; series
  are ordered finest-resolution first, then by file name. `gribVectorAt` =
  the first series with a value: bilinear in space (NaN corners dropped +
  weights renormalized for coastlines) and linear in time (±3 h clamp slack at
  the range edges). Stack layers use `gribSubsetSeries(data, files)` (uncached
  here; `resolve.ts` keeps the result per layer): per geometry, a file subset
  that equals the canonical series' whole file set **reuses the canonical
  `GridSeries` object** (no second dedup pass or cell mask); only a strict
  subset is built, on the canonical grid object. Each series carries a
  per-cell `cellMask` (bit 0 = defined in some slot, bit 1 = defined in every
  slot) built at load, so `gribSeriesCovers` (the claim probe) is exact yet
  O(1) in the common case; it raises an optional `TimeDependence` out-flag
  when it had to sample the bracketing slots (partially-defined cell), the one
  case where its answer changes with the time while the series stays in range
  (`gribSeriesInRange` is the other, coarse, time dependence).
  **Cycle seams (accepted behaviour):** the dedup is per valid time, not per
  cycle, so a series can bracket slots from different cycles. Where a newer
  forecast cycle starts *later* than an older one covers, the step between the
  last old-cycle-only slot and the first newer-cycle slot interpolates ACROSS
  the two cycles. The same happens *inside* the newer cycle's range when it
  lacks an intermediate valid time that an older cycle has (the older cycle
  supplies that slot), and because depth ranks before `refTime`, a shallower
  slot from an older cycle outranks a deeper slot from a newer one. This is
  deliberate — dropping older-cycle slots would leave gaps — so do not "fix"
  it. `createGribSource(dir)` re-stats the dir at most 1×/min and reloads on
  file-set change, re-decoding only files whose size/mtime changed (per-file
  parse cache — a full re-decode of every file on each change froze small
  ARM boxes once many regions were installed).
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
  alias. Rejects unknown schema **major** versions; a
  `representative_area` ring that encircles a pole (unwrapped ring does not
  close) is rejected with a warning (nearest-station lookup applies).
  `utcefVectorAt` prefers a station whose `representative_area` polygon
  contains the point (first in array order), else nearest within `maxKm`
  (ties: earliest in array). A finite `maxKm` goes through
  `utcefCoverageIndexFor(data).stationAt()` (shared `geoindex.ts` cell index
  for stations; small polygons in per-cell lists, polygons whose bbox spans
  > 64 cells in coarse 10° buckets with a bbox pre-test — mind the ±360
  frames); `Infinity` keeps the linear scan. Parity tests pin the index path
  to the linear algorithm. `createUtcefSource(dir)` mirrors the GRIB source's
  1×/min reload and per-file parse cache.
- `src/geoindex.ts` — the one shared cell index (`createCellIndex`) used by
  the UTCEF and legacy indexes: antimeridian-wrapped keys, padded box with a
  linear fallback when the box covers more cells than there are items,
  `nearestWithin` (rounded distance, ties by array rank, d = 0 fast path),
  `within`, `inBbox`. Also home of `distanceKm`/`lonHalfWidthDeg`/`lonInSpan`.
- `src/resolve.ts` — **THE resolver**; no other module decides who answers at
  (lat, lon, t). `orderedLayers()` (dataset stack, then the type rank: the
  configured `sourcePriority` when set — any order — else the `preferGrib`
  fallback, GRIB → UTCEF → legacy station, or UTCEF → station → GRIB when
  `preferGrib` is false; a stack UTCEF probe's nearest radius is clamped to
  50 km) builds the
  layers; `createResolveCtx(state, maxKm, {bbox?, legacy?})` keeps those that
  can answer (an optional `bbox` drops layers whose 10°-bucket extent cannot
  reach it). `claimAt` returns WHO answers (GRIB series / UTCEF station /
  legacy station) without sampling; `resolveAt` is claim + sample; both run
  the same private layer loop (which takes an optional `TimeDependence`
  out-flag raised when a GRIB probe before the winner went through the
  mask-partial branch). `ctx.counters` (claims, resolves, layerProbes,
  samples) is what the tests assert the cost bounds on.
  **Long-lived caches hang off (data object, layer snapshot)** — the snapshot
  being the array `orderedLayers()` returns — in a two-level `WeakMap`, so they
  are freed when the data reloads or the stack changes, are keyed by layer
  OBJECT (never by Set identity or a name string), and have **no count caps**:
  their size is bounded by the number of stack layers. Per layer: the GRIB
  series (`gribSubsetSeries`, built once; canonical series reused where the
  files equal a region's whole file set) and, for UTCEF, the bbox pre-filter
  extent = the union of per-FILE extents (one pass over the stations builds
  every file's extent for a radius; a layer's extent is <= 648 bucket keys).
  Capped FIFO caches here thrashed as soon as the stack had more layers than
  the cap (every manually dropped file is its own layer) — don't reintroduce
  one. `resolveBuildCounts` / `gribBuildCounts` are the test hooks asserting
  each entry is built once.
  **`ownWinFor(ctx, 'utcef' | 'station', t)`** = per station, whether it wins
  its OWN position: a `Uint8Array` (0 loses, 1 wins, 2 time-dependent), one
  byte per station, indexed by array position (UTCEF: `currentStations`;
  legacy: the legacy index's station list). Filled once per
  (snapshot, legacy flag, maxStationKm, `rangeKey`) by the same claim loop,
  against the **unpruned** `ctx.fullLayers` (it covers stations outside the
  current view, so it must not see a bbox-pruned layer list). `rangeKey` = which
  GRIB series are in range at `t`, so crossing a forecast-horizon edge selects
  or builds another array; stations flagged 2 (coastline cells, partially
  defined GRIB) are re-decided per request with `claimAt`. LRU of
  `OWN_WIN_CACHE_CAP` (4) arrays per (snapshot, GRIB, UTCEF, harmonics) —
  chained WeakMaps, so replacing ANY loaded data object misses and frees it
  (the claim loop reads all three). It is NOT a per-station memo map.
- `src/api.ts` — REST routes, express-free (`RouterLike` shim). Mounted at
  `/plugins/signalk-tidal-currents` (via `registerWithRouter`) **and**
  `/signalk/v2/api/currents` (via an app.get prefix shim in `start()`).
  `resolveVector()`, `/vector`, `/timeline` (one `resolveAt` per sample, so
  windows past the GRIB horizon degrade to the other sources) and `/grid` all
  go through `resolve.ts`. Station endpoints (`/stations`,
  `/stations/:id[/timeline]`) serve **both** harmonics and UTCEF stations.
  `speedKn` is signed for legacy station samples, a magnitude for UTCEF and
  GRIB samples. `/stations?bbox=w,s,e,n` (vs. the nearest-N
  `?latitude=&longitude=` form) returns the current stations inside a
  viewport (gathered through the cell index), thinned to `maxPoints` (default
  500, max 5000; legacy alias `limit`) via `thinByCellLadder()` — a stable
  spatial cell ladder (`CELL_LADDER_DEG`, fine→coarse) keeping ONE
  representative (nearest the cell centre) per occupied cell at the finest
  level whose occupancy fits. Cells are aligned to the **global origin**, not
  the bbox, so which stations survive depends only on where they are.
  **`/grid?bbox=…` has three rules** (`gridPoints`):
  1. *Single resolver.* `/grid` only chooses candidate positions (lattice
     nodes, in-view stations); every one is decided by `resolveAt`/`claimAt`.
     It never probes GRIB/UTCEF/legacy itself, so each point equals `/vector`
     at its coordinates — with two exceptions: by default `/grid` excludes
     legacy harmonic stations while `/vector` includes them, so the two can
     pick different sources at the same position (`stations=1` opts them in);
     and with `stations=1` a legacy station's `speedKn` is a magnitude in
     `/grid` while `/vector` keeps its sign.
  2. *Series model.* A lattice belongs to a grid geometry; a GRIB answer from
     another grid is dropped (that grid's own lattice shows it), a station
     answer is emitted as that station's vector (`stationId`) — but only
     where that grid has a value at the node (the station merely outranks it).
     Where the grid has none (land) the node is dropped: the resolver falls
     through to the nearest station there, and painting that vector on the
     lattice puts arrows over land (the station shows at its own position).
  3. *Geometry-only stride.* Per grid, a power-of-two base stride from the
     bbox size and the grid's cell size alone (`baseStride`), nodes = the
     grid's own (i, j) multiples of the stride from index 0 (lattices nest).
     Station winners are counted first — in-view stations are gathered as
     array positions through the cell index (`inBboxRanks`, unsorted), read
     from the `ownWin` array (`resolve.ts`) and only the time-dependent ones go
     through `claimAt`; winners live in parallel typed arrays (zoomed out with
     nothing covering them, ~200k stations all win: per-station objects there
     cost hundreds of MB of transient RSS), are thinned by index
     (`thinIndicesByCellLadder`, typed-array cell table — same selection as the
     object version) and only the survivors (<= `maxPoints`) re-derive their
     claim for sampling. Station points are therefore in thinning order, not
     station-array order. The
     fill level is the densest `max(1, base / 2^k)` with candidates + winners
     ≤ `maxPoints` (index arithmetic, one resolve pass, no trial passes).
     Total ≤ `maxPoints` by construction. No content-dependent heuristics.
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
- signalk-routeiq integration: its `FlowField` provider interface consumes
  `GET /vector`-style samples; a `StationFlowField` there should prefer this
  plugin's stations and fall back to its height-gradient estimate.
